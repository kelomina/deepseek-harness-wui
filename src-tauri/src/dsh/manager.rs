use crate::dsh::config::{DshConfig, ExecMode};
use crate::dsh::event::{EventSink, TauriSink};
use serde::Serialize;
use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, LockResult, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Runtime};

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
    managed_runtime_root: std::path::PathBuf,
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
            managed_runtime_root: std::path::PathBuf::new(),
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

    /// 设置受管运行时根目录（app_config_dir/runtimes），用于 Bundled 模式解析受管版本。
    pub fn set_managed_runtime_root(&mut self, root: std::path::PathBuf) {
        self.managed_runtime_root = root;
    }

    pub fn replace_config(&mut self, cfg: DshConfig) {
        self.config = cfg;
    }

    pub fn set_config<R: Runtime>(&mut self, app: &AppHandle<R>, cfg: DshConfig) -> Result<(), String> {
        cfg.validate()?;
        if self.child.is_some() {
            return Err("stop dsh before changing configuration".to_string());
        }
        crate::dsh::config::save(app, &cfg)?;
        self.config = cfg;
        let sink = TauriSink::new(app.clone());
        self.emit(&sink);
        Ok(())
    }

    pub fn start<S: EventSink>(&mut self, shared: Arc<Mutex<DshManager>>, sink: S) -> Result<(), String> {
        if self.child.is_some() {
            return Ok(());
        }
        if self.config.exec_mode == ExecMode::Wsl && !cfg!(windows) {
            return Err("WSL 执行模式仅支持 Windows；macOS/Linux 请使用 bundled/npx/path 模式".to_string());
        }
        if port_in_use(self.config.port) {
            let stale = find_dsh_pids(self.config.port);
            if !stale.is_empty() {
                for pid in &stale {
                    kill_tree(*pid);
                }
                self.push_log(
                    format!("[dsh] 端口 {} 被残留 dsh 进程占用，已自动清理: {:?}", self.config.port, stale),
                    &sink,
                );
                for _ in 0..15 {
                    if !port_in_use(self.config.port) {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(200));
                }
            }
            // WSL 模式：dsh 跑在 WSL 内，宿主 node.exe 探测不到；单独清理 WSL 内残留 dsh。
            if self.config.exec_mode == ExecMode::Wsl && port_in_use(self.config.port) {
                if let Some(distro) = self.config.wsl_default_distro.clone() {
                    let user = wsl_launch_user(self.config.wsl_dsh_home.as_deref(), &distro);
                    match wsl_kill_stale_dsh(&distro, &user, self.config.port) {
                        Ok(killed) if !killed.is_empty() => {
                            self.push_log(
                                format!("[dsh] 已清理 WSL 内残留 dsh 进程: {killed:?}"),
                                &sink,
                            );
                            for _ in 0..15 {
                                if !port_in_use(self.config.port) {
                                    break;
                                }
                                std::thread::sleep(Duration::from_millis(200));
                            }
                        }
                        Ok(_) => {}
                        Err(e) => self.push_log(format!("[dsh] WSL 残留清理失败: {e}"), &sink),
                    }
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
        self.emit(&sink);
        spawn_log_reader(stdout, "out", shared.clone(), sink.clone());
        spawn_log_reader(stderr, "err", shared.clone(), sink.clone());
        spawn_exit_watcher(shared, sink.clone(), pid);
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

    /// Bundled 模式：若配置了受管运行时版本，则解析到 app_config_dir/runtimes/<v>/...；
    /// 否则退回仓库 runtime/（bundled_bin_path）。
    fn managed_runtime_bin_path(&self) -> Result<String, String> {
        if let Some(version) = &self.config.managed_runtime_version {
            if !self.managed_runtime_root.as_os_str().is_empty() {
                let bin = self
                    .managed_runtime_root
                    .join(version)
                    .join("node_modules/@deepseek-ai/dsh/lib/bin.js");
                if bin.exists() {
                    return Ok(bin.to_string_lossy().to_string());
                }
                return Err(format!(
                    "受管运行时 {version} 缺失 lib/bin.js；请到设置页「DSH 运行时」复验或回滚"
                ));
            }
        }
        bundled_bin_path()
    }

    fn build_command(&self) -> Result<(String, Vec<String>), String> {
        let port = self.config.port.to_string();
        // node 用绝对路径解析：安装器/首启装完 Node 后当前进程 PATH 不刷新，find_node 会兜底已知默认位置
        let node = crate::dsh::prereq::find_node()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|| "node".to_string());
        match self.config.exec_mode {
            ExecMode::Bundled => {
                let bin = self.managed_runtime_bin_path()?;
                Ok((node, vec![bin, "web".to_string(), "--port".to_string(), port]))
            }
            ExecMode::Npx => {
                let npx = resolve_npx_cli()?;
                Ok((
                    node,
                    vec![
                        npx,
                        "-y".to_string(),
                        "@deepseek-ai/dsh@0.1.1-rc.2".to_string(),
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
            ExecMode::Wsl => {
                let distro =
                    self.config.wsl_default_distro.clone().ok_or("wsl_default_distro is not set")?;
                let user = wsl_launch_user(self.config.wsl_dsh_home.as_deref(), &distro);
                // 前台运行（exec）保持 wsl.exe 会话活跃，避免 dsh 子进程被 WSL 会话清理。
                // node 由 wsl.rs 一键创建安装在 ~/.dsh-node/<version>/bin；DSH_HOME 由脚本覆盖。
                //
                // 脚本经 base64 传入并在 WSL 内解码，规避 wsl.exe 参数转发对多行脚本
                // 引号/换行/`$()` 的破坏（否则首行变 `""`、NODE_BIN 为空、dsh 以 exit 1 退出）。
                let script = format!(
                    r#"exec 2>&1
NODE_BIN=$(ls -d "$HOME"/.dsh-node/*/bin/node 2>/dev/null | head -n1)
if [ -z "$NODE_BIN" ]; then
  echo "error: dsh node runtime not found under ~/.dsh-node; run WSL 一键创建 first" >&2
  exit 1
fi
export PATH="$(dirname "$NODE_BIN"):$PATH"
export DSH_HOME="$HOME/.dsh"
if [ -f "$HOME/.dsh-node/host-ca.crt" ]; then
  export CURL_CA_BUNDLE="$HOME/.dsh-node/host-ca.crt"
  export NODE_EXTRA_CA_CERTS="$HOME/.dsh-node/host-ca.crt"
fi
echo "dsh in WSL: distro={distro} user=$USER node=$("$NODE_BIN" -v)"
exec dsh --profile web --port {port}"#,
                    distro = distro,
                    port = port,
                );
                use base64::Engine as _;
                let b64 = base64::engine::general_purpose::STANDARD.encode(script);
                Ok((
                    "wsl.exe".to_string(),
                    vec![
                        "-d".to_string(),
                        distro,
                        "-u".to_string(),
                        user,
                        "--".to_string(),
                        "bash".to_string(),
                        "-c".to_string(),
                        format!("echo {b64} | base64 -d | bash"),
                    ],
                ))
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

    fn push_log<S: EventSink>(&mut self, line: String, sink: &S) {
        while self.logs.len() >= self.config.log_max_lines {
            self.logs.pop_front();
        }
        self.logs.push_back(line.clone());
        sink.emit("dsh://log", &line);
    }

    fn emit<S: EventSink>(&self, sink: &S) {
        sink.emit("dsh://status", &self.status_view());
    }
}

fn spawn_log_reader<T: Read + Send + 'static, S: EventSink>(
    reader: T,
    tag: &'static str,
    shared: Arc<Mutex<DshManager>>,
    sink: S,
) {
    thread::spawn(move || {
        let br = BufReader::new(reader);
        for line in br.lines() {
            let Ok(line) = line else { break };
            let mut mgr = lock(shared.lock());
            mgr.push_log(format!("[{tag}] {line}"), &sink);
        }
    });
}

pub fn spawn_health_watcher<S: EventSink>(shared: Arc<Mutex<DshManager>>, sink: S) {
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
                mgr.emit(&sink);
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
                    mgr.emit(&sink);
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
                        mgr.emit(&sink);
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
            let _ = mgr.start(shared.clone(), sink.clone());
        }
    });
}

fn spawn_exit_watcher<S: EventSink>(shared: Arc<Mutex<DshManager>>, sink: S, watch_pid: u32) {
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
            mgr.emit(&sink);
            drop(mgr);
            if restart {
                thread::sleep(Duration::from_secs(2));
                let mut mgr = lock(shared.lock());
                let _ = mgr.start(shared.clone(), sink.clone());
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

/// 从 `\\wsl$\<distro>\...` 的 DSH_HOME UNC 路径推导 WSL 启动用户。
/// - `\\wsl$\<distro>\root\...` → root
/// - `\\wsl$\<distro>\home\<user>\...` → user
/// - 解析失败或未配置 → 默认 root
fn wsl_launch_user(dsh_home_unc: Option<&str>, distro: &str) -> String {
    let Some(unc) = dsh_home_unc else {
        return "root".to_string();
    };
    let prefix = format!(r"\\wsl$\{}\", distro.to_ascii_lowercase());
    let lower = unc.to_ascii_lowercase();
    let Some(rest) = lower.strip_prefix(&prefix) else {
        return "root".to_string();
    };
    let mut parts = rest.split(['\\', '/']);
    match parts.next() {
        Some("root") => "root".to_string(),
        Some("home") => parts.next().filter(|u| !u.is_empty()).unwrap_or("root").to_string(),
        _ => "root".to_string(),
    }
}

/// 清理 WSL 内绑定指定端口的残留 dsh（node）进程，返回被终结的 WSL 内 PID 列表。
/// 依赖 `ss`（iproute2，Ubuntu 基础自带）；缺失时返回 Err（不静默跳过，便于日志提示手工清理）。
fn wsl_kill_stale_dsh(distro: &str, user: &str, port: u16) -> Result<Vec<u32>, String> {
    let script = format!(
        r#"exec 2>&1
if ! command -v ss >/dev/null 2>&1; then
  echo "SS_MISSING"
  exit 0
fi
PIDS=$(ss -ltnpH "sport = :{port}" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | sort -u)
[ -z "$PIDS" ] && exit 0
killtree() {{ local p=$1; for c in $(pgrep -P "$p" 2>/dev/null); do killtree "$c"; done; kill -9 "$p" 2>/dev/null; }}
for p in $PIDS; do killtree "$p"; done
echo "KILLED $PIDS"
"#,
        port = port
    );
    let out = Command::new("wsl.exe")
        .args(["-d", distro, "-u", user, "--", "bash", "-c", &script])
        .output()
        .map_err(|e| format!("wsl.exe 不可用: {e}"))?;
    let text = String::from_utf8_lossy(&out.stdout).to_string();
    if text.contains("SS_MISSING") {
        return Err(
            "WSL 内缺少 ss（iproute2），无法自动清理残留 dsh；请在发行版内手动停止 dsh 或重启发行版".to_string(),
        );
    }
    let mut pids = Vec::new();
    if let Some(line) = text.lines().find(|l| l.trim_start().starts_with("KILLED")) {
        for tok in line.split_whitespace().skip(1) {
            if let Ok(p) = tok.parse::<u32>() {
                pids.push(p);
            }
        }
    }
    Ok(pids)
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
    #[cfg(windows)]
    {
        let fallback = r"C:\Program Files\nodejs\node_modules\npm\bin\npx-cli.js";
        if std::path::Path::new(fallback).exists() {
            return Ok(fallback.to_string());
        }
    }
    #[cfg(not(windows))]
    {
        // macOS 常见安装位置：官方 pkg（/usr/local）与 Homebrew（/opt/homebrew，arm64）；Linux 官方源同 /usr/local
        for fallback in [
            "/usr/local/lib/node_modules/npm/bin/npx-cli.js",
            "/opt/homebrew/lib/node_modules/npm/bin/npx-cli.js",
        ] {
            if std::path::Path::new(fallback).exists() {
                return Ok(fallback.to_string());
            }
        }
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
/// Windows: PowerShell Get-CimInstance (wmic is removed on modern Windows).
/// macOS/Linux: `lsof` for the listening port, then verify the cmdline via `ps`.
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
    #[cfg(not(windows))]
    {
        // 先按端口找监听进程（macOS 自带 lsof；Linux 可能缺失 → 返回空，走端口占用报错路径）
        let Ok(output) = Command::new("lsof")
            .args(["-nP", &format!("-iTCP:{port}"), "-sTCP:LISTEN"])
            .output()
        else {
            return out;
        };
        let text = String::from_utf8_lossy(&output.stdout);
        let mut pids: Vec<u32> = Vec::new();
        for line in text.lines().skip(1) {
            // COMMAND PID USER ... （第 2 列为 PID）
            if let Some(tok) = line.split_whitespace().nth(1) {
                if let Ok(pid) = tok.parse::<u32>() {
                    if !pids.contains(&pid) {
                        pids.push(pid);
                    }
                }
            }
        }
        for pid in pids {
            // 核对命令行确属 dsh（bin.js web --port N / @deepseek-ai/dsh），避免误杀无关进程
            if let Ok(ps) = Command::new("ps").args(["-p", &pid.to_string(), "-o", "command="]).output() {
                let cmd = String::from_utf8_lossy(&ps.stdout).trim().to_string();
                if is_dsh_cmdline(&cmd, port) {
                    out.push(pid);
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wsl_launch_user_parses_root_and_home() {
        assert_eq!(wsl_launch_user(Some(r"\\wsl$\DshUbuntu\root\.dsh"), "DshUbuntu"), "root");
        assert_eq!(
            wsl_launch_user(Some(r"\\wsl$\DshUbuntu\home\alice\.dsh"), "DshUbuntu"),
            "alice"
        );
        // 发行版大小写不敏感
        assert_eq!(
            wsl_launch_user(Some(r"\\wsl$\DshUbuntu\home\alice\.dsh"), "dshubuntu"),
            "alice"
        );
    }

    #[test]
    fn wsl_launch_user_falls_back_to_root() {
        // 未配置 / 发行版不匹配 / 结构未知 → root
        assert_eq!(wsl_launch_user(None, "DshUbuntu"), "root");
        assert_eq!(
            wsl_launch_user(Some(r"\\wsl$\Other\root\.dsh"), "DshUbuntu"),
            "root"
        );
        assert_eq!(
            wsl_launch_user(Some(r"\\wsl$\DshUbuntu\weird"), "DshUbuntu"),
            "root"
        );
    }
}




