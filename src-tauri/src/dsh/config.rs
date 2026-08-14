use serde::{Deserialize, Serialize};
use tauri::Manager;
use std::path::PathBuf;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExecMode {
    Bundled,
    Npx,
    Path,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DshConfig {
    pub exec_mode: ExecMode,
    pub exec_path: Option<String>,
    pub port: u16,
    pub dsh_home: Option<String>,
    pub workspace_dir: Option<String>,
    pub auto_start: bool,
    pub startup_timeout_secs: u64,
    pub max_restarts: u32,
    pub restart_window_secs: u64,
    pub health_interval_secs: u64,
    pub log_max_lines: usize,
}

impl Default for DshConfig {
    fn default() -> Self {
        Self {
            exec_mode: ExecMode::Bundled,
            exec_path: None,
            port: 3080,
            dsh_home: None,
            workspace_dir: None,
            auto_start: true,
            startup_timeout_secs: 90,
            max_restarts: 3,
            restart_window_secs: 600,
            health_interval_secs: 2,
            log_max_lines: 2000,
        }
    }
}

impl DshConfig {
    pub fn validate(&self) -> Result<(), String> {
        if self.port == 0 {
            return Err("port must be in 1..=65535".to_string());
        }
        if self.startup_timeout_secs == 0 {
            return Err("startup_timeout_secs must be > 0".to_string());
        }
        if self.health_interval_secs == 0 {
            return Err("health_interval_secs must be > 0".to_string());
        }
        if self.log_max_lines == 0 {
            return Err("log_max_lines must be > 0".to_string());
        }
        if self.exec_mode == ExecMode::Path {
            let p = self.exec_path.as_deref().ok_or("exec_path is required in Path mode")?;
            if !std::path::Path::new(p).exists() {
                return Err(format!("exec_path not found: {p}"));
            }
        }
        Ok(())
    }
}

pub fn config_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("config.json"))
}

pub fn load(app: &tauri::AppHandle) -> DshConfig {
    match config_path(app) {
        Ok(path) => match std::fs::read_to_string(&path) {
            Ok(text) => serde_json::from_str(&text).unwrap_or_default(),
            Err(_) => DshConfig::default(),
        },
        Err(_) => DshConfig::default(),
    }
}

pub fn save(app: &tauri::AppHandle, cfg: &DshConfig) -> Result<(), String> {
    let path = config_path(app)?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(&path);
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

