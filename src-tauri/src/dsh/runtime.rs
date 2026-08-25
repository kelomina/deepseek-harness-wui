//! Managed dsh runtime download/install/verify/rollback (devContext item 3).
//!
//! 事实边界：
//! - `DownloadsApi.sessionLog` 仅是会话日志 ZIP 下载，不是运行时下载（官方类型契约），
//!   因此运行时下载为本模块自研管道。
//! - 首选下载源：npm registry（复用 `runtime/` 先例：`@deepseek-ai/dsh` 精确锁定版本）。
//!   版本元数据来自 registry；校验以 `dist.integrity`（sha512）为必须项。
//! - 备选 GitHub release 仅在官方提供可信发布物时启用（当前版本未启用，记录为后续）。
//!
//! 安装布局（可回滚）：
//!   <root>/<version>/node_modules/@deepseek-ai/dsh/...
//!   <root>/runtimes.json         记录（integrity + bin sha256 + 安装时间）
//!   <root>/.trash-<version>-<ts> 移除时的可逆备份
//! 校验失败 → 禁止安装（不落任何运行时目录）。
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256, Sha512};
use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use tauri::Manager;

const REGISTRY: &str = "https://registry.npmjs.org/@deepseek-ai/dsh";
const PKG_REL: &str = "node_modules/@deepseek-ai/dsh";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstalledRuntime {
    pub version: String,
    /// epoch 毫秒
    pub installed_at: u64,
    /// registry dist.integrity（sha512-...）
    pub integrity: String,
    /// 安装时 lib/bin.js 的 sha256 hex（用于后续完整性复验）
    pub bin_sha256: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct RuntimeView {
    pub version: String,
    pub installed: bool,
    pub installed_at: Option<u64>,
    pub integrity: Option<String>,
    pub bin_sha256: Option<String>,
    /// 当前配置启用的受管版本
    pub active: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct VerifyReport {
    pub version: String,
    pub present: bool,
    pub version_match: bool,
    pub bin_exists: bool,
    pub bin_hash_match: bool,
    pub ok: bool,
    pub detail: String,
}

#[derive(Debug, Clone, Deserialize)]
struct RegistryDist {
    tarball: String,
    integrity: String,
    #[allow(dead_code)] // 备用 sha1 校验信息，主校验为 dist.integrity (sha512)
    shasum: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct RegistryMeta {
    name: String,
    version: String,
    dist: RegistryDist,
}

#[derive(Debug, Clone, Deserialize)]
struct RegistryDoc {
    #[allow(dead_code)] // dist-tags（latest/next 等），备用展示
    dist_tags: BTreeMap<String, String>,
    versions: BTreeMap<String, serde_json::Value>,
}

fn runtimes_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("runtimes"))
}

fn records_path(root: &Path) -> PathBuf {
    root.join("runtimes.json")
}

fn load_records(root: &Path) -> Vec<InstalledRuntime> {
    match std::fs::read_to_string(records_path(root)) {
        Ok(text) => serde_json::from_str(&text).unwrap_or_default(),
        Err(_) => Vec::new(),
    }
}

fn save_records(root: &Path, records: &[InstalledRuntime]) -> Result<(), String> {
    std::fs::create_dir_all(root).map_err(|e| e.to_string())?;
    let path = records_path(root);
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(records).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(&path);
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

/// 严格精确版本校验：禁止范围/通配与首尾空白（`^`,`~`,`>`,`<`,`*`,`latest` 等）。
pub fn is_exact_version(v: &str) -> bool {
    if v.trim() != v {
        return false;
    }
    if v.is_empty() || v.len() > 64 {
        return false;
    }
    let bad = ['^', '~', '>', '<', '*', 'x', 'X', ' ', '\t', '\n', '\r', '/', '\\'];
    if v.chars().any(|c| bad.contains(&c)) {
        return false;
    }
    let core = v.split('-').next().unwrap_or(v);
    let parts: Vec<&str> = core.split('.').collect();
    parts.len() == 3 && parts.iter().all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()))
}

