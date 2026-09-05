use axum::body::Body;
use axum::extract::ws::{CloseFrame, Message as WsMessage, WebSocket, WebSocketUpgrade};
use axum::extract::{Request, State};
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::any;
use axum::Router;
use futures_util::{SinkExt, StreamExt};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::Arc;
use tokio::net::TcpListener;
use tokio::task::JoinHandle;

const MAX_BODY_BYTES: usize = 64 * 1024 * 1024;

pub struct ProxyContext {
    pub dsh_port: Arc<AtomicU16>,
    pub dsh_home: Option<PathBuf>,
    client: reqwest::Client,
}

pub struct ProxyHandle {
    pub port: u16,
    pub addr: String,
    pub dsh_port: Arc<AtomicU16>,
    _task: JoinHandle<()>,
}

pub async fn start_proxy(dsh_port: u16, dsh_home: Option<PathBuf>) -> Result<ProxyHandle, String> {
    let client = reqwest::Client::builder()
        .no_proxy() // proxy 转发到本地 127.0.0.1:{dsh_port}，绝不能走系统外部代理
        .build()
        .map_err(|e| e.to_string())?;
    let ctx = Arc::new(ProxyContext {
        dsh_port: Arc::new(AtomicU16::new(dsh_port)),
        dsh_home,
        client,
    });
    let app = Router::new()
        .route("/api/events.mux", any(proxy_ws))
        .route("/api/events.host", any(proxy_ws))
        .route("/api/{*path}", any(proxy_api))
        .with_state(ctx.clone());
    let listener = TcpListener::bind("127.0.0.1:0").await.map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let task = tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    Ok(ProxyHandle {
        port,
        addr: format!("127.0.0.1:{port}"),
        dsh_port: ctx.dsh_port.clone(),
        _task: task,
    })
}

pub fn is_allowed_origin(origin: &str) -> bool {
    let lower = origin.trim().trim_end_matches('/').to_ascii_lowercase();
    // macOS WKWebView（WebKit）从自定义协议发起跨协议（http://127.0.0.1）请求时，
    // 标准行为会将 Origin 标记为 "null" 或 "tauri://localhost"。
    if lower.is_empty() || lower == "null" || lower == "about:blank" {
        return true;
    }
    // 放行所有非公网域名的本地/应用协议
    if lower.starts_with("tauri://")
        || lower.starts_with("file://")
        || lower.starts_with("applewebdata://")
        || lower.starts_with("app://")
        || lower.starts_with("vscode-webview://")
    {
        return true;
    }
    // 放行所有本地回环地址及 localhost 端口
    for prefix in [
        "http://localhost",
        "https://localhost",
        "http://127.0.0.1",
        "https://127.0.0.1",
        "http://tauri.localhost",
        "https://tauri.localhost",
        "http://ipc.localhost",
        "https://ipc.localhost",
        "http://[::1]",
        "https://[::1]",
    ] {
        if lower == prefix || lower.starts_with(&format!("{prefix}:")) || lower.starts_with(&format!("{prefix}/")) {
            return true;
        }
    }
    false
}

fn origin_allowed(headers: &HeaderMap) -> bool {
    match headers.get(header::ORIGIN) {
        None => true,
        Some(v) => v
            .to_str()
            .map(|s| {
                // 如果包含多个 token（例如 WebKit 多 origin），逐一校验
                s.split([' ', ',']).all(|token| {
                    let t = token.trim();
                    t.is_empty() || is_allowed_origin(t)
                })
            })
            .unwrap_or(false),
    }
}

fn apply_cors(resp: &mut Response, headers: &HeaderMap) {
    if let Some(origin_str) = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()) {
        let trimmed = origin_str.trim();
        if is_allowed_origin(trimmed) {
            let h = resp.headers_mut();
            if let Ok(hv) = HeaderValue::from_str(trimmed) {
                h.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, hv);
            } else {
                h.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, HeaderValue::from_static("*"));
            }
            h.insert(header::VARY, HeaderValue::from_static("Origin"));
            h.insert(
                header::ACCESS_CONTROL_ALLOW_METHODS,
                HeaderValue::from_static("GET, POST, PUT, DELETE, PATCH, OPTIONS, HEAD"),
            );
            if let Some(req_h) = headers.get("access-control-request-headers") {
                h.insert(header::ACCESS_CONTROL_ALLOW_HEADERS, req_h.clone());
            } else {
                h.insert(header::ACCESS_CONTROL_ALLOW_HEADERS, HeaderValue::from_static("*"));
            }
            h.insert(header::ACCESS_CONTROL_MAX_AGE, HeaderValue::from_static("86400"));
        } else {
            resp.headers_mut().insert(header::VARY, HeaderValue::from_static("Origin"));
        }
    }
}

