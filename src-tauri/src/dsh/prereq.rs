//! 首启前置条件检测与自动安装（Node.js + dsh 受管运行时入口见 lib.rs 命令）。
//!
//! 边界：
//! - Node 安装包来自 nodejs.org 官方 dist，SHA256 以官方 SHASUMS256.txt 校验，不一致即拒绝安装；
//! - 静默安装需要提权：Windows 走 PowerShell `Start-Process -Verb RunAs`（UAC 弹窗），
//!   macOS 走 osascript `with administrator privileges`（系统密码框）；用户取消即报错返回；
//! - 安装完成后当前进程的 PATH 不刷新：find_node() 会探测已知默认安装位置（绝对路径），
//!   manager 启动 dsh 时优先使用该绝对路径。

use serde::Serialize;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

/// 与 wsl.rs 的 NODE_VERSION 口径一致（pi-ai 引擎要求 node>=22.19.0）。
pub const NODE_PINNED_VERSION: &str = "v22.19.0";
const NODE_DIST: &str = "https://nodejs.org/dist";

#[derive(Debug, Clone, Serialize)]
pub struct PrereqCheck {
    pub ok: bool,
    pub node_path: Option<String>,
    pub node_version: Option<String>,
    /// 受管运行时激活版本（config.managed_runtime_version；None=未设置，走 bundled）
    pub dsh_runtime_version: Option<String>,
    /// 仓库 bundled runtime 是否存在（开发模式路径）
    pub bundled_present: bool,
}

