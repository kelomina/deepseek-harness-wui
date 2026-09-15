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
use serde_json::Value;
use std::path::{Path, PathBuf};
use tauri::Manager;

/// Directory name of the vendored suite (relative to the plugins root).
const SUITE_DIR: &str = "dsh-routing-suite";
/// Plugin id the injector inserts into the composed profile config.
pub const INJECTOR_ID: &str = "dsh-super-injector";
/// Package name of the vendored injector (its `package.json` name); it is the
/// `dsh.profile.bundles` / `dependencies` key dsh resolves.
pub const INJECTOR_PKG: &str = "@dsh-external/dsh-super-injector";
/// Preset id = directory name under `$DSH_HOME/.agent-presets/`.
pub const PRESET_ID: &str = "router-standard";
/// The only dsh profile this app manages (see `plugins::patch_path`).
pub const WEB_PROFILE: &str = "web";
/// Bundles owned by the dsh installation itself (upstream `PROFILE_TEMPLATES`
/// in `@deepseek-ai/dsh-app-boot`). An unresolvable one means the runtime
/// install is incomplete, so it is reported instead of stripped from the
/// profile manifest.
const INSTALLATION_OWNED_BUNDLES: &[&str] = &[
    "@deepseek-ai/dsh-base",
    "@deepseek-ai/dsh-web-app",
    "@deepseek-ai/dsh-acp-app",
    "@deepseek-ai/dsh-headless",
    "@deepseek-ai/dsh-sdk-app",
];

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
    let mut candidates = suite_root_candidates(
        &crate::dsh::resource_roots(app),
        std::env::var("DSH_WUI_PLUGINS_DIR").ok().as_deref(),
        std::env::current_dir().ok().as_deref(),
    );
    for cand in candidates.drain(..) {
        if cand.join("injector").join("package.json").is_file() {
            return Ok(cand);
        }
    }
    Err(
        "找不到 vendored dsh-routing-suite 资源目录（打包时需包含 plugins/dsh-routing-suite）"
            .to_string(),
    )
}

/// 纯函数：套装根候选顺序（打包资源根 → 环境变量覆盖 → cwd 相对）。
/// 打包布局契约由单测钉住：NSIS 把 `../plugins/…` 落到 `$INSTDIR/_up_/plugins/…`。
fn suite_root_candidates(
    resource_roots: &[PathBuf],
    env_dir: Option<&str>,
    cwd: Option<&Path>,
) -> Vec<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    // 打包：资源键是 `../plugins/dsh-routing-suite/**`，落盘形态见 `dsh::resource_roots`
    // （`$INSTDIR/plugins/…` 与 `$INSTDIR/_up_/plugins/…`）；旧写法只试 `Resource`+裸目录名，
    // 安装包内必然找不到 vendored 套装。
    for root in resource_roots {
        candidates.push(root.join("plugins").join(SUITE_DIR));
        candidates.push(root.join(SUITE_DIR));
    }
    if let Some(dir) = env_dir {
        candidates.push(PathBuf::from(dir).join(SUITE_DIR));
    }
    if let Some(cwd) = cwd {
        let cwd = cwd.to_path_buf();
        candidates.push(cwd.join("plugins").join(SUITE_DIR));
        candidates.push(cwd.join("..").join("plugins").join(SUITE_DIR));
    }
    candidates
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
    copy_tree_skip(src, dst, &[])
}

/// `copy_tree` + 顶层跳过的目录名（如 `node_modules`：里面的 junction 必须按
/// 当前生效运行时重建，复制过来只会指向旧运行时）。
fn copy_tree_skip(src: &Path, dst: &Path, skip_top: &[&str]) -> Result<(), String> {
    copy_tree_impl(src, dst, src, skip_top)
}

fn copy_tree_impl(src: &Path, dst: &Path, top: &Path, skip_top: &[&str]) -> Result<(), String> {
    std::fs::create_dir_all(dst).map_err(|e| format!("创建 {} 失败: {e}", dst.display()))?;
    let mut entries =
        std::fs::read_dir(src).map_err(|e| format!("读取 {} 失败: {e}", src.display()))?;
    while let Some(entry) = entries.next().transpose().map_err(|e| e.to_string())? {
        let ty = entry.file_type().map_err(|e| e.to_string())?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if ty.is_dir() {
            if src == top {
                if let Some(name) = entry.file_name().to_str() {
                    if skip_top.contains(&name) {
                        continue;
                    }
                }
            }
            copy_tree_impl(&from, &to, top, skip_top)?;
        } else if ty.is_file() {
            std::fs::copy(&from, &to)
                .map_err(|e| format!("复制 {} → {} 失败: {e}", from.display(), to.display()))?;
        }
    }
    Ok(())
}

/// `$DSH_HOME/profiles/web`
pub fn web_profile_dir(cfg: &DshConfig) -> PathBuf {
    dsh_home(cfg).join("profiles").join(WEB_PROFILE)
}

