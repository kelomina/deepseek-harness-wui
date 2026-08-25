mod dsh;

use dsh::config::{load, DshConfig};
use dsh::event::TauriSink;
use dsh::manager::{lock, spawn_health_watcher, DshManager, DshStatusView};
use dsh::plugins::{plugins_import, plugins_list, plugins_remove, plugins_set_enabled};
use dsh::prereq;
use dsh::proxy::{start_proxy, ProxyHandle};
use dsh::routing_suite::{
    routing_suite_install, routing_suite_remove, routing_suite_status, RoutingSuiteStatus,
};
use dsh::runtime;
use dsh::wsl;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager, State};

pub struct AppState {
    pub manager: Arc<Mutex<DshManager>>,
    pub proxy: Mutex<Option<ProxyHandle>>,
    pub plugin_host: Arc<Mutex<dsh::plugin_host::PluginHostManager>>,
}

#[tauri::command]
fn frontend_error(message: String) {
    eprintln!("[frontend-error] {message}");
}

#[tauri::command]
fn dsh_set_selected_model(
    app: AppHandle,
    state: State<AppState>,
    provider: String,
    model: String,
    reasoning: Option<String>,
) -> Result<(), String> {
    {
        let mut mgr = lock(state.manager.lock());
        mgr.config_mut().selected_provider = Some(provider);
        mgr.config_mut().selected_model = Some(model);
        mgr.config_mut().selected_reasoning = reasoning;
        crate::dsh::config::save(&app, mgr.config())?;
    }
    Ok(())
}
#[tauri::command]
fn clipboard_write(text: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        // macOS 原生剪贴板（pbcopy），避免引入 objc2 C 工具链依赖
        use std::io::Write;
        use std::process::Stdio;
        let mut child = std::process::Command::new("pbcopy")
            .stdin(Stdio::piped())
            .spawn()
            .map_err(|e| format!("pbcopy 不可用: {e}"))?;
        child
            .stdin
            .take()
            .ok_or_else(|| "pbcopy stdin 不可用".to_string())?
            .write_all(text.as_bytes())
            .map_err(|e| format!("写入剪贴板失败: {e}"))?;
        child.wait().map_err(|e| e.to_string())?;
        return Ok(());
    }
    #[cfg(not(target_os = "macos"))]
    {
        let mut cb = arboard::Clipboard::new().map_err(|e| e.to_string())?;
        cb.set_text(text).map_err(|e| e.to_string())
    }
}
#[tauri::command]
fn fs_revert(
    root: String,
    path: String,
    expected: String,
    old_text: Option<String>,
) -> Result<String, String> {
    if expected.len() > 2 * 1024 * 1024 {
        return Err("expected 文本过大".to_string());
    }
    if let Some(old) = &old_text {
        if old.len() > 2 * 1024 * 1024 {
            return Err("oldText 文本过大".to_string());
        }
    }
    // 校验目标路径位于 root 内（会话工作区）
    let root_abs = std::fs::canonicalize(&root).map_err(|e| format!("root 不可访问: {e}"))?;
    let path_abs = std::path::Path::new(&path);
    let joined = if path_abs.is_absolute() {
        path_abs.to_path_buf()
    } else {
        root_abs.join(path_abs)
    };
    let parent = joined.parent().ok_or("路径无父目录")?;
    let parent_abs = std::fs::canonicalize(parent).map_err(|e| format!("父目录不可访问: {e}"))?;
    let file_name = joined.file_name().ok_or("路径无文件名")?.to_os_string();
    let target = parent_abs.join(file_name);
    if !target.starts_with(&root_abs) {
        return Err("目标路径不在会话工作区内".to_string());
    }
    match old_text {
        Some(old) => {
            let content =
                std::fs::read_to_string(&target).map_err(|e| format!("读取文件失败: {e}"))?;
            let idx = content
                .find(&expected)
                .ok_or_else(|| "文件内容已变化，无法自动回退（找不到预期文本）".to_string())?;
            let new_content = format!(
                "{}{}{}",
                &content[..idx],
                old,
                &content[idx + expected.len()..]
            );
            std::fs::write(&target, new_content).map_err(|e| format!("写入失败: {e}"))?;
            Ok("reverted".to_string())
        }
        None => {
            // oldText 为空表示该文件是本次新建，回退即删除
            if target.exists() {
                std::fs::remove_file(&target).map_err(|e| format!("删除失败: {e}"))?;
            }
            Ok("removed".to_string())
        }
    }
}
#[tauri::command]
fn git_restore_deleted(root: String) -> Result<Vec<String>, String> {
    let root_abs = std::fs::canonicalize(&root).map_err(|e| format!("root 不可访问: {e}"))?;
    let out = std::process::Command::new("git")
        .args([
            "-C",
            root_abs.to_str().ok_or("root 路径非法")?,
            "status",
            "--porcelain",
        ])
        .output()
        .map_err(|e| format!("git 不可用: {e}"))?;
    if !out.status.success() {
        return Err("git status 失败（可能不是 git 仓库）".to_string());
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let mut restored = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim_start();
        if !trimmed.starts_with('D') {
            continue;
        }
        let path = trimmed[1..].trim();
        if path.is_empty() || path.contains("->") || path.starts_with('"') {
            continue;
        }
        let target = root_abs.join(path);
        if !target.starts_with(&root_abs) {
            continue;
        }
        if let Ok(o) = std::process::Command::new("git")
            .args([
                "-C",
                root_abs.to_str().unwrap_or("."),
                "checkout",
                "--",
                path,
            ])
            .output()
        {
            if o.status.success() {
                restored.push(path.to_string());
            }
        }
    }
    Ok(restored)
}