pub(crate) fn client_with_proxy() -> Result<reqwest::blocking::Client, String> {
    let mut b = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .connect_timeout(std::time::Duration::from_secs(20));
    // 代理优先级：环境变量（与 Node 行为一致）→ 平台系统代理探测。
    // 注意：reqwest 启用了 rustls-tls-native-roots（加载系统根证书，兼容自装 MITM CA）。
    let proxy = std::env::var("HTTPS_PROXY")
        .or_else(|_| std::env::var("https_proxy"))
        .or_else(|_| std::env::var("HTTP_PROXY"))
        .or_else(|_| std::env::var("http_proxy"))
        .or_else(|_| std::env::var("ALL_PROXY"))
        .or_else(|_| std::env::var("all_proxy"))
        .ok()
        .filter(|s| !s.trim().is_empty())
        .or_else(crate::dsh::config::detect_system_proxy);
    if let Some(p) = proxy {
        if let Ok(px) = reqwest::Proxy::all(&p) {
            b = b.proxy(px);
        }
    }
    b.build().map_err(|e| format!("HTTP 客户端初始化失败: {e}"))
}

fn fetch_meta(client: &reqwest::blocking::Client, version: &str) -> Result<RegistryMeta, String> {
    let url = format!("{REGISTRY}/{version}");
    let resp = client
        .get(&url)
        .send()
        .map_err(|e| format!("获取 npm registry 元数据失败: {}", err_chain(&e)))?;
    if !resp.status().is_success() {
        return Err(format!(
            "npm registry 返回 {}（版本 {} 不存在或已被移除）",
            resp.status().as_u16(),
            version
        ));
    }
    let meta: RegistryMeta = resp
        .json()
        .map_err(|e| format!("解析 npm 元数据失败: {e}"))?;
    if meta.name != "@deepseek-ai/dsh" || meta.version != version {
        return Err(format!(
            "registry 元数据与请求不一致：name={} version={}（期望 @deepseek-ai/dsh@{version}）",
            meta.name, meta.version
        ));
    }
    Ok(meta)
}

fn fetch_remote_versions(client: &reqwest::blocking::Client) -> Result<Vec<String>, String> {
    let resp = client
        .get(REGISTRY)
        .send()
        .map_err(|e| format!("获取 npm registry 版本列表失败: {}", err_chain(&e)))?;
    if !resp.status().is_success() {
        return Err(format!("npm registry 返回 {}", resp.status().as_u16()));
    }
    let doc: RegistryDoc = resp.json().map_err(|e| format!("解析版本列表失败: {e}"))?;
    let mut versions: Vec<String> = doc.versions.keys().cloned().collect();
    versions.sort();
    Ok(versions)
}

fn sha256_hex(data: &[u8]) -> String {
    let digest = Sha256::digest(data);
    hex::encode(digest)
}

/// 拼接错误原因链（reqwest 的 Display 不含根因，如 TLS/连接拒绝细节）。
fn err_chain(e: &impl std::error::Error) -> String {
    let mut s = e.to_string();
    let mut src = std::error::Error::source(e);
    while let Some(cause) = src {
        s.push_str(&format!(" ← {cause}"));
        src = cause.source();
    }
    s
}

/// 纯函数：校验字节流的 sha512 base64 是否与 npm dist.integrity 一致。
fn check_integrity(data: &[u8], expected_integrity: &str) -> Result<(), String> {
    let expected = expected_integrity
        .strip_prefix("sha512-")
        .ok_or_else(|| format!("dist.integrity 不是 sha512 格式: {expected_integrity}"))?;
    let actual = B64.encode(Sha512::digest(data));
    if actual != expected {
        return Err(format!(
            "sha512 校验失败（禁止安装）：期望 {expected}，实际 {actual}"
        ));
    }
    Ok(())
}

/// 下载 tarball 到临时文件并校验 integrity（必须通过，否则返回 Err 且不安装）。
fn download_and_verify(client: &reqwest::blocking::Client, meta: &RegistryMeta, dest: &Path) -> Result<(), String> {
    let resp = client
        .get(&meta.dist.tarball)
        .send()
        .map_err(|e| format!("下载 tarball 失败: {}", err_chain(&e)))?;
    if !resp.status().is_success() {
        return Err(format!("tarball 下载返回 {}", resp.status().as_u16()));
    }
    let mut file = std::fs::File::create(dest).map_err(|e| format!("创建临时文件失败: {e}"))?;
    let mut data: Vec<u8> = Vec::new();
    let mut reader = resp;
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = reader
            .read(&mut buf)
            .map_err(|e| format!("读取下载流失败: {e}"))?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n]).map_err(|e| format!("写入临时文件失败: {e}"))?;
        data.extend_from_slice(&buf[..n]);
    }
    file.flush().map_err(|e| e.to_string())?;
    drop(file);
    check_integrity(&data, &meta.dist.integrity)?;
    Ok(())
}

