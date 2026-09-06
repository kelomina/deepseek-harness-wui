//! 真 pty→xterm 后端（任务#7）：常驻 shell，经 Tauri 事件流推送。
//!
//! - 跨平台：`portable-pty`（Windows ConPTY / Unix pty）。
//! - 默认 shell：Windows `powershell.exe`（COMSPEC 备选 cmd）；Unix `$SHELL` 备选 sh。
//! - 事件（统一名 + id 字段冻结）：`pty-output {id,data}` / `pty-exit {id,exit_code}`。
//! - 上限：`MAX_PTY_SESSIONS = 4`，超限报错不静默失败。

use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, Mutex,
};
use tauri::{AppHandle, Emitter, State};

use crate::AppState;

/// 最大并发 pty 数（冻结常量，前端对接依据）。
pub const MAX_PTY_SESSIONS: usize = 4;
/// 输出事件名（统一事件 + id 字段）。
pub const PTY_EVENT_OUTPUT: &str = "pty-output";
/// 退出事件名（统一事件 + id 字段）。
pub const PTY_EVENT_EXIT: &str = "pty-exit";

const DEFAULT_COLS: u16 = 80;
const DEFAULT_ROWS: u16 = 24;
const MAX_COLS: u16 = 500;
const MAX_ROWS: u16 = 500;
const MAX_WRITE_BYTES: usize = 1_000_000;

#[derive(serde::Serialize, Clone)]
struct PtyOutputPayload {
    id: String,
    data: String,
}

#[derive(serde::Serialize, Clone)]
struct PtyExitPayload {
    id: String,
    exit_code: Option<i32>,
}

struct PtySession {
    master: Mutex<Box<dyn portable_pty::MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    child: Mutex<Box<dyn portable_pty::Child + Send + Sync>>,
}

pub struct PtyManager {
    sessions: Mutex<HashMap<String, Arc<PtySession>>>,
    next_id: AtomicU64,
}

impl PtyManager {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(0),
        }
    }

    fn alloc_id(&self) -> String {
        let n = self.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        format!("pty-{n}")
    }
}

impl Default for PtyManager {
    fn default() -> Self {
        Self::new()
    }
}

fn default_shell_primary() -> String {
    #[cfg(target_os = "windows")]
    {
        "powershell.exe".to_string()
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::env::var("SHELL")
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|_| "sh".to_string())
    }
}

fn fallback_shell() -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        let comspec = std::env::var("COMSPEC")
            .ok()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| "cmd.exe".to_string());
        if comspec.eq_ignore_ascii_case("powershell.exe")
            || comspec.to_lowercase().ends_with("powershell.exe")
        {
            None
        } else {
            Some(comspec)
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        None
    }
}

fn resolve_cwd(cwd: Option<String>) -> Result<std::path::PathBuf, String> {
    match cwd.filter(|c| !c.trim().is_empty()) {
        Some(c) => {
            let p = std::path::PathBuf::from(c.trim());
            if !p.exists() {
                return Err(format!("cwd 不存在: {}", p.display()));
            }
            if !p.is_dir() {
                return Err("cwd 不是目录".to_string());
            }
            Ok(p)
        }
        None => Ok(dirs::home_dir().unwrap_or_else(|| std::path::PathBuf::from("."))),
    }
}

fn check_size(cols: u16, rows: u16) -> Result<PtySize, String> {
    if cols < 1 || cols > MAX_COLS || rows < 1 || rows > MAX_ROWS {
        return Err(format!("cols/rows 非法: {cols}x{rows}（允许 1..={MAX_COLS} x 1..={MAX_ROWS}）"));
    }
    Ok(PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    })
}

/// 建常驻 shell：`pty_spawn(cwd?, cols?, rows?) -> id`。
#[tauri::command]
pub fn pty_spawn(
    app: AppHandle,
    state: State<AppState>,
    cwd: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
) -> Result<String, String> {
    let pty = state.pty.clone();
    {
        let sessions = pty.sessions.lock().map_err(|e| format!("pty 锁失败: {e}"))?;
        if sessions.len() >= MAX_PTY_SESSIONS {
            return Err(format!("pty 并发已达上限({MAX_PTY_SESSIONS})，请先关闭空闲会话"));
        }
    }
    let size = check_size(cols.unwrap_or(DEFAULT_COLS), rows.unwrap_or(DEFAULT_ROWS))?;
    let workdir = resolve_cwd(cwd)?;
    let primary = default_shell_primary();

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(size)
        .map_err(|e| format!("pty 打开失败: {e:#}"))?;

    let mut builder = CommandBuilder::new(&primary);
    builder.cwd(&workdir);
    let mut child = match pair.slave.spawn_command(builder) {
        Ok(c) => c,
        Err(first_err) => {
            // Windows 备选：powershell 不可用时回落 COMSPEC/cmd
            if let Some(fb) = fallback_shell() {
                let mut retry = CommandBuilder::new(&fb);
                retry.cwd(&workdir);
                pair.slave
                    .spawn_command(retry)
                    .map_err(|e2| format!("shell 启动失败({primary}: {first_err:#}；{fb}: {e2:#})"))?
            } else {
                return Err(format!("shell 启动失败({primary}): {first_err:#}"));
            }
        }
    };
    // 主动确认子进程存活（spawn 后即退的场景早报错，不等首读）
    if let Ok(Some(status)) = child.try_wait() {
        return Err(format!("shell 已退出(code={})", status.exit_code()));
    }

    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("pty reader 失败: {e:#}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("pty writer 失败: {e:#}"))?;
    let id = pty.alloc_id();
    let session = Arc::new(PtySession {
        master: Mutex::new(pair.master),
        writer: Mutex::new(writer),
        child: Mutex::new(child),
    });
    {
        let mut sessions = pty.sessions.lock().map_err(|e| format!("pty 锁失败: {e}"))?;
        if sessions.len() >= MAX_PTY_SESSIONS {
            return Err(format!("pty 并发已达上限({MAX_PTY_SESSIONS})，请先关闭空闲会话"));
        }
        sessions.insert(id.clone(), session.clone());
    }
    spawn_reader(app, pty, id.clone(), session, reader);
    Ok(id)
}

fn spawn_reader(
    app: AppHandle,
    pty: Arc<PtyManager>,
    id: String,
    session: Arc<PtySession>,
    mut reader: Box<dyn Read + Send>,
) {
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break, // EOF：子进程退出
                Ok(n) => {
                    let data = String::from_utf8_lossy(&buf[..n]).to_string();
                    let _ = app.emit(
                        PTY_EVENT_OUTPUT,
                        PtyOutputPayload {
                            id: id.clone(),
                            data,
                        },
                    );
                }
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            }
        }
        // 自然退出：取 exit code 并推送，仅当会话仍在表内（kill 路径已推送则跳过，避免双事件）
        let code: Option<i32> = session
            .child
            .lock()
            .ok()
            .and_then(|mut c| c.try_wait().ok().flatten())
            .map(|st| st.exit_code() as i32);
        let still_present = pty
            .sessions
            .lock()
            .map(|mut m| m.remove(&id).is_some())
            .unwrap_or(false);
        if still_present {
            let _ = app.emit(
                PTY_EVENT_EXIT,
                PtyExitPayload {
                    id: id.clone(),
                    exit_code: code,
                },
            );
        }
    });
}