/// 目录浏览（只读）：返回指定路径下的子目录列表。
/// 用于文件管理器面板，不依赖 dsh browse capability。
#[tauri::command]
fn fs_list_dir(path: Option<String>) -> Result<DirListing, String> {
    let cwd = path.unwrap_or_default();
    let p = if cwd.is_empty() {
        dirs::home_dir().unwrap_or_else(|| std::path::PathBuf::from("."))
    } else {
        std::path::PathBuf::from(&cwd)
    };
    let canonical = std::fs::canonicalize(&p).unwrap_or_else(|_| p.clone());
    let mut entries: Vec<DirEntry> = Vec::new();
    if let Ok(read_dir) = std::fs::read_dir(&canonical) {
        for entry in read_dir.flatten() {
            let ft = match entry.file_type() {
                Ok(ft) => ft,
                Err(_) => continue,
            };
            if !ft.is_dir() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            let full = entry.path().to_string_lossy().to_string();
            let hidden = name.starts_with('.') || name.starts_with('$');
            entries.push(DirEntry { name, path: full, hidden });
        }
    }
    entries.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(DirListing {
        path: canonical.to_string_lossy().to_string(),
        entries,
    })
}

#[derive(serde::Serialize)]
struct DirEntry {
    name: String,
    path: String,
    hidden: bool,
}

#[derive(serde::Serialize)]
struct DirListing {
    path: String,
    entries: Vec<DirEntry>,
}

/// 终端命令执行（同步，带输出截断保护）。
#[tauri::command]
fn term_exec(cmd: String, cwd: Option<String>) -> Result<TermExecResult, String> {
    let trimmed = cmd.trim();
    if trimmed.is_empty() {
        return Err("命令为空".to_string());
    }
    let workdir = cwd
        .filter(|c| !c.trim().is_empty())
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| dirs::home_dir().unwrap_or_else(|| std::path::PathBuf::from(".")));
    let output = if cfg!(target_os = "windows") {
        std::process::Command::new("cmd")
            .args(["/C", trimmed])
            .current_dir(&workdir)
            .output()
    } else {
        std::process::Command::new("sh")
            .args(["-c", trimmed])
            .current_dir(&workdir)
            .output()
    }
    .map_err(|e| format!("命令启动失败: {e}"))?;
    let mut text = String::from_utf8_lossy(&output.stdout).to_string();
    let err_text = String::from_utf8_lossy(&output.stderr);
    if !err_text.trim().is_empty() {
        if !text.is_empty() {
            text.push('\n');
        }
        text.push_str(&err_text);
    }
    const MAX: usize = 200_000;
    if text.len() > MAX {
        text.truncate(MAX);
        text.push_str("\n…（输出过长已截断）");
    }
    Ok(TermExecResult {
        output: text,
        exit_code: output.status.code(),
    })
}

#[derive(serde::Serialize)]
struct TermExecResult {
    output: String,
    exit_code: Option<i32>,
}