fn copy_dir_all(src: &Path, dst: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dst).map_err(|e| format!("创建目录失败: {e}"))?;
    for entry in std::fs::read_dir(src).map_err(|e| format!("读取目录失败: {e}"))? {
        let entry = entry.map_err(|e| e.to_string())?;
        let ty = entry.file_type().map_err(|e| e.to_string())?;
        let target = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_dir_all(&entry.path(), &target)?;
        } else if ty.is_symlink() {
            #[cfg(windows)]
            {
                let link = std::fs::read_link(entry.path()).map_err(|e| e.to_string())?;
                std::os::windows::fs::symlink_dir(&link, &target)
                    .or_else(|_| std::os::windows::fs::symlink_file(&link, &target))
                    .map_err(|e| e.to_string())?;
            }
            #[cfg(not(windows))]
            {
                let link = std::fs::read_link(entry.path()).map_err(|e| e.to_string())?;
                std::os::unix::fs::symlink(&link, &target).map_err(|e| e.to_string())?;
            }
        } else {
            std::fs::copy(entry.path(), &target).map_err(|e| format!("复制文件失败: {e}"))?;
        }
    }
    Ok(())
}

fn pkg_dir_of(version_dir: &Path) -> PathBuf {
    version_dir.join(PKG_REL)
}

fn bin_path_of(version_dir: &Path) -> PathBuf {
    pkg_dir_of(version_dir).join("lib").join("bin.js")
}

fn read_pkg_version(pkg_dir: &Path) -> Result<String, String> {
    let pkg_path = pkg_dir.join("package.json");
    let text = std::fs::read_to_string(&pkg_path).map_err(|e| format!("读取 package.json 失败: {e}"))?;
    let pkg: serde_json::Value = serde_json::from_str(&text).map_err(|e| format!("解析 package.json 失败: {e}"))?;
    Ok(pkg
        .get("version")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string())
}

fn chrono_now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 安装一个精确版本的 dsh 运行时（正式入口，root = app_config_dir/runtimes）。
pub fn install(app: &tauri::AppHandle, version: &str) -> Result<RuntimeView, String> {
    let root = runtimes_root(app)?;
    install_at(&root, version)
}