async fn proxy_api(State(ctx): State<Arc<ProxyContext>>, req: Request) -> Response {
    let method = req.method().clone();
    let headers = req.headers().clone();
    if method == Method::OPTIONS {
        let mut resp = Response::new(Body::empty());
        *resp.status_mut() = StatusCode::NO_CONTENT;
        apply_cors(&mut resp, &headers);
        return resp;
    }
    if !origin_allowed(&headers) {
        eprintln!(
            "[proxy] 403 Forbidden: method={} path={} origin={:?}",
            method,
            req.uri().path(),
            headers.get(header::ORIGIN)
        );
        return (StatusCode::FORBIDDEN, "forbidden").into_response();
    }
    let path = req
        .uri()
        .path_and_query()
        .map(|p| p.as_str().to_string())
        .unwrap_or_default();
    let port = ctx.dsh_port.load(Ordering::Relaxed);
    // BUG-14: inject BrowserAuth cookie for 0.1.2-rc.1+ when authority is loopback.
    // dsh 侧 authority 恒为 dsh 监听地址：本代理转发时不透传 Host（allowlist 丢弃），
    // reqwest 按目标 URL 重写 Host 为 127.0.0.1:{dsh_port}；上游 requestAuthority、
    // cookie name、body.authority 验签全都基于该值。用前端发来的 Host（代理端口）
    // 计算 cookie 会导致 name/body 双错位而 upstream 401，故 build_cookie 入参必须
    // 是 dsh_authority。is_loopback 门禁仍看原始 Host（非 loopback 来源不注入）。
    let host_header = headers
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string())
        .unwrap_or_else(|| format!("127.0.0.1:{port}"));
    let dsh_authority = format!("127.0.0.1:{port}");
    let mut extra_cookie: Option<String> = None;
    if super::browser_auth::is_loopback_authority(&host_header) {
        if let Some(home) = &ctx.dsh_home {
            match super::browser_auth::build_cookie(&dsh_authority, home) {
                Some(cookie_val) => {
                    let prefix = cookie_val.split('=').next().unwrap_or("dsh-auth-?");
                    let short: String = prefix.chars().take(20).collect();
                    eprintln!(
                        "[proxy] BrowserAuth inject authority={} cookie={}… (client host={})",
                        dsh_authority, short, host_header
                    );
                    extra_cookie = Some(cookie_val);
                }
                None => {
                    eprintln!(
                        "[proxy] BrowserAuth downgrade: no cookie for authority={} (secret 缺失/不可读或 HMAC 失败，保持不注入)",
                        dsh_authority
                    );
                }
            }
        } else {
            eprintln!(
                "[proxy] BrowserAuth downgrade: dsh_home 未配置，不注入 cookie (authority={})",
                dsh_authority
            );
        }
    } else {
        eprintln!(
            "[proxy] BrowserAuth skip: 非 loopback Host ({})，不注入 cookie",
            host_header
        );
    }
    let upstream = format!("http://127.0.0.1:{port}{path}");
    let mut rb = ctx.client.request(method, &upstream);
    // Allowlist: only forward headers the upstream API actually needs.
    // Drop all browser-specific headers (sec-fetch-*, user-agent, accept-language,
    // priority, etc.) because dsh rejects non-loopback requests based on them.
    // BUG-14 fix: cookie is forwarded only when we successfully generated a
    // BrowserAuth cookie above; otherwise keep original allowlist behaviour.
    for (k, v) in headers.iter() {
        let name = k.as_str().to_ascii_lowercase();
        if matches!(
            name.as_str(),
            "content-type" | "accept" | "authorization" | "x-requested-with"
        ) {
            rb = rb.header(k, v);
        } else if name == "cookie" {
            // Merge upstream-origin cookie (if any) with our BrowserAuth cookie.
            let existing = v.to_str().unwrap_or("").to_string();
            let combined = match &extra_cookie {
                Some(bc) if existing.is_empty() => bc.clone(),
                Some(bc) => format!("{}; {}", existing, bc),
                None => existing,
            };
            if let Ok(hv) = HeaderValue::from_str(&combined) {
                rb = rb.header(k, hv);
            }
        }
    }
    // If no original Cookie header existed but we have a BrowserAuth one, inject it.
    if extra_cookie.is_some() && !headers.contains_key(header::COOKIE) {
        if let Some(ref cv) = extra_cookie {
            if let Ok(hv) = HeaderValue::from_str(cv) {
                rb = rb.header(header::COOKIE, hv);
            }
        }
    }
    let body = axum::body::to_bytes(req.into_body(), MAX_BODY_BYTES)
        .await
        .unwrap_or_default();
    rb = rb.body(body);
    let up = match rb.send().await {
        Ok(r) => r,
        Err(e) => {
            eprintln!("[proxy] ✗ upstream send error: {e}");
            return (StatusCode::BAD_GATEWAY, format!("proxy error: {e}")).into_response();
        }
    };
    let up_status = up.status();
    let up_headers = up.headers().clone();
    let bytes = up.bytes().await.unwrap_or_default();
    // BUG-14 diagnosability: log upstream 401/403 bodies (dsh trust fence or future auth)
    // to stderr so harness.log contains actionable evidence, not just FE's "transport failure".
    if up_status.as_u16() == 401 || up_status.as_u16() == 403 {
        let preview = String::from_utf8_lossy(&bytes);
        let head = if preview.len() > 600 { format!("{}…", &preview[..600]) } else { preview.to_string() };
        eprintln!(
            "[proxy] upstream {} for {} (dsh:{} proxy:{}): {}",
            up_status.as_u16(),
            path,
            port,
            ctx.dsh_port.load(Ordering::Relaxed),
            head
        );
    }
    let mut resp = Response::new(Body::from(bytes));
    *resp.status_mut() = StatusCode::from_u16(up_status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    for (k, v) in up_headers.iter() {
        let name = k.as_str().to_ascii_lowercase();
        if matches!(name.as_str(), "content-length" | "transfer-encoding" | "connection" | "upgrade" | "keep-alive") {
            continue;
        }
        resp.headers_mut().insert(k.clone(), v.clone());
    }
    apply_cors(&mut resp, &headers);
    resp
}

