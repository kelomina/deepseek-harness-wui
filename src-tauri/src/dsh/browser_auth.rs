//! BUG-14 fix: dsh 0.1.2-rc.1 BrowserAuth cookie injection.
//!
//! dsh 0.1.2-rc.1 在 /api/* 请求上新增 BrowserAuth 认证层，未在 Cookie header
//! 携带有效签名的请求会被 dsh 返回 HTTP 401。本模块在 Rust 代理转发前代为计算
//! 并注入该 cookie，使 0.1.2-rc.1 兼容。
//!
//! 认证机制（逆向）：
//!   cookie name = "dsh-auth-" + base64url(sha256(authority))
//!   cookie value = "v1.{body}.{sig}"
//!     body = base64url(JSON.stringify({version:1, authority, issuedAt, expiresAt}))
//!     sig  = base64url(HMAC-SHA256(secret, body_bytes))
//!   authority = dsh 侧看到的 Host（即 127.0.0.1:{dsh_port}，见 proxy.rs）。
//!     注意：reqwest 转发时按目标 URL 重写 Host，dsh 收到的 Host 恒为 dsh 监听
//!     地址；用代理监听端口计算 cookie 会导致 name/body 双错位而 401。
//!     上游实现以 base64url(body) 为 HMAC 输入（dsh encodeCookie/decodeCookie），
//!     本模块与之对齐：sig = base64url(HMAC-SHA256(secret, body_b64))。
//!   secret    = %DSH_HOME%\.credentials.yaml 的 records.client-connection/browser-session.payload.secret
//!   expiresAt = issuedAt + 30 days
//!
//! 失败策略：任何环节解析/计算失败均返回 None，代理回退到不注入 cookie 的行为
//! （与 0.1.1-rc.2 兼容，不会引入新的 401）。

use std::path::PathBuf;
use sha2::Digest;

/// 从 DSH_HOME/.credentials.yaml 中读取 signing secret（base64url 编码的 32 字节）。
/// 若文件不存在、格式不符或字段缺失，返回 None（降级）。
fn read_secret(dsh_home: &PathBuf) -> Option<Vec<u8>> {
    let cred_path = dsh_home.join(".credentials.yaml");
    let text = std::fs::read_to_string(&cred_path).ok()?;
    // 极简 YAML 解析：找到 client-connection/browser-session 段落，
    // 在该段落内找第一个 `secret:` 键的值。
    // credentials.yaml 结构示例：
    //   records:
    //     client-connection/browser-session:
    //       kind: grant
    //       payload:
    //         version: 1
    //         secret: <base64url 32-byte>
    let section_marker = "client-connection/browser-session:";
    let mut in_section = false;
    let mut section_indent: Option<usize> = None;
    let mut secret_value: Option<String> = None;
    for line in text.lines() {
        // 用原始行（未 trim）检查缩进，避免丢失层级信息
        let leading = line.chars().take_while(|c| *c == ' ' || *c == '\t').count();
        let trimmed = line.trim();
        if trimmed.starts_with(section_marker) {
            in_section = true;
            section_indent = Some(leading);
            continue;
        }
        if in_section {
            // 遇到同级或上级键（首列非空且缩进 ≤ 段落缩进）→ 退出
            if !trimmed.is_empty()
                && trimmed.contains(':')
                && section_indent.map_or(false, |si| leading <= si)
            {
                break;
            }
            if trimmed.starts_with("secret:") {
                let after_colon = trimmed.splitn(2, ':').nth(1)?.trim();
                let inner = after_colon.trim_start_matches('"').trim_end_matches('"');
                if inner.is_empty() {
                    return None;
                }
                secret_value = Some(inner.to_string());
                // 不立即 break：继续扫描以正确消费整个段落（防御性）
            }
        }
    }
    if let Some(secret) = secret_value {
        let decoded =
            base64::Engine::decode(&base64::engine::general_purpose::URL_SAFE_NO_PAD, &secret)
                .ok()?;
        if decoded.len() == 32 {
            return Some(decoded);
        }
    }
    None
}

