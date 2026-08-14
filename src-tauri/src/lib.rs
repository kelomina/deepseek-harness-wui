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
fn dsh_set_selected_model(app: AppHandle, state: State<AppState>, provider: String, model: String) -> Result<(), String> {
    {
        let mut mgr = lock(state.manager.lock());
        mgr.config_mut().selected_provider = Some(provider);
        mgr.config_mut().selected_model = Some(model);
        crate::dsh::config::save(&app, mgr.config())?;
    }
    Ok(())
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




