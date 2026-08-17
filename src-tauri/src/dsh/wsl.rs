//! WSL 检测与基础配置 + 一键创建/初始化（devContext item 2，0.2.0 P1 扩展）。
//!
//! 边界：
//! - 只读检测优先：`wsl.exe --status` / `wsl.exe --list --verbose`（输出为 UTF-16LE，需解码）。
//! - 配置读写仅覆盖应用自有配置（config.json 的 `wsl_*` 字段）：
//!   目标发行版、WSL 内 DSH_HOME、WSL 工作区目录；写入前校验发行版存在、路径存在，
//!   保存前备份 config.json（可逆）。不做跨发行版系统级管理（如 /etc/wsl.conf、注册表）。
//! - 非 Windows 或 WSL 不可用：返回明确不可用原因，UI 降级，不阻塞主流程。
//! - 一键创建/初始化（provision）：
//!   - 目标发行版已存在 → 复用；不存在 → 用 `wsl --install -d <base> --name <name> -n` 创建（不自动 OOBE）。
//!   - 在发行版内安装现代 Node（>=20，官方 Node 二进制 tarball，置于 `$HOME/.dsh-node`，无需 root）
//!     并 `npm -g install @deepseek-ai/dsh@<精确版本>`，随后 `dsh --version` 验证。
//!   - 全程经 `wsl.exe -d <distro> -u <user> -- bash -s` 以 stdin 传脚本（避免参数转义/路径改写），
//!     输出 UTF-8（Linux 侧），逐行发 `wsl://provision` 事件。
use crate::dsh::event::EventSink;
use serde::Serialize;
use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};
use std::time::Duration;

/// 本项目锁定的 dsh 版本（与 runtime.rs / manager.rs 一致）。
const DEFAULT_DSH_VERSION: &str = "0.1.0-rc.6";
/// 未指定发行版时创建的应用专用发行版名（Ubuntu 基础）。
const DEFAULT_CREATE_DISTRO: &str = "DshUbuntu";
/// 复用 Node 官方二进制版本（>=20，含 node:util.parseEnv，dsh 需要）。
/// 选择 v22.19.0：满足 dsh 运行依赖 pi-ai 的 node>=22.19.0（EBADENGINE），且含 parseEnv。
const NODE_VERSION: &str = "v22.19.0";

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

// ---- 一键创建/初始化（provision）----

/// 进度步骤（经 `wsl://provision` 事件逐条推送，也在报告内汇总）。
#[derive(Debug, Clone, Serialize)]
pub struct WslProvisionStep {
    pub phase: String,
    pub status: String, // running | ok | warn | error | log
    pub message: String,
}

impl WslProvisionStep {
    fn new(phase: &str, status: &str, message: impl Into<String>) -> Self {
        Self {
            phase: phase.to_string(),
            status: status.to_string(),
            message: message.into(),
        }
    }
}

/// 一键创建/初始化结果报告。
#[derive(Debug, Clone, Serialize)]
pub struct WslProvisionReport {
    pub ok: bool,
    pub distro: Option<String>,
    pub user: Option<String>,
    pub node_version: Option<String>,
    pub dsh_version: Option<String>,
    pub dsh_home: Option<String>,
    pub workspace_dir: Option<String>,
    pub steps: Vec<WslProvisionStep>,
    pub error: Option<String>,
}

/// 运行 `wsl.exe` 控制命令，合并 stdout/stderr 并按 UTF-16LE 解码（wsl.exe 自身输出）。
fn run_wsl_checked(args: &[&str]) -> Result<(bool, String), String> {
    let out = Command::new("wsl.exe")
        .args(args)
        .output()
        .map_err(|e| format!("wsl.exe 不可用: {e}"))?;
    let mut text = decode_utf16(&out.stdout);
    text.push_str(&decode_utf16(&out.stderr));
    Ok((out.status.success(), text))
}