/// 安装到指定根目录（可测试）。全流程可回滚：任何失败都会清理 staging 与半成品，
/// 不会留下不完整运行时；已存在同版本时拒绝（需先移除）。
///
/// 2026-08-24 修复（mac ERR_MODULE_NOT_FOUND）：此前只解压 `@deepseek-ai/dsh` 单个 tarball，
/// 不解析依赖树；而 bin.js 依赖的 `@deepseek-ai/dsh-app-boot` 等包以 peerDependencies 声明
/// （npm≥7 才会自动安装）。现改为在 staging 内真实执行 `npm install`（Node 自带 npm CLI），
/// 并以「bin.js 可执行冒烟」作为安装成功门禁——缺依赖类问题在安装期即被拦截。
pub fn install_at(root: &Path, version: &str) -> Result<RuntimeView, String> {
    let version = version.trim();
    if !is_exact_version(version) {
        return Err(format!("版本必须是精确锁定版本（禁止范围/通配），收到: {version}"));
    }
    std::fs::create_dir_all(root).map_err(|e| e.to_string())?;
    let version_dir = root.join(version);
    if version_dir.exists() {
        return Err(format!("版本 {version} 已安装；如需重装请先移除（可回滚）"));
    }
    let client = client_with_proxy()?;
    let meta = fetch_meta(&client, version)?;

    let tmp_tarball = std::env::temp_dir().join(format!("dsh-{version}-{}.tgz", std::process::id()));
    let staging = root.join(format!(".staging-{version}"));
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging).map_err(|e| e.to_string())?;

    let result = (|| -> Result<RuntimeView, String> {
        // 1. 下载主包 tarball 并以 registry dist.integrity（sha512）强校验（自控门禁）
        download_and_verify(&client, &meta, &tmp_tarball)?;

        // 2. npm 安装（两阶段 + peer 闭包迭代，全部走 --legacy-peer-deps）：
        //    实测（2026-08-24，Windows）：npm≥7 自动 peer 解析对本依赖图病态慢（>25min）；
        //    legacy 模式 41s 装完 430 包，再按扫描结果显式补 peers（增量 7s），冒烟通过。
        //    staging 必须写显式 package.json 锁定项目根，否则 npm 会向上查找到
        //    祖先 package.json 并装进别人的树（本机复现过）。
        let node = crate::dsh::prereq::find_node()
            .ok_or_else(|| "未找到 Node.js，无法执行 npm install".to_string())?;
        let npm_cli = find_npm_cli(&node)?;
        let tarball_dep = format!("file:{}", tmp_tarball.to_string_lossy().replace('\\', "/"));
        write_staging_manifest(&staging, version, &[("@deepseek-ai/dsh", &tarball_dep)])?;

        let run_npm_install = |extra_note: &str| -> Result<(), String> {
            let output = run_with_timeout(
                &node,
                &[
                    npm_cli.to_string_lossy().as_ref(),
                    "install",
                    "--omit=dev",
                    "--legacy-peer-deps",
                    "--no-audit",
                    "--no-fund",
                    "--loglevel=error",
                    "--no-progress",
                ],
                &staging,
                900_000,
                None,
            )
            .map_err(|e| format!("npm install 失败: {e}"))?;
            if !output.success {
                // 直连失败（ENOTFOUND/ECONN* 等）时带系统代理重试一次
                if looks_like_network_error(&output.combined) {
                    if let Some(proxy) = crate::dsh::config::detect_system_proxy() {
                        eprintln!("[runtime] npm install 直连失败，改用系统代理 {proxy} 重试");
                        let mut envs: Vec<(String, String)> = Vec::new();
                        for key in ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"] {
                            envs.push((key.to_string(), proxy.clone()));
                        }
                        envs.push(("NO_PROXY".to_string(), "localhost,127.0.0.1,::1".to_string()));
                        let retried = run_with_timeout(
                            &node,
                            &[
                                npm_cli.to_string_lossy().as_ref(),
                                "install",
                                "--omit=dev",
                                "--legacy-peer-deps",
                                "--no-audit",
                                "--no-fund",
                                "--loglevel=error",
                                "--no-progress",
                            ],
                            &staging,
                            900_000,
                            Some(&envs),
                        )
                        .map_err(|e| format!("npm install(代理重试) 失败: {e}"))?;
                        if retried.success {
                            return Ok(());
                        }
                        return Err(format!(
                            "npm install{extra_note} 非零退出（code={:?}，含代理重试）:\n{}",
                            retried.code,
                            truncate_tail(&retried.combined, 2_000)
                        ));
                    }
                }
                return Err(format!(
                    "npm install{extra_note} 非零退出（code={:?}）:\n{}",
                    output.code,
                    truncate_tail(&output.combined, 2_000)
                ));
            }
            Ok(())
        };

        run_npm_install("（主包）")?;

        // 3. peer 闭包迭代：把已安装包声明的非可选 peerDependencies 显式补齐。
        //    （legacy-peer-deps 不自动装 peer；其中部分是运行时真实 import 需求，
        //    如 dsh-app-boot → cordis-plugin-group。每轮增量安装为秒级。）
        for round in 1..=5u32 {
            let node_modules = staging.join("node_modules");
            let missing = scan_missing_peers(&node_modules);
            if missing.is_empty() {
                break;
            }
            eprintln!("[runtime] peer 闭包第 {round} 轮：补装 {} 个缺失 peer", missing.len());
            let refs: Vec<(&str, &str)> =
                missing.iter().map(|(n, r)| (n.as_str(), r.as_str())).collect();
            write_staging_manifest(&staging, version, &refs)?;
            run_npm_install(&format!("（peer 第 {round} 轮）"))?;
            if round == 5 {
                return Err("peer 闭包 5 轮仍未收敛（依赖图异常），已中止".to_string());
            }
        }

        // 4. 校验主包：版本精确匹配 + lib/bin.js 存在
        let pkg_dir = staging.join(PKG_REL);
        let staged_version = read_pkg_version(&pkg_dir)?;
        if staged_version != version {
            return Err(format!(
                "npm 安装产物版本 {staged_version} 与请求版本 {version} 不一致"
            ));
        }
        let staged_bin = pkg_dir.join("lib").join("bin.js");
        if !staged_bin.exists() {
            return Err(format!("安装产物缺少 lib/bin.js（版本 {version} 不可用）"));
        }

        // 5. 启动冒烟：任何残余依赖缺失（ERR_MODULE_NOT_FOUND）在此暴露并中止安装
        let smoke = run_with_timeout(
            &node,
            &[staged_bin.to_string_lossy().as_ref(), "--version"],
            &pkg_dir,
            60_000,
            None,
        );
        match smoke {
            Ok(out) if out.success => {}
            Ok(out) => {
                return Err(format!(
                    "bin.js 启动冒烟失败（依赖不完整或不可执行，code={:?}）:\n{}",
                    out.code,
                    truncate_tail(&out.combined, 2_000)
                ));
            }
            Err(e) => return Err(format!("bin.js 启动冒烟超时/失败: {e}")),
        }

        // 6. 搬运完整依赖树 + 记录（integrity 取 registry dist.integrity 作为版本指纹）
        let target_node_modules = version_dir.join("node_modules");
        copy_dir_all(&staging.join("node_modules"), &target_node_modules)?;
        let bin = bin_path_of(&version_dir);
        if !bin.exists() {
            return Err(format!("搬运后缺少 lib/bin.js（版本 {version}）"));
        }
        let bin_bytes = std::fs::read(&bin).map_err(|e| format!("读取 bin.js 失败: {e}"))?;
        let bin_sha256 = sha256_hex(&bin_bytes);
        let mut records = load_records(root);
        records.retain(|r| r.version != version);
        records.push(InstalledRuntime {
            version: version.to_string(),
            installed_at: chrono_now_ms(),
            integrity: meta.dist.integrity.clone(),
            bin_sha256: bin_sha256.clone(),
        });
        save_records(root, &records)?;
        Ok(RuntimeView {
            version: version.to_string(),
            installed: true,
            installed_at: Some(chrono_now_ms()),
            integrity: Some(meta.dist.integrity),
            bin_sha256: Some(bin_sha256),
            active: false,
        })
    })();

    let _ = std::fs::remove_file(&tmp_tarball);
    let _ = std::fs::remove_dir_all(&staging);
    match result {
        Ok(view) => Ok(view),
        Err(e) => {
            let _ = std::fs::remove_dir_all(&version_dir);
            Err(e)
        }
    }
}

