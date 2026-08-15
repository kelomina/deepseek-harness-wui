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
use crate::dsh::config::detect_system_proxy;
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use flate2::read::GzDecoder;
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

fn client_with_proxy() -> Result<reqwest::blocking::Client, String> {
    let mut b = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .connect_timeout(std::time::Duration::from_secs(20));
    if let Some(proxy) = detect_system_proxy() {
        if let Ok(p) = reqwest::Proxy::all(&proxy) {
            b = b.proxy(p);
        }
    }
    b.build().map_err(|e| format!("HTTP 客户端初始化失败: {e}"))
}

fn fetch_meta(client: &reqwest::blocking::Client, version: &str) -> Result<RegistryMeta, String> {
    let url = format!("{REGISTRY}/{version}");
    let resp = client
        .get(&url)
        .send()
        .map_err(|e| format!("获取 npm registry 元数据失败: {e}"))?;
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
        .map_err(|e| format!("获取 npm registry 版本列表失败: {e}"))?;
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
        .map_err(|e| format!("下载 tarball 失败: {e}"))?;
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

fn extract_tarball(tarball: &Path, staging: &Path) -> Result<(), String> {
    let file = std::fs::File::open(tarball).map_err(|e| format!("打开 tarball 失败: {e}"))?;
    let gz = GzDecoder::new(file);
    let mut archive = tar::Archive::new(gz);
    archive
        .unpack(staging)
        .map_err(|e| format!("解包 tarball 失败: {e}"))?;
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
        download_and_verify(&client, &meta, &tmp_tarball)?;
        extract_tarball(&tmp_tarball, &staging)?;
        let pkg_staging = staging.join("package");
        let staged_version = read_pkg_version(&pkg_staging)?;
        if staged_version != version {
            return Err(format!(
                "tarball 内 package.json 版本 {staged_version} 与请求版本 {version} 不一致"
            ));
        }
        let target_pkg = pkg_dir_of(&version_dir);
        copy_dir_all(&pkg_staging, &target_pkg)?;
        let bin = bin_path_of(&version_dir);
        if !bin.exists() {
            return Err(format!("安装产物缺少 lib/bin.js（版本 {version} 不可用）"));
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
        assert!(is_exact_version("0.1.0-rc.6"));
        assert!(is_exact_version("0.1.0"));
        assert!(is_exact_version("1.2.3-alpha.1"));
        assert!(!is_exact_version("latest"));
        assert!(!is_exact_version("^0.1.0"));
        assert!(!is_exact_version("~0.1.0"));
        assert!(!is_exact_version(">=0.1.0"));
        assert!(!is_exact_version("0.1"));
        assert!(!is_exact_version("0.1.0 "));
        assert!(!is_exact_version(""));
        assert!(!is_exact_version("0.1.0-rc.6/extra"));
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
    #[ignore = "live: 需要网络访问 npm registry，手动运行 cargo test -- --ignored runtime_live_install_and_verify"]
    fn runtime_live_install_and_verify() {
        // 端到端：从 npm registry 下载 @deepseek-ai/dsh@0.1.0-rc.6，校验 integrity，解包，复验。
        let dir = std::env::temp_dir().join(format!("dsh-runtime-e2e-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let view = install_at(&dir, "0.1.0-rc.6").expect("live install should succeed");
        assert!(view.installed);
        let report = verify_at(&dir, "0.1.0-rc.6").expect("verify");
        assert!(report.ok, "verify failed: {}", report.detail);
        let list = list_at(&dir, Some("0.1.0-rc.6")).expect("list");
        assert!(list.iter().any(|r| r.version == "0.1.0-rc.6" && r.active));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
