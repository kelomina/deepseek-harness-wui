use crate::dsh::config::{DshConfig, ExecMode};
use serde::Serialize;
use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, LockResult, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

pub fn lock<T>(r: LockResult<T>) -> T {
    r.unwrap_or_else(|e| e.into_inner())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DshState {
    Stopped,
    Starting,
    Running,
    Error,
}

#[derive(Debug, Clone, Serialize)]
pub struct DshStatusView {
    pub state: DshState,
    pub pid: Option<u32>,
    pub port: u16,
    pub proxy_port: u16,
    pub message: String,
    pub uptime_secs: Option<u64>,
    pub auto_start: bool,
    pub proxy_used: Option<String>,
}

pub struct DshManager {
    config: DshConfig,
    child: Option<Child>,
    pid: Option<u32>,
    started_at: Option<Instant>,
    state: DshState,
    message: String,
    logs: VecDeque<String>,
    restart_attempts: Vec<Instant>,
    health_failures: u32,
    proxy_port: u16,
    proxy_used: Option<String>,
}

impl DshManager {
    pub fn new(config: DshConfig, proxy_port: u16) -> Self {
        Self {
            config,
            child: None,
            pid: None,
            started_at: None,
            state: DshState::Stopped,
            message: "stopped".to_string(),
            logs: VecDeque::new(),
            restart_attempts: Vec::new(),
            health_failures: 0,
            proxy_port,
            proxy_used: None,
        }
    }

    pub fn config(&self) -> &DshConfig {
        &self.config
    }

    pub fn config_mut(&mut self) -> &mut DshConfig {
        &mut self.config
    }

    pub fn status_view(&self) -> DshStatusView {
        DshStatusView {
            state: self.state,
            pid: self.pid,
            port: self.config.port,
            proxy_port: self.proxy_port,
            message: self.message.clone(),
            uptime_secs: self.started_at.map(|t| t.elapsed().as_secs()),
            auto_start: self.config.auto_start,
            proxy_used: self.proxy_used.clone(),
        }
    }

    pub fn logs(&self, limit: usize) -> Vec<String> {
        self.logs.iter().rev().take(limit).cloned().collect::<Vec<_>>().into_iter().rev().collect()
    }

    pub fn set_proxy_port(&mut self, port: u16) {
        self.proxy_port = port;
    }

    pub fn replace_config(&mut self, cfg: DshConfig) {
        self.config = cfg;
    }

    pub fn set_config(&mut self, app: &AppHandle, cfg: DshConfig) -> Result<(), String> {
        cfg.validate()?;
        if self.child.is_some() {
            return Err("stop dsh before changing configuration".to_string());
        }
        crate::dsh::config::save(app, &cfg)?;
        self.config = cfg;
        self.emit(app);
        Ok(())
    }

    pub fn start(&mut self, shared: Arc<Mutex<DshManager>>, app: &AppHandle) -> Result<(), String> {
        if self.child.is_some() {
            return Ok(());
        }
        if port_in_use(self.config.port) {
            let stale = find_dsh_pids(self.config.port);
            if !stale.is_empty() {
                for pid in &stale {
                    kill_tree(*pid);
                }
                self.push_log(
                    format!("[dsh] 端口 {} 被残留 dsh 进程占用，已自动清理: {:?}", self.config.port, stale),
                    app,
                );
                for _ in 0..15 {
                    if !port_in_use(self.config.port) {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(200));
                }
            }
            if port_in_use(self.config.port) {
                return Err(format!(
                    "dsh 端口 {} 已被其他进程占用（非 dsh，无法自动清理）；请释放该端口或在设置中更换端口",
                    self.config.port
                ));
            }
        }
        let (program, args) = self.build_command()?;
        let mut cmd = Command::new(&program);
        cmd.args(&args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        if let Some(home) = &self.config.dsh_home {
            cmd.env("DSH_HOME", home);
        }
        if self.config.proxy_enabled {
            let proxy = self
                .config
                .proxy_url
                .clone()
                .or_else(crate::dsh::config::detect_system_proxy);
            if let Some(p) = proxy {
                cmd.env("NODE_USE_ENV_PROXY", "1");
                cmd.env("HTTP_PROXY", &p);
                cmd.env("HTTPS_PROXY", &p);
                cmd.env("NO_PROXY", "localhost,127.0.0.1,::1");
                self.proxy_used = Some(p);
            } else {
                self.proxy_used = None;
            }
        }
        let cwd = self
            .config
            .workspace_dir
            .clone()
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| dirs::home_dir().unwrap_or_else(|| std::env::current_dir().unwrap_or_default()));
        cmd.current_dir(cwd);
        let mut child = cmd.spawn().map_err(|e| format!("spawn failed ({program}): {e}"))?;
        let pid = child.id();
        let stdout = child.stdout.take().ok_or("stdout pipe missing")?;
        let stderr = child.stderr.take().ok_or("stderr pipe missing")?;
        self.child = Some(child);
        self.pid = Some(pid);
        self.state = DshState::Starting;
        self.message = format!("starting (pid {pid})");
        self.started_at = Some(Instant::now());
        self.health_failures = 0;
        self.emit(app);
        spawn_log_reader(stdout, "out", shared.clone(), app.clone());
        spawn_log_reader(stderr, "err", shared.clone(), app.clone());
        spawn_exit_watcher(shared, app.clone(), pid);
        Ok(())
    }

    pub fn stop(&mut self) -> Result<(), String> {
        if let Some(pid) = self.pid {
            kill_tree(pid);
        }
        self.child = None;
        self.pid = None;
        self.started_at = None;
        self.state = DshState::Stopped;
        self.message = "stopped".to_string();
        self.health_failures = 0;
        Ok(())
    }

    fn build_command(&self) -> Result<(String, Vec<String>), String> {
        let port = self.config.port.to_string();
        match self.config.exec_mode {
            ExecMode::Bundled => {
                let bin = bundled_bin_path()?;
                Ok(("node".to_string(), vec![bin, "web".to_string(), "--port".to_string(), port]))
            }
            ExecMode::Npx => {
                let npx = resolve_npx_cli()?;
                Ok((
                    "node".to_string(),
                    vec![
                        npx,
                        "-y".to_string(),
                        "@deepseek-ai/dsh@0.1.0-rc.6".to_string(),
                        "web".to_string(),
                        "--port".to_string(),
                        port,
                    ],
                ))
            }
            ExecMode::Path => {
                let p = self.config.exec_path.clone().ok_or("exec_path is not set")?;
                if p.to_ascii_lowercase().ends_with(".cmd") || p.to_ascii_lowercase().ends_with(".bat") {
                    Ok(("cmd".to_string(), vec!["/C".to_string(), p, "web".to_string(), "--port".to_string(), port]))
                } else {
                    Ok((p, vec!["web".to_string(), "--port".to_string(), port]))
                }
            }
        }
    }

    fn should_restart(&mut self) -> bool {
        if !self.config.auto_start {
            return false;
        }
        let now = Instant::now();
        let window = Duration::from_secs(self.config.restart_window_secs);
        self.restart_attempts.retain(|t| now.duration_since(*t) < window);
        (self.restart_attempts.len() as u32) < self.config.max_restarts
    }

    fn note_restart(&mut self) {
        self.restart_attempts.push(Instant::now());
    }

    fn push_log(&mut self, line: String, app: &AppHandle) {
        while self.logs.len() >= self.config.log_max_lines {
            self.logs.pop_front();
        }
        self.logs.push_back(line.clone());
        let _ = app.emit("dsh://log", line);
    }

    fn emit(&self, app: &AppHandle) {
        let _ = app.emit("dsh://status", self.status_view());
    }
}

fn spawn_log_reader<R: Read + Send + 'static>(reader: R, tag: &'static str, shared: Arc<Mutex<DshManager>>, app: AppHandle) {
    thread::spawn(move || {
        let br = BufReader::new(reader);
        for line in br.lines() {
            let Ok(line) = line else { break };
            let mut mgr = lock(shared.lock());
            mgr.push_log(format!("[{tag}] {line}"), &app);
        }
    });
}

