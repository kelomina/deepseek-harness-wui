# Changelog

All notable user-visible changes are aggregated here. / 本项目重要变更按用户可见特性聚合记录于此。

## [Unreleased]

### Changed / 变更

- Upgraded pinned dsh runtime `0.1.0-rc.6` → **`0.1.1-rc.2`** (runtime + root, exact lock; Npx mode and WSL provisioning defaults synced). RPC surface (52 methods) and event frames unchanged — verified by type-contract diff and full live smoke re-run against the real dsh. Upstream removed `@deepseek-ai/dsh-client-ui-slots`; the routing-suite installer already tolerates missing link targets, and boot-time healing no longer spins on permanently absent targets — 升级精确锁定 dsh 至 0.1.1-rc.2；52 方法与事件面零变化，live 冒烟全量复验通过；上游移除 dsh-client-ui-slots 的兼容处置已落地（安装器容错 + 自愈信号修正）。

### Added / 新增

- **macOS support (compile-level + CI builds)**: platform-gated system proxy detection (`scutil --proxies`), stale-process cleanup via `lsof`+`ps`, symlink-based routing-suite links, native `pbcopy` clipboard, macOS npx fallback paths; WSL features degrade gracefully. GitHub Actions workflow builds unsigned app+dmg on macos runners and NSIS/MSI on Windows on every push/PR — **macOS 支持落地**：平台门控的代理探测/进程清理/symlink 链接/pbcopy 剪贴板，WSL 优雅降级；GitHub Actions 在 macos runner 上自动打包 app+dmg（真机运行仍待验证，见 RISKS）。
- Default model card in Settings (providers tab): reads/edits the new dsh `agent-default-model` settings namespace (provider / model / reasoning effort, CAS-guarded write, dropdowns from the live model catalog); write path live-verified — 设置页新增「默认模型（新会话）」卡片，接入 dsh 0.1.1-rc.2 新增的 agent-default-model 命名空间（CAS 写路径已 live 实证）。
- Status page now shows the host home directory (new `home` field of host.describe) — 状态页宿主信息新增「宿主主目录」。
- Feature entrypoints alignment with the `design/feature-entrypoints` mockup: sidebar search loading spinner + focus highlight, guided "＋ 设定目标" state on the session-header goal capsule, queue dock empty state, dock segment icons, default dock sub-tab = 队列 — 功能入口体系与设计稿对齐：侧栏搜索加载态与聚焦高亮、会话头目标胶囊无目标引导态、队列坞空态、功能坞分段图标、默认子 tab=队列。
- Graceful degradation for two dsh deployment findings: sidebar search shows a "搜索索引未启用（openAt=never）" hint instead of an error banner; skill panels show "会话未激活" hint when `skill.list` returns session-not-found — 两项部署级发现的优雅降级：侧栏搜索提示索引未启用原因与启用方法；技能面板冷会话提示先发送一条消息。
- Settings page gates 打开设置文档 by `settings.describe().hasDocument` (live-verified) — 设置页「打开设置文档」按宿主 hasDocument 门禁。

### Verified / live 验证收口

- Live smoke against real dsh 0.1.0-rc.6 closed the 2026-08-18 integration debt: goal six verbs full chain (CAS refs + projection frames), updateQueue/attachment error contracts, workspace create/insertBefore/insertSessionBefore/delete/archiveSession on throwaway fixtures, host.openPath ok path, settings.describe/openDocument, mux frame consumption (projection/event/subscribed/queue). Two findings recorded in RISKS: session search disabled by default (`openAt: never`, enableable via profile patch — proven), FTS index covers message text only (titles not searchable) — 2026-08-18 全量接入链路对真实 dsh 完成冒烟验证；两项发现与启用路径已实证并记入 RISKS。

## [0.2.0] - 2026-08-19

### Added / 新增

