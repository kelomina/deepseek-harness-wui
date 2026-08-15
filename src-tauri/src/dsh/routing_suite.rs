//! dsh-routing-suite integration: vendored injector plugin + router-standard
//! agent preset, installed/uninstalled on demand (reversible) from the
//! Settings UI. The suite assets live under `plugins/dsh-routing-suite/`
//! (see plugins/dsh-routing-suite/VENDOR.md for provenance and versions).
//!
//! Semantics mirror the suite's own install chain:
//! - injector → `dsh plugin --profile web add <vendored injector>` (pnpm)
//! - preset   → copy vendored `preset/` to `$DSH_HOME/.agent-presets/router-standard`
//! Both are reversible; removal renames the preset dir to a dot-prefixed
//! `.trash-<ts>` (dsh's preset scan skips it) and removes the injector by the
//! package name discovered from the composed config.

use crate::dsh::config::DshConfig;
use crate::dsh::plugins::{dsh_home, run_dsh_cli, PluginEntry};
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::Manager;

/// Directory name of the vendored suite (relative to the plugins root).
const SUITE_DIR: &str = "dsh-routing-suite";
/// Plugin id the injector inserts into the composed profile config.
pub const INJECTOR_ID: &str = "dsh-super-injector";
/// Preset id = directory name under `$DSH_HOME/.agent-presets/`.
pub const PRESET_ID: &str = "router-standard";

#[derive(Debug, Clone, Serialize)]
pub struct RoutingSuiteStatus {
    /// Injector row present in `dsh web --dump-config`.
    pub injector_installed: bool,
    /// Package name discovered from the composed config (e.g. `@dsh-external/dsh-super-injector`).
    pub injector_name: Option<String>,
    /// `$DSH_HOME/.agent-presets/router-standard/agent.cordis.yml` exists.
    pub preset_installed: bool,
    /// Absolute preset target directory (for display).
    pub preset_dir: String,
    /// Vendored suite assets were found (packaged resource / dev cwd).
    pub vendored_found: bool,
    /// Vendored injector has the built `lib/index.js` (required by pnpm add).
    pub vendored_injector_ready: bool,
    /// Vendored preset has `agent.cordis.yml`.
    pub vendored_preset_ready: bool,
    /// Resolved harness home used for install/remove.
    pub dsh_home: String,
}

fn timestamp_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// Locate the vendored suite root: Tauri resource dir (packaged) first, then
/// `DSH_WUI_PLUGINS_DIR` env override (tests/dev), then repo-relative `plugins/`.
fn resolve_suite_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(p) = app
        .path()
        .resolve(SUITE_DIR, tauri::path::BaseDirectory::Resource)
    {
        candidates.push(p);
    }
    if let Ok(dir) = std::env::var("DSH_WUI_PLUGINS_DIR") {
        candidates.push(PathBuf::from(dir).join(SUITE_DIR));
    }
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("plugins").join(SUITE_DIR));
        candidates.push(cwd.join("..").join("plugins").join(SUITE_DIR));
    }
    for cand in candidates {
        if cand.join("injector").join("package.json").is_file() {
            return Ok(cand);
        }
    }
    Err(
        "找不到 vendored dsh-routing-suite 资源目录（打包时需包含 plugins/dsh-routing-suite）"
            .to_string(),
    )
}

/// Pure helper: find the injector row by id and return its package name.
fn injector_installed_name(entries: &[PluginEntry]) -> Option<String> {
    entries
        .iter()
        .find(|p| p.id == INJECTOR_ID)
        .map(|p| p.name.clone())
        .filter(|n| !n.is_empty())
}

pub fn routing_suite_status(app: &tauri::AppHandle, cfg: &DshConfig) -> RoutingSuiteStatus {
    let home = dsh_home(cfg);
    let preset_dir = home.join(".agent-presets").join(PRESET_ID);
    let preset_installed = preset_dir.join("agent.cordis.yml").is_file();
    let entries = crate::dsh::plugins::plugins_list(cfg).unwrap_or_default();
    let injector_name = injector_installed_name(&entries);
    let vendored = resolve_suite_root(app).ok();
    let vendored_dir = vendored.as_deref();
    RoutingSuiteStatus {
        injector_installed: injector_name.is_some(),
        injector_name,
        preset_installed,
        preset_dir: preset_dir.display().to_string(),
        vendored_found: vendored.is_some(),
        vendored_injector_ready: vendored_dir
            .map(|r| r.join("injector").join("lib").join("index.js").is_file())
            .unwrap_or(false),
        vendored_preset_ready: vendored_dir
            .map(|r| r.join("preset").join("agent.cordis.yml").is_file())
            .unwrap_or(false),
        dsh_home: home.display().to_string(),
    }
}

/// Recursively copy a directory tree (files only, plain copies).
fn copy_tree(src: &Path, dst: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dst).map_err(|e| format!("创建 {} 失败: {e}", dst.display()))?;
    let mut entries =
        std::fs::read_dir(src).map_err(|e| format!("读取 {} 失败: {e}", src.display()))?;
    while let Some(entry) = entries.next().transpose().map_err(|e| e.to_string())? {
        let ty = entry.file_type().map_err(|e| e.to_string())?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_tree(&from, &to)?;
        } else if ty.is_file() {
            std::fs::copy(&from, &to)
                .map_err(|e| format!("复制 {} → {} 失败: {e}", from.display(), to.display()))?;
        }
    }
    Ok(())
}