pub fn spawn_health_watcher(shared: Arc<Mutex<DshManager>>, app: AppHandle) {
    thread::spawn(move || loop {
        let (interval, port) = {
            let mgr = lock(shared.lock());
            (mgr.config.health_interval_secs, mgr.config.port)
        };
        thread::sleep(Duration::from_secs(interval));
        let ok = check_health(port);
        let mut mgr = lock(shared.lock());
        if mgr.child.is_none() {
            continue;
        }
        let mut restart = false;
        match (ok, mgr.state) {
            (true, DshState::Starting) => {
                mgr.state = DshState::Running;
                mgr.message = "running".to_string();
                mgr.health_failures = 0;
                mgr.emit(&app);
            }
            (true, _) => {
                mgr.health_failures = 0;
            }
            (false, DshState::Running) => {
                mgr.health_failures += 1;
                if mgr.health_failures >= 3 {
                    mgr.state = DshState::Error;
                    mgr.message = "health check failed".to_string();
                    restart = mgr.should_restart();
                    if restart {
                        mgr.note_restart();
                        mgr.message = format!("restarting (attempt {})", mgr.restart_attempts.len());
                    }
                    mgr.emit(&app);
                }
            }
            (false, DshState::Starting) => {
                if let Some(t) = mgr.started_at {
                    if t.elapsed() > Duration::from_secs(mgr.config.startup_timeout_secs) {
                        mgr.state = DshState::Error;
                        mgr.message = "startup timeout".to_string();
                        restart = mgr.should_restart();
                        if restart {
                            mgr.note_restart();
                            mgr.message = format!("restarting (attempt {})", mgr.restart_attempts.len());
                        }
                        mgr.emit(&app);
                    }
                }
            }
            _ => {}
        }
        let pid = mgr.pid;
        drop(mgr);
        if pid.is_some() && restart {
            if let Some(p) = pid {
                kill_tree(p);
            }
            thread::sleep(Duration::from_secs(2));
            let mut mgr = lock(shared.lock());
            let _ = mgr.start(shared.clone(), &app);
        }
    });
}

