//! 事件发射抽象：把「向 Tauri 前端发事件」从核心业务逻辑中解耦。
//!
//! 背景：e2e 测试若直接引用 `tauri::test::mock_app()` / `AppHandle`，会把 winit/windows
//! GUI 代码链进测试二进制（导入 `comctl32!TaskDialogIndirect`），而本机 comctl32.dll 为
//! v5.82 不导出该入口 → 测试二进制加载即崩溃（0xc0000139）。
//!
//! 方案：核心逻辑只依赖 `EventSink` 特征。生产用 `TauriSink`（转发到 AppHandle.emit），
//! e2e 测试用 `CollectSink`（收集到 Vec）。于是测试二进制可完全不引用 Tauri GUI 类型，
//! 相关 GUI 代码被 dead-code elimination 移除，二进制只导入系统基础 DLL。

use serde::Serialize;
use std::sync::{Arc, Mutex};

/// 事件发射抽象。要求 `Clone + Send + 'static`，以便克隆进后台线程（日志/健康/退出 watcher）。
pub trait EventSink: Clone + Send + 'static {
    fn emit<S: Serialize + Clone>(&self, event: &str, payload: &S);
}

/// 生产环境：包装 Tauri AppHandle，转发到 Tauri 事件系统。
pub struct TauriSink<R: tauri::Runtime> {
    app: tauri::AppHandle<R>,
}

impl<R: tauri::Runtime> Clone for TauriSink<R> {
    fn clone(&self) -> Self {
        // AppHandle<R> 是句柄克隆，不要求 R: Clone。
        Self {
            app: self.app.clone(),
        }
    }
}

impl<R: tauri::Runtime> TauriSink<R> {
    pub fn new(app: tauri::AppHandle<R>) -> Self {
        Self { app }
    }
}

impl<R: tauri::Runtime> EventSink for TauriSink<R> {
    fn emit<S: Serialize + Clone>(&self, event: &str, payload: &S) {
        use tauri::Emitter;
        let _ = self.app.emit(event, payload);
    }
}

/// 测试环境：把所有事件收集到 `Vec<(event, json)>`，便于驱动真实业务逻辑并断言。
#[derive(Clone, Default)]
pub struct CollectSink {
    pub events: Arc<Mutex<Vec<(String, String)>>>,
}

impl EventSink for CollectSink {
    fn emit<S: Serialize + Clone>(&self, event: &str, payload: &S) {
        let json = serde_json::to_string(payload).unwrap_or_default();
        self.events
            .lock()
            .unwrap()
            .push((event.to_string(), json));
    }
}