/// Install injector (pnpm) + preset (copy, reversible backup of existing).
pub fn routing_suite_install(app: &tauri::AppHandle, cfg: &DshConfig) -> Result<String, String> {
    let root = resolve_suite_root(app)?;
    let home = dsh_home(cfg);
    let mut msgs: Vec<String> = Vec::new();

    // 1) Injector — must carry the built lib; pnpm add accepts a directory.
    let injector_dir = root.join("injector");
    if !injector_dir.join("lib").join("index.js").is_file() {
        return Err(format!(
            "vendored 注入器缺少构建产物 lib/index.js（{}）；请按 plugins/dsh-routing-suite/VENDOR.md 更新构建产物",
            injector_dir.display()
        ));
    }
    let inj = injector_dir
        .to_str()
        .ok_or_else(|| "注入器路径非法".to_string())?;
    let out = run_dsh_cli(&["plugin", "--profile", "web", "add", inj], &home)?;
    msgs.push(format!("✓ 注入器已装配（重启后由 bundles 接管）：\n{out}"));

    // 2) Preset — copy to the official user preset root, keeping the previous
    //    copy recoverable under a dot-prefixed `.trash-<ts>` name.
    let presets_root = home.join(".agent-presets");
    let target = presets_root.join(PRESET_ID);
    if target.exists() {
        let trash = presets_root.join(format!(".trash-{}-{PRESET_ID}", timestamp_ms()));
        std::fs::rename(&target, &trash)
            .map_err(|e| format!("备份旧预设 {} 失败: {e}", target.display()))?;
        msgs.push(format!(
            "✓ 旧预设已备份 → {}",
            trash
                .file_name()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default()
        ));
    }
    std::fs::create_dir_all(&presets_root)
        .map_err(|e| format!("创建 {} 失败: {e}", presets_root.display()))?;
    copy_tree(&root.join("preset"), &target)?;
    msgs.push(format!("✓ 预设已安装：{}", target.display()));

    msgs.push(
        "\n重启 dsh 后生效：注入器由 bundles 装载；新会话可在「Agent 模式」选择 Router Standard (experimental)。"
            .to_string(),
    );
    Ok(msgs.join("\n"))
}

/// Remove injector (by discovered package name) + preset (reversible rename).
pub fn routing_suite_remove(cfg: &DshConfig) -> Result<String, String> {
    let home = dsh_home(cfg);
    let mut msgs: Vec<String> = Vec::new();

    let entries = crate::dsh::plugins::plugins_list(cfg)?;
    match injector_installed_name(&entries) {
        Some(name) => {
            let out = run_dsh_cli(&["plugin", "--profile", "web", "remove", &name], &home)?;
            msgs.push(format!("✓ 注入器已移除：\n{out}"));
        }
        None => msgs.push("注入器未安装，跳过。".to_string()),
    }

    let target = home.join(".agent-presets").join(PRESET_ID);
    if target.exists() {
        let presets_root = target.parent().unwrap_or(&home);
        let trash = presets_root.join(format!(".trash-{}-{PRESET_ID}", timestamp_ms()));
        std::fs::rename(&target, &trash)
            .map_err(|e| format!("移除预设 {} 失败: {e}", target.display()))?;
        msgs.push(format!(
            "✓ 预设已移除（可回滚：{}）",
            trash
                .file_name()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default()
        ));
    } else {
        msgs.push("预设未安装，跳过。".to_string());
    }

    msgs.push("\n重启 dsh 后生效。".to_string());
    Ok(msgs.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(id: &str, name: &str) -> PluginEntry {
        PluginEntry {
            id: id.to_string(),
            name: name.to_string(),
            enabled: true,
            builtin: name.starts_with("@deepseek-ai/"),
            conditional: false,
        }
    }

    #[test]
    fn detects_injector_by_id_and_name() {
        let rows = vec![
            entry("llm", "@deepseek-ai/dsh-llm"),
            entry(INJECTOR_ID, "@dsh-external/dsh-super-injector"),
        ];
        assert_eq!(
            injector_installed_name(&rows).as_deref(),
            Some("@dsh-external/dsh-super-injector")
        );
        let empty = vec![entry("llm", "@deepseek-ai/dsh-llm")];
        assert!(injector_installed_name(&empty).is_none());
    }

    #[test]
    fn preset_id_is_scan_safe() {
        // dsh-agent-presets PRESET_ID = /^[a-z0-9][a-z0-9-]*$/; dot-prefixed
        // trash dirs must be skipped, so they can never collide with the id.
        assert!(PRESET_ID
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-'));
        assert!(PRESET_ID.chars().next().unwrap().is_ascii_alphanumeric());
        assert!(format!(".trash-123-{PRESET_ID}").starts_with('.'));
    }

    #[test]
    fn copy_tree_copies_recursively() {
        let base = std::env::temp_dir().join(format!("dsh-routing-suite-test-{}", timestamp_ms()));
        let src = base.join("src");
        let dst = base.join("dst");
        std::fs::create_dir_all(src.join("sub")).unwrap();
        std::fs::write(src.join("a.yml"), "a").unwrap();
        std::fs::write(src.join("sub").join("b.mjs"), "b").unwrap();
        copy_tree(&src, &dst).unwrap();
        assert_eq!(std::fs::read_to_string(dst.join("a.yml")).unwrap(), "a");
        assert_eq!(
            std::fs::read_to_string(dst.join("sub").join("b.mjs")).unwrap(),
            "b"
        );
        // cleanup (best-effort, within temp dir)
        let _ = std::fs::remove_dir_all(&base);
    }
}
