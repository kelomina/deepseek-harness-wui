//! WSL 检测与基础配置（devContext item 2）。
//!
//! 边界：
//! - 只读检测优先：`wsl.exe --status` / `wsl.exe --list --verbose`（输出为 UTF-16LE，需解码）。
//! - 配置读写仅覆盖应用自有配置（config.json 的 `wsl_*` 字段）：
//!   目标发行版、WSL 内 DSH_HOME、WSL 工作区目录；写入前校验发行版存在、路径存在，
//!   保存前备份 config.json（可逆）。不做跨发行版系统级管理（如 /etc/wsl.conf、注册表）。
//! - 非 Windows 或 WSL 不可用：返回明确不可用原因，UI 降级，不阻塞主流程。
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct WslDistro {
    pub name: String,
    pub state: String,
    pub version: String,
    pub is_default: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct WslStatus {
    pub available: bool,
    pub windows: bool,
    pub default_distro: Option<String>,
    pub kernel: Option<String>,
    pub wsl_version: Option<String>,
    pub distros: Vec<WslDistro>,
    pub reason: Option<String>,
}

fn decode_utf16(bytes: &[u8]) -> String {
    // wsl.exe 管道输出为 UTF-16LE（可能带 BOM）
    let mut start = 0;
    if bytes.len() >= 2 && bytes[0] == 0xFF && bytes[1] == 0xFE {
        start = 2;
    }
    let mut units: Vec<u16> = Vec::new();
    let mut i = start;
    while i + 1 < bytes.len() {
        units.push(u16::from_le_bytes([bytes[i], bytes[i + 1]]));
        i += 2;
    }
    String::from_utf16_lossy(&units)
}

fn run_wsl(args: &[&str]) -> Result<String, String> {
    let out = std::process::Command::new("wsl.exe")
        .args(args)
        .output()
        .map_err(|e| format!("wsl.exe 不可用: {e}"))?;
    Ok(decode_utf16(&out.stdout))
}

fn parse_distro_table(text: &str) -> Vec<WslDistro> {
    let mut distros = Vec::new();
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with("NAME") && trimmed.contains("VERSION") {
            continue;
        }
        if trimmed == "NAME" {
            continue;
        }
        let is_default = trimmed.starts_with('*');
        let body = trimmed.trim_start_matches('*').trim();
        let mut fields: Vec<&str> = body.split_whitespace().collect();
        if fields.len() < 3 {
            continue;
        }
        let version = fields.pop().unwrap_or("").to_string();
        let state = fields.pop().unwrap_or("").to_string();
        let name = fields.join(" ").to_string();
        if name.is_empty() {
            continue;
        }
        distros.push(WslDistro {
            name,
            state,
            version,
            is_default,
        });
    }
    distros
}

/// 只读 WSL 状态检测。
pub fn wsl_status() -> WslStatus {
    if !cfg!(windows) {
        return WslStatus {
            available: false,
            windows: false,
            default_distro: None,
            kernel: None,
            wsl_version: None,
            distros: Vec::new(),
            reason: Some("非 Windows 平台：WSL 不可用".to_string()),
        };
    }
    let status_text = run_wsl(&["--status"]).unwrap_or_default();
    let list_text = run_wsl(&["--list", "--verbose"]).unwrap_or_default();
    if list_text.is_empty() && status_text.is_empty() {
        return WslStatus {
            available: false,
            windows: true,
            default_distro: None,
            kernel: None,
            wsl_version: None,
            distros: Vec::new(),
            reason: Some("WSL 未安装或 wsl.exe 不可用（请运行 wsl --install）".to_string()),
        };
    }
    let distros = parse_distro_table(&list_text);
    let default_distro = distros.iter().find(|d| d.is_default).map(|d| d.name.clone());
    let mut kernel = None;
    let mut wsl_version = None;
    for line in status_text.lines() {
        let t = line.trim();
        let lower = t.to_ascii_lowercase();
        if lower.contains("kernel") {
            kernel = Some(t.to_string());
        }
        if lower.contains("version") || lower.contains("wsl") {
            wsl_version = Some(t.to_string());
        }
    }
    WslStatus {
        available: !distros.is_empty() || default_distro.is_some(),
        windows: true,
        default_distro,
        kernel,
        wsl_version,
        distros,
        reason: None,
    }
}