/// 网页抓取：返回 HTTP 状态码与正文（截断保护）。
#[tauri::command]
fn web_fetch(url: String) -> Result<WebFetchResult, String> {
    let trimmed = url.trim();
    if !trimmed.starts_with("http://") && !trimmed.starts_with("https://") {
        return Err("URL 必须以 http:// 或 https:// 开头".to_string());
    }
    let resp = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) DeepSeekHarnessWUI/0.1")
        .build()
        .map_err(|e| format!("HTTP 客户端初始化失败: {e}"))?
        .get(trimmed)
        .send()
        .map_err(|e| format!("请求失败: {e}"))?;
    let status = resp.status().as_u16();
    let body = resp.text().map_err(|e| format!("读取响应失败: {e}"))?;
    const MAX: usize = 100_000;
    let body = if body.len() > MAX {
        let mut b = body;
        b.truncate(MAX);
        b.push_str("\n…（内容过长已截断）");
        b
    } else {
        body
    };
    Ok(WebFetchResult { status, body })
}

#[derive(serde::Serialize)]
struct WebFetchResult {
    status: u16,
    body: String,
}

/// git status --porcelain 解析结果。
#[tauri::command]
fn git_status(root: String) -> Result<Vec<GitFileStatus>, String> {
    let out = run_git(&root, &["status", "--porcelain"])?;
    let mut files = Vec::new();
    for line in out.lines() {
        let mut chars = line.chars();
        let x = chars.next().unwrap_or(' ');
        let y = chars.next().unwrap_or(' ');
        let path = line.get(3..).unwrap_or("").trim().to_string();
        if path.is_empty() {
            continue;
        }
        // 跳过重命名条目的 " -> " 后缀
        let path = path.rsplit(" -> ").next().unwrap_or(&path).to_string();
        files.push(GitFileStatus {
            path,
            staged: x,
            unstaged: y,
        });
    }
    Ok(files)
}

#[derive(serde::Serialize, Clone, Debug)]
struct GitFileStatus {
    path: String,
    staged: char,
    unstaged: char,
}

/// git diff（默认工作区；staged=true 时取暂存区）。
#[tauri::command]
fn git_diff_file(root: String, path: String, staged: bool) -> Result<String, String> {
    let mut args: Vec<&str> = vec!["diff", "--"];
    if staged {
        args.insert(1, "--cached");
    }
    args.push(&path);
    run_git(&root, &args)
}

#[tauri::command]
fn git_stage(root: String, path: String) -> Result<String, String> {
    run_git(&root, &["add", "--", &path])
}

#[tauri::command]
fn git_unstage(root: String, path: String) -> Result<String, String> {
    run_git(&root, &["restore", "--staged", "--", &path])
}

#[tauri::command]
fn git_commit(root: String, message: String) -> Result<String, String> {
    if message.trim().is_empty() {
        return Err("提交信息不能为空".to_string());
    }
    run_git(&root, &["commit", "-m", &message])
}