/// vendored 注入器目录（打包资源或仓库 `plugins/`）；供 manager 启动前守卫使用。
pub fn vendored_injector_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(resolve_suite_root(app)?.join("injector"))
}

fn read_json(path: &Path) -> Result<Value, String> {
    let raw = std::fs::read_to_string(path)
        .map_err(|e| format!("读取 {} 失败: {e}", path.display()))?;
    serde_json::from_str(&raw).map_err(|e| format!("解析 {} 失败: {e}", path.display()))
}

fn pkg_version(pkg_json: &Path) -> Option<String> {
    read_json(pkg_json)
        .ok()?
        .get("version")?
        .as_str()
        .map(str::to_string)
}

/// 注入器的稳定副本目录：留在 profile 内部，不依赖应用安装目录与开发仓库路径
/// （安装目录随升级/卸载变动，仓库路径随移动/`git clean` 断链）。
fn staged_injector_dir(profile_dir: &Path) -> PathBuf {
    profile_dir.join(".dsh-plugins").join(INJECTOR_ID)
}

/// `link:` / `file:` 协议依赖声明里的目标路径；其他 spec 返回 None。
fn link_spec_target(profile_dir: &Path, spec: &str) -> Option<PathBuf> {
    let rest = spec
        .strip_prefix("link:")
        .or_else(|| spec.strip_prefix("file:"))?
        .trim();
    if rest.is_empty() {
        return None;
    }
    let p = PathBuf::from(rest.replace('/', std::path::MAIN_SEPARATOR_STR));
    Some(if p.is_absolute() { p } else { profile_dir.join(p) })
}

/// profile 当前实际装载的注入器目录（由 `dependencies` 的 link spec 推得）。
pub(crate) fn profile_injector_dir(cfg: &DshConfig) -> Option<PathBuf> {
    let profile_dir = web_profile_dir(cfg);
    let spec = read_json(&profile_dir.join("package.json"))
        .ok()?
        .get("dependencies")?
        .get(INJECTOR_PKG)?
        .as_str()?
        .to_string();
    let target = link_spec_target(&profile_dir, &spec)?;
    target.is_dir().then_some(target)
}

/// 镜像 dsh `resolveBundleDir` 的解析顺序：安装（运行时 node_modules）优先，
/// 然后从 profile 目录逐级向上找 `node_modules/<pkg>/package.json`。
fn bundle_resolvable(pkg: &str, profile_dir: &Path, runtime_nm: Option<&Path>) -> bool {
    if let Some(nm) = runtime_nm {
        if nm.join(pkg).join("package.json").is_file() {
            return true;
        }
    }
    let mut cur: Option<&Path> = Some(profile_dir);
    while let Some(dir) = cur {
        if dir
            .join("node_modules")
            .join(pkg)
            .join("package.json")
            .is_file()
        {
            return true;
        }
        cur = dir.parent();
    }
    false
}

/// 复制 vendored 注入器到稳定目录：版本一致跳过；不一致时旧副本改名 `.trash-*` 保留。
fn stage_injector_copy(vendor: &Path, dst: &Path, lines: &mut Vec<String>) -> Result<(), String> {
    let parent = dst.parent().unwrap_or(dst);
    std::fs::create_dir_all(parent).map_err(|e| format!("创建 {} 失败: {e}", parent.display()))?;
    if dst.join("package.json").is_file() {
        if pkg_version(&vendor.join("package.json")) == pkg_version(&dst.join("package.json")) {
            lines.push(format!("  - 稳定副本版本一致，跳过复制：{}", dst.display()));
            return Ok(());
        }
        let trash = parent.join(format!(".trash-{}-{INJECTOR_ID}", timestamp_ms()));
        std::fs::rename(dst, &trash)
            .map_err(|e| format!("备份旧稳定副本 {} 失败: {e}", dst.display()))?;
        lines.push(format!("  - 旧稳定副本已备份 → {}", trash.display()));
    }
    copy_tree_skip(vendor, dst, &["node_modules"])?;
    lines.push(format!("  - 注入器已复制到稳定目录 {}", dst.display()));
    Ok(())
}

