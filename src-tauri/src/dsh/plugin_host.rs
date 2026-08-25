use crate::dsh::manager::{kill_tree, lock};
use serde::Serialize;
use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

/// dsh-std 插件宿主 sidecar（实验特性，默认关闭；见 docs/DSH_STD_HOST_PLAN.md）。
///
/// 生命周期镜像 DshManager：spawn → stdio NDJSON 握手/请求 → kill_tree 清理。
/// 安全边界：无 Tauri IPC、无监听端口、token 握手、权限默认 deny；
/// 第三方插件代码只在本子进程内执行（trusted-in-process 于 sidecar，非 OS 边界）。
pub struct PluginHostManager {
    child: Option<Child>,
    stdin: Option<ChildStdin>,
    rx: Option<Receiver<serde_json::Value>>,
    stderr_handle: Option<std::thread::JoinHandle<()>>,
    stdout_handle: Option<std::thread::JoinHandle<()>>,
    pending: VecDeque<serde_json::Value>,
    state: PluginHostState,
    pid: Option<u32>,
    started_at: Option<Instant>,
    message: String,
    logs: Arc<Mutex<VecDeque<String>>>,
    next_id: AtomicU64,
    grants_path: Option<std::path::PathBuf>,
    restart_count: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PluginHostState {
    Stopped,
    Starting,
    Running,
    Error,
}

#[derive(Debug, Clone, Serialize)]
pub struct PluginHostStatusView {
    pub state: PluginHostState,
    pub pid: Option<u32>,
    pub message: String,
    pub uptime_secs: Option<u64>,
}

impl PluginHostManager {
    pub fn new() -> Self {
        Self {
            child: None,
            stdin: None,
            rx: None,
            stderr_handle: None,
            stdout_handle: None,
            pending: VecDeque::new(),
            state: PluginHostState::Stopped,
            pid: None,
            started_at: None,
            message: "stopped（实验特性，默认关闭）".to_string(),
            logs: Arc::new(Mutex::new(VecDeque::new())),
            next_id: AtomicU64::new(1),
            grants_path: None,
            restart_count: 0,
        }
    }

    pub fn status_view(&self) -> PluginHostStatusView {
        PluginHostStatusView {
            state: self.state,
            pid: self.pid,
            message: self.message.clone(),
            uptime_secs: self.started_at.map(|t| t.elapsed().as_secs()),
        }
    }

    pub fn logs(&self, limit: usize) -> Vec<String> {
        let logs = lock(self.logs.lock());
        logs.iter().rev().take(limit).cloned().collect::<Vec<_>>().into_iter().rev().collect()
    }

    /// 定位 plugin-host/main.mjs：资源目录 → 环境变量覆盖 → cwd 相对路径
    /// （对齐 routing_suite::resolve_suite_root 的三级回退模式）。
    fn resolve_entry(app: &AppHandle) -> Result<std::path::PathBuf, String> {
        let mut candidates: Vec<std::path::PathBuf> = Vec::new();
        if let Ok(p) = app.path().resolve("plugin-host", tauri::path::BaseDirectory::Resource) {
            candidates.push(p);
        }
        if let Ok(dir) = std::env::var("DSH_WUI_PLUGIN_HOST_DIR") {
            candidates.push(std::path::PathBuf::from(dir));
        }
        if let Ok(cwd) = std::env::current_dir() {
            candidates.push(cwd.join("plugin-host"));
            candidates.push(cwd.join("..").join("plugin-host"));
        }
        for cand in candidates {
            if cand.join("main.mjs").is_file() && cand.join("package.json").is_file() {
                return Ok(cand);
            }
        }
        Err(
            "找不到 plugin-host 目录（需要先安装依赖：cd plugin-host && npm install）".to_string(),
        )
    }

