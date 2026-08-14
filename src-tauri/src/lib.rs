mod dsh;

use dsh::config::{load, DshConfig};
use dsh::manager::{lock, spawn_health_watcher, DshManager, DshStatusView};
use dsh::proxy::{start_proxy, ProxyHandle};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager, State};

pub struct AppState {
    pub manager: Arc<Mutex<DshManager>>,
    pub proxy: Mutex<Option<ProxyHandle>>,
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
    let mut cb = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    cb.set_text(text).map_err(|e| e.to_string())
}
#[tauri::command]
fn fs_revert(root: String, path: String, expected: String, old_text: Option<String>) -> Result<String, String> {
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
            let content = std::fs::read_to_string(&target).map_err(|e| format!("读取文件失败: {e}"))?;
            let idx = content
                .find(&expected)
                .ok_or_else(|| format!("文件内容已变化，无法自动回退（找不到预期文本）"))?;
            let new_content = format!("{}{}{}", &content[..idx], old, &content[idx + expected.len()..]);
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
        .args(["-C", root_abs.to_str().ok_or("root 路径非法")?, "status", "--porcelain"])
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
            .args(["-C", root_abs.to_str().unwrap_or("."), "checkout", "--", path])
            .output()
        {
            if o.status.success() {
                restored.push(path.to_string());
            }
        }
    }
    Ok(restored)
}
#[tauri::command]
fn dsh_status(state: State<AppState>) -> DshStatusView {
    lock(state.manager.lock()).status_view()
}

#[tauri::command]
fn dsh_start(app: AppHandle, state: State<AppState>) -> Result<(), String> {
    let shared = state.manager.clone();
    let mut mgr = lock(shared.lock());
    mgr.start(shared.clone(), &app)
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
        })
        .invoke_handler(tauri::generate_handler![
            frontend_error,
            dsh_set_selected_model,
            clipboard_write,
            fs_revert,
            git_restore_deleted,
            dsh_status,
            dsh_start,
            dsh_stop,
            dsh_get_config,
            dsh_set_config,
            dsh_get_logs
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
                mgr.replace_config(cfg.clone());
                *state.proxy.lock().unwrap() = Some(proxy);
            }
            spawn_health_watcher(handle.state::<AppState>().manager.clone(), handle.clone());
            if cfg.auto_start {
                let app2 = handle.clone();
                tauri::async_runtime::spawn_blocking(move || {
                    let state = app2.state::<AppState>();
                    let shared = state.manager.clone();
                    let mut mgr = lock(shared.lock());
                    let _ = mgr.start(shared.clone(), &app2);
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
            }
        });
}