async fn proxy_ws(State(ctx): State<Arc<ProxyContext>>, ws: WebSocketUpgrade, req: Request) -> Response {
    if !origin_allowed(req.headers()) {
        eprintln!(
            "[proxy_ws] 403 Forbidden: ws path={} origin={:?}",
            req.uri().path(),
            req.headers().get(header::ORIGIN)
        );
        return (StatusCode::FORBIDDEN, "forbidden").into_response();
    }
    let path = req.uri().path().to_string();
    ws.on_upgrade(move |socket| tunnel(ctx, socket, path))
}

async fn tunnel(ctx: Arc<ProxyContext>, mut client: WebSocket, path: String) {
    let port = ctx.dsh_port.load(Ordering::Relaxed);
    let url = format!("ws://127.0.0.1:{port}{path}");
    let (server, _) = match tokio_tungstenite::connect_async(url).await {
        Ok(v) => v,
        Err(_) => {
            let _ = client.close().await;
            return;
        }
    };
    let (mut s_sink, mut s_stream) = server.split();
    let (mut c_sink, mut c_stream) = client.split();
    let c2s = async move {
        while let Some(Ok(msg)) = c_stream.next().await {
            let out = match msg {
                WsMessage::Text(t) => tokio_tungstenite::tungstenite::Message::text(t.as_str().to_string()),
                WsMessage::Binary(b) => tokio_tungstenite::tungstenite::Message::binary(b.to_vec()),
                WsMessage::Ping(p) => tokio_tungstenite::tungstenite::Message::Ping(p.to_vec()),
                WsMessage::Pong(p) => tokio_tungstenite::tungstenite::Message::Pong(p.to_vec()),
                WsMessage::Close(c) => tokio_tungstenite::tungstenite::Message::Close(c.map(|cf| {
                    tokio_tungstenite::tungstenite::protocol::CloseFrame {
                        code: cf.code.into(),
                        reason: cf.reason.to_string().into(),
                    }
                })),
            };
            if s_sink.send(out).await.is_err() {
                break;
            }
        }
        let _ = s_sink.close().await;
    };
    let s2c = async move {
        while let Some(Ok(msg)) = s_stream.next().await {
            let out = match msg {
                tokio_tungstenite::tungstenite::Message::Text(t) => WsMessage::Text(t.as_str().to_string().into()),
                tokio_tungstenite::tungstenite::Message::Binary(b) => WsMessage::Binary(b.into()),
                tokio_tungstenite::tungstenite::Message::Ping(p) => WsMessage::Ping(p.into()),
                tokio_tungstenite::tungstenite::Message::Pong(p) => WsMessage::Pong(p.into()),
                tokio_tungstenite::tungstenite::Message::Close(c) => WsMessage::Close(c.map(|cf| CloseFrame {
                    code: cf.code.into(),
                    reason: cf.reason.to_string().into(),
                })),
                tokio_tungstenite::tungstenite::Message::Frame(_) => continue,
            };
            if c_sink.send(out).await.is_err() {
                break;
            }
        }
        let _ = c_sink.close().await;
    };
    let _ = tokio::join!(c2s, s2c);
}