    pub fn start(&mut self, app: &AppHandle) -> Result<(), String> {
        if self.child.is_some() {
            return Ok(());
        }
        let node = crate::dsh::prereq::find_node()
            .ok_or_else(|| "未找到 Node.js（≥22.19），请先完成前置条件安装".to_string())?;
        let entry = Self::resolve_entry(app)?;
        let token = format!("ph-{}-{}", std::process::id(), unique_nanos());
        let cfg_dir_opt = app.path().app_config_dir().ok();
        let storage_root = cfg_dir_opt
            .clone()
            .map(|d| d.join("plugin-storage"))
            .unwrap_or_else(|| std::env::temp_dir().join("dsh-wui-plugin-storage"));
        let grants_path = cfg_dir_opt.as_ref().map(|d| d.join("plugin-host-grants.json"));
        let ledger_path = cfg_dir_opt
            .map(|d| d.join("plugin-host-ledger.jsonl"))
            .unwrap_or_else(|| std::env::temp_dir().join("dsh-wui-plugin-ledger.jsonl"));

        let mut cmd = Command::new(&node);
        cmd.arg(entry.join("main.mjs"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .current_dir(&entry)
            .env("DSH_WUI_PLUGIN_HOST_TOKEN", &token)
            .env("DSH_WUI_PLUGIN_HOST_STORAGE_ROOT", &storage_root)
            .env("DSH_WUI_PLUGIN_HOST_LEDGER", &ledger_path);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        let mut child = cmd
            .spawn()
            .map_err(|e| format!("plugin-host 启动失败 ({}): {e}", node.display()))?;
        let pid = child.id();
        let stdout = child.stdout.take().ok_or("stdout pipe missing")?;
        let stderr = child.stderr.take().ok_or("stderr pipe missing")?;
        self.stdin = Some(child.stdin.take().ok_or("stdin pipe missing")?);

        // stderr → 日志环；stdout → 帧通道（读线程阻塞读，kill 后管道关闭自然退出）
        let logs = self.logs.clone();
        self.stderr_handle = Some(std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines().map_while(Result::ok) {
                push_log(&logs, format!("[host] {line}"));
            }
        }));
        let (tx, rx) = channel::<serde_json::Value>();
        self.stdout_handle = Some(std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines().map_while(Result::ok) {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                match serde_json::from_str(trimmed) {
                    Ok(value) => {
                        if tx.send(value).is_err() {
                            break;
                        }
                    }
                    Err(_) => {
                        let _ = tx.send(serde_json::json!({
                            "id": null, "ok": false,
                            "error": {"code": "BAD_FRAME"}
                        }));
                    }
                }
            }
        }));

        self.child = Some(child);
        self.rx = Some(rx);
        self.pid = Some(pid);
        self.state = PluginHostState::Starting;
        self.started_at = Some(Instant::now());
        self.message = format!("starting (pid {pid})");
        push_log(&self.logs, format!("spawned pid {pid}: {}", entry.display()));