fn spawn_exit_watcher(shared: Arc<Mutex<DshManager>>, app: AppHandle, watch_pid: u32) {
    thread::spawn(move || loop {
        thread::sleep(Duration::from_secs(1));
        let mut mgr = lock(shared.lock());
        if mgr.pid != Some(watch_pid) {
            break;
        }
        let exited = mgr.child.as_mut().and_then(|c| c.try_wait().ok()).flatten();
        if let Some(status) = exited {
            let was_expected = mgr.state == DshState::Stopped;
            mgr.child = None;
            mgr.pid = None;
            mgr.started_at = None;
            mgr.health_failures = 0;
            let mut restart = false;
            if was_expected {
                mgr.state = DshState::Stopped;
                mgr.message = "stopped".to_string();
            } else {
                mgr.state = DshState::Error;
                mgr.message = format!("dsh process exited: {status}");
                restart = mgr.should_restart();
                if restart {
                    mgr.note_restart();
                    mgr.message = format!("restarting (attempt {})", mgr.restart_attempts.len());
                }
            }
            mgr.emit(&app);
            drop(mgr);
            if restart {
                thread::sleep(Duration::from_secs(2));
                let mut mgr = lock(shared.lock());
                let _ = mgr.start(shared.clone(), &app);
            }
            break;
        }
    });
}

