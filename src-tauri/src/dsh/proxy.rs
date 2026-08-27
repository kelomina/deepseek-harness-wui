use axum::body::Body;
use axum::extract::ws::{CloseFrame, Message as WsMessage, WebSocket, WebSocketUpgrade};
use axum::extract::{Request, State};
use axum::http::{header, HeaderMap, HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::any;
use axum::Router;
use futures_util::{SinkExt, StreamExt};
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::Arc;
use tokio::net::TcpListener;
use tokio::task::JoinHandle;

const MAX_BODY_BYTES: usize = 64 * 1024 * 1024;

pub struct ProxyContext {
    pub dsh_port: Arc<AtomicU16>,
    client: reqwest::Client,
    allowed_origins: Vec<String>,
}

pub struct ProxyHandle {
    pub port: u16,
    pub addr: String,
    pub dsh_port: Arc<AtomicU16>,
    _task: JoinHandle<()>,
}

pub async fn start_proxy(dsh_port: u16) -> Result<ProxyHandle, String> {
    let ctx = Arc::new(ProxyContext {
        dsh_port: Arc::new(AtomicU16::new(dsh_port)),
        client: reqwest::Client::builder().build().map_err(|e| e.to_string())?,
        allowed_origins: vec![
            "http://localhost:1420".to_string(),
            "http://127.0.0.1:1420".to_string(),
            "http://tauri.localhost".to_string(),
            "https://tauri.localhost".to_string(),
            "tauri://localhost".to_string(),
            "null".to_string(), // Tauri v2 webview may send Origin: null for custom protocol
        ],
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

fn origin_allowed(headers: &HeaderMap, allowed: &[String]) -> bool {
    match headers.get(header::ORIGIN) {
        None => true,
        Some(v) => v
            .to_str()
            .map(|s| allowed.iter().any(|a| a == s))
            .unwrap_or(false),
    }
}

fn apply_cors(resp: &mut Response, headers: &HeaderMap, allowed: &[String]) {
    if let Some(origin) = headers
        .get(header::ORIGIN)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string())
        .filter(|s| allowed.iter().any(|a| a == s))
    {
        let h = resp.headers_mut();
        h.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, HeaderValue::from_str(&origin).unwrap());
        h.insert(header::VARY, HeaderValue::from_static("Origin"));
        h.insert(header::ACCESS_CONTROL_ALLOW_METHODS, HeaderValue::from_static("GET, POST, OPTIONS"));
        if let Some(req_h) = headers.get("access-control-request-headers") {
            h.insert(header::ACCESS_CONTROL_ALLOW_HEADERS, req_h.clone());
        } else {
            h.insert(header::ACCESS_CONTROL_ALLOW_HEADERS, HeaderValue::from_static("Content-Type"));
        }
        h.insert(header::ACCESS_CONTROL_MAX_AGE, HeaderValue::from_static("86400"));
    } else if headers.contains_key(header::ORIGIN) {
        resp.headers_mut().insert(header::VARY, HeaderValue::from_static("Origin"));
    }
}

async fn proxy_api(State(ctx): State<Arc<ProxyContext>>, req: Request) -> Response {
    let method = req.method().clone();
    let headers = req.headers().clone();
    if method == Method::OPTIONS {
        let mut resp = Response::new(Body::empty());
        *resp.status_mut() = StatusCode::NO_CONTENT;
        apply_cors(&mut resp, &headers, &ctx.allowed_origins);
        return resp;
    }
    if !origin_allowed(&headers, &ctx.allowed_origins) {
        return (StatusCode::FORBIDDEN, "forbidden").into_response();
    }
    let path = req
        .uri()
        .path_and_query()
        .map(|p| p.as_str().to_string())
        .unwrap_or_default();
    let port = ctx.dsh_port.load(Ordering::Relaxed);
    let upstream = format!("http://127.0.0.1:{port}{path}");
    let mut rb = ctx.client.request(method, &upstream);
    // Allowlist: only forward headers the upstream API actually needs.
    // Drop all browser-specific headers (sec-fetch-*, user-agent, accept-language,
    // priority, etc.) because dsh rejects non-loopback requests based on them.
    for (k, v) in headers.iter() {
        let name = k.as_str().to_ascii_lowercase();
        if matches!(
            name.as_str(),
            "content-type"
                | "accept"
                | "authorization"
                | "x-requested-with"
        ) {
            rb = rb.header(k, v);
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
    let mut resp = Response::new(Body::from(bytes));
    *resp.status_mut() = StatusCode::from_u16(up_status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    for (k, v) in up_headers.iter() {
        let name = k.as_str().to_ascii_lowercase();
        if matches!(name.as_str(), "content-length" | "transfer-encoding" | "connection" | "upgrade" | "keep-alive") {
            continue;
        }
        resp.headers_mut().insert(k.clone(), v.clone());
    }
    apply_cors(&mut resp, &headers, &ctx.allowed_origins);
    resp
}

async fn proxy_ws(State(ctx): State<Arc<ProxyContext>>, ws: WebSocketUpgrade, req: Request) -> Response {
    if !origin_allowed(req.headers(), &ctx.allowed_origins) {
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

    #[tokio::test]
    #[ignore = "live: 需要本地网络栈，手动运行 cargo test -- --ignored proxy_binds_loopback"]
    async fn proxy_binds_loopback_and_forwards() {
        let handle = start_proxy(3080).await.expect("start proxy");
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