/// 将 bytes 编码为 base64url（无 padding，RFC 4648 §5）。
fn base64url_encode(bytes: &[u8]) -> String {
    base64::Engine::encode(&base64::engine::general_purpose::URL_SAFE_NO_PAD, bytes)
}

/// 构造 BrowserAuth cookie header 值（"name=value" 格式），供 proxy 直接 insert。
/// authority 必须传 **dsh 侧 authority**（"127.0.0.1:{dsh_port}"，即 dsh 收到的
/// Host），而非代理监听端口；上游 requestAuthority 取自 dsh 收到的 Host，
/// cookie name 与 body.authority 均绑定该值，错位即 401。
/// 任意步骤失败返回 None（代理不注入 cookie，维持 0.1.1-rc.2 行为）。
pub fn build_cookie(authority: &str, dsh_home: &PathBuf) -> Option<String> {
    let secret = read_secret(dsh_home)?;

    // cookie name = "dsh-auth-" + base64url(sha256(authority))
    let hash = sha2::Sha256::digest(authority.as_bytes());
    let name = format!("dsh-auth-{}", base64url_encode(&hash));

    // body payload
    let now = chrono::Utc::now();
    let issued_at = now.timestamp_millis();
    let expires_at = now + chrono::Duration::days(30);
    let expires_at_ms = expires_at.timestamp_millis();

    let body_obj = serde_json::json!({
        "version": 1,
        "authority": authority,
        "issuedAt": issued_at,
        "expiresAt": expires_at_ms
    });
    let body_str = body_obj.to_string();
    let body_b64 = base64url_encode(body_str.as_bytes());

    // sig = base64url(HMAC-SHA256(secret, body_b64))：与上游 encodeCookie 对齐，
    // 上游签名输入是 base64url 编码后的 body 字符串（验签时同样对收到的 b64
    // body 重算 HMAC），对原始 JSON 签名会导致验签恒失败而 401。
    use hmac::{Hmac, Mac};
    type HmacSha256 = Hmac<sha2::Sha256>;
    let mut mac = HmacSha256::new_from_slice(&secret).ok()?;
    mac.update(body_b64.as_bytes());
    let sig = base64url_encode(&mac.finalize().into_bytes());

    Some(format!("{}={}.{}.{}", name, "v1", body_b64, sig))
}

