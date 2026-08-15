# Changelog

All notable user-visible changes are aggregated here. / 本项目重要变更按用户可见特性聚合记录于此。

## [Unreleased]

## [0.2.0] - 2026-08-15

### Added / 新增

- Brand-new self-built frontend rebuilt per the design mockup (`docs/UIDesign.desktop.html`): frameless custom title bar, Work/Code dual modes — 全新自研前端（按设计稿重构）：无边框自定义标题栏、Work/Code 双模式。
- Code AIDE three-pane view: changed files → per-hunk diff accept/reject → AI side chat + terminal/status bar — Code AIDE 三栏视图：变更文件 → 逐 hunk diff 接受/拒绝 → AI 侧聊 + 终端/状态栏。
- Settings: real model provider CRUD (add/edit/activate/delete), preset provider delete/hide semantics, provider form (id/name/context), expandable model rows, connection test, DeepSeek API Key configuration — 设置：模型提供商真实增删改查、预设提供商删除/隐藏语义、提供商表单（id/name/context）、可展开模型行、连接测试、DeepSeek API Key 配置。
- Agent preset picker, settings manager tabs, plugin manager (via Rust bridge), permission menu, session rename — agent preset 选择器、设置标签页、插件管理器（Rust bridge）、权限菜单、会话重命名。
- Sessions: workspace-grouped list, rename, archive filter, fork a message into a new session from the context menu — 会话：工作区分组、重命名、归档过滤、右键菜单 fork 到新会话。
- Messages: streaming output, thinking indicator (auto-collapse when the reply body starts), Markdown + KaTeX math rendering, hide comm events, surface llm/error and empty assistant replies — 消息：流式输出、thinking 指示器（回复体开始自动折叠）、Markdown + KaTeX 数学渲染、隐藏 comm 事件、展示错误与空回复。
- Message menu: copy via Rust clipboard, retract with file revert (reverse diff + `git restore` for deleted files) + confirmation dialog — 消息菜单：Rust 剪贴板复制、retract 带文件还原（反向 diff + `git restore` 删除文件）+ 确认对话框。
- Model selection: show provider and display name, reasoning effort selector, persisted to config — 模型选择：显示提供商与显示名、reasoning effort 选择器、持久化到配置。
- Session history: auto refresh after send and on new messages, load after connect — 会话历史：发送后自动刷新、新消息时刷新、连接后加载。
- dsh hosting: auto-kill stale dsh process on startup, port pre-check with a clear error — dsh 托管：启动自动清理残留 dsh 进程、端口预检明确报错。
- Proxy: inject system proxy into the dsh process (`NODE_USE_ENV_PROXY`), show the injected proxy in the status bar — 代理：向 dsh 注入系统代理（`NODE_USE_ENV_PROXY`）、状态栏显示注入状态。
- Workspaces: native directory picker — 工作区：原生目录选择器。

### Fixed / 修复

- Blank window on startup (Vite bound to IPv6-only localhost; now `127.0.0.1`) — 启动空窗口（Vite 仅绑定 IPv6 localhost，已改 `127.0.0.1`）。
- Assistant/message content read from the wrong path (`data.message.content`) — 助手/消息内容读取错误路径（`data.message.content`）。
- Stale empty history view after sending a message — 发送后历史不刷新/空视图。
- Empty model replies (system proxy was not injected into the dsh process) — 模型空回复（未向 dsh 注入系统代理）。
- Port-in-use (`EADDRINUSE`) loop; now a clear error is reported — 端口占用（`EADDRINUSE`）循环，改为明确报错。
- Markdown math rendering color issue — Markdown 数学渲染颜色问题。
- Various UI fixes: scrolling (messages inside view, composer, sticky-bottom auto-scroll), menus (upward workspace menu, model menu), text selection, collapsible sidebar, error-only red rows, hide system prompt — 各类 UI 修复：滚动（消息区内滚、composer、底部粘性自动滚动）、菜单（工作区菜单向上展开、模型菜单）、文本选择、可折叠侧栏、仅错误行标红、隐藏 system prompt。

### Internal / 内部与文档

- Pin all `@deepseek-ai/*` dependencies to exact versions (dsh `0.1.0-rc.6`); RISKS records the glib Dependabot alert disposition (upstream-blocked) — 精确锁定 `@deepseek-ai/*` 依赖（dsh `0.1.0-rc.6`）；RISKS 记录 glib Dependabot 告警处置（upstream-blocked）。
- Removed obsolete UIDesign HTML mockups — 移除过时的 UIDesign HTML 设计稿。

### Known Limitations / 已知限制

- Code AIDE hunk accept/reject is a UI-local state marker; dsh has no pending-diff semantics. "Reject = restore oldText" needs a future restricted Rust command — AIDE hunk 接受/拒绝为 UI 本地状态标记（dsh 无 pending-diff 语义）；「拒绝=还原 oldText」需后续受限 Rust 命令。
- Session history renders tool events with a generic mapping, not official 1:1 rendering — 会话历史工具事件为通用映射渲染，非官方 1:1。