- Session stop semantics: stop button enters a stopped state within 2s, calls the official `sessions.cancel` interrupt, freezes the stream after stop, and records cancel/turn-aborted evidence; front-end-only stop as documented degradation — 停止语义：停止按钮 2s 内进入已停止，调用官方 `sessions.cancel` 中断，停止后冻结流式内容并记录 cancel/turn-aborted 证据；后端不支持时前端止流降级（已记录）。
- Retry semantics: retry = retract (fork to the previous turn boundary) + resend, avoiding duplicate context; protocol limitation (no same-session retract in dsh 0.1.0-rc.6) recorded with validation boundary — 重试语义：重试 = 撤回（fork 到上轮边界）+ 重发，避免上下文重复；协议限制已记录。
- Retract semantics: same-session retract unsupported by dsh; degraded to fork-new-session + optional file revert with explicit UI labeling — 撤回语义：dsh 不支持同会话撤回；降级为 fork 新会话 + 可选文件回退并明示。
- Official tool-call card rendering per the pinned presentation contract (diff / terminal / read / search / web / generic) — 工具调用按锁定官方 presentation 契约渲染卡片（diff/terminal/read/search/web/generic）。
- Empty-message merge: thinking-only assistant messages suppressed and merged into the next text message (official `deriveEventMessage` rule) — 空消息合并：仅思考的 assistant 消息抑制并合并到下一条文本消息。
- Tool views (MVP): file manager (read-only browse + session files), terminal / browser / Git read-only record views, collapsible at ≤1280px — 工具视图（MVP）：文件管理器（只读浏览 + 会话涉及文件）、终端/浏览器/Git 只读记录视图，≤1280 折叠。
- DSH WSL config & connection: read-only detection (`wsl --status` / `-l -v`), config read/write with validation + confirmation + backup, graceful degradation without WSL — DSH WSL 配置与连接：只读检测、配置读写（校验+确认+备份）、无 WSL 降级。
- Managed dsh runtime download/install/manage: npm-registry source, exact version locking, mandatory sha512 integrity verification, reversible remove/rollback, verify on demand — 受管 dsh 运行时下载/安装/管理：npm registry 源、精确锁定、sha512 integrity 必校验、可逆移除/回滚、按需复验。
- DeepSeek-V4-Pro chain-of-thought degradation detection (configurable regex, non-blocking warning, conservative wording; model identifiability treated as assumption) — V4-Pro 思维链降智检测（可配置正则、非阻断提示、保守措辞；模型可识别性按假设）。
- Plugin UI compat (item 6): spike concluded there is no independently mountable contract; degraded to read-only inventory + documentation — 插件 UI 兼容：spike 结论无独立挂载契约；降级为只读清单 + 文档说明。
- dsh-routing-suite integration: vendored injector (dsh-super-injector 0.3.1) + Router Standard preset (0.1.0), one-click install/remove/status in Settings → 插件, reversible (preset backup `.trash-*`), restart required; live-install dependency-resolution issue fixed (runtime deps junctioned into `injector/node_modules` on install, unlinked on remove) — 集成 dsh-routing-suite（注入器 + Router Standard 思维模式路由预设）：设置 → 插件一键安装/卸载/状态，可回滚，重启 dsh 生效；live 安装实测的注入器依赖解析问题已修复（安装时自动把 runtime 依赖 junction 进 injector/node_modules，卸载解链）。
- Session rename completed & fixed: inline rename in the session header (pencil → input, Enter/blur save, Esc cancel), sidebar double-click rename, fixed a title-display helper that never showed titles (now reads `projections.values.title`); a local title cache makes renamed titles appear immediately, including cold sessions — 会话重命名补全与修复：会话视图头部内联重命名（铅笔→输入框，Enter/失焦保存，Esc 取消）、侧栏双击重命名；修复标题显示（读 `projections.values.title`，原实现读错结构导致标题从不显示）；本地标题缓存让重命名（含冷会话）立即生效。

### Internal / 内部与文档

- Rust unit tests: 12 passed (runtime download/integrity, WSL decode/parse, plugins); live E2E install test (ignored) passes against the npm registry — Rust 单元测试 12 项通过（运行时下载/integrity、WSL 解码/解析、插件）；live E2E 安装测试（ignored）对 npm registry 实测通过。
- Fixture tests: render normalization 8/8, revert boundary 5/5, tool-view collectors 5/5, CoT sample eval TP=2 TN=4 FP=0 FN=0 — fixture 测试：渲染归一 8/8、撤回边界 5/5、工具视图收集 5/5、CoT 样本评估 TP=2 TN=4 FP=0 FN=0。
- RISKS.md updated with per-item dsh 0.1.0-rc.6 verification dates and validation boundaries — RISKS.md 记录逐条目 dsh 版本验证日期与验证边界。

## [0.1.0] - 2026-08-15

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