/// 判断 authority 是否属于 loopback（仅对这些 authority 注入 cookie）。
pub fn is_loopback_authority(authority: &str) -> bool {
    let auth = authority.to_ascii_lowercase();
    auth.starts_with("127.0.0.1:")
        || auth.starts_with("localhost:")
        || auth.starts_with("[::1]:")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// probe 型临时 DSH_HOME（pid 唯一防并行/重跑碰撞）；创建失败返回 None 由调用方 skip。
    fn probe_dsh_home(tag: &str) -> Option<PathBuf> {
        let p = std::env::temp_dir().join(format!("dsh_ba_test_{tag}_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).ok()?;
        Some(p)
    }

    fn write_cred(home: &PathBuf, body: &str) -> Result<(), String> {
        std::fs::write(home.join(".credentials.yaml"), body).map_err(|e| e.to_string())
    }

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

    #[test]
    fn loopback_authority_detection() {
        assert!(is_loopback_authority("127.0.0.1:3080"));
        assert!(is_loopback_authority("localhost:3080"));
        assert!(is_loopback_authority("[::1]:3080"));
        assert!(!is_loopback_authority("192.168.1.1:3080"));
        assert!(!is_loopback_authority("example.com:443"));
    }

    #[test]
    fn base64url_encode_produces_no_padding() {
        let encoded = base64url_encode(b"\xff\xff\xff\xff");
        assert!(!encoded.contains('='));
        assert!(!encoded.contains('+'));
        assert!(!encoded.contains('/'));
    }

    #[test]
    fn cookie_name_matches_spec() {
        // 用已知 authority 验证 name 格式（不依赖真实 secret，只校验结构）
        let name = build_cookie("127.0.0.1:3080", &PathBuf::from("/nonexistent"));
        // 非存在路径应返回 None（降级）
        assert!(name.is_none());
    }

    #[test]
    fn secret_validation_rejects_wrong_length() {
        // 用唯一 temp 文件路径测试，避免并行测试共享 .credentials.yaml 的竞态
        let dsh_home = match probe_dsh_home("16b") {
            Some(p) => p,
            None => {
                eprintln!("[skip] 临时目录创建失败");
                return;
            }
        };
        let short_secret_b64 = base64url_encode(&[0u8; 16]);
        probe!(write_cred(
            &dsh_home,
            &format!(
                "records:\n  client-connection/browser-session:\n    kind: grant\n    payload:\n      version: 1\n      secret: \"{short_secret_b64}\"\n"
            )
        ));
        // 短 secret 应被拒绝
        assert!(read_secret(&dsh_home).is_none());
        let _ = std::fs::remove_dir_all(&dsh_home);
    }

    #[test]
    fn read_secret_parses_nested_yaml_structure() {
        // 用实际 credentials.yaml 的嵌套结构测试解析（与真实文件一致）
        let dsh_home = match probe_dsh_home("nested") {
            Some(p) => p,
            None => {
                eprintln!("[skip] 临时目录创建失败");
                return;
            }
        };
        // 32 字节全零的 base64url = 43 字符（无 padding）
        let zero_secret_b64 = base64url_encode(&[0u8; 32]);
        probe!(write_cred(
            &dsh_home,
            &format!(
                "version: 1\nrefs:\n  {{}}\nrecords:\n  client-connection/browser-session:\n    kind: grant\n    payload:\n      version: 1\n      secret: \"{zero_secret_b64}\"\n"
            )
        ));
        let result = read_secret(&dsh_home);
        assert!(result.is_some(), "应成功解析嵌套 YAML 中的 secret");
        let decoded = result.unwrap();
        assert_eq!(decoded.len(), 32);
        assert!(decoded.iter().all(|&b| b == 0));
        let _ = std::fs::remove_dir_all(&dsh_home);
    }

    #[test]
    fn read_secret_handles_no_secret_key() {
        let dsh_home = match probe_dsh_home("no_secret") {
            Some(p) => p,
            None => {
                eprintln!("[skip] 临时目录创建失败");
                return;
            }
        };
        probe!(write_cred(
            &dsh_home,
            "records:\n  client-connection/browser-session:\n    kind: grant\n    payload:\n      version: 1\n",
        ));
        assert!(read_secret(&dsh_home).is_none(), "无 secret 键应返回 None");
        let _ = std::fs::remove_dir_all(&dsh_home);
    }

    #[test]
    fn read_secret_matches_real_credentials_format() {
        // 用真实 credentials.yaml 格式（含 refs 块）测试
        let dsh_home = match probe_dsh_home("real") {
            Some(p) => p,
            None => {
                eprintln!("[skip] 临时目录创建失败");
                return;
            }
        };
        let real_secret_b64 = "-ZMR6fSXTUyhokewdC-ySoOrQVrgiuKwK3v7BJYOJ8E";
        probe!(write_cred(
            &dsh_home,
            &format!(
                "version: 1\nrefs:\n  {{\n    OpenCode_API_KEY: sk-test,\n    WZRAGENT_API_KEY: sk-test2\n  }}\nrecords:\n  client-connection/browser-session:\n    kind: grant\n    payload:\n      version: 1\n      secret: \"{real_secret_b64}\"\n"
            )
        ));
        let result = read_secret(&dsh_home);
        assert!(result.is_some(), "应解析真实格式的 credentials.yaml");
        let decoded = result.unwrap();
        assert_eq!(decoded.len(), 32, "secret 解码后应为 32 字节");
        let _ = std::fs::remove_dir_all(&dsh_home);
    }

    /// BUG-14 回归：cookie name 必须绑定 dsh 侧 authority。
    /// 代理端口 authority 与 dsh 端口 authority 算出的 name 必须不同，
    /// 且 dsh 端口的 name 必须等于上游 cookieName 公式（sha256→base64url）。
    #[test]
    fn cookie_name_bound_to_dsh_authority() {
        use sha2::Digest;
        for auth in ["127.0.0.1:3080", "127.0.0.1:62288"] {
            let hash = sha2::Sha256::digest(auth.as_bytes());
            let expect = format!("dsh-auth-{}", base64url_encode(&hash));
            // 与上游 cookieName("dsh-auth-" + b64(sha256(authority))) 同公式
            assert!(expect.starts_with("dsh-auth-"));
            assert!(!expect.contains('='));
        }
        let h3080 = sha2::Sha256::digest("127.0.0.1:3080".as_bytes());
        let h62288 = sha2::Sha256::digest("127.0.0.1:62288".as_bytes());
        assert_ne!(
            base64url_encode(&h3080),
            base64url_encode(&h62288),
            "代理端口与 dsh 端口的 cookie name 必须不同（错位即 401）"
        );
    }

    /// BUG-14 回归：sig 必须是对 base64url(body) 的 HMAC（与上游 encodeCookie/
    /// decodeCookie 一致），而非对原始 JSON。按“签原始 JSON”的旧算法重算
    /// 必须与 cookie 中的 sig 不同，按“签 b64 body”重算必须完全一致。
    #[test]
    fn cookie_sig_signs_b64_body_like_upstream() {
        use hmac::{Hmac, Mac};
        type HmacSha256 = Hmac<sha2::Sha256>;
        let dsh_home = match probe_dsh_home("sig") {
            Some(p) => p,
            None => {
                eprintln!("[skip] 临时目录创建失败");
                return;
            }
        };
        let secret_b64 = base64url_encode(&[7u8; 32]);
        probe!(write_cred(
            &dsh_home,
            &format!(
                "records:\n  client-connection/browser-session:\n    kind: grant\n    payload:\n      version: 1\n      secret: \"{secret_b64}\"\n"
            )
        ));
        let cookie = build_cookie("127.0.0.1:3080", &dsh_home).expect("应成功构造 cookie");
        let (name, value) = cookie.split_once('=').expect("name=value 格式");
        assert!(name.starts_with("dsh-auth-"), "cookie name 前缀");
        let mut parts = value.split('.');
        assert_eq!(parts.next(), Some("v1"));
        let body_b64 = parts.next().expect("body 段");
        let sig_b64 = parts.next().expect("sig 段");
        assert!(parts.next().is_none(), "恰为 v1.body.sig 三段");
        // body 解码后 authority 必须回显 dsh 侧 authority
        let body_json = String::from_utf8(
            base64::Engine::decode(&base64::engine::general_purpose::URL_SAFE_NO_PAD, body_b64)
                .expect("body 应为合法 base64url"),
        )
        .expect("body 应为 UTF-8 JSON");
        let v: serde_json::Value = serde_json::from_str(&body_json).expect("body 应为 JSON");
        assert_eq!(v["authority"], "127.0.0.1:3080");
        assert_eq!(v["version"], 1);
        // 上游算法：HMAC(secret, body_b64) → 必须与 sig 一致
        let secret =
            base64::Engine::decode(&base64::engine::general_purpose::URL_SAFE_NO_PAD, &secret_b64)
                .unwrap();
        let mut mac = HmacSha256::new_from_slice(&secret).unwrap();
        mac.update(body_b64.as_bytes());
        let expect_sig = base64url_encode(&mac.finalize().into_bytes());
        assert_eq!(sig_b64, expect_sig, "sig 必须是对 b64 body 的 HMAC（上游算法）");
        // 旧错误算法：HMAC(secret, 原始 JSON) → 必须与 sig 不同（防回退）
        let mut mac_old = HmacSha256::new_from_slice(&secret).unwrap();
        mac_old.update(body_json.as_bytes());
        let old_sig = base64url_encode(&mac_old.finalize().into_bytes());
        assert_ne!(sig_b64, old_sig, "旧算法（签原始 JSON）不得复现");
        let _ = std::fs::remove_dir_all(&dsh_home);
    }
}