/// 写 stdin：`pty_write(id, data)`。
#[tauri::command]
pub fn pty_write(state: State<AppState>, id: String, data: String) -> Result<(), String> {
    if data.len() > MAX_WRITE_BYTES {
        return Err(format!("单次写入过大(>{MAX_WRITE_BYTES}B)，请分片"));
    }
    let pty = state.pty.clone();
    let session = {
        let sessions = pty.sessions.lock().map_err(|e| format!("pty 锁失败: {e}"))?;
        sessions
            .get(&id)
            .cloned()
            .ok_or_else(|| format!("pty 会话不存在: {id}"))?
    };
    let mut w = session.writer.lock().map_err(|e| format!("pty 写锁失败: {e}"))?;
    w.write_all(data.as_bytes())
        .map_err(|e| format!("pty 写入失败: {e}"))?;
    w.flush().map_err(|e| format!("pty 刷新失败: {e}"))?;
    Ok(())
}

/// 改尺寸：`pty_resize(id, cols, rows)`。
#[tauri::command]
pub fn pty_resize(state: State<AppState>, id: String, cols: u16, rows: u16) -> Result<(), String> {
    let size = check_size(cols, rows)?;
    let pty = state.pty.clone();
    let session = {
        let sessions = pty.sessions.lock().map_err(|e| format!("pty 锁失败: {e}"))?;
        sessions
            .get(&id)
            .cloned()
            .ok_or_else(|| format!("pty 会话不存在: {id}"))?
    };
    let master = session.master.lock().map_err(|e| format!("pty 主端锁失败: {e}"))?;
    master.resize(size).map_err(|e| format!("pty resize 失败: {e:#}"))?;
    Ok(())
}

/// 杀会话并清理句柄：`pty_kill(id)`（推送 `pty-exit` 后清理，不留双事件）。
#[tauri::command]
pub fn pty_kill(app: AppHandle, state: State<AppState>, id: String) -> Result<(), String> {
    let pty = state.pty.clone();
    let session = {
        let mut sessions = pty.sessions.lock().map_err(|e| format!("pty 锁失败: {e}"))?;
        sessions
            .remove(&id)
            .ok_or_else(|| format!("pty 会话不存在: {id}"))?
    };
    let code: Option<i32> = (|| {
        let mut child = session.child.lock().ok()?;
        let _ = child.kill();
        // 取退出码（best-effort，拿不到即 None）
        child.try_wait().ok().flatten().map(|st| st.exit_code() as i32)
    })();
    let _ = app.emit(
        PTY_EVENT_EXIT,
        PtyExitPayload {
            id: id.clone(),
            exit_code: code,
        },
    );
    Ok(())
}

#[cfg(test)]
mod pty_tests {
    use super::*;

    #[test]
    fn pty_constants_frozen() {
        assert_eq!(MAX_PTY_SESSIONS, 4);
        assert_eq!(PTY_EVENT_OUTPUT, "pty-output");
        assert_eq!(PTY_EVENT_EXIT, "pty-exit");
    }

    #[test]
    fn pty_size_validation() {
        assert!(check_size(80, 24).is_ok());
        assert!(check_size(0, 24).is_err());
        assert!(check_size(80, 0).is_err());
        assert!(check_size(501, 24).is_err());
        assert!(check_size(80, 501).is_err());
    }

    #[test]
    fn pty_shell_non_empty() {
        assert!(!default_shell_primary().trim().is_empty());
    }

    #[test]
    fn pty_cwd_rejects_missing() {
        // 可移植改写：temp 下必定不存在的绝对路径（Windows 仍为盘符绝对路径，
        // 与旧 `Z:\...` 同等强度；Unix 下 `Z:\...` 会退化为相对文件名，语义不准）
        let missing = std::env::temp_dir().join("no_such_dir_xyz_123_dsh_pty");
        let _ = std::fs::remove_file(&missing);
        let _ = std::fs::remove_dir(&missing);
        assert!(resolve_cwd(Some(missing.to_string_lossy().to_string())).is_err());
        assert!(resolve_cwd(Some(String::new())).is_ok());
        assert!(resolve_cwd(None).is_ok());
    }
}