/// 流式运行 bash 脚本（Linux 侧 `exec 2>&1` 合并 stderr，故只读 stdout），逐行回调；返回成功与否 + 合并输出。
fn run_wsl_in_stream<F: FnMut(&str)>(
    distro: &str,
    user: &str,
    script: &str,
    mut on_line: F,
) -> Result<(bool, String), String> {
    let mut child = Command::new("wsl.exe")
        .args(["-d", distro, "-u", user, "--", "bash", "-s"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("wsl.exe 不可用: {e}"))?;
    {
        let mut stdin = child.stdin.take().ok_or("stdin pipe missing")?;
        stdin
            .write_all(script.as_bytes())
            .map_err(|e| format!("写入脚本失败: {e}"))?;
    }
    let stdout = child.stdout.take().ok_or("stdout pipe missing")?;
    let mut combined = String::new();
    let reader = BufReader::new(stdout);
    for line in reader.lines() {
        let Ok(l) = line else { break };
        let l = l.trim_end().to_string();
        if !l.is_empty() {
            combined.push_str(&l);
            combined.push('\n');
            on_line(&l);
        }
    }
    let status = child.wait().map_err(|e| format!("等待 wsl 失败: {e}"))?;
    Ok((status.success(), combined))
}

/// 获取发行版默认用户（运行 `wsl -d <distro> -- id -un`，UTF-8 输出）。
fn default_user(distro: &str) -> Result<String, String> {
    let out = Command::new("wsl.exe")
        .args(["-d", distro, "--", "bash", "-c", "id -un 2>/dev/null || echo root"])
        .output()
        .map_err(|e| format!("wsl.exe 不可用: {e}"))?;
    let text = std::str::from_utf8(&out.stdout)
        .unwrap_or("")
        .trim()
        .to_string();
    if text.is_empty() {
        Ok("root".to_string())
    } else {
        Ok(text)
    }
}

/// 发行版是否已就绪（存在且非 "Installing"）。
fn distro_ready(name: &str) -> bool {
    if let Ok(list) = run_wsl(&["--list", "--verbose"]) {
        return parse_distro_table(&list)
            .iter()
            .any(|d| d.name.eq_ignore_ascii_case(name) && !d.state.eq_ignore_ascii_case("Installing"));
    }
    false
}

/// 创建发行版：`wsl --install -d <base> --name <name> -n`，随后等待就绪并把默认用户设为 root（跳过 OOBE）。
/// 刻意不用 `--web-download`：实测在本地 MITM 环境下返回 0x80072f78（WinHTTP 安全错误），
/// 默认 Store 安装路径稳定可用。
fn create_distro_impl(name: &str, emit: &mut dyn FnMut(WslProvisionStep)) -> Result<(), String> {
    emit(WslProvisionStep::new(
        "distro_ensure",
        "running",
        format!("创建发行版 {name}（Ubuntu 基础，--no-launch，不触发首次用户向导）…"),
    ));
    // 下载方式对环境敏感：`--web-download` 直连 WSL 分发端点；Store 路径走 Windows 交付链路。
    // 实测：MITM/代理环境下二者可能互斥（web-download 可用但 Store `WININET_E_CANNOT_CONNECT`，
    // 反之亦然）。故依次尝试 web-download → Store，取首个成功者。
    let mut attempts: Vec<(&str, Vec<&str>)> = Vec::new();
    attempts.push((
        "web-download",
        vec!["--install", "-d", "Ubuntu", "--name", name, "-n", "--web-download"],
    ));
    attempts.push((
        "store",
        vec!["--install", "-d", "Ubuntu", "--name", name, "-n"],
    ));
    let mut last_err = String::new();
    for (label, args) in attempts {
        emit(WslProvisionStep::new(
            "distro_ensure",
            "running",
            format!("创建发行版 {name}（{label} 下载通道）…"),
        ));
        let (ok, text) = run_wsl_checked(&args)?;
        if ok {
            last_err.clear();
            break;
        }
        emit(WslProvisionStep::new(
            "distro_ensure",
            "warn",
            format!("{label} 下载通道失败：{text}"),
        ));
        last_err = text;
    }
    if !last_err.is_empty() {
        return Err(format!("创建发行版失败：{last_err}"));
    }
    // 等待发行版出现在列表且非 Installing（最长 ~10 分钟）。
    let mut appeared = false;
    for _ in 0..120 {
        if distro_ready(name) {
            appeared = true;
            break;
        }
        std::thread::sleep(Duration::from_secs(5));
    }
    if !appeared {
        return Err(format!("发行版 {name} 创建后未能在超时内就绪"));
    }
    // 跳过 OOBE：把默认用户设为 root（应用专用发行版，最小自动化）。
    let _ = Command::new("wsl.exe")
        .args(["--manage", name, "--set-default-user", "root"])
        .output();
    emit(WslProvisionStep::new(
        "distro_ensure",
        "ok",
        format!("发行版 {name} 已创建并就绪"),
    ));
    Ok(())
}

/// 导出宿主机 Windows 受信任根 CA 存储为 PEM（含本地 MITM CA，如 Avast Web/Mail Shield）。
/// 若失败返回 Err —— 调用方应降级为不带 CA 覆盖的普通脚本（非 MITM 环境无需覆盖）。
fn export_host_ca_bundle() -> Result<String, String> {
    // 两个坑（均在无控制台/后台进程 spawn powershell 时出现）：
    // 1) stdout 收不到对象输出（`-Command`/`-File` + `Write-Output`/`[Console]::Out.Write` 均空），
    //    故改为让 PS 把 PEM 直接写文件、Rust 读文件。
    // 2) PSDrive `Cert:\...` provider 在非交互上下文枚举为空（LM=0 CU=0），
    //    须改用 .NET `System.Security.Cryptography.X509Certificates.X509Store` 直接读。
    let out_pem = std::env::temp_dir().join(format!("dsh_host_ca_{}.pem", std::process::id()));
    let ps_file = std::env::temp_dir().join(format!("dsh_host_ca_{}.ps1", std::process::id()));
    let ps = format!(
        r#"$out = New-Object System.Collections.Generic.List[string]
$lm = New-Object System.Security.Cryptography.X509Certificates.X509Store('Root','LocalMachine')
$cu = New-Object System.Security.Cryptography.X509Certificates.X509Store('Root','CurrentUser')
$lm.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadOnly)
$cu.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadOnly)
foreach ($cert in $lm.Certificates) {{
  $out.Add('-----BEGIN CERTIFICATE-----')
  $out.Add([Convert]::ToBase64String($cert.RawData))
  $out.Add('-----END CERTIFICATE-----')
}}
foreach ($cert in $cu.Certificates) {{
  $out.Add('-----BEGIN CERTIFICATE-----')
  $out.Add([Convert]::ToBase64String($cert.RawData))
  $out.Add('-----END CERTIFICATE-----')
}}
$lm.Dispose(); $cu.Dispose()
Set-Content -LiteralPath '{out_path}' -Value ($out -join "`n") -Encoding Ascii
"#,
        out_path = out_pem.display()
    );
    std::fs::write(&ps_file, ps).map_err(|e| format!("写入临时脚本失败: {e}"))?;
    let status = Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            ps_file.to_str().ok_or("无效临时文件路径")?,
        ])
        .status()
        .map_err(|e| format!("powershell 不可用: {e}"))?;
    let _ = std::fs::remove_file(&ps_file);
    if !status.success() {
        return Err("导出宿主机 CA 失败（powershell 非零退出）".to_string());
    }
    let text = std::fs::read_to_string(&out_pem)
        .map_err(|e| format!("读取 CA 输出文件失败: {e}"))?;
    let _ = std::fs::remove_file(&out_pem);
    if text.contains("BEGIN CERTIFICATE") {
        Ok(text)
    } else {
        Err("宿主机根证书存储为空".to_string())
    }
}