fn run_git(root: &str, args: &[&str]) -> Result<String, String> {
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .output()
        .map_err(|e| format!("git 执行失败: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(format!("git 报错: {}", err.trim()));
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

#[tauri::command]
fn dsh_status(state: State<AppState>) -> DshStatusView {
    lock(state.manager.lock()).status_view()
}

#[tauri::command]
fn dsh_start(app: AppHandle, state: State<AppState>) -> Result<(), String> {
    // 启动前自愈路由套装注入器依赖 junction：链接缺失会让 dsh 启动即失败
    // （ERR_MODULE_NOT_FOUND），提前修复并给出可读错误
    let cfg = lock(state.manager.lock()).config().clone();
    if let Some(lines) = dsh::routing_suite::heal_injector_links_if_needed(&app, &cfg)? {
        eprintln!("[routing-suite] 启动前自愈依赖链接：\n{}", lines.join("\n"));
    }
    let shared = state.manager.clone();
    let mut mgr = lock(shared.lock());
    mgr.start(shared.clone(), TauriSink::new(app.clone()))
}

#[tauri::command]
fn dsh_stop(state: State<AppState>) -> Result<(), String> {
    let mut mgr = lock(state.manager.lock());
    mgr.stop()
}

#[tauri::command]
fn dsh_get_config(state: State<AppState>) -> DshConfig {
    lock(state.manager.lock()).config().clone()
}

#[tauri::command]
fn dsh_set_config(app: AppHandle, state: State<AppState>, config: DshConfig) -> Result<(), String> {
    config.validate()?;
    {
        let mut mgr = lock(state.manager.lock());
        mgr.set_config(&app, config.clone())?;
    }
    if let Some(proxy) = state.proxy.lock().unwrap().as_ref() {
        proxy.dsh_port.store(config.port, Ordering::Relaxed);
    }
    Ok(())
}

#[tauri::command]
fn dsh_get_logs(state: State<AppState>, limit: Option<usize>) -> Vec<String> {
    lock(state.manager.lock()).logs(limit.unwrap_or(200))
}

#[tauri::command]
fn plugins_list_cmd(state: State<AppState>) -> Result<Vec<dsh::plugins::PluginEntry>, String> {
    let cfg = lock(state.manager.lock()).config().clone();
    plugins_list(&cfg)
}

#[tauri::command]
fn plugins_set_enabled_cmd(
    state: State<AppState>,
    id: String,
    enabled: bool,
) -> Result<String, String> {
    let cfg = lock(state.manager.lock()).config().clone();
    plugins_set_enabled(&cfg, &id, enabled)
}

#[tauri::command]
fn plugins_import_cmd(state: State<AppState>, spec: String) -> Result<String, String> {
    let cfg = lock(state.manager.lock()).config().clone();
    plugins_import(&cfg, &spec)
}

#[tauri::command]
fn plugins_remove_cmd(state: State<AppState>, name: String) -> Result<String, String> {
    let cfg = lock(state.manager.lock()).config().clone();
    plugins_remove(&cfg, &name)
}

#[tauri::command]
fn routing_suite_status_cmd(app: AppHandle, state: State<AppState>) -> RoutingSuiteStatus {
    let cfg = lock(state.manager.lock()).config().clone();
    routing_suite_status(&app, &cfg)
}

#[tauri::command]
fn routing_suite_install_cmd(app: AppHandle, state: State<AppState>) -> Result<String, String> {
    let cfg = lock(state.manager.lock()).config().clone();
    routing_suite_install(&app, &cfg)
}

#[tauri::command]
fn routing_suite_remove_cmd(app: AppHandle, state: State<AppState>) -> Result<String, String> {
    let cfg = lock(state.manager.lock()).config().clone();
    routing_suite_remove(&app, &cfg)
}

// ---- 0.2.0 条目 3：DSH 运行时下载/安装/管理 ----
#[tauri::command]
fn runtime_list_cmd(
    app: AppHandle,
    state: State<AppState>,
) -> Result<Vec<runtime::RuntimeView>, String> {
    let active = lock(state.manager.lock())
        .config()
        .managed_runtime_version
        .clone();
    runtime::list(&app, active.as_deref())
}

#[tauri::command]
fn runtime_install_cmd(app: AppHandle, version: String) -> Result<runtime::RuntimeView, String> {
    runtime::install(&app, &version)
}

#[tauri::command]
fn runtime_verify_cmd(app: AppHandle, version: String) -> Result<runtime::VerifyReport, String> {
    runtime::verify(&app, &version)
}

#[tauri::command]
fn runtime_remove_cmd(app: AppHandle, version: String) -> Result<String, String> {
    runtime::remove(&app, &version)
}

#[tauri::command]
fn runtime_rollback_cmd(app: AppHandle, version: String) -> Result<String, String> {
    runtime::rollback(&app, &version)
}

#[tauri::command]
fn runtime_remote_versions_cmd() -> Result<Vec<String>, String> {
    runtime::remote_versions()
}

#[tauri::command]
fn runtime_set_active_cmd(
    app: AppHandle,
    state: State<AppState>,
    version: Option<String>,
) -> Result<(), String> {
    {
        let mut mgr = lock(state.manager.lock());
        if mgr.config().managed_runtime_version == version {
            return Ok(());
        }
        if let Some(v) = &version {
            if !runtime::list(&app, None)?.iter().any(|r| r.version == *v) {
                return Err(format!("版本 {v} 未安装，无法设为启用"));
            }
        }
        let mut cfg = mgr.config().clone();
        cfg.managed_runtime_version = version;
        mgr.set_config(&app, cfg)?;
    }
    Ok(())
}

// ---- dsh-std 插件宿主 sidecar（实验特性，默认关闭；见 docs/DSH_STD_HOST_PLAN.md）----
#[tauri::command]
fn plugin_host_status_cmd(
    state: State<AppState>,
) -> dsh::plugin_host::PluginHostStatusView {
    lock(state.plugin_host.lock()).status_view()
}

#[tauri::command]
fn plugin_host_logs_cmd(state: State<AppState>, limit: Option<usize>) -> Vec<String> {
    lock(state.plugin_host.lock()).logs(limit.unwrap_or(100))
}

#[tauri::command]
fn plugin_host_start_cmd(app: AppHandle, state: State<AppState>) -> Result<(), String> {
    let shared = state.plugin_host.clone();
    let mut host = lock(shared.lock());
    host.start(&app)
}

#[tauri::command]
fn plugin_host_stop_cmd(state: State<AppState>) -> Result<(), String> {
    let shared = state.plugin_host.clone();
    let mut host = lock(shared.lock());
    host.stop()
}

/// 准入校验（授权状态由持久化 grants 决定，默认全拒 → waiting_authorization）。
#[tauri::command]
fn plugin_host_admit_cmd(
    app: AppHandle,
    state: State<AppState>,
    manifest_json: String,
) -> Result<serde_json::Value, String> {
    let shared = state.plugin_host.clone();
    let mut host = lock(shared.lock());
    host.ensure_alive(&app)?;
    host.admit(&manifest_json)
}

/// 授权决策（持久化 + 同步到 sidecar）。
#[tauri::command]
fn plugin_host_grant_set_cmd(
    app: AppHandle,
    state: State<AppState>,
    plugin_id: String,
    permissions: Vec<String>,
) -> Result<(), String> {
    let shared = state.plugin_host.clone();
    let mut host = lock(shared.lock());
    host.ensure_alive(&app)?;
    host.grant_set(&plugin_id, &permissions)
}

/// 当前持久化授权快照。
#[tauri::command]
fn plugin_host_grants_cmd(state: State<AppState>) -> serde_json::Value {
    lock(state.plugin_host.lock()).grants_snapshot()
}

/// 示例插件目录（实验区默认值）。
#[tauri::command]
fn plugin_host_example_root_cmd(app: AppHandle) -> Result<String, String> {
    dsh::plugin_host::resolve_example_plugin_root(&app)
        .map(|p| p.to_string_lossy().to_string())
}

/// 激活插件（真实 import entry 并执行 activate(ctx)）。
/// plugin_root：本地插件目录（须含 dsh-plugin.json）；缺省时仅解析内置示例。
#[tauri::command]
fn plugin_host_activate_cmd(
    app: AppHandle,
    state: State<AppState>,
    plugin_id: String,
    plugin_root: Option<String>,
) -> Result<serde_json::Value, String> {
    let shared = state.plugin_host.clone();
    let mut host = lock(shared.lock());
    host.ensure_alive(&app)?;
    let root = match plugin_root.filter(|s| !s.trim().is_empty()) {
        Some(dir) => std::path::PathBuf::from(dir.trim().to_string()),
        None => dsh::plugin_host::resolve_example_plugin_root(&app)?,
    };
    host.activate(&plugin_id, &root)
}

/// 执行已激活命令。
#[tauri::command]
fn plugin_host_execute_cmd(
    app: AppHandle,
    state: State<AppState>,
    plugin_id: String,
    command_id: String,
    raw_input: Option<String>,
) -> Result<serde_json::Value, String> {
    let shared = state.plugin_host.clone();
    let mut host = lock(shared.lock());
    host.ensure_alive(&app)?;
    host.execute(&plugin_id, &command_id, raw_input.as_deref().unwrap_or(""))
}

/// 停用（撤销效果，保留授权与 storage）。
#[tauri::command]
fn plugin_host_deactivate_cmd(
    app: AppHandle,
    state: State<AppState>,
    plugin_id: String,
) -> Result<serde_json::Value, String> {
    let shared = state.plugin_host.clone();
    let mut host = lock(shared.lock());
    host.ensure_alive(&app)?;
    host.deactivate(&plugin_id)
}

/// 卸载（停用+撤权；purge 额外删除 storage 文件）。
#[tauri::command]
fn plugin_host_uninstall_cmd(
    app: AppHandle,
    state: State<AppState>,
    plugin_id: String,
    purge: Option<bool>,
) -> Result<serde_json::Value, String> {
    let shared = state.plugin_host.clone();
    let mut host = lock(shared.lock());
    host.ensure_alive(&app)?;
    host.uninstall(&plugin_id, purge.unwrap_or(false))
}

/// 命令目录（含激活状态）。
#[tauri::command]
fn plugin_host_commands_cmd(
    app: AppHandle,
    state: State<AppState>,
) -> Result<serde_json::Value, String> {
    let shared = state.plugin_host.clone();
    let mut host = lock(shared.lock());
    host.ensure_alive(&app)?;
    host.commands_list()
}

// ---- 首启前置条件：Node.js 检测/自动安装 + dsh 运行时状态汇总 ----
#[tauri::command]
fn prereq_check_cmd(app: AppHandle, state: State<AppState>) -> prereq::PrereqCheck {
    let node = prereq::find_node();
    let node_version = node.as_ref().and_then(|p| {
        std::process::Command::new(p)
            .arg("--version")
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
    });
    let dsh_runtime_version = lock(state.manager.lock()).config().managed_runtime_version.clone();
    let bundled_present = dsh::manager::bundled_bin_path().is_ok();
    let _ = &app;
    prereq::PrereqCheck {
        ok: node_version.is_some() && (dsh_runtime_version.is_some() || bundled_present),
        node_path: node.map(|p| p.to_string_lossy().to_string()),
        node_version,
        dsh_runtime_version,
        bundled_present,
    }
}

/// 长耗时（下载 ~30MB + 静默安装 + 提权弹窗）：放阻塞线程池执行。
#[tauri::command]
async fn prereq_install_node_cmd() -> Result<prereq::NodeInstallReport, String> {
    tokio::task::spawn_blocking(prereq::install_node)
        .await
        .map_err(|e| format!("安装任务失败: {e}"))
}

// ---- 0.2.0 条目 2：DSH WSL 配置与连接 ----
#[tauri::command]
fn wsl_status_cmd() -> wsl::WslStatus {
    wsl::wsl_status()
}

#[tauri::command]
fn wsl_save_config_cmd(
    app: AppHandle,
    state: State<AppState>,
    default_distro: Option<String>,
    dsh_home: Option<String>,
    workspace_dir: Option<String>,
) -> Result<(), String> {
    wsl::validate_wsl_config(
        default_distro.as_deref(),
        dsh_home.as_deref(),
        workspace_dir.as_deref(),
    )?;
    let mut mgr = lock(state.manager.lock());
    let mut cfg = mgr.config().clone();
    cfg.wsl_default_distro = default_distro.filter(|s| !s.trim().is_empty());
    cfg.wsl_dsh_home = dsh_home.filter(|s| !s.trim().is_empty());
    cfg.wsl_workspace_dir = workspace_dir.filter(|s| !s.trim().is_empty());
    // 可逆备份：保留 config.json.bak-<ts>
    if let Ok(path) = crate::dsh::config::config_path(&app) {
        if path.exists() {
            let ts = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0);
            let bak = path.with_extension(format!("json.bak-{ts}"));
            let _ = std::fs::copy(&path, &bak);
        }
    }
    mgr.set_config(&app, cfg)
}

/// 一键创建/初始化 WSL 并安装 DSH。异步执行，进度经 `wsl://provision` 事件推送；
/// 成功后把发行版 / DSH_HOME / 工作区写入应用 config（保存前备份）。
#[tauri::command]
async fn wsl_provision_cmd(
    app: AppHandle,
    state: State<'_, AppState>,
    distro: Option<String>,
    exact_version: Option<String>,
) -> Result<wsl::WslProvisionReport, String> {
    let manager = state.manager.clone();
    let configured = {
        let mgr = lock(manager.lock());
        mgr.config().wsl_default_distro.clone()
    };
    let app_for_task = app.clone();
    let report = tauri::async_runtime::spawn_blocking(move || {
        wsl::provision(TauriSink::new(app_for_task), configured.as_deref(), distro.as_deref(), exact_version.as_deref())
    })
    .await
    .map_err(|e| format!("provision task failed: {e}"))?;
    if report.ok {
        let mut mgr = lock(manager.lock());
        let mut cfg = mgr.config().clone();
        cfg.wsl_default_distro = report.distro.clone();
        cfg.wsl_dsh_home = report.dsh_home.clone();
        cfg.wsl_workspace_dir = report.workspace_dir.clone();
        if let Ok(path) = crate::dsh::config::config_path(&app) {
            if path.exists() {
                let ts = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis())
                    .unwrap_or(0);
                let bak = path.with_extension(format!("json.bak-{ts}"));
                let _ = std::fs::copy(&path, &bak);
            }
        }
        let _ = mgr.set_config(&app, cfg);
    }
    Ok(report)
}

/// 生产/开发入口：构建并运行 Wry 桌面应用。
/// 在 `e2e` feature 下被 cfg 排除，避免测试二进制链接 WebView2 导致
/// `STATUS_ENTRYPOINT_NOT_FOUND`（0xc0000139）；e2e 测试走 `tauri::test::mock_app()`。
#[cfg(not(feature = "e2e"))]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.set_focus();
            }
        }))
        .manage(AppState {
            manager: Arc::new(Mutex::new(DshManager::new(DshConfig::default(), 0))),
            proxy: Mutex::new(None),
            plugin_host: Arc::new(Mutex::new(dsh::plugin_host::PluginHostManager::new())),
        })
        .invoke_handler(tauri::generate_handler![
            frontend_error,
            dsh_set_selected_model,
            clipboard_write,
            fs_revert,
            fs_list_dir,
            term_exec,
            web_fetch,
            git_status,
            git_diff_file,
            git_stage,
            git_unstage,
            git_commit,
            git_restore_deleted,
            dsh_status,
            dsh_start,
            dsh_stop,
            dsh_get_config,
            dsh_set_config,
            dsh_get_logs,
            plugins_list_cmd,
            plugins_set_enabled_cmd,
            plugins_import_cmd,
            plugins_remove_cmd,
            routing_suite_status_cmd,
            routing_suite_install_cmd,
            routing_suite_remove_cmd,
            runtime_list_cmd,
            runtime_install_cmd,
            runtime_verify_cmd,
            runtime_remove_cmd,
            runtime_rollback_cmd,
            runtime_remote_versions_cmd,
            runtime_set_active_cmd,
            prereq_check_cmd,
            prereq_install_node_cmd,
            wsl_status_cmd,
            wsl_save_config_cmd,
            wsl_provision_cmd,
            plugin_host_status_cmd,
            plugin_host_logs_cmd,
            plugin_host_start_cmd,
            plugin_host_stop_cmd,
            plugin_host_admit_cmd,
            plugin_host_grant_set_cmd,
            plugin_host_grants_cmd,
            plugin_host_activate_cmd,
            plugin_host_execute_cmd,
            plugin_host_commands_cmd,
            plugin_host_example_root_cmd,
            plugin_host_deactivate_cmd,
            plugin_host_uninstall_cmd
        ])
        .setup(|app| {
            let handle = app.handle();
            let cfg = load(handle);
            let proxy = tauri::async_runtime::block_on(start_proxy(cfg.port))
                .map_err(|e| format!("proxy start failed: {e}"))?;
            {
                let state = handle.state::<AppState>();
                let mut mgr = lock(state.manager.lock());
                mgr.set_proxy_port(proxy.port);
                if let Ok(cfg_dir) = app.path().app_config_dir() {
                    mgr.set_managed_runtime_root(cfg_dir.join("runtimes"));
                }
                mgr.replace_config(cfg.clone());
                *state.proxy.lock().unwrap() = Some(proxy);
            }
            spawn_health_watcher(handle.state::<AppState>().manager.clone(), TauriSink::new(handle.clone()));
            if cfg.auto_start {
                let app2 = handle.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    // 自愈路由套装依赖链接（尽力而为：失败不阻断启动，
                    // 由 dsh 原始报错兜底暴露问题）
                    {
                        let state = app2.state::<AppState>();
                        let cfg = lock(state.manager.lock()).config().clone();
                        if let Ok(Some(lines)) =
                            dsh::routing_suite::heal_injector_links_if_needed(&app2, &cfg)
                        {
                            eprintln!(
                                "[routing-suite] 启动前自愈依赖链接：\n{}",
                                lines.join("\n")
                            );
                        }
                    }
                    let state = app2.state::<AppState>();
                    let shared = state.manager.clone();
                    let mut mgr = lock(shared.lock());
                    let _ = mgr.start(shared.clone(), TauriSink::new(app2));
                });
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                let state = app.state::<AppState>();
                if let Ok(mut mgr) = state.manager.lock() {
                    let _ = mgr.stop();
                };
                let plugin_host_stop = state.plugin_host.lock().map(|mut host| host.stop());
                let _ = plugin_host_stop;
            }
        });
}