fn check_health(port: u16) -> bool {
    if port == 0 {
        return false;
    }
    let mut sock = match TcpStream::connect(("127.0.0.1", port)) {
        Ok(s) => s,
        Err(_) => return false,
    };
    let _ = sock.set_read_timeout(Some(Duration::from_secs(3)));
    let req = format!("GET / HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    if sock.write_all(req.as_bytes()).is_err() {
        return false;
    }
    let mut buf = [0u8; 64];
    let n = match sock.read(&mut buf) {
        Ok(n) => n,
        Err(_) => return false,
    };
    String::from_utf8_lossy(&buf[..n]).starts_with("HTTP/1.")
}

fn kill_tree(pid: u32) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(0x0800_0000)
            .output();
    }
    #[cfg(not(windows))]
    {
        let _ = Command::new("kill").args(["-9", &pid.to_string()]).output();
    }
}

pub(crate) fn bundled_bin_path() -> Result<String, String> {
    let rel = "runtime/node_modules/@deepseek-ai/dsh/lib/bin.js";
    let mut candidates: Vec<std::path::PathBuf> = Vec::new();
    if let Ok(env_dir) = std::env::var("DSH_WUI_RUNTIME_DIR") {
        candidates.push(std::path::PathBuf::from(env_dir).join(rel));
    }
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join(rel));
        candidates.push(cwd.join("..").join(rel));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("..").join("..").join("..").join(rel));
            candidates.push(dir.join("..").join("..").join(rel));
            candidates.push(dir.join("..").join(rel));
            candidates.push(dir.join(rel));
        }
    }
    for c in candidates {
        if c.exists() {
            return Ok(c.to_string_lossy().to_string());
        }
    }
    Err(format!(
        "bundled dsh runtime not found (looked for {}); run `npm install` in runtime/ or switch exec mode to npx/path",
        rel
    ))
}

fn resolve_npx_cli() -> Result<String, String> {
    let probe = "console.log(require('path').join(require('path').dirname(process.execPath),'node_modules','npm','bin','npx-cli.js'))";
    if let Ok(out) = Command::new("node").args(["-e", probe]).output() {
        if out.status.success() {
            let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !s.is_empty() && std::path::Path::new(&s).exists() {
                return Ok(s);
            }
        }
    }
    let fallback = r"C:\Program Files\nodejs\node_modules\npm\bin\npx-cli.js";
    if std::path::Path::new(fallback).exists() {
        return Ok(fallback.to_string());
    }
    Err("npx-cli.js not found (Node.js is required for npx mode)".to_string())
}
fn port_in_use(port: u16) -> bool {
    if port == 0 {
        return false;
    }
    std::net::TcpStream::connect(("127.0.0.1", port)).is_ok()
}

/// Find stale dsh node processes (bundled bin.js web --port N or @deepseek-ai/dsh).
/// Uses PowerShell Get-CimInstance because `wmic` is removed on modern Windows.
fn find_dsh_pids(port: u16) -> Vec<u32> {
    let mut out = Vec::new();
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let script = r#"Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ForEach-Object { $_.ProcessId.ToString() + '|' + $_.CommandLine }"#;
        let Ok(output) = Command::new("powershell")
            .args(["-NoProfile", "-Command", script])
            .creation_flags(0x0800_0000)
            .output()
        else {
            return out;
        };
        let text = String::from_utf8_lossy(&output.stdout);
        for raw in text.lines() {
            let line = raw.trim();
            if line.is_empty() {
                continue;
            }
            if let Some((pid_s, cmd)) = line.split_once('|') {
                if let Ok(pid) = pid_s.trim().parse::<u32>() {
                    if is_dsh_cmdline(cmd, port) {
                        out.push(pid);
                    }
                }
            }
        }
    }
    out
}

fn is_dsh_cmdline(cmd: &str, port: u16) -> bool {
    (cmd.contains("bin.js") && cmd.contains("web") && cmd.contains(&format!("--port {port}")))
        || cmd.contains("@deepseek-ai/dsh")
}