        // 同步握手；失败即回滚停止（保证无半启动残留）
        match self.request_inner(15_000, "hello", |params| {
            params.insert("token".to_string(), serde_json::Value::String(token));
        }) {
            Ok(_) => {
                self.grants_path = grants_path;
                self.state = PluginHostState::Running;
                self.message = format!("running (pid {pid})");
                // 重启/冷启动后恢复持久化授权（sidecar 内存态不跨生命周期）
                self.resync_grants();
                Ok(())
            }
            Err(e) => {
                let msg = format!("握手失败: {e}");
                push_log(&self.logs, msg.clone());
                let _ = self.stop();
                self.state = PluginHostState::Error;
                self.message = msg.clone();
                Err(msg)
            }
        }
    }

    pub fn stop(&mut self) -> Result<(), String> {
        // 先关 stdin 触发优雅路径，随后强杀进程树并回收线程与僵尸状态
        if let Some(mut stdin) = self.stdin.take() {
            let _ = writeln!(
                stdin,
                "{}",
                serde_json::json!({"id": 0, "method": "shutdown", "params": {}})
            );
            let _ = stdin.flush();
        }
        if let Some(pid) = self.pid {
            kill_tree(pid);
        }
        if let Some(handle) = self.stdout_handle.take() {
            let _ = handle.join();
        }
        if let Some(handle) = self.stderr_handle.take() {
            let _ = handle.join();
        }
        if let Some(mut child) = self.child.take() {
            let _ = child.wait();
        }
        self.rx = None;
        self.pending.clear();
        self.pid = None;
        self.started_at = None;
        push_log(&self.logs, "stopped".to_string());
        if self.state != PluginHostState::Error {
            self.state = PluginHostState::Stopped;
            self.message = "stopped".to_string();
        }
        Ok(())
    }

    /// 发送请求并等待匹配 id 的响应。调用方需持有 manager 锁（串行请求）；
    /// 非匹配帧进 pending 队列保序，未来异步通知复用同一通道。
    fn request_inner(
        &mut self,
        timeout_ms: u64,
        method: &str,
        patch_params: impl FnOnce(&mut serde_json::Map<String, serde_json::Value>),
    ) -> Result<serde_json::Value, String> {
        if self.child.is_none() || self.stdin.is_none() {
            return Err("plugin-host 未运行".to_string());
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let mut params = serde_json::Map::new();
        patch_params(&mut params);
        let frame = serde_json::json!({ "id": id, "method": method, "params": params });
        {
            let stdin = self.stdin.as_mut().unwrap();
            writeln!(stdin, "{frame}").map_err(|e| format!("写入请求失败: {e}"))?;
            stdin.flush().map_err(|e| format!("flush 失败: {e}"))?;
        }

        // 先扫已缓冲的乱序帧
        if let Some(pos) = self.pending.iter().position(|v| v.get("id").and_then(|v| v.as_u64()) == Some(id)) {
            let value = self.pending.remove(pos).unwrap();
            return finish_response(method, value);
        }

        let rx = self.rx.as_ref().ok_or("plugin-host 未运行")?;
        let deadline = Instant::now() + Duration::from_millis(timeout_ms);
        loop {
            let remain = deadline.saturating_duration_since(Instant::now());
            if remain.is_zero() {
                return Err(format!("等待 {method} 响应超时 ({timeout_ms}ms)"));
            }
            match rx.recv_timeout(Duration::from_millis(200).min(remain)) {
                Ok(value) => {
                    if value.get("id").and_then(|v| v.as_u64()) == Some(id) {
                        return finish_response(method, value);
                    }
                    self.pending.push_back(value);
                }
                Err(RecvTimeoutError::Timeout) => continue,
                Err(RecvTimeoutError::Disconnected) => {
                    return Err("plugin-host 已退出（stdout 关闭）".to_string())
                }
            }
        }
    }

    /// 准入校验。授权状态由 grants.set（持久化于 Rust 侧）决定，默认全部拒绝。
    pub fn admit(&mut self, manifest_json: &str) -> Result<serde_json::Value, String> {
        if self.state != PluginHostState::Running {
            return Err("plugin-host 未运行".to_string());
        }
        let manifest_json = manifest_json.to_string();
        self.request_inner(10_000, "admit", move |params| {
            params.insert("manifestJson".to_string(), serde_json::Value::String(manifest_json));
        })
    }

    /// 授权（宿主操作者决策）：更新 sidecar 内存态并持久化到 grants 文件。
    pub fn grant_set(&mut self, plugin_id: &str, permissions: &[String]) -> Result<(), String> {
        if self.state != PluginHostState::Running {
            return Err("plugin-host 未运行".to_string());
        }
        let pid = plugin_id.to_string();
        self.request_inner(5_000, "grants.set", move |params| {
            params.insert("pluginId".to_string(), serde_json::Value::String(pid));
            params.insert(
                "permissions".to_string(),
                serde_json::Value::Array(
                    permissions.iter().map(|p| serde_json::Value::String(p.clone())).collect(),
                ),
            );
        })?;
        self.persist_grant(plugin_id, permissions.to_vec());
        Ok(())
    }

    /// 激活（真实 import 插件 entry 并执行 activate(ctx)）。
    pub fn activate(
        &mut self,
        plugin_id: &str,
        plugin_root: &std::path::Path,
    ) -> Result<serde_json::Value, String> {
        if self.state != PluginHostState::Running {
            return Err("plugin-host 未运行".to_string());
        }
        let plugin_id = plugin_id.to_string();
        let root = plugin_root.to_string_lossy().to_string();
        self.request_inner(15_000, "activate", move |params| {
            params.insert("pluginId".to_string(), serde_json::Value::String(plugin_id.clone()));
            params.insert("pluginRoot".to_string(), serde_json::Value::String(root.clone()));
        })
    }

    /// 执行已激活插件命令（handler 异常被 sidecar 捕获为 error 结果）。
    pub fn execute(
        &mut self,
        plugin_id: &str,
        command_id: &str,
        raw_input: &str,
    ) -> Result<serde_json::Value, String> {
        if self.state != PluginHostState::Running {
            return Err("plugin-host 未运行".to_string());
        }
        let plugin_id = plugin_id.to_string();
        let command_id = command_id.to_string();
        let raw_input = raw_input.to_string();
        self.request_inner(15_000, "execute", move |params| {
            params.insert("pluginId".to_string(), serde_json::Value::String(plugin_id.clone()));
            params.insert("commandId".to_string(), serde_json::Value::String(command_id.clone()));
            params.insert("rawInput".to_string(), serde_json::Value::String(raw_input.clone()));
        })
    }

    /// 停用（撤销命令注册等效果，保留准入与授权与 storage）。
    pub fn deactivate(&mut self, plugin_id: &str) -> Result<serde_json::Value, String> {
        if self.state != PluginHostState::Running {
            return Err("plugin-host 未运行".to_string());
        }
        let plugin_id = plugin_id.to_string();
        self.request_inner(10_000, "deactivate", move |params| {
            params.insert("pluginId".to_string(), serde_json::Value::String(plugin_id.clone()));
        })
    }

    /// 卸载：停用 + 撤销准入/授权；purge=true 额外删除 namespaced storage。
    pub fn uninstall(
        &mut self,
        plugin_id: &str,
        purge: bool,
    ) -> Result<serde_json::Value, String> {
        if self.state != PluginHostState::Running {
            return Err("plugin-host 未运行".to_string());
        }
        let pid = plugin_id.to_string();
        self.request_inner(10_000, "uninstall", move |params| {
            params.insert("pluginId".to_string(), serde_json::Value::String(pid.clone()));
            params.insert("purge".to_string(), serde_json::Value::Bool(purge));
        })?;
        self.remove_persisted_grant(plugin_id);
        Ok(serde_json::json!({ "uninstalled": true }))
    }

    /// 命令目录（含激活/未激活状态）。
    pub fn commands_list(&mut self) -> Result<serde_json::Value, String> {
        if self.state != PluginHostState::Running {
            return Err("plugin-host 未运行".to_string());
        }
        self.request_inner(5_000, "commands.list", |_| {})
    }

    /// 意外退出检测 + 自动重启（单次应用生命周期内最多 2 次）。
    /// 返回 Ok 表示 sidecar 可用（可能刚重启，需重新准入）；Err 说明不可用。
    pub(crate) fn ensure_alive(&mut self, app: &AppHandle) -> Result<(), String> {
        let exited = match self.child.as_mut() {
            None => return Err("plugin-host 未运行".to_string()),
            Some(child) => match child.try_wait() {
                Ok(None) => return Ok(()),
                Ok(Some(status)) => Some(status),
                Err(e) => return Err(format!("进程状态检查失败: {e}")),
            },
        };
        push_log(&self.logs, format!("检测到 sidecar 意外退出: {exited:?}"));
        let was_running = self.state == PluginHostState::Running;
        let _ = self.stop();
        self.restart_count += 1;
        if !was_running || self.restart_count > 2 {
            self.state = PluginHostState::Error;
            self.message = format!("sidecar 意外退出且已达重启上限（{} 次）", self.restart_count - 1);
            return Err(self.message.clone());
        }
        push_log(&self.logs, format!("自动重启（第 {} 次）", self.restart_count));
        self.start(app).map_err(|e| {
            self.state = PluginHostState::Error;
            self.message = format!("自动重启失败: {e}");
            e
        })?;
        push_log(&self.logs, "自动重启成功；已恢复持久化授权，插件需重新准入+激活".to_string());
        Ok(())
    }

    fn resync_grants(&mut self) {
        let Some(path) = self.grants_path.clone() else { return };
        for (plugin_id, permissions) in load_grants(&path) {
            let pid = plugin_id.clone();
            let result = self.request_inner(3_000, "grants.set", move |params| {
                params.insert("pluginId".to_string(), serde_json::Value::String(pid));
                params.insert(
                    "permissions".to_string(),
                    serde_json::Value::Array(
                        permissions.iter().map(|p| serde_json::Value::String(p.clone())).collect(),
                    ),
                );
            });
            if let Err(e) = result {
                push_log(&self.logs, format!("grants 同步失败 ({plugin_id}): {e}"));
            }
        }
    }

    fn persist_grant(&self, plugin_id: &str, permissions: Vec<String>) {
        let Some(path) = &self.grants_path else { return };
        let mut all = load_grants(path);
        all.insert(plugin_id.to_string(), permissions);
        save_grants(path, &all);
    }

    fn remove_persisted_grant(&self, plugin_id: &str) {
        let Some(path) = &self.grants_path else { return };
        let mut all = load_grants(path);
        if all.remove(plugin_id).is_some() {
            save_grants(path, &all);
        }
    }

    /// 读取当前持久化授权快照（供 UI 展示）。
    pub fn grants_snapshot(&self) -> serde_json::Value {
        match &self.grants_path {
            Some(path) => serde_json::to_value(load_grants(path)).unwrap_or(serde_json::json!({})),
            None => serde_json::json!({}),
        }
    }
}