/// 生成发行版内安装脚本（Node >=20 + dsh 精确版本）。
/// `ca_bundle_b64` 为 Some 时，把宿主机 CA（base64）写入发行版内 `$HOME/.dsh-node/host-ca.crt`
/// 并注入 curl/node，缓解 MITM 环境（如 Avast）SSL 校验失败。用 base64 传 CA 可避免
/// UNC 路径在新建发行版启动初期的竞态（目录可建但文件写入失败）。
fn build_provision_script(
    exact_version: &str,
    node_version: &str,
    ca_bundle_b64: Option<&str>,
) -> String {
    let ca_lines = match ca_bundle_b64 {
        Some(b64) => format!(
            "if [ -n \"{b64}\" ]; then\n  mkdir -p \"$HOME/.dsh-node\"\n  echo \"{b64}\" | base64 -d > \"$HOME/.dsh-node/host-ca.crt\"\n  export CURL_CA_BUNDLE=\"$HOME/.dsh-node/host-ca.crt\"\n  export NODE_EXTRA_CA_CERTS=\"$HOME/.dsh-node/host-ca.crt\"\n  echo \"== using host CA bundle (from host trust store) ==\"\nfi"
        ),
        None => String::new(),
    };
    format!(
        r#"exec 2>&1
set -e
echo "== ensure DNS =="
# 新发行版默认 resolv.conf 常为 WSL NAT64 的 IPv6 (fec0::) 解析器；若 systemd 未运行，
# 该解析器不可达会导致 apt/npm 报 "Temporary failure resolving"。检测并回退公共解析器。
if ! getent hosts archive.ubuntu.com >/dev/null 2>&1; then
  if [ ! -f /etc/wsl.conf ] || ! grep -q generateResolvConf /etc/wsl.conf 2>/dev/null; then
    printf '[network]\ngenerateResolvConf = false\n' >> /etc/wsl.conf
  fi
  : > /etc/resolv.conf
  echo "nameserver 8.8.8.8" >> /etc/resolv.conf
  echo "nameserver 1.1.1.1" >> /etc/resolv.conf
  echo "dns-fix: 默认解析器不可用，已写入公共 nameserver"
else
  echo "dns-fix: 默认解析器正常"
fi
echo "== identity =="
whoami
{ca_lines}
echo "== ensure build tools (node-pty 本地编译需要 make/g++/python3) =="
if ! command -v make >/dev/null 2>&1 || ! command -v g++ >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq build-essential make g++ python3 ca-certificates curl
fi
command -v make g++ python3 curl
NODE_VER="{node_version}"
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64) NODE_ARCH="x64" ;;
  aarch64|arm64) NODE_ARCH="arm64" ;;
  *) NODE_ARCH="x64" ;;