/// staging 内写入显式 package.json：锁定 npm 项目根（防止向上查找到祖先
/// package.json 把依赖装进别人的树），并声明当前需要补装的精确依赖集。
fn write_staging_manifest(staging: &Path, version: &str, deps: &[(&str, &str)]) -> Result<(), String> {
    use serde_json::Value;
    let mut dep_map = serde_json::Map::new();
    for (name, range) in deps {
        dep_map.insert((*name).to_string(), Value::String((*range).to_string()));
    }
    // 保留既有 dependencies（增量合并），避免每轮覆盖已装 peer 声明
    let manifest_path = staging.join("package.json");
    let mut root: serde_json::Map<String, Value> = match std::fs::read_to_string(&manifest_path) {
        Ok(text) => serde_json::from_str(&text).unwrap_or_default(),
        Err(_) => serde_json::Map::new(),
    };
    if !root.contains_key("name") {
        root.insert("name".to_string(), Value::String("dsh-runtime-staging".to_string()));
    }
    root.insert("private".to_string(), Value::Bool(true));
    let existing = root.entry("dependencies").or_insert_with(|| Value::Object(Default::default()));
    if let Some(obj) = existing.as_object_mut() {
        for (k, v) in dep_map {
            obj.insert(k, v);
        }
    }
    std::fs::write(
        &manifest_path,
        serde_json::to_string_pretty(&Value::Object(root)).map_err(|e| e.to_string())?,
    )
    .map_err(|e| format!("写入 staging package.json 失败: {e}"))
}

/// 遍历 node_modules（含 scope 包），收集所有非可选 peerDependencies 中
/// 尚未存在于树内的 (name, requestedRange)。存在性检查 scope-aware。
fn scan_missing_peers(node_modules: &Path) -> Vec<(String, String)> {
    let mut peers: BTreeMap<String, String> = BTreeMap::new();
    fn scan_pkg(dir: &Path, peers: &mut BTreeMap<String, String>) {
        let manifest_path = dir.join("package.json");
        let Ok(text) = std::fs::read_to_string(&manifest_path) else { return };
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else { return };
        let Some(peer_deps) = value.get("peerDependencies").and_then(|v| v.as_object()) else { return };
        let optional_meta = value.get("peerDependenciesMeta").and_then(|v| v.as_object());
        for (name, range) in peer_deps {
            let optional = optional_meta
                .and_then(|m| m.get(name))
                .and_then(|m| m.get("optional"))
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            if !optional {
                peers.insert(name.clone(), range.as_str().unwrap_or("*").to_string());
            }
        }
    }
    let Ok(entries) = std::fs::read_dir(node_modules) else { return Vec::new() };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || name.starts_with('@') {
            // scope 目录：遍历其下每个包
            if let Ok(scope_entries) = std::fs::read_dir(&path) {
                for scoped in scope_entries.flatten() {
                    scan_pkg(&scoped.path(), &mut peers);
                }
            }
            continue;
        }
        scan_pkg(&path, &mut peers);
    }
    peers
        .into_iter()
        .filter(|(name, _)| !node_modules.join(name).exists())
        .collect()
}