fn finish_response(method: &str, value: serde_json::Value) -> Result<serde_json::Value, String> {
    if value.get("ok").and_then(|v| v.as_bool()) == Some(true) {
        Ok(value.get("result").cloned().unwrap_or(serde_json::Value::Null))
    } else {
        Err(format!(
            "{method} 失败: {}",
            value.get("error").map(|e| e.to_string()).unwrap_or_else(|| "unknown".to_string())
        ))
    }
}

fn push_log(logs: &Arc<Mutex<VecDeque<String>>>, message: String) {
    let stamped = format!("[{}] [plugin-host] {}", crate::dsh::manager::log_stamp(), message);
    let mut buf = lock(logs.lock());
    if buf.len() > 500 {
        buf.pop_front();
    }
    buf.push_back(stamped);
}

fn unique_nanos() -> u128 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0)
}

type GrantMap = std::collections::HashMap<String, Vec<String>>;

fn load_grants(path: &std::path::Path) -> GrantMap {
    match std::fs::read_to_string(path) {
        Ok(text) => serde_json::from_str(&text).unwrap_or_default(),
        Err(_) => GrantMap::new(),
    }
}

fn save_grants(path: &std::path::Path, grants: &GrantMap) {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(text) = serde_json::to_string_pretty(grants) {
        let tmp = path.with_extension(format!("json.tmp-{}", std::process::id()));
        if std::fs::write(&tmp, text).is_ok() {
            let _ = std::fs::rename(&tmp, path);
        }
    }
}

/// 解析示例插件目录（实验区默认值）：plugin-host/examples/echo-plugin。
pub fn resolve_example_plugin_root(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let entry = PluginHostManager::resolve_entry(app)?;
    let candidate = entry.join("examples").join("echo-plugin");
    if candidate.join("dsh-plugin.json").is_file() {
        return Ok(candidate);
    }
    Err("找不到示例插件目录（plugin-host/examples/echo-plugin）".to_string())
}

impl Drop for PluginHostManager {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_starts_stopped_and_stop_is_idempotent() {
        let mut mgr = PluginHostManager::new();
        assert_eq!(mgr.status_view().state, PluginHostState::Stopped);
        mgr.stop().unwrap();
        mgr.stop().unwrap();
        assert_eq!(mgr.status_view().state, PluginHostState::Stopped);
    }

    #[test]
    fn request_without_child_fails_fast() {
        let mut mgr = PluginHostManager::new();
        assert!(mgr.commands_list().is_err());
        assert_eq!(mgr.next_id.load(Ordering::Relaxed), 1);
    }
}