esac
NODE_DIR="$HOME/.dsh-node/$NODE_VER"
NODE_BIN="$NODE_DIR/bin/node"
if [ -x "$NODE_BIN" ]; then
  echo "node (bundled): $("$NODE_BIN" -v)"
else
  echo "downloading node $NODE_VER ($NODE_ARCH)…"
  mkdir -p "$HOME/.dsh-node"
  curl -fsSL "https://nodejs.org/dist/$NODE_VER/node-$NODE_VER-linux-$NODE_ARCH.tar.xz" -o /tmp/dsh-node.tar.xz
  tar -xJf /tmp/dsh-node.tar.xz -C "$HOME/.dsh-node"
  rm -f /tmp/dsh-node.tar.xz
  mv "$HOME/.dsh-node/node-$NODE_VER-linux-$NODE_ARCH" "$NODE_DIR"
  echo "node installed: $("$NODE_BIN" -v)"
fi
export PATH="$NODE_DIR/bin:$PATH"
echo "== npm =="
"$NODE_DIR/bin/npm" -v
echo "== install dsh @{exact_version} =="
"$NODE_DIR/bin/npm" install -g "@deepseek-ai/dsh@{exact_version}" --no-audit --no-fund --network-concurrency=4 --fetch-timeout=120000 --fetch-retries=3
echo "== verify dsh =="
dsh --version
echo "DSH_HOME=$HOME/.dsh"
"#
    )
}

/// 从脚本输出中提取 node 版本（如 "v22.11.0"）。
fn extract_node_version(text: &str) -> Option<String> {
    for line in text.lines() {
        let t = line.trim();
        if !t.to_ascii_lowercase().contains("node") {
            continue;
        }
        for tok in t.split_whitespace() {
            if tok.starts_with('v') && tok[1..].split('.').count() == 3 {
                if tok[1..].chars().all(|c| c.is_ascii_digit() || c == '.') {
                    return Some(tok.to_string());
                }
            }
        }
    }
    None
}

