//! 端到端验证：宿主机应用内「创建 WSL → 连接 WSL → 用 dsh 启动 DSH」完整闭环。
//!
//! 运行方式（需在真实 Windows + WSL + 网络环境）：
//! ```text
//! cargo test --features e2e -- --ignored --nocapture wsl_provision_and_start_dsh_e2e
//! ```
//! 流程：用应用真实的 `wsl::provision` 一键创建全新发行版并安装 Node+v22.19.0 + dsh@0.1.1-rc.2，
//! 再用应用真实的 `DshManager::start`（WSL 执行模式）启动 dsh，验证宿主机经 WSL2 localhost 转发
//! 可达其 Web 服务，最后停止并检查端口释放。
//! 发行版默认保留以便复查；设 `DSH_E2E_CLEANUP=1` 自动 `wsl --unregister`。

use super::config::{DshConfig, ExecMode};
use super::event::CollectSink;
use super::manager::{lock, spawn_health_watcher, DshManager, DshState};
use super::wsl;
use std::time::{Duration, Instant};

fn http_ok(port: u16) -> bool {
    use std::io::{Read, Write};
    use std::net::TcpStream;
    let mut s = match TcpStream::connect(("127.0.0.1", port)) {
        Ok(s) => s,
        Err(_) => return false,
    };
    let _ = s.set_read_timeout(Some(Duration::from_secs(3)));
    let req = format!("GET / HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    if s.write_all(req.as_bytes()).is_err() {
        return false;
    }
    let mut buf = [0u8; 32];
    match s.read(&mut buf) {
        Ok(n) => String::from_utf8_lossy(&buf[..n]).starts_with("HTTP/1."),
        Err(_) => false,
    }
}

#[test]
#[ignore]
fn wsl_provision_and_start_dsh_e2e() {
    if !cfg!(windows) {
        eprintln!("[e2e] 非 Windows，跳过");
        return;
    }
    let sink = CollectSink::default();
    let port: u16 = 4199;
    let reuse = std::env::var("DSH_E2E_REUSE_DISTRO").ok().filter(|s| !s.is_empty());

    // 阶段 1：一键创建 WSL 并安装 DSH（应用真实 provision 代码）。
    // 设 DSH_E2E_REUSE_DISTRO=<name> 可复用已装好 Node+dsh 的发行版，跳过缓慢的
    // create/install，只重验「连接 WSL 用 dsh 启动 DSH」这一 start 路径。
    let (distro, wsl_dsh_home, wsl_workspace_dir) = if let Some(name) = &reuse {
        assert!(wsl::distro_exists(name).unwrap_or(false), "复用发行版 {name} 不存在");
        eprintln!("[e2e] 阶段1 复用已就绪发行版 {name}（跳过 create/install）");
        (
            name.clone(),
            Some(format!(r"\\wsl$\{name}\root\.dsh")),
            Some(format!(r"\\wsl$\{name}\root")),
        )
    } else {
        let distro = format!("DshE2E{}", std::process::id());
        eprintln!("[e2e] 阶段1 provision（创建发行版 {} + Node v22.19.0 + dsh 0.1.1-rc.2）…", distro);
        let report = wsl::provision(sink.clone(), None, Some(&distro), None);
        assert!(report.ok, "provision 失败: {:?}", report.error);
        eprintln!(
            "[e2e] provision ok: distro={:?} user={:?} node={:?} dsh={:?} dsh_home={:?}",
            report.distro, report.user, report.node_version, report.dsh_version, report.dsh_home
        );
        (
            report.distro.clone().unwrap(),
            report.dsh_home.clone(),
            report.workspace_dir.clone(),
        )
    };

    // 阶段 2：构造 WSL 执行模式配置（与设置页保存的字段一致）
    let mut cfg = DshConfig::default();
    cfg.exec_mode = ExecMode::Wsl;
    cfg.port = port;
    cfg.auto_start = false;
    cfg.wsl_default_distro = Some(distro.clone());
    cfg.wsl_dsh_home = wsl_dsh_home;
    cfg.wsl_workspace_dir = wsl_workspace_dir;
    cfg.health_interval_secs = 1;
    cfg.startup_timeout_secs = 240;

    let shared = std::sync::Arc::new(std::sync::Mutex::new(DshManager::new(cfg, 0)));
    spawn_health_watcher(shared.clone(), sink.clone());

    // 阶段 3：启动
    eprintln!("[e2e] 阶段3 start（WSL 模式，发行版 {}）…", distro);
    lock(shared.lock()).start(shared.clone(), sink.clone()).expect("start 失败");

    // 阶段 4：等待 Running + 宿主机 localhost 转发可达
    let deadline = Instant::now() + Duration::from_secs(300);
    let mut state = DshState::Stopped;
    let mut last_msg = String::new();
    while Instant::now() < deadline {
        let sv = lock(shared.lock()).status_view();
        state = sv.state;
        last_msg = sv.message.clone();
        if state == DshState::Running && http_ok(port) {
            break;
        }
        std::thread::sleep(Duration::from_millis(1000));
    }
    eprintln!("[e2e] 阶段4 最终 state={state:?} msg={last_msg:?} http_ok={}", http_ok(port));
    if state != DshState::Running {
        eprintln!("[e2e] 阶段4 未达 Running，dump 收集到的 dsh 日志：");
        let events = sink.events.lock().unwrap();
        for (ev, payload) in events.iter() {
            if ev == "dsh://log" {
                eprintln!("  LOG: {payload}");
            }
        }
    }
    assert_eq!(state, DshState::Running, "dsh 未进入 Running：{last_msg}");
    assert!(http_ok(port), "宿主机无法经 localhost 访问 WSL 内 dsh Web 服务");

    // 阶段 5：停止并验证端口释放
    lock(shared.lock()).stop().expect("stop 失败");
    let deadline = Instant::now() + Duration::from_secs(30);
    while Instant::now() < deadline && http_ok(port) {
        std::thread::sleep(Duration::from_millis(500));
    }
    assert!(!http_ok(port), "stop 后端口 {port} 仍被占用");
    eprintln!("[e2e] 阶段5 停止后端口 {port} 已释放");

    // 阶段 6：发行版清理（默认保留供复查）
    if std::env::var("DSH_E2E_CLEANUP").map(|v| v == "1").unwrap_or(false) {
        let _ = std::process::Command::new("wsl.exe")
            .args(["--unregister", &distro])
            .output();
        eprintln!("[e2e] 已清理发行版 {distro}");
    } else {
        eprintln!("[e2e] 保留发行版 {distro} 供复查（设 DSH_E2E_CLEANUP=1 自动清理）");
    }
    eprintln!("[e2e] 通过 ✔ 完整闭环验证成功");
}