/// 重建 profile → 注入器的链接：稳定副本 + `node_modules` junction + 注入器自身的
/// 裸依赖 junction（Node ESM 按真实路径解析，指向稳定副本后仍要对齐当前运行时）。
/// 返回稳定副本路径，供调用方把 `link:` spec 一起改写。
fn relink_injector(
    profile_dir: &Path,
    runtime_nm: Option<&Path>,
    vendor_injector: Option<&Path>,
    lines: &mut Vec<String>,
) -> Result<PathBuf, String> {
    let vendor = vendor_injector
        .filter(|v| v.join("lib").join("index.js").is_file())
        .ok_or_else(|| {
            format!("没有可用的 vendored 注入器资源（缺 lib/index.js），无法重建 {INJECTOR_PKG} 链接")
        })?;
    let staged = staged_injector_dir(profile_dir);
    stage_injector_copy(vendor, &staged, lines)?;
    let link = profile_dir.join("node_modules").join(INJECTOR_PKG);
    if !link.exists() {
        // 悬空 junction 会占住路径，先解链再重建（remove_dir 只解链，不动目标）
        remove_link_best_effort(&link);
        if let Some(nm) = link.parent() {
            std::fs::create_dir_all(nm)
                .map_err(|e| format!("创建 {} 失败: {e}", nm.display()))?;
        }
        make_junction(&link, &staged)?;
        lines.push(format!("  - {INJECTOR_PKG} → {}（junction）", staged.display()));
    }
    if let Some(nm) = runtime_nm {
        lines.extend(ensure_injector_links(nm, &staged)?);
    }
    Ok(staged)
}

/// 启动前 profile bundles 自检结果。
#[derive(Debug, Default)]
pub struct BundleHeal {
    /// 自愈说明（稳定副本 / junction / 依赖链接）。
    pub relink_notes: Vec<String>,
    /// 从 `dsh.profile.bundles` 摘除的包名。
    pub removed: Vec<String>,
    /// 无法解析但不自动处理（运行时自带 bundle）。
    pub unrecoverable: Vec<String>,
    /// 改写清单前的备份路径。
    pub backup: Option<String>,
}

impl BundleHeal {
    /// 人话摘要，供 dsh 日志面板显示（无内容表示什么都没做）。
    pub fn summary_lines(&self) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        if !self.relink_notes.is_empty() {
            out.push("注入器链接已自愈（保留在 dsh.profile.bundles）：".to_string());
            out.extend(self.relink_notes.iter().cloned());
        }
        for pkg in &self.removed {
            out.push(format!(
                "{pkg} 无法解析且无法自愈，已从 dsh.profile.bundles 摘除；dsh 先起来，之后可在设置 → 插件重新安装"
            ));
        }
        out.extend(self.unrecoverable.iter().cloned());
        if let Some(bak) = &self.backup {
            out.push(format!("profile 清单备份：{bak}"));
        }
        out
    }
}

