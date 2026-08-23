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

/// First-level bare/scoped imports of the injector's lib that must resolve
/// from the injector directory itself (Node ESM resolves bare specifiers
/// relative to the importing file's real path — a pnpm `link:` junction to an
/// external directory cannot see the profile's node_modules). Mirrors what the
/// upstream build script does: junction the runtime's packages into the
/// injector's own node_modules at install time. Pairs are (link path under
/// injector/node_modules, target path under the runtime's node_modules).
const INJECTOR_LINK_PAIRS: &[(&str, &str)] = &[
    ("schemastery", "@deepseek-ai/schemastery"),
    ("cordis", "@deepseek-ai/cordis"),
    ("@deepseek-ai/dsh-tools", "@deepseek-ai/dsh-tools"),
    ("@deepseek-ai/dsh-llm", "@deepseek-ai/dsh-llm"),
    (
        "@deepseek-ai/dsh-client-ui-slots",
        "@deepseek-ai/dsh-client-ui-slots",
    ),
];

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
/// Resolve the node_modules root of the ACTIVE runtime (managed or bundled).
fn runtime_node_modules_root(app: &tauri::AppHandle, cfg: &DshConfig) -> Result<PathBuf, String> {
    if let Some(v) = &cfg.managed_runtime_version {
        let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
        let p = dir.join("runtimes").join(v).join("node_modules");
        if p.is_dir() {
            return Ok(p);
        }
        return Err(format!(
            "受管运行时 {v} 的 node_modules 缺失：{}（请先在「DSH 运行时」复验或回滚）",
            p.display()
        ));
    }
    let bin = PathBuf::from(crate::dsh::manager::bundled_bin_path()?);
    let nm = bin
        .parent()
        .and_then(|p| p.parent())
        .and_then(|p| p.parent())
        .ok_or_else(|| "无法解析 bundled runtime/node_modules".to_string())?;
    if nm.is_dir() {
        return Ok(nm.to_path_buf());
    }
    Err(format!(
        "bundled runtime node_modules 缺失：{}",
        nm.display()
    ))
}

/// Create a Windows junction (no admin needed). Junctions are removed with
/// `std::fs::remove_dir` (unlinks the junction, never the target).
#[cfg(windows)]
fn make_junction(link: &Path, target: &Path) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    // mklink 是 cmd 内置命令，不接受正斜杠路径（如 `@deepseek-ai/pkg` join 后
    // 保留 `/`），统一规范为反斜杠，否则报「无效目录」导致链接静默建不成
    let link_s = link.to_string_lossy().replace('/', "\\");
    let target_s = target.to_string_lossy().replace('/', "\\");
    let out = std::process::Command::new("cmd")
        .args(["/C", "mklink", "/J", &link_s, &target_s])
        .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
        .output()
        .map_err(|e| format!("创建 junction 失败: {e}"))?;
    if out.status.success() {
        Ok(())
    } else {
        let msg = String::from_utf8_lossy(&out.stderr).trim().to_string();
        let msg = if msg.is_empty() {
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        } else {
            msg
        };
        Err(format!(
            "mklink /J {} → {} 失败: {msg}",
            link.display(),
            target.display()
        ))
    }
}

#[cfg(not(windows))]
fn make_junction(_link: &Path, _target: &Path) -> Result<(), String> {
    Err("当前仅支持 Windows junction".to_string())
}