#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allowed_origin_validation() {
        // macOS WKWebView null & custom schemes
        assert!(is_allowed_origin("null"));
        assert!(is_allowed_origin("NULL"));
        assert!(is_allowed_origin("about:blank"));
        assert!(is_allowed_origin("applewebdata://12345"));
        assert!(is_allowed_origin("file:///Applications/App.app/Contents/Resources/index.html"));
        // Tauri & local origins (with and without trailing slashes)
        assert!(is_allowed_origin("tauri://localhost"));
        assert!(is_allowed_origin("tauri://localhost/"));
        assert!(is_allowed_origin("tauri://deepseek.wui"));
        assert!(is_allowed_origin("http://tauri.localhost"));
        assert!(is_allowed_origin("https://tauri.localhost"));
        assert!(is_allowed_origin("http://localhost:1420"));
        assert!(is_allowed_origin("http://127.0.0.1:1420"));
        assert!(is_allowed_origin("http://localhost:5173"));
        assert!(is_allowed_origin("http://ipc.localhost"));
        assert!(is_allowed_origin("http://[::1]:1420"));
        // Multi-origin headers
        let mut h = HeaderMap::new();
        h.insert(header::ORIGIN, HeaderValue::from_static("tauri://localhost null"));
        assert!(origin_allowed(&h));
        // External unauthorized origins must be rejected
        assert!(!is_allowed_origin("http://evil.example.com"));
        assert!(!is_allowed_origin("https://attacker.org"));
        assert!(!is_allowed_origin("http://localhost.evil.com"));
    }

    #[tokio::test]
    #[ignore = "live: 需要本地网络栈，手动运行 cargo test -- --ignored proxy_binds_loopback"]
    async fn proxy_binds_loopback_and_forwards() {
        let handle = start_proxy(3080, None).await.expect("start proxy");
        assert!(
            handle.addr.starts_with("127.0.0.1:"),
            "proxy 必须绑定 loopback，实际: {}",
            handle.addr
        );
        // 通过代理请求任意 /api 路径：dsh 未运行时应得到网关错误（说明代理在转发），
        // 且带非白名单 Origin 的请求必须被 403 拒绝。
        let client = reqwest::Client::new();
        let bad_origin = client
            .get(format!("http://{}/api/host.describe", handle.addr))
            .header("Origin", "http://evil.example")
            .send()
            .await
            .expect("proxy responds");
        assert_eq!(bad_origin.status().as_u16(), 403, "非白名单 Origin 必须 403");
        // 无 Origin（loopback 同源语义）应进入转发路径：dsh 未监听 → 5xx（不是 403）
        let no_origin = client
            .get(format!("http://{}/api/host.describe", handle.addr))
            .send()
            .await
            .expect("proxy responds");
        assert_ne!(no_origin.status().as_u16(), 403);
        // 显式关闭服务任务
        handle._task.abort();
    }
}