/// 粗判 npm 输出是否为网络类失败（用于决定是否带系统代理重试）。
fn looks_like_network_error(output: &str) -> bool {
    const MARKERS: [&str; 8] = [
        "ENOTFOUND", "ECONNREFUSED", "ETIMEDOUT", "ECONNRESET", "EAI_AGAIN",
        "fetch failed", "network", "getaddrinfo",
    ];
    let lower = output.to_ascii_lowercase();
    MARKERS.iter().any(|m| lower.contains(&m.to_ascii_lowercase()))
}

/// 定位随 Node 分发的 npm CLI 入口（npm-cli.js），多候选回退：
/// Windows `<node>/node_modules/npm/bin/npm-cli.js`；unix `<node>/../lib/node_modules/npm/bin/npm-cli.js`；
/// 兜底 PATH 中的 npm（macOS/Linux）。
fn find_npm_cli(node: &Path) -> Result<PathBuf, String> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(dir) = node.parent() {
        candidates.push(dir.join("node_modules").join("npm").join("bin").join("npm-cli.js"));
        candidates.push(dir.join("..").join("lib").join("node_modules").join("npm").join("bin").join("npm-cli.js"));
    }
    for cand in candidates {
        if cand.is_file() {
            return Ok(cand);
        }
    }
    // 兜底：PATH 中可执行的 npm（unix 直接可用；Windows 的 npm.cmd 由调用方经 node 规避）
    #[cfg(unix)]
    {
        let out = std::process::Command::new("which")
            .arg("npm")
            .output()
            .map_err(|e| format!("查找 npm 失败: {e}"))?;
        let p = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if !p.is_empty() && PathBuf::from(&p).exists() {
            // which 命中的可能是 shim；优先其指向的真实 cli 由 npm 自身处理，直接返回 shim 路径交给系统执行器
            return Ok(PathBuf::from(p));
        }
    }
    Err("未找到 npm CLI（npm-cli.js）；请确认 Node.js 安装完整（npm 随 Node 分发）".to_string())
}

struct ProcOutput {
    success: bool,
    code: Option<i32>,
    combined: String,
}

/// 带超时的同步进程执行（stdout+stderr 合并截断）；超时强杀。
fn run_with_timeout(
    program: &Path,
    args: &[&str],
    cwd: &Path,
    timeout_ms: u64,
    envs: Option<&[(String, String)]>,
) -> Result<ProcOutput, String> {
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};
    let mut cmd = Command::new(program);
    cmd.args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(envs) = envs {
        for (k, v) in envs {
            cmd.env(k, v);
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = cmd.spawn().map_err(|e| format!("启动 {} 失败: {e}", program.display()))?;
    let deadline = Instant::now() + Duration::from_millis(timeout_ms);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let mut stdout = child.stdout.take().map(|mut s| {
                    let mut buf = String::new();
                    let _ = std::io::Read::read_to_string(&mut s, &mut buf);
                    buf
                }).unwrap_or_default();
                let stderr = child.stderr.take().map(|mut s| {
                    let mut buf = String::new();
                    let _ = std::io::Read::read_to_string(&mut s, &mut buf);
                    buf
                }).unwrap_or_default();
                stdout.push_str(&stderr);
                return Ok(ProcOutput {
                    success: status.success(),
                    code: status.code(),
                    combined: stdout,
                });
            }
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!("超时（{timeout_ms}ms）已终止"));
                }
                std::thread::sleep(Duration::from_millis(200));
            }
            Err(e) => return Err(format!("等待进程失败: {e}")),
        }
    }
}

fn truncate_tail(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let cut = &s[s.len() - max..];
    format!("…（前文截断）{cut}")
}

/// 列出所有已安装运行时（正式入口）。
pub fn list(app: &tauri::AppHandle, active_version: Option<&str>) -> Result<Vec<RuntimeView>, String> {
    let root = runtimes_root(app)?;
    list_at(&root, active_version)
}