/// Ensure the injector's own node_modules carries junctions to the active
/// runtime's packages, so dsh's loader can resolve the injector's bare imports.
/// Returns human-readable lines (created / skipped / missing).
fn ensure_injector_links(runtime_nm: &Path, injector_dir: &Path) -> Result<Vec<String>, String> {
    let nm = injector_dir.join("node_modules");
    let mut lines: Vec<String> = Vec::new();
    for (link, target_rel) in INJECTOR_LINK_PAIRS {
        let target = runtime_nm.join(target_rel);
        let link_path = nm.join(link);
        if link_path.exists() {
            lines.push(format!("  - {link} 已存在（跳过）"));
            continue;
        }
        if !target.exists() {
            lines.push(format!(
                "  - {link}：runtime 缺少目标 {}（跳过）",
                target.display()
            ));
            continue;
        }
        if let Some(parent) = link_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("创建 {} 失败: {e}", parent.display()))?;
        }
        make_junction(&link_path, &target)?;
        lines.push(format!("  - {link} → {}（junction）", target.display()));
    }
    Ok(lines)
}

/// 修复缺失的注入器依赖 junction：全部存在时返回 Ok(None)（无事可做），
/// 有缺失时重建并返回 Ok(Some(说明行))。仅做文件系统检查，不跑 dsh CLI。
/// 目标在 runtime 中不存在的 pair（如 dsh 0.1.1-rc.2 起移除的 dsh-client-ui-slots，
/// 仅注入器类型引用）不算缺失——避免每次启动空转自愈。
pub(crate) fn repair_injector_links(
    runtime_nm: &Path,
    injector_dir: &Path,
) -> Result<Option<Vec<String>>, String> {
    let nm = injector_dir.join("node_modules");
    let any_missing = INJECTOR_LINK_PAIRS.iter().any(|(link, target_rel)| {
        runtime_nm.join(target_rel).exists() && !nm.join(link).exists()
    });
    if !any_missing {
        return Ok(None);
    }
    ensure_injector_links(runtime_nm, injector_dir).map(Some)
}

/// dsh 启动前自愈：套装已安装但注入器依赖 junction 缺失时重建。
/// 背景：pnpm `link:` 装配只登记 profile，注入器裸导入（schemastery 等）依赖
/// injector/node_modules 里的 junction；链接被清（git clean / 手动删除 /
/// 安装中途失败）会导致 dsh 启动即失败且报错晦涩（ERR_MODULE_NOT_FOUND）。
/// 轻量信号：`$DSH_HOME/.agent-presets/<PRESET_ID>` 存在 ≈ 套装已安装
/// （安装同时写入注入器与预设、卸载同时移除两者；信号误报只会多建几个
/// 不被使用的 junction，无功能影响）。
pub fn heal_injector_links_if_needed(
    app: &tauri::AppHandle,
    cfg: &DshConfig,
) -> Result<Option<Vec<String>>, String> {
    let root = match resolve_suite_root(app) {
        Ok(r) => r,
        Err(_) => return Ok(None), // vendored 套装不存在：无套装可自愈
    };
    let injector_dir = root.join("injector");
    if !injector_dir.join("lib").join("index.js").is_file() {
        return Ok(None);
    }
    let preset_installed = crate::dsh::plugins::dsh_home(cfg)
        .join(".agent-presets")
        .join(PRESET_ID)
        .exists();
    if !preset_installed {
        return Ok(None);
    }
    let runtime_nm = runtime_node_modules_root(app, cfg)?;
    repair_injector_links(&runtime_nm, &injector_dir)
}