/// `e2e` feature 下的入口桩：仅用于满足 bin（main.rs）在 `cargo test --features e2e` 下的链接，
/// 不启动 Wry 应用。真正的 e2e 验证在 `dsh::e2e_wsl::wsl_provision_and_start_dsh_e2e`。
#[cfg(feature = "e2e")]
pub fn run() {
    // no-op：e2e 构建不运行桌面应用入口。
}

#[cfg(test)]
mod tool_panel_tests {
    //! 工具面板（终端/浏览器/Git）真实功能测试：
    //! 终端真实执行命令、浏览器真实发起 HTTP 请求、Git 真实操作临时仓库。
    use super::*;
    use std::io::{Read as _, Write as _};

    fn tmp_dir(tag: &str) -> std::path::PathBuf {
        let p = std::env::temp_dir().join(format!(
            "wui_tool_test_{}_{}",
            tag,
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn term_exec_runs_real_command() {
        let r = term_exec("echo hello_term_exec".to_string(), None).unwrap();
        assert_eq!(r.exit_code, Some(0));
        assert!(r.output.contains("hello_term_exec"), "output: {}", r.output);
    }

    #[test]
    fn term_exec_respects_cwd_and_reports_exit_code() {
        let dir = tmp_dir("term");
        // 平台各自的列目录命令：cmd 用 dir /b，sh 用 ls
        let list_cmd = if cfg!(target_os = "windows") { "dir /b" } else { "ls" };
        let r = term_exec(list_cmd.to_string(), Some(dir.to_string_lossy().to_string())).unwrap();
        assert_eq!(r.exit_code, Some(0));
        // 不存在的命令应返回非零退出码而非 panic
        let bad = term_exec("no_such_command_xyz_123".to_string(), None).unwrap();
        assert_ne!(bad.exit_code, Some(0));
        // 空命令应报错
        assert!(term_exec("   ".to_string(), None).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn web_fetch_rejects_bad_scheme() {
        assert!(web_fetch("ftp://example.com".to_string()).is_err());
        assert!(web_fetch("not a url".to_string()).is_err());
    }

    #[test]
    fn web_fetch_fetches_real_local_http() {
        // 本地起一个一次性 HTTP 服务，真实走 reqwest 网络栈
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let body = "hello_web_fetch_ok";
        let srv = std::thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut buf = [0u8; 2048];
                let _ = stream.read(&mut buf);
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                );
                let _ = stream.write_all(resp.as_bytes());
                let _ = stream.flush();
            }
        });
        let r = web_fetch(format!("http://127.0.0.1:{port}/")).unwrap();
        assert_eq!(r.status, 200);
        assert!(r.body.contains(body), "body: {}", r.body);
        let _ = srv.join();
    }

    #[test]
    fn git_full_cycle_on_temp_repo() {
        if std::process::Command::new("git").arg("--version").output().is_err() {
            // 环境无 git 时跳过（本测试机已确认有 git）
            return;
        }
        let dir = tmp_dir("git");
        let root = dir.to_string_lossy().to_string();
        run_git(&root, &["init"]).unwrap();
        run_git(&root, &["config", "user.email", "t@t.local"]).unwrap();
        run_git(&root, &["config", "user.name", "t"]).unwrap();

        std::fs::write(dir.join("a.txt"), "line1\n").unwrap();

        // 未跟踪
        let st = git_status(root.clone()).unwrap();
        assert_eq!(st.len(), 1);
        assert_eq!(st[0].path, "a.txt");
        assert_eq!(st[0].staged, '?');

        // 暂存
        git_stage(root.clone(), "a.txt".to_string()).unwrap();
        let st = git_status(root.clone()).unwrap();
        assert_eq!(st[0].staged, 'A');

        // 提交后工作区干净
        git_commit(root.clone(), "init commit".to_string()).unwrap();
        let st = git_status(root.clone()).unwrap();
        assert!(st.is_empty(), "after commit: {st:?}");

        // 修改后出现 unstaged diff
        std::fs::write(dir.join("a.txt"), "line1\nline2\n").unwrap();
        let st = git_status(root.clone()).unwrap();
        assert_eq!(st.len(), 1);
        assert_eq!(st[0].unstaged, 'M');
        let diff = git_diff_file(root.clone(), "a.txt".to_string(), false).unwrap();
        assert!(diff.contains("+line2"), "diff: {diff}");

        // 空提交信息应报错
        assert!(git_commit(root.clone(), "  ".to_string()).is_err());

        let _ = std::fs::remove_dir_all(&dir);
    }
}