/// 按根目录列出（可测试）。
pub fn list_at(root: &Path, active_version: Option<&str>) -> Result<Vec<RuntimeView>, String> {
    let records = load_records(root);
    let mut out: Vec<RuntimeView> = Vec::new();
    if std::fs::create_dir_all(root).is_ok() {
        if let Ok(entries) = std::fs::read_dir(root) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if name.starts_with('.') || name.starts_with("runtimes.json") {
                    continue;
                }
                let pkg_dir = pkg_dir_of(&entry.path());
                if let Ok(v) = read_pkg_version(&pkg_dir) {
                    let rec = records.iter().find(|r| r.version == v);
                    out.push(RuntimeView {
                        version: v.clone(),
                        installed: true,
                        installed_at: rec.map(|r| r.installed_at),
                        integrity: rec.map(|r| r.integrity.clone()),
                        bin_sha256: rec.map(|r| r.bin_sha256.clone()),
                        active: active_version == Some(v.as_str()),
                    });
                }
            }
        }
    }
    out.sort_by(|a, b| a.version.cmp(&b.version));
    Ok(out)
}

/// 复验已安装运行时的完整性（正式入口）。
pub fn verify(app: &tauri::AppHandle, version: &str) -> Result<VerifyReport, String> {
    let root = runtimes_root(app)?;
    verify_at(&root, version)
}

/// 按根目录复验（可测试）。
pub fn verify_at(root: &Path, version: &str) -> Result<VerifyReport, String> {
    let version_dir = root.join(version);
    if !version_dir.exists() {
        return Ok(VerifyReport {
            version: version.to_string(),
            present: false,
            version_match: false,
            bin_exists: false,
            bin_hash_match: false,
            ok: false,
            detail: format!("版本 {version} 未安装"),
        });
    }
    let pkg_dir = pkg_dir_of(&version_dir);
    let installed_version = read_pkg_version(&pkg_dir).unwrap_or_default();
    let version_match = installed_version == version;
    let bin = bin_path_of(&version_dir);
    let bin_exists = bin.exists();
    let mut bin_hash_match = false;
    let mut detail = String::new();
    if bin_exists {
        if let Ok(bytes) = std::fs::read(&bin) {
            let actual = sha256_hex(&bytes);
            let rec = load_records(root).into_iter().find(|r| r.version == version);
            if let Some(r) = rec {
                bin_hash_match = actual == r.bin_sha256;
                detail = if bin_hash_match {
                    format!("bin.js sha256 一致（{}）", &actual[..16])
                } else {
                    format!("bin.js sha256 与安装记录不一致（实际 {}，记录 {}）", &actual[..16], &r.bin_sha256[..16])
                };
            } else {
                detail = "无安装记录（无法比对）".to_string();
            }
        }
    }
    let ok = version_match && bin_exists && bin_hash_match;
    Ok(VerifyReport {
        version: version.to_string(),
        present: true,
        version_match,
        bin_exists,
        bin_hash_match,
        ok,
        detail,
    })
}

/// 移除（可逆）：把运行时目录移动到 .trash-<version>-<ts>。
pub fn remove(app: &tauri::AppHandle, version: &str) -> Result<String, String> {
    let root = runtimes_root(app)?;
    let version_dir = root.join(version);
    if !version_dir.exists() {
        return Err(format!("版本 {version} 未安装"));
    }
    let ts = chrono_now_ms();
    let trash = root.join(format!(".trash-{version}-{ts}"));
    std::fs::rename(&version_dir, &trash).map_err(|e| format!("移动到备份失败: {e}"))?;
    let mut records = load_records(&root);
    records.retain(|r| r.version != version);
    save_records(&root, &records)?;
    Ok(trash.to_string_lossy().to_string())
}

/// 回滚：从 .trash-<version>-* 恢复。
pub fn rollback(app: &tauri::AppHandle, version: &str) -> Result<String, String> {
    let root = runtimes_root(app)?;
    let version_dir = root.join(version);
    if version_dir.exists() {
        return Err(format!("版本 {version} 已存在，无法回滚（请先移除）"));
    }
    let mut trash: Vec<PathBuf> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&root) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with(&format!(".trash-{version}-")) {
                trash.push(entry.path());
            }
        }
    }
    trash.sort();
    let latest = trash.last().ok_or_else(|| format!("没有可回滚的备份（版本 {version}）"))?;
    std::fs::rename(latest, &version_dir).map_err(|e| format!("回滚失败: {e}"))?;
    let records = load_records(&root);
    save_records(&root, &records)?;
    Ok(version_dir.to_string_lossy().to_string())
}