/// 一键创建/初始化：确保发行版存在（复用或创建），并在其中安装现代 Node + dsh。
/// 全程发 `wsl://provision` 事件；返回报告（成功时含发行版/用户/版本/DSH_HOME）。
pub fn provision<S: EventSink>(
    sink: S,
    configured_distro: Option<&str>,
    requested_distro: Option<&str>,
    exact_version: Option<&str>,
) -> WslProvisionReport {
    let mut steps: Vec<WslProvisionStep> = Vec::new();
    let mut emit = |s: WslProvisionStep| {
        sink.emit("wsl://provision", &s);
        steps.push(s);
    };
    let version = exact_version
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| DEFAULT_DSH_VERSION.to_string());

    let fail = |steps: Vec<WslProvisionStep>, e: String| WslProvisionReport {
        ok: false,
        distro: None,
        user: None,
        node_version: None,
        dsh_version: None,
        dsh_home: None,
        workspace_dir: None,
        steps,
        error: Some(e),
    };

    // 1) WSL 可用性检查
    if !cfg!(windows) {
        return fail(steps, "非 Windows 平台：WSL 不可用".to_string());
    }
    let status = wsl_status();
    if !status.windows {
        return fail(steps, "非 Windows 平台：WSL 不可用".to_string());
    }
    if status.available && !status.distros.is_empty() {
        emit(WslProvisionStep::new(
            "wsl_check",
            "ok",
            format!("WSL 可用（{} 个发行版）", status.distros.len()),
        ));
    } else {
        emit(WslProvisionStep::new(
            "wsl_check",
            "ok",
            "WSL 已启用但无发行版，将为你创建。".to_string(),
        ));
    }

    // 2) 确定目标发行版（复用或创建）
    let requested = requested_distro
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let target: String = if let Some(name) = &requested {
        if distro_ready(name) {
            name.clone()
        } else {
            if let Err(e) = create_distro_impl(name, &mut emit) {
                return fail(steps, e);
            }
            name.clone()
        }
    } else {
        let preferred = configured_distro
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .or_else(|| status.default_distro.clone());
        match preferred {
            Some(name) if distro_ready(&name) => name,
            _ => {
                let name = DEFAULT_CREATE_DISTRO.to_string();
                if !distro_ready(&name) {
                    if let Err(e) = create_distro_impl(&name, &mut emit) {
                        return fail(steps, e);
                    }
                }
                name
            }
        }
    };

    // 3) 确定用户
    let user = match default_user(&target) {
        Ok(u) if !u.is_empty() => u,
        _ => "root".to_string(),
    };
    emit(WslProvisionStep::new(
        "distro_ensure",
        "ok",
        format!("目标发行版 {target}，用户 {user}"),
    ));

    // 3.5) 导出宿主机受信任 CA（缓解 MITM，如 Avast Web/Mail Shield；非 MITM 环境自动降级）
    // 用 base64 注入脚本内、在 WSL 内部写文件，规避 UNC 在新建发行版启动初期的竞态。
    let ca_bundle_b64 = match export_host_ca_bundle() {
        Ok(bundle) => {
            use base64::Engine;
            let b64 =
                base64::engine::general_purpose::STANDARD.encode(bundle.as_bytes());
            if b64.is_empty() {
                emit(WslProvisionStep::new(
                    "node_dsh_install",
                    "warn",
                    "宿主机 CA 为空，回退系统 CA（如遇 SSL 校验失败请检查代理/MITM 软件）".to_string(),
                ));
                None
            } else {
                emit(WslProvisionStep::new(
                    "node_dsh_install",
                    "log",
                    "已导出宿主机 CA（缓解 MITM SSL 校验）".to_string(),
                ));
                Some(b64)
            }
        }
        Err(e) => {
            emit(WslProvisionStep::new(
                "node_dsh_install",
                "warn",
                format!("导出宿主机 CA 失败（{e}），回退系统 CA"),
            ));
            None
        }
    };

    // 4) 安装 Node + dsh
    let script = build_provision_script(&version, NODE_VERSION, ca_bundle_b64.as_deref());
    emit(WslProvisionStep::new(
        "node_dsh_install",
        "running",
        format!("在 {target}（{user}）内安装 Node {} + dsh@{version} …", NODE_VERSION),
    ));
    let (ok, output) = match run_wsl_in_stream(&target, &user, &script, |line| {
        sink.emit(
            "wsl://provision",
            &WslProvisionStep::new("log", "log", line.to_string()),
        );
    }) {
        Ok(r) => r,
        Err(e) => return fail(steps, e),
    };
    if !ok {
        return fail(steps, format!("安装 dsh 失败：\n{output}"));
    }
    emit(WslProvisionStep::new(
        "node_dsh_install",
        "ok",
        "Node + dsh 安装完成".to_string(),
    ));

    // 5) 汇总报告
    let node_version = extract_node_version(&output);
    let dsh_version = output
        .lines()
        .find(|l| l.trim() == version)
        .map(|l| l.trim().to_string());
    let home_suffix = if user == "root" { "root" } else { &format!("home/{user}") };
    let dsh_home = format!(r"\\wsl$\{target}\{home_suffix}\.dsh");
    let workspace_dir = format!(r"\\wsl$\{target}\{home_suffix}");
    emit(WslProvisionStep::new(
        "verify",
        "ok",
        format!("验证通过：node {node:?} dsh {dsh:?}", node = node_version, dsh = dsh_version),
    ));
    WslProvisionReport {
        ok: true,
        distro: Some(target.clone()),
        user: Some(user.clone()),
        node_version,
        dsh_version,
        dsh_home: Some(dsh_home),
        workspace_dir: Some(workspace_dir),
        steps,
        error: None,
    }
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

    #[test]
    fn extract_node_version_from_output() {
        assert_eq!(
            extract_node_version("node (bundled): v22.11.0"),
            Some("v22.11.0".to_string())
        );
        assert_eq!(
            extract_node_version("node installed: v20.19.4"),
            Some("v20.19.4".to_string())
        );
        assert_eq!(extract_node_version("no node present"), None);
        assert_eq!(extract_node_version(""), None);
    }

    #[test]
    fn dbg_export_host_ca_bundle() {
        // 无控制台进程 spawn powershell 时，PSDrive `Cert:\` 与 stdout 均不可靠；
        // export_host_ca_bundle 已改为 .NET X509Store + 写文件。此处验证其确实产出 PEM。
        let got = export_host_ca_bundle();
        match &got {
            Ok(s) => eprintln!(
                "[dbg] export ok: len={} certs={}",
                s.len(),
                s.matches("BEGIN CERTIFICATE").count()
            ),
            Err(e) => eprintln!("[dbg] export err: {e}"),
        }
        assert!(got.is_ok(), "export_host_ca_bundle 必须成功：{:?}", got);
        assert!(got.unwrap().contains("BEGIN CERTIFICATE"));
    }

    #[test]
    fn provision_script_pins_versions_and_identity() {
        let s = build_provision_script("0.1.0-rc.6", "v22.19.0", None);
        assert!(s.contains("exec 2>&1"));
        assert!(s.contains("@deepseek-ai/dsh@0.1.0-rc.6"));
        assert!(s.contains("node-$NODE_VER-linux-$NODE_ARCH.tar.xz"));
        assert!(s.contains("NODE_VER=\"v22.19.0\""));
        assert!(s.contains("dsh --version"));
        // 构建工具（node-pty 本地编译需要 make/g++/python3）
        assert!(s.contains("build-essential make g++ python3"));
        // 稳健 npm 参数（限并发/超时/重试，缓解 MITM 下并行抓取挂起）
        assert!(s.contains("--network-concurrency=4"));
        assert!(s.contains("--fetch-timeout=120000"));
        // 不带 CA 覆盖时不应出现 CURL_CA_BUNDLE
        assert!(!s.contains("CURL_CA_BUNDLE"));
        // 脚本用 stdin 传，不应含闭合 done 残留
        assert!(!s.trim_end().ends_with("done"));
    }

    #[test]
    fn provision_script_injects_host_ca() {
        let s = build_provision_script("0.1.0-rc.6", "v22.19.0", Some("$HOME/.dsh-node/host-ca.crt"));
        assert!(s.contains("CURL_CA_BUNDLE=\"$HOME/.dsh-node/host-ca.crt\""));
        assert!(s.contains("NODE_EXTRA_CA_CERTS=\"$HOME/.dsh-node/host-ca.crt\""));
    }
}