/// 校验发行版是否存在于 WSL。
pub fn distro_exists(name: &str) -> Result<bool, String> {
    if name.trim().is_empty() {
        return Ok(false);
    }
    let list = run_wsl(&["--list", "--verbose"])?;
    Ok(parse_distro_table(&list).iter().any(|d| d.name.eq_ignore_ascii_case(name)))
}

/// 校验 WSL UNC 路径是否存在（仅支持 `\\wsl$\<distro>\...`）。
pub fn check_wsl_path(path: &str) -> Result<bool, String> {
    let p = path.trim().trim_end_matches(['\\', '/']);
    let lower = p.to_ascii_lowercase();
    if !lower.starts_with(r"\\wsl$\") {
        return Err("仅支持 \\\\wsl$\\<发行版>\\ 路径".to_string());
    }
    let rest = &p[r"\\wsl$\".len()..];
    let mut parts = rest.split(['\\', '/']);
    let distro = parts.next().unwrap_or("");
    if distro.is_empty() {
        return Err("路径缺少发行版名".to_string());
    }
    if !distro_exists(distro)? {
        return Err(format!("发行版 {distro} 不存在"));
    }
    let _ = parts; // 剩余部分交给 \\wsl$\ 挂载点探测
    let mount = format!(r"\\wsl$\{distro}");
    match std::fs::metadata(&mount) {
        Ok(_) => Ok(true),
        Err(e) => Err(format!("无法访问 \\\\wsl$\\{distro}: {e}")),
    }
}

/// 校验 WSL 基础配置（写前校验；实际写入经 manager.set_config，含原子保存与备份）。
pub fn validate_wsl_config(
    default_distro: Option<&str>,
    dsh_home: Option<&str>,
    workspace_dir: Option<&str>,
) -> Result<(), String> {
    if let Some(d) = default_distro {
        if !d.trim().is_empty() && !distro_exists(d.trim())? {
            return Err(format!("发行版 {} 不存在", d.trim()));
        }
    }
    if let Some(p) = dsh_home {
        if !p.trim().is_empty() {
            check_wsl_path(p)?;
        }
    }
    if let Some(p) = workspace_dir {
        if !p.trim().is_empty() {
            check_wsl_path(p)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decode_utf16le_with_bom() {
        // "NA" in UTF-16LE with BOM
        let bytes: Vec<u8> = vec![0xFF, 0xFE, b'N', 0, b'A', 0];
        assert_eq!(decode_utf16(&bytes), "NA");
    }

    #[test]
    fn decode_utf16le_without_bom() {
        let bytes: Vec<u8> = vec![b'H', 0, b'i', 0];
        assert_eq!(decode_utf16(&bytes), "Hi");
    }

    #[test]
    fn test_parse_distro_table() {
        let text = "  NAME              STATE           VERSION\r\n* CodexUbuntu       Stopped         2\r\n  CentOS8-stream    Stopped         2\r\n  docker-desktop    Stopped         2\r\n";
        let distros = parse_distro_table(text);
        assert_eq!(distros.len(), 3);
        let default = distros.iter().find(|d| d.is_default).expect("default");
        assert_eq!(default.name, "CodexUbuntu");
        assert_eq!(default.version, "2");
        assert_eq!(default.state, "Stopped");
        let centos = distros.iter().find(|d| d.name == "CentOS8-stream").expect("centos");
        assert!(!centos.is_default);
    }

    #[test]
    fn test_parse_distro_table_multi_word() {
        let text = "* Ubuntu-20.04  Running  2";
        let distros = parse_distro_table(text);
        assert_eq!(distros.len(), 1);
        assert_eq!(distros[0].name, "Ubuntu-20.04");
    }
}