/// 远程可用版本列表（只读网络操作；失败不阻塞本地管理）。
pub fn remote_versions() -> Result<Vec<String>, String> {
    let client = client_with_proxy()?;
    fetch_remote_versions(&client)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_version_validation() {
        assert!(is_exact_version("0.1.1-rc.2"));
        assert!(is_exact_version("0.1.0"));
        assert!(is_exact_version("1.2.3-alpha.1"));
        assert!(!is_exact_version("latest"));
        assert!(!is_exact_version("^0.1.0"));
        assert!(!is_exact_version("~0.1.0"));
        assert!(!is_exact_version(">=0.1.0"));
        assert!(!is_exact_version("0.1"));
        assert!(!is_exact_version("0.1.0 "));
        assert!(!is_exact_version(""));
        assert!(!is_exact_version("0.1.1-rc.2/extra"));
    }

    #[test]
    fn integrity_check_ok_and_tamper() {
        let data = b"hello dsh runtime";
        let digest = Sha512::digest(data);
        let b64 = B64.encode(digest);
        let expected = format!("sha512-{b64}");
        assert!(check_integrity(data, &expected).is_ok());
        assert!(check_integrity(b"tampered", &expected).is_err());
        assert!(check_integrity(data, "sha256-xxxx").is_err());
    }

    #[test]
    fn integrity_check_uses_registry_contract() {
        // registry 的 dist.integrity 口径：sha512-<base64>，与本模块算法一致
        let data = b"fixture";
        let digest = Sha512::digest(data);
        let expected = format!("sha512-{}", B64.encode(digest));
        assert!(expected.starts_with("sha512-"));
        assert!(check_integrity(data, &expected).is_ok());
    }

    #[test]
    #[ignore = "live: 需要网络访问 npm registry + npm install，手动运行 cargo test -- --ignored runtime_live_install_and_verify"]
    fn runtime_live_install_and_verify() {
        // 端到端：下载 @deepseek-ai/dsh@0.1.1-rc.2 → sha512 校验 → npm install 全依赖树
        // → bin.js 启动冒烟（依赖缺失在此暴露）→ 复验。
        let dir = std::env::temp_dir().join(format!("dsh-runtime-e2e-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let view = install_at(&dir, "0.1.1-rc.2").expect("live install should succeed");
        assert!(view.installed);
        let report = verify_at(&dir, "0.1.1-rc.2").expect("verify");
        assert!(report.ok, "verify failed: {}", report.detail);
        let list = list_at(&dir, Some("0.1.1-rc.2")).expect("list");
        assert!(list.iter().any(|r| r.version == "0.1.1-rc.2" && r.active));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn find_npm_cli_resolves_bundled_npm() {
        let node = crate::dsh::prereq::find_node().expect("node should exist in dev/CI env");
        let cli = find_npm_cli(&node).expect("npm-cli.js ships with Node");
        assert!(cli.is_file(), "cli path: {}", cli.display());
    }

    #[test]
    fn run_with_timeout_captures_output_and_exit_code() {
        let node = crate::dsh::prereq::find_node().unwrap();
        let cwd = std::env::temp_dir();
        let out = run_with_timeout(
            &node,
            &["-e", "process.stdout.write('ok-marker')"],
            &cwd,
            10_000,
            None,
        )
        .unwrap();
        assert!(out.success);
        assert_eq!(out.code, Some(0));
        assert!(out.combined.contains("ok-marker"), "combined: {}", out.combined);
    }

    #[test]
    fn run_with_timeout_kills_hanging_process() {
        let node = crate::dsh::prereq::find_node().unwrap();
        let cwd = std::env::temp_dir();
        let started = std::time::Instant::now();
        let result = run_with_timeout(
            &node,
            &["-e", "setInterval(() => {}, 1000)"],
            &cwd,
            1_500,
            None,
        );
        assert!(result.is_err(), "expected timeout error");
        assert!(
            started.elapsed() < std::time::Duration::from_secs(30),
            "should return promptly after timeout"
        );
    }

    #[test]
    fn run_with_timeout_injects_env() {
        let node = crate::dsh::prereq::find_node().unwrap();
        let cwd = std::env::temp_dir();
        let envs = vec![("HTTPS_PROXY".to_string(), "http://probe-host:1".to_string())];
        let out = run_with_timeout(
            &node,
            &["-e", "process.stdout.write(String(process.env.HTTPS_PROXY))"],
            &cwd,
            5_000,
            Some(&envs),
        )
        .unwrap();
        assert!(out.combined.contains("http://probe-host:1"), "combined: {}", out.combined);
    }

    #[test]
    fn truncate_tail_keeps_tail_and_marks_cut() {
        let long = format!("{}tail-marker", "a".repeat(3_000));
        let cut = truncate_tail(&long, 100);
        assert!(cut.starts_with('…'));
        assert!(cut.contains("tail-marker"), "tail must be preserved: {cut}");
        assert!(cut.chars().count() < 3_000);
        assert_eq!(truncate_tail("short", 100), "short");
    }
}