impl PrereqCheck {
    pub fn ok(&self) -> bool {
        self.node_version.is_some() && (self.dsh_runtime_version.is_some() || self.bundled_present)
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct NodeInstallReport {
    pub ok: bool,
    pub node_path: Option<String>,
    pub node_version: Option<String>,
    pub steps: Vec<String>,
    pub error: Option<String>,
}

/// 纯函数：从官方 SHASUMS256.txt 中取指定文件名的 sha256。
fn parse_shasums(text: &str, filename: &str) -> Option<String> {
    for line in text.lines() {
        let mut parts = line.split_whitespace();
        let hash = parts.next()?;
        let name = parts.next()?;
        if name.trim_start_matches('*') == filename {
            return Some(hash.to_string());
        }
    }
    None
}

/// 纯函数：node 版本号（v 前缀可选）是否 >= major.minor。
fn version_at_least(version: &str, major: u32, minor: u32) -> bool {
    let core = version.trim().trim_start_matches('v');
    let core = core.split('-').next().unwrap_or(core);
    let mut it = core.split('.');
    let maj = it.next().and_then(|s| s.parse::<u32>().ok());
    let min = it.next().and_then(|s| s.parse::<u32>().ok());
    match (maj, min) {
        (Some(m), Some(n)) => (m, n) >= (major, minor),
        _ => false,
    }
}

/// 运行一个 node 可执行文件并返回其 --version 输出（失败返回 None）。
fn probe_node(path: &Path) -> Option<String> {
    let out = std::process::Command::new(path).arg("--version").output().ok()?;
    if !out.status.success() {
        return None;
    }
    let v = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if v.starts_with('v') {
        Some(v)
    } else {
        None
    }
}

/// 已知默认安装位置（PATH 未刷新 / 未入 PATH 的兜底）。
fn known_node_candidates() -> Vec<PathBuf> {
    let mut list = Vec::new();
    if cfg!(windows) {
        for var in ["ProgramFiles", "ProgramFiles(x86)", "LocalAppData"] {
            if let Ok(base) = std::env::var(var) {
                list.push(PathBuf::from(base).join("nodejs").join("node.exe"));
            }
        }
    } else {
        for p in ["/usr/local/bin/node", "/opt/homebrew/bin/node", "/usr/bin/node"] {
            list.push(PathBuf::from(p));
        }
    }
    list
}

/// 查找可用 node：先 PATH（`node -p process.execPath` 直接给绝对路径），再已知默认位置。
pub fn find_node() -> Option<PathBuf> {
    if let Ok(out) = std::process::Command::new("node")
        .args(["-p", "process.execPath"])
        .output()
    {
        if out.status.success() {
            let p = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !p.is_empty() {
                let pb = PathBuf::from(&p);
                if probe_node(&pb).is_some() {
                    return Some(pb);
                }
            }
        }
    }
    for cand in known_node_candidates() {
        if cand.exists() && probe_node(&cand).is_some() {
            return Some(cand);
        }
    }
    None
}

/// 当前平台对应的 nodejs.org 发行文件名。
fn asset_name(version: &str) -> Result<String, String> {
    if cfg!(all(windows, target_arch = "x86_64")) {
        Ok(format!("node-{version}-x64.msi"))
    } else if cfg!(all(windows, target_arch = "aarch64")) {
        Ok(format!("node-{version}-arm64.msi"))
    } else if cfg!(target_os = "macos") {
        Ok(format!("node-{version}.pkg"))
    } else {
        Err("当前平台不支持自动安装 Node（请用系统包管理器或 nvm 安装）".to_string())
    }
}

/// 提权静默执行官方安装包。Windows：msiexec /qn 经 PowerShell RunAs；
/// macOS：installer -pkg 经 osascript 管理员权限。
fn run_elevated_installer(pkg: &Path) -> Result<(), String> {
    let pkg_s = pkg.to_string_lossy().to_string();
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let ps = format!(
            "Start-Process -FilePath msiexec -ArgumentList '/i','{pkg_s}','/qn','/norestart' -Verb RunAs -Wait"
        );
        let out = std::process::Command::new("powershell")
            .args(["-NoProfile", "-Command", &ps])
            .creation_flags(0x0800_0000)
            .output()
            .map_err(|e| format!("无法启动 PowerShell（提权安装）: {e}"))?;
        if out.status.success() {
            Ok(())
        } else {
            Err(format!(
                "Node 安装失败或被取消（msiexec exit={}）：{}",
                out.status.code().unwrap_or(-1),
                String::from_utf8_lossy(&out.stderr).trim()
            ))
        }
    }
    #[cfg(not(windows))]
    {
        if !cfg!(target_os = "macos") {
            return Err("当前平台不支持自动安装 Node".to_string());
        }
        let script = format!(
            "do shell script \"/usr/sbin/installer -pkg '{pkg_s}' -target /\" with administrator privileges"
        );
        let out = std::process::Command::new("osascript")
            .args(["-e", &script])
            .output()
            .map_err(|e| format!("无法启动 osascript（提权安装）: {e}"))?;
        if out.status.success() {
            Ok(())
        } else {
            Err(format!(
                "Node 安装失败或被取消：{}",
                String::from_utf8_lossy(&out.stderr).trim()
            ))
        }
    }
}

/// 下载并校验 Node 官方安装包，静默安装（提权），随后重新探测 node。
pub fn install_node() -> NodeInstallReport {
    let mut steps: Vec<String> = Vec::new();
    let version = NODE_PINNED_VERSION;
    macro_rules! fail {
        ($msg:expr) => {{
            let msg: String = $msg.into();
            steps.push(format!("[error] {msg}"));
            return NodeInstallReport { ok: false, node_path: None, node_version: None, steps, error: Some(msg) };
        }};
    }

    let asset = match asset_name(version) {
        Ok(a) => a,
        Err(e) => fail!(e),
    };
    steps.push(format!("目标版本 {version}（{asset}）"));
    let client = match crate::dsh::runtime::client_with_proxy() {
        Ok(c) => c,
        Err(e) => fail!(e),
    };

    // 1. 官方 SHASUMS256.txt 校验基准
    let sums_url = format!("{NODE_DIST}/{version}/SHASUMS256.txt");
    steps.push("获取校验基准 SHASUMS256.txt".to_string());
    let resp = match client.get(&sums_url).send() {
        Ok(r) => r,
        Err(e) => fail!(format!("网络错误: {e}")),
    };
    if !resp.status().is_success() {
        fail!(format!("SHASUMS256.txt 请求失败: HTTP {}", resp.status().as_u16()));
    }
    let sums = resp.text().unwrap_or_default();
    let expected = match parse_shasums(&sums, &asset) {
        Some(h) => h,
        None => fail!(format!("SHASUMS256.txt 中未找到 {asset}（版本/平台不受支持？）")),
    };

    // 2. 下载安装包
    let file_url = format!("{NODE_DIST}/{version}/{asset}");
    steps.push(format!("下载 {file_url}"));
    let resp = match client.get(&file_url).send() {
        Ok(r) => r,
        Err(e) => fail!(format!("下载网络错误: {e}")),
    };
    if !resp.status().is_success() {
        fail!(format!("下载失败: HTTP {}", resp.status().as_u16()));
    }
    let bytes = match resp.bytes() {
        Ok(b) => b,
        Err(e) => fail!(format!("读取响应失败: {e}")),
    };
    let actual = hex::encode(Sha256::digest(&bytes));
    if actual != expected {
        fail!(format!("SHA256 校验失败（禁止安装）：期望 {expected}，实际 {actual}"));
    }
    steps.push(format!("SHA256 校验通过（{} 字节）", bytes.len()));

    // 3. 落盘临时文件
    let tmp = std::env::temp_dir().join(&asset);
    if let Err(e) = std::fs::write(&tmp, &bytes) {
        fail!(format!("写临时文件失败: {e}"));
    }

    // 4. 提权静默安装
    steps.push("执行静默安装（请在弹出的授权窗口确认）…".to_string());
    if let Err(e) = run_elevated_installer(&tmp) {
        let _ = std::fs::remove_file(&tmp);
        fail!(e);
    }
    let _ = std::fs::remove_file(&tmp);

    // 5. 复检（find_node 含已知默认位置兜底）
    match find_node().and_then(|p| probe_node(&p).map(|v| (p, v))) {
        Some((p, v)) if version_at_least(&v, 22, 19) => {
            steps.push(format!("安装完成：{} ({})", p.display(), v));
            NodeInstallReport {
                ok: true,
                node_path: Some(p.to_string_lossy().to_string()),
                node_version: Some(v),
                steps,
                error: None,
            }
        }
        Some((_, v)) => {
            let msg = format!("Node 已存在但版本过低（{v} < v22.19，pi-ai 引擎要求）");
            steps.push(format!("[error] {msg}"));
            NodeInstallReport { ok: false, node_path: None, node_version: Some(v), steps, error: Some(msg) }
        }
        None => fail!("安装后仍未探测到可用 node（可能需要重启应用刷新 PATH）"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_shasums_matches_binary_marker() {
        let txt = "abc123  node-v22.19.0.pkg\ndef456 *node-v22.19.0-x64.msi\n";
        assert_eq!(parse_shasums(txt, "node-v22.19.0.pkg").as_deref(), Some("abc123"));
        assert_eq!(parse_shasums(txt, "node-v22.19.0-x64.msi").as_deref(), Some("def456"));
        assert_eq!(parse_shasums(txt, "missing.msi"), None);
    }

    #[test]
    fn version_at_least_checks_major_minor() {
        assert!(version_at_least("v22.19.0", 22, 19));
        assert!(version_at_least("v23.1.2", 22, 19));
        assert!(!version_at_least("v22.18.0", 22, 19));
        assert!(!version_at_least("18.0.0", 22, 19));
        assert!(!version_at_least("garbage", 22, 19));
    }

    #[test]
    fn find_node_probe_works_on_host() {
        // 主机装有 node 时应能定位；未装时返回 None（两种结果都合法，不硬断言环境）
        let has_node = std::process::Command::new("node")
            .arg("--version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        assert_eq!(find_node().is_some(), has_node);
    }
}