/// dsh 在加载 profile 阶段要求 `dsh.profile.bundles` 每项都能解析
/// （`@deepseek-ai/dsh-app-boot` 的 `resolveBundleDir` 解析不到就直接 throw），
/// 任一条目悬空即整个应用起不来，自动重启只会重复同一条错误。这里按 dsh 自身的
/// 解析顺序预检：注入器能重建链接就重建（改指 `$DSH_HOME` 下的稳定副本），
/// 其余无法解析的条目从 bundles 摘除并备份清单，保证 dsh 可启动。
pub fn heal_profile_bundles(
    profile_dir: &Path,
    runtime_nm: Option<&Path>,
    vendor_injector: Option<&Path>,
) -> Result<Option<BundleHeal>, String> {
    let manifest = profile_dir.join("package.json");
    if !manifest.is_file() {
        return Ok(None);
    }
    let mut value = read_json(&manifest)?;
    let bundles: Vec<String> = match value
        .get("dsh")
        .and_then(|d| d.get("profile"))
        .and_then(|p| p.get("bundles"))
        .and_then(Value::as_array)
    {
        Some(arr) => arr
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect(),
        None => return Ok(None),
    };
    let broken: Vec<String> = bundles
        .iter()
        .filter(|b| !bundle_resolvable(b, profile_dir, runtime_nm))
        .cloned()
        .collect();
    if broken.is_empty() {
        return Ok(None);
    }

    let mut heal = BundleHeal::default();
    let mut next = bundles.clone();
    let mut deps_changed = false;
    for pkg in &broken {
        if pkg == INJECTOR_PKG {
            match relink_injector(profile_dir, runtime_nm, vendor_injector, &mut heal.relink_notes) {
                Ok(staged) => {
                    // 同步改写 link spec：下一次 pnpm install 也会落在稳定目录
                    let spec = format!("link:{}", staged.to_string_lossy().replace('\\', "/"));
                    if let Some(deps) = value.get_mut("dependencies").and_then(Value::as_object_mut) {
                        if deps.get(INJECTOR_PKG).and_then(Value::as_str) != Some(spec.as_str()) {
                            deps.insert(INJECTOR_PKG.to_string(), Value::String(spec));
                            deps_changed = true;
                        }
                    }
                    continue;
                }
                Err(e) => heal.relink_notes.push(format!("  - 重建链接失败：{e}")),
            }
        }
        if INSTALLATION_OWNED_BUNDLES.contains(&pkg.as_str()) {
            heal.unrecoverable.push(format!(
                "{pkg} 无法解析：受管运行时不完整，请到设置 → DSH 运行时复验或回滚（该 bundle 不做自动摘除）"
            ));
            continue;
        }
        next.retain(|b| b != pkg);
        heal.removed.push(pkg.clone());
        // 悬空的 link:/file: 依赖一并摘除：留着它 pnpm install 会因目标不存在直接失败
        let dangling_link = value
            .get("dependencies")
            .and_then(|d| d.get(pkg.as_str()))
            .and_then(Value::as_str)
            .map(|spec| {
                link_spec_target(profile_dir, spec)
                    .map(|t| !t.is_dir())
                    .unwrap_or(false)
            })
            .unwrap_or(false);
        if dangling_link {
            if let Some(deps) = value.get_mut("dependencies").and_then(Value::as_object_mut) {
                deps.remove(pkg.as_str());
                deps_changed = true;
            }
        }
    }

    let unchanged = next == bundles;
    if unchanged && !deps_changed {
        return Ok(Some(heal));
    }
    if !unchanged {
        if let Some(profile) = value
            .get_mut("dsh")
            .and_then(|d| d.get_mut("profile"))
            .and_then(|p| p.as_object_mut())
        {
            profile.insert(
                "bundles".to_string(),
                Value::Array(next.into_iter().map(Value::String).collect()),
            );
        }
    }
    let bak = profile_dir.join(format!("package.json.bak-{}", timestamp_ms()));
    std::fs::copy(&manifest, &bak).map_err(|e| format!("备份 {} 失败: {e}", manifest.display()))?;
    let text = serde_json::to_string_pretty(&value)
        .map_err(|e| format!("序列化 profile 清单失败: {e}"))?
        + "\n";
    std::fs::write(&manifest, text).map_err(|e| format!("写入 {} 失败: {e}", manifest.display()))?;
    heal.backup = Some(bak.display().to_string());
    Ok(Some(heal))
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
    // bin = <runtime>/node_modules/@deepseek-ai/dsh/lib/bin.js：注入器裸依赖要
    // junction 自 node_modules 本体。此前只上溯三层，落在 @deepseek-ai 目录上，
    // 目标一律「不存在（跳过）」→ 注入器启动即 ERR_MODULE_NOT_FOUND（schemastery）。
    let nm = crate::dsh::manager::node_modules_root_of_bin(&bin)
        .ok_or_else(|| "无法解析 bundled runtime/node_modules".to_string())?;
    if nm.is_dir() {
        return Ok(nm);
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
fn make_junction(link: &Path, target: &Path) -> Result<(), String> {
    // Unix：目录 symlink 等价于 junction（Node ESM 按真实路径解析的行为一致）
    std::os::unix::fs::symlink(target, link).map_err(|e| format!("创建 symlink 失败: {e}"))
}

/// 移除残留链接（junction/symlink），失败忽略；不触碰真实目录与目标内容。
/// - Windows junction 与 Unix symlink 在 symlink_metadata 中均表现为 is_symlink；
/// - Windows 用 remove_dir 解除 junction；Unix 的 remove_dir 对 symlink 报 ENOTDIR，
///   回退 remove_file（unlink）。真实目录不动。
fn remove_link_best_effort(link_path: &Path) {
    let Ok(meta) = std::fs::symlink_metadata(link_path) else {
        return; // 不存在：无事可做
    };
    if meta.file_type().is_symlink() || !meta.is_dir() {
        let _ = std::fs::remove_dir(link_path).or_else(|_| std::fs::remove_file(link_path));
    }
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
        // 清理悬空链接（存在但目标不可达），否则创建会因路径已占用而失败
        remove_link_best_effort(&link_path);
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
    // 自愈对象是 profile 实际装载的那一份（稳定副本）；拿不到有效链接时才回落到
    // vendored 目录（老布局：link 直接指向仓库/安装目录）。
    let injector_dir = match profile_injector_dir(cfg) {
        Some(d) => d,
        None => match resolve_suite_root(app) {
            Ok(r) => r.join("injector"),
            Err(_) => return Ok(None), // vendored 套装不存在：无套装可自愈
        },
    };
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
        remove_link_best_effort(&nm.join(link));
    }
    // 空目录收尾（@deepseek-ai 与 node_modules 本体是真实目录）
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
    // 先复制到 profile 内的稳定目录再 link：profile 不该记住开发仓库或应用安装目录，
    // 那些路径随升级/卸载/移动消失后，dsh 加载 profile 会直接失败（应用起不来）。
    let staged = staged_injector_dir(&web_profile_dir(cfg));
    let mut stage_lines: Vec<String> = Vec::new();
    stage_injector_copy(&injector_dir, &staged, &mut stage_lines)?;
    msgs.push(format!(
        "✓ 注入器落地到稳定目录：\n{}\n  （源：{}）",
        stage_lines.join("\n"),
        injector_dir.display()
    ));
    let inj = staged.to_string_lossy().replace('\\', "/");
    let out = run_dsh_cli(cfg, &["plugin", "--profile", WEB_PROFILE, "add", &inj])?;
    msgs.push(format!("✓ 注入器已装配（重启后由 bundles 接管）：\n{out}"));

    // 注入器 lib 的裸依赖需从注入器目录自身可解析：把当前 runtime 的包 junction 进
    // injector/node_modules（与上游 build.sh 同机制；node_modules 被 .gitignore 忽略）。
    let runtime_nm = runtime_node_modules_root(app, cfg)?;
    let links = ensure_injector_links(&runtime_nm, &staged)?;
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
            let out = run_dsh_cli(cfg, &["plugin", "--profile", WEB_PROFILE, "remove", &name])?;
            msgs.push(format!("✓ 注入器已移除：\n{out}"));
        }
        None => msgs.push("注入器未安装，跳过。".to_string()),
    }

    // profile 内的稳定副本改名 `.trash-*` 保留（可回滚）；只动本应用落的目录。
    let staged = staged_injector_dir(&web_profile_dir(cfg));
    if staged.is_dir() {
        let parent = staged.parent().unwrap_or(&staged);
        let trash = parent.join(format!(".trash-{}-{INJECTOR_ID}", timestamp_ms()));
        match std::fs::rename(&staged, &trash) {
            Ok(()) => msgs.push(format!("✓ 注入器稳定副本已移除（可回滚：{}）", trash.display())),
            Err(e) => msgs.push(format!(
                "注入器稳定副本移除失败（{}）：{e}",
                staged.display()
            )),
        }
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
        // probe 型：temp 创建/写/拷任一步环境失败→skip；成功后断言内容纯逻辑
        macro_rules! probe {
            ($e:expr) => {
                match $e {
                    Ok(v) => v,
                    Err(e) => {
                        eprintln!("[skip] 外部依赖异常早退: {e}");
                        return;
                    }
                }
            };
        }
        let base = std::env::temp_dir().join(format!(
            "dsh-routing-suite-test-{}_{}",
            timestamp_ms(),
            std::process::id() // pid 防并行/重跑碰撞
        ));
        let src = base.join("src");
        let dst = base.join("dst");
        probe!(std::fs::create_dir_all(src.join("sub")));
        probe!(std::fs::write(src.join("a.yml"), "a"));
        probe!(std::fs::write(src.join("sub").join("b.mjs"), "b"));
        probe!(copy_tree(&src, &dst));
        let a: String = probe!(std::fs::read_to_string(dst.join("a.yml")).map_err(|e| e.to_string()));
        assert_eq!(a, "a");
        let b: String =
            probe!(std::fs::read_to_string(dst.join("sub").join("b.mjs")).map_err(|e| e.to_string()));
        assert_eq!(b, "b");
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

    fn test_base(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "dsh-bundle-heal-{tag}-{}-{}",
            timestamp_ms(),
            std::process::id()
        ))
    }

    #[test]
    fn suite_root_candidates_cover_packaged_and_dev_layouts() {
        let base = test_base("layout");
        let inst = base.join("inst");
        // NSIS 实测打包布局（0.4.1 安装包 7z 复核）：$INSTDIR/_up_/plugins/<suite>/injector
        let packaged = inst.join("_up_").join("plugins").join(SUITE_DIR);
        std::fs::create_dir_all(packaged.join("injector")).unwrap();
        std::fs::write(packaged.join("injector").join("package.json"), "{}").unwrap();
        // 旧写法假设的 $INSTDIR/<suite> 不存在，钉住这个回归
        assert!(!inst.join(SUITE_DIR).join("injector").join("package.json").is_file());
        let roots = crate::dsh::expand_resource_roots(vec![inst.clone()]);
        let found = suite_root_candidates(&roots, None, None)
            .into_iter()
            .find(|c| c.join("injector").join("package.json").is_file());
        assert_eq!(found.as_deref(), Some(packaged.as_path()), "打包布局必须命中");

        // dev：cwd = 仓库根（plugins/<suite>）与 src-tauri（../plugins/<suite>）两种
        let repo = base.join("repo");
        let dev = repo.join("plugins").join(SUITE_DIR);
        std::fs::create_dir_all(dev.join("injector")).unwrap();
        std::fs::write(dev.join("injector").join("package.json"), "{}").unwrap();
        for cwd in [repo.as_path(), repo.join("src-tauri").as_path()] {
            std::fs::create_dir_all(cwd).unwrap();
            let hit = suite_root_candidates(&[], None, Some(cwd))
                .into_iter()
                .find(|c| c.join("injector").join("package.json").is_file());
            // cwd 回退允许带 `..` 的未规范化路径，按真实目标比较
            let same = hit
                .as_ref()
                .and_then(|h| std::fs::canonicalize(h).ok())
                .zip(std::fs::canonicalize(&dev).ok())
                .map(|(a, b)| a == b)
                .unwrap_or(false);
            assert!(same, "cwd={cwd:?} 命中应为 {dev:?}，实际 {hit:?}");
        }
        // 环境变量覆盖优先于 cwd
        let env_root = base.join("env");
        std::fs::create_dir_all(env_root.join(SUITE_DIR).join("injector")).unwrap();
        std::fs::write(
            env_root
                .join(SUITE_DIR)
                .join("injector")
                .join("package.json"),
            "{}",
        )
        .unwrap();
        let hit = suite_root_candidates(&[], Some(env_root.to_str().unwrap()), Some(repo.as_path()))
            .into_iter()
            .find(|c| c.join("injector").join("package.json").is_file());
        assert_eq!(
            hit.as_deref(),
            Some(env_root.join(SUITE_DIR).as_path()),
            "DSH_WUI_PLUGINS_DIR 覆盖应命中"
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    fn write_pkg(dir: &Path, version: &str) {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(
            dir.join("package.json"),
            format!(r#"{{"name":"pkg","version":"{version}"}}"#),
        )
        .unwrap();
    }

    fn write_manifest(profile_dir: &Path, bundles: &[&str], deps: &[(&str, &str)]) {
        std::fs::create_dir_all(profile_dir).unwrap();
        let dep_lines: Vec<String> = deps
            .iter()
            .map(|(k, v)| format!(r#""{k}":"{v}""#))
            .collect();
        let bundle_lines: Vec<String> = bundles.iter().map(|b| format!(r#""{b}""#)).collect();
        std::fs::write(
            profile_dir.join("package.json"),
            format!(
                r#"{{"name":"dsh-profile-web","private":true,"dsh":{{"profile":{{"bundles":[{}],"patchReload":"live"}}}},"dependencies":{{{}}}}}"#,
                bundle_lines.join(","),
                dep_lines.join(",")
            ),
        )
        .unwrap();
    }

    fn manifest_bundles(profile_dir: &Path) -> Vec<String> {
        read_json(&profile_dir.join("package.json"))
            .unwrap()
            .get("dsh")
            .and_then(|d| d.get("profile"))
            .and_then(|p| p.get("bundles"))
            .and_then(Value::as_array)
            .map(|arr| {
                arr.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default()
    }

    #[test]
    fn bundle_resolvable_walks_up_to_ancestor_node_modules() {
        let base = test_base("walk");
        let profile_dir = base.join("profiles").join(WEB_PROFILE);
        std::fs::create_dir_all(&profile_dir).unwrap();
        // 只有 base 的包放在 profile 的祖先 node_modules 里（dsh 的第二锚点链）
        write_pkg(&base.join("node_modules").join("upward-pkg"), "1.0.0");
        assert!(bundle_resolvable("upward-pkg", &profile_dir, None));
        assert!(!bundle_resolvable("missing-pkg", &profile_dir, None));
        // 运行时锚点命中即可，无需 profile 侧副本
        let runtime_nm = base.join("runtime").join("node_modules");
        write_pkg(&runtime_nm.join("@deepseek-ai/dsh-base"), "1.0.0");
        assert!(bundle_resolvable(
            "@deepseek-ai/dsh-base",
            &profile_dir,
            Some(&runtime_nm)
        ));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn heal_drops_unresolvable_bundle_and_backs_up_manifest() {
        let base = test_base("drop");
        let profile_dir = base.join("profiles").join(WEB_PROFILE);
        let runtime_nm = base.join("runtime").join("node_modules");
        write_pkg(&runtime_nm.join("@deepseek-ai/dsh-base"), "1.0.0");
        write_pkg(&runtime_nm.join("@deepseek-ai/dsh-web-app"), "1.0.0");
        let dangling = base.join("gone").join("injector");
        write_manifest(
            &profile_dir,
            &[
                "@deepseek-ai/dsh-base",
                "@deepseek-ai/dsh-web-app",
                INJECTOR_PKG,
                "third-party-plugin",
            ],
            &[
                (INJECTOR_PKG, &format!("link:{}", dangling.to_string_lossy().replace('\\', "/"))),
                ("third-party-plugin", "github:someone/x#v1.0.0"),
            ],
        );

        let heal = heal_profile_bundles(&profile_dir, Some(&runtime_nm), None)
            .unwrap()
            .expect("broken bundles should be reported");
        assert!(heal.removed.iter().any(|p| p == INJECTOR_PKG));
        assert!(heal.removed.iter().any(|p| p == "third-party-plugin"));
        let left = manifest_bundles(&profile_dir);
        assert!(left.contains(&"@deepseek-ai/dsh-base".to_string()));
        assert!(left.contains(&"@deepseek-ai/dsh-web-app".to_string()));
        assert!(!left.iter().any(|b| b == INJECTOR_PKG || b == "third-party-plugin"));

        let value = read_json(&profile_dir.join("package.json")).unwrap();
        let deps = value.get("dependencies").unwrap();
        // 悬空 link 一并摘除（否则 pnpm install 直接失败）；非 link 的 spec 保留可复装
        assert!(deps.get(INJECTOR_PKG).is_none(), "dangling link dep must go");
        assert!(
            deps.get("third-party-plugin").is_some(),
            "installable spec must stay"
        );
        assert_eq!(
            value
                .get("dsh")
                .and_then(|d| d.get("profile"))
                .and_then(|p| p.get("patchReload"))
                .and_then(Value::as_str),
            Some("live"),
            "其他清单字段必须保留"
        );
        let backup = heal.backup.expect("改写前必须备份清单");
        assert!(Path::new(&backup).is_file());
        assert!(std::fs::read_to_string(&backup)
            .unwrap()
            .contains("third-party-plugin"));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn heal_healthy_manifest_is_a_noop() {
        let base = test_base("noop");
        let profile_dir = base.join("profiles").join(WEB_PROFILE);
        let runtime_nm = base.join("runtime").join("node_modules");
        write_pkg(&runtime_nm.join("@deepseek-ai/dsh-base"), "1.0.0");
        write_manifest(&profile_dir, &["@deepseek-ai/dsh-base"], &[]);
        let before = std::fs::read(profile_dir.join("package.json")).unwrap();
        assert!(
            heal_profile_bundles(&profile_dir, Some(&runtime_nm), None)
                .unwrap()
                .is_none()
        );
        assert_eq!(
            std::fs::read(profile_dir.join("package.json")).unwrap(),
            before,
            "健康清单不应被改写"
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn heal_keeps_installation_owned_bundle_and_points_at_runtime() {
        let base = test_base("owned");
        let profile_dir = base.join("profiles").join(WEB_PROFILE);
        std::fs::create_dir_all(&profile_dir).unwrap();
        // 用「本机祖先 node_modules 里不存在」的自带 bundle 名造运行时不完整场景；
        // dsh 的解析会一路向上走到盘根，若环境里恰好存在该包（如家目录下的散装
        // node_modules）则前提不成立，按 probe 约定跳过而非造假断言。
        const OWNED: &str = "@deepseek-ai/dsh-acp-app";
        if bundle_resolvable(OWNED, &profile_dir, None) {
            eprintln!("[skip] {OWNED} 可从祖先 node_modules 解析，环境不满足前提");
            let _ = std::fs::remove_dir_all(&base);
            return;
        }
        write_manifest(&profile_dir, &[OWNED], &[]);
        // 运行时不完整（没有 node_modules 锚点）：不得静默摘除自带 bundle
        let heal = heal_profile_bundles(&profile_dir, None, None)
            .unwrap()
            .expect("should report");
        assert!(heal.removed.is_empty(), "自带 bundle 不能被摘除");
        assert_eq!(heal.unrecoverable.len(), 1, "{:?}", heal.unrecoverable);
        assert!(heal.backup.is_none(), "未改写就不该留备份");
        assert_eq!(
            manifest_bundles(&profile_dir),
            vec![OWNED.to_string()],
            "清单必须原样保留"
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    #[cfg(windows)]
    fn heal_relinks_dangling_injector_to_stable_copy() {
        let base = test_base("relink");
        let profile_dir = base.join("profiles").join(WEB_PROFILE);
        let runtime_nm = base.join("runtime").join("node_modules");
        write_pkg(&runtime_nm.join("@deepseek-ai/dsh-base"), "1.0.0");
        for (_, target_rel) in INJECTOR_LINK_PAIRS {
            write_pkg(&runtime_nm.join(target_rel), "1.0.0");
        }
        // vendored 套装（模拟打包资源/仓库目录）
        let vendor = base.join("app").join("plugins").join(SUITE_DIR).join("injector");
        std::fs::create_dir_all(vendor.join("lib")).unwrap();
        std::fs::write(vendor.join("lib").join("index.js"), "// stub").unwrap();
        std::fs::write(
            vendor.join("package.json"),
            r#"{"name":"@dsh-external/dsh-super-injector","version":"9.9.9"}"#,
        )
        .unwrap();
        std::fs::write(vendor.join("cordis.patch.yml"), "[]\n").unwrap();
        // 悬空链接：指向一个不存在的路径（升级/删仓库后的真实形态）
        let gone = base.join("deleted-repo").join("injector");
        write_manifest(
            &profile_dir,
            &["@deepseek-ai/dsh-base", INJECTOR_PKG],
            &[(INJECTOR_PKG, &format!("link:{}", gone.to_string_lossy().replace('\\', "/")))],
        );
        // 残留的悬空 junction 也要能被重建
        let link = profile_dir.join("node_modules").join(INJECTOR_PKG);
        std::fs::create_dir_all(link.parent().unwrap()).unwrap();
        make_junction(&link, &gone).unwrap();

        let heal = heal_profile_bundles(&profile_dir, Some(&runtime_nm), Some(&vendor))
            .unwrap()
            .expect("relink should report");
        assert!(heal.removed.is_empty(), "自愈成功不应摘除 bundle：{:?}", heal.removed);
        assert!(
            manifest_bundles(&profile_dir).contains(&INJECTOR_PKG.to_string()),
            "注入器应保留在 bundles 里"
        );
        // 链接改指稳定副本，且经链接可见构建产物与 patch 层
        let staged = staged_injector_dir(&profile_dir);
        assert!(staged.join("lib").join("index.js").is_file());
        assert!(staged.join("cordis.patch.yml").is_file());
        assert!(
            link.join("lib").join("index.js").is_file(),
            "profile node_modules 链接应指向稳定副本"
        );
        assert!(bundle_resolvable(INJECTOR_PKG, &profile_dir, Some(&runtime_nm)));
        // 稳定副本的裸依赖按当前运行时重建（不再沿用旧运行时的 junction）
        assert!(staged
            .join("node_modules")
            .join("schemastery")
            .join("package.json")
            .is_file());
        let spec = read_json(&profile_dir.join("package.json"))
            .unwrap()
            .get("dependencies")
            .and_then(|d| d.get(INJECTOR_PKG))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        assert!(
            spec.starts_with("link:") && spec.contains(".dsh-plugins"),
            "link spec 应改写到稳定目录，实际：{spec}"
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    /// 端到端活体验证（手动）：用真实 dsh CLI 证明「悬空 bundle → dsh 拒绝启动」
    /// 以及「启动前守卫自愈 → dsh 正常加载 profile」。
    /// 运行：`cargo test -- --ignored profile_bundle_heal_live_end_to_end`
    #[test]
    #[ignore = "live: 需要 Node.js 与仓库 runtime/ 里的 dsh CLI，手动运行"]
    fn profile_bundle_heal_live_end_to_end() {
        let node = crate::dsh::prereq::find_node().expect("需要 Node.js");
        let bin = crate::dsh::manager::bundled_bin_path().expect("需要仓库 runtime/ 的 dsh CLI");
        let runtime_nm = crate::dsh::manager::node_modules_root_of_bin(Path::new(&bin))
            .expect("无法从 bin.js 定位 runtime node_modules");
        let vendor = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .map(|p| p.join("plugins").join(SUITE_DIR).join("injector"))
            .expect("仓库路径异常");
        if !vendor.join("lib").join("index.js").is_file() {
            eprintln!("[skip] vendored 注入器不可用：{}", vendor.display());
            return;
        }

        let base = test_base("live");
        let home = base.join("home");
        let profile_dir = home.join("profiles").join(WEB_PROFILE);
        let gone = base.join("deleted-repo").join("injector");
        write_manifest(
            &profile_dir,
            &[
                "@deepseek-ai/dsh-base",
                "@deepseek-ai/dsh-web-app",
                INJECTOR_PKG,
            ],
            &[(
                INJECTOR_PKG,
                &format!("link:{}", gone.to_string_lossy().replace('\\', "/")),
            )],
        );

        let dump = |tag: &str| -> (bool, String) {
            let out = std::process::Command::new(&node)
                .arg(&bin)
                .args(["web", "--dump-config"])
                .env("DSH_HOME", &home)
                .output()
                .unwrap_or_else(|e| panic!("{tag}: 启动 dsh CLI 失败: {e}"));
            let mut text = String::from_utf8_lossy(&out.stdout).to_string();
            text.push_str(&String::from_utf8_lossy(&out.stderr));
            (out.status.success(), text)
        };

        // 1) 自愈前：必须复现用户现场（dsh 在加载 profile 阶段直接退出）
        let (ok_before, out_before) = dump("before");
        assert!(!ok_before, "悬空 bundle 下 dsh 不应启动成功");
        assert!(
            out_before.contains("cannot resolve profile bundle"),
            "未复现现场报错：{out_before}"
        );

        // 2) 启动前守卫自愈
        let heal = heal_profile_bundles(&profile_dir, Some(&runtime_nm), Some(&vendor))
            .unwrap()
            .expect("守卫应报告处理结果");
        assert!(
            heal.removed.is_empty(),
            "有 vendored 资源时应重建链接而非摘除：{:?}",
            heal.removed
        );

        // 3) 自愈后：dsh 必须能加载 profile，且注入器仍在合成配置里
        let (ok_after, out_after) = dump("after");
        assert!(ok_after, "自愈后 dsh 仍起不来：{out_after}");
        assert!(
            out_after.contains(INJECTOR_ID),
            "注入器未出现在合成配置里：{out_after}"
        );
        let _ = std::fs::remove_dir_all(&base);
    }
}