/// Best-effort cleanup of the injector junctions (unlink only, never the target).
fn remove_injector_links(injector_dir: &Path) {
    let nm = injector_dir.join("node_modules");
    for (link, _) in INJECTOR_LINK_PAIRS {
        let link_path = nm.join(link);
        if link_path.exists() {
            let _ = std::fs::remove_dir(&link_path);
        }
    }
    let _ = std::fs::remove_dir(nm.join("@deepseek-ai"));
    let _ = std::fs::remove_dir(nm);
}
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

    // 注入器 lib 的裸依赖需从注入器目录自身可解析：把当前 runtime 的包 junction 进
    // injector/node_modules（与上游 build.sh 同机制；node_modules 被 .gitignore 忽略）。
    let runtime_nm = runtime_node_modules_root(app, cfg)?;
    let links = ensure_injector_links(&runtime_nm, &injector_dir)?;
    msgs.push(format!("✓ 注入器依赖链接：\n{}", links.join("\n")));

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
pub fn routing_suite_remove(app: &tauri::AppHandle, cfg: &DshConfig) -> Result<String, String> {
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

    // 清理注入器依赖 junction（只解链，不动 runtime）
    if let Ok(root) = resolve_suite_root(app) {
        remove_injector_links(&root.join("injector"));
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
    #[test]
    fn link_pairs_are_sane() {
        // 裸包映射到 runtime 的 @deepseek-ai 作用域；其余必须是 scoped 包
        assert!(INJECTOR_LINK_PAIRS
            .iter()
            .all(|(l, t)| !l.is_empty() && !t.is_empty()));
        assert!(INJECTOR_LINK_PAIRS
            .iter()
            .all(|(l, _)| *l == "schemastery" || *l == "cordis" || l.starts_with("@deepseek-ai/")));
        assert!(INJECTOR_LINK_PAIRS
            .iter()
            .all(|(_, t)| t.starts_with("@deepseek-ai/")));
    }

    #[test]
    #[cfg(windows)]
    fn junction_creation_and_unlink_keeps_target() {
        let base = std::env::temp_dir().join(format!("dsh-routing-suite-junc-{}", timestamp_ms()));
        let target = base.join("target");
        let link = base.join("link");
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(target.join("f.txt"), "x").unwrap();
        std::fs::create_dir_all(link.parent().unwrap()).unwrap();
        make_junction(&link, &target).unwrap();
        assert!(
            link.join("f.txt").is_file(),
            "junction should expose target content"
        );
        // remove_dir unlinks the junction only; the target must survive
        std::fs::remove_dir(&link).unwrap();
        assert!(target.join("f.txt").is_file(), "target must survive unlink");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    #[cfg(windows)]
    fn repair_recreates_missing_junctions_and_is_idempotent() {
        let base = std::env::temp_dir().join(format!("dsh-routing-suite-repair-{}", timestamp_ms()));
        let runtime_nm = base.join("runtime").join("node_modules");
        let injector_dir = base.join("injector");
        // 伪造 runtime：每个 link 目标（@deepseek-ai/<pkg>）都带 marker 文件
        for (_, target_rel) in INJECTOR_LINK_PAIRS {
            let t = runtime_nm.join(target_rel);
            std::fs::create_dir_all(&t).unwrap();
            std::fs::write(t.join("marker.txt"), "ok").unwrap();
        }
        // 伪造注入器（lib/index.js 存在即可）
        std::fs::create_dir_all(injector_dir.join("lib")).unwrap();
        std::fs::write(injector_dir.join("lib").join("index.js"), "// stub").unwrap();

        // 1) 全缺 → 修复 → Some，且所有链接可见目标内容
        let r1 = repair_injector_links(&runtime_nm, &injector_dir).unwrap();
        assert!(r1.is_some(), "missing links should trigger repair");
        for (link, _) in INJECTOR_LINK_PAIRS {
            assert!(
                injector_dir.join("node_modules").join(link).join("marker.txt").is_file(),
                "link {link} should expose target marker"
            );
        }
        // 2) 再跑 → None（幂等，无事可做）
        let r2 = repair_injector_links(&runtime_nm, &injector_dir).unwrap();
        assert!(r2.is_none(), "all links present should be a no-op");
        // 3) 删一个链接 → 再修复 → Some 且恢复
        let victim = injector_dir.join("node_modules").join("schemastery");
        std::fs::remove_dir(&victim).unwrap();
        let r3 = repair_injector_links(&runtime_nm, &injector_dir).unwrap();
        assert!(r3.is_some(), "single missing link should trigger repair");
        assert!(victim.join("marker.txt").is_file(), "victim link restored");

        let _ = std::fs::remove_dir_all(&base);
    }
}
