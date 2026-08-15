# DevContext — DeepSeek Harness Desktop（开发与版本变更上下文）

> 2026-08-15 合并自 `docs/DEV_PLAN.md`（UI 重构开发计划）与 `docs/devContext.md`（0.2.0 版本变更工作区）。
> 本文档是项目的开发上下文：UI 重构计划与数据契约结论（§5-6）+ 0.2.0 版本变更生成依据（§1-4）。
> 最终发布文案见 `CHANGELOG.md`。

## 1. 基线事实（[事实]，2026-08-15 取证）

| 项 | 值 |
|---|---|
| 项目 | DeepSeek Harness Desktop（Tauri 2 + React/TS/Vite，Windows 目标） |
| 版本 | `0.2.0`（package.json / Cargo.toml / tauri.conf.json / runtime 已同步 bump，2026-08-15） |
| Git tag | `v0.1.0` → `045cbbf`（bootstrap，2026-08-14 14:07；2026-08-15 从 HEAD 回移） |
| dsh 运行时 | `@deepseek-ai/dsh` `0.1.0-rc.6`（精确锁定） |
| 分支 / 工作区 | main / 待提交 |
| 提交 | 33 个（bootstrap → `89cdb58` HEAD）；**0.2.0 = bootstrap 后全部开发（32 个 feature/fix）** |

## 2. 决策记录（0.2.0 版本变更，用户确认 2026-08-15）

1. **变更基线**：0.2.0 = bootstrap 之后全部开发（32 个提交）。✔
2. **版本/tag**：bump `0.1.0 → 0.2.0`（7 个文件）；`v0.1.0` 回移到 `045cbbf`。✔
3. **语言**：双语（English — 中文）。✔
4. **粒度/产物**：用户可见特性聚合 → `CHANGELOG.md`（仓库根）。✔
5. **范围**：纳入已知限制（沿用 RISKS/HARD_LIMITS 口径）。✔

## 3. 0.2.0 变更清单（候选，git log 聚合）

### 3.1 UI 重构（按设计稿重构，§5 阶段 0-5 已完成）
- 全新自研前端：无边框自定义标题栏、Work/Code 双模式、Code AIDE 三栏（变更文件 / diff 逐 hunk 接受/拒绝 / AI 侧聊 + 终端/状态栏）。
- 视图/布局：消息区内滚、底部粘性自动滚动、可折叠侧栏、向上展开菜单、composer 滚动修复。
- 修复：vite 绑定 127.0.0.1（IPv6-only localhost 空窗）、store getter 绑定、代理允许 127.0.0.1 dev origin。

### 3.2 设置与模型提供商
- DeepSeek API Key 配置；真实 provider CRUD（`settings.mutate` 写路径）；预设 provider 删除/隐藏语义；
  provider 表单（id/name/context）；可展开模型行；连接测试（`discoverModels`）；HTML 错误截断。
- agent preset 选择器、settings manager、plugin manager（Rust bridge）、permission 菜单、settings 标签页、会话重命名。

### 3.3 会话与消息流
- 工作区分组会话、历史加载/合并、发送后刷新、会话归档过滤、右键菜单 fork 到新会话。
- 消息：流式输出、thinking 指示器（回复体开始时自动折叠）、markdown + KaTeX、隐藏 comm 事件、
  错误与空回复展示、内容读取路径修复（`data.message.content`）。
- 消息菜单：Rust 剪贴板复制、retract 带文件还原（diff 反向 + git restore 删除）+ 确认对话框。
- 模型选择：显示 provider/display name、reasoning effort 选择器、持久化到 config、仅错误行标红。

### 3.4 dsh 托管 / 代理 / Rust 侧
- 启动时自动清理 stale dsh 进程（PowerShell CIM）；dsh 端口预检，EADDRINUSE 明确报错。
- 代理注入系统代理（`NODE_USE_ENV_PROXY`）修复空模型回复；状态栏显示注入代理、错误事件标红。
- 工作区 native 目录选择器（`host.pickDirectory`）。

### 3.5 文档与清理
- RISKS 记录 glib dependabot 告警处置（upstream-blocked）；移除过时 UIDesign mockups。

> 定稿发布文案（双语、用户可见特性聚合）见 `CHANGELOG.md`。

## 4. 产物与验证状态

| 产物 | 路径 | 状态 |
|---|---|---|
| 版本 bump | `package.json` / `package-lock.json` / `src-tauri/Cargo.toml` / `src-tauri/Cargo.lock` / `src-tauri/tauri.conf.json` / `runtime/package.json` / `runtime/package-lock.json` | 已写入，验证通过 |
| CHANGELOG | `CHANGELOG.md` | 初版已生成 |
| 开发上下文（合并） | `docs/devContext.md` | 本轮维护（合并 DEV_PLAN） |

验证：`npm run build` 通过；`cargo check` 通过（`deepseek-harness-wui v0.2.0`）。

## 5. UI 重构开发计划（原 docs/DEV_PLAN.md）

- 状态：已批准（2026-08-14）
- 进度：阶段 0-5 已完成（2026-08-14 实施），提交见 git log
- 设计稿：原 `docs/UIDesign.desktop.html`（单视图切换版，含 Work/Code 双模式；该 mockup 已于 2026-08-15 移除，见 git `b7f4e91`，本节为历史计划记录）
- 目标：重构前端为设计稿形态（自定义标题栏 + 新侧边栏 + 6 视图），保持 Rust 后端（dsh-manager/proxy/协议层）不变。

### 背景与关键语义

- **Work 模式** = 对话式会话（消息流 + 工具卡 + 审批 + 输入区）。
- **Code 模式（AIDE）** = 显示实际代码的三栏视图：变更文件 → diff 逐 hunk 接受/拒绝 → AI 侧聊 + 底部终端/状态栏（人主导、AI 协作）。
- dsh 官方无内置 AIDE；Code 模式为本项目差异化能力，数据契约见 §6 阶段 0 结论。

### 阶段

| 阶段 | 内容 | 验收 |
|---|---|---|
| 0 | Spike 数据契约：tool/result 是否含 diff/补丁；变更文件列表重建；提供商 CRUD 写路径；hunk 接受/拒绝语义 | 数据契约结论 + 降级方案（本文档追加） |
| 1 | 壳层：decorations:false + 窗口控制；TitleBar/Sidebar；单视图切换；设计稿 tokens CSS | 无系统边框可拖拽/按钮可用；视图切换；cargo check + npm run build |
| 2 | 欢迎页 + Work 会话（hero/composer/env-bar、消息流、审批、发送/停止双态） | 发送→实时消息；审批/停止可交互 |
| 3 | Code AIDE 三栏 + term-strip + status-bar（按 §6 数据契约接入；允许 MVP 降级） | 按设计稿渲染；hunk/侧聊交互；≤1280 隐藏侧聊 |
| 4 | 内部页面：状态网格、工作区 ws-row、设置提供商可配置 | 与设计稿一致；CRUD 可用或标注能力边界 |
| 5 | 响应式/空态/错误态；构建运行验收；文档更新；提交推送 | 逐视图核对 + 证据记录 |

### 写集边界

- 允许：`src/` 全部前端、`src-tauri/tauri.conf.json`、`src-tauri/capabilities/`、`src-tauri/src/lib.rs`（如需新命令）、`docs/`、README/AGENTS。
- 不动：Rust `dsh-manager/proxy` 核心、`runtime/`、官方 dsh 上游。

### 主要风险

1. Code diff 数据源未知 → 阶段 0 spike；MVP 可降级（文件内容/工具结果/git diff）。
2. hunk 接受/拒绝：dsh 无“接受 diff”语义（agent 直接改文件）→ 先 UI 本地态 + 后续 git 集成。
3. 提供商 CRUD：llm.providers 只读；写路径需 spike；无 API 部分 UI 标注禁用。

### 验证与证据

- 每阶段：`npm run build`、`cd src-tauri && cargo check`、`npm run tauri dev` 运行验收（窗口/视图/无 frontend-error/链路）。
- 阶段 5：对照设计稿逐视图核对，记录证据到 docs/。

## 6. 阶段 0 结论：数据契约（原 docs/DEV_PLAN.md，2026-08-14 基于官方包类型与 README 实证）

### Code 模式数据源（官方能力，可直接使用）
- **diff**：工具结果自带。`ToolResultView` 含 `DiffResultView { card:'diff', diffs: FileDiff[] }`，
  `FileDiff { path, oldText: string|null, newText: string }`；write/edit 工具把 `FsDiffMeta{diffs}` 附加在
  tool/result meta 并持久化于会话日志（`diffsFromMeta` 可在 replay 还原），逐 hunk、3 行上下文。
  调用时另有 `DiffCallView`（基于调用参数的预估 diff）。
- **变更文件列表**：聚合会话内全部 `DiffResultView.diffs` 按 path 分组，`+/-` 由 oldText/newText 行数差计算；
  `FileLocation{path,line?}` 支持 follow-along。
- **打开文件**：`ReadResultView`（`ReadFileLine{number,text}[]`，fs.read 结果视图，带行号）。
- **终端**：`TerminalCallView{cwd,title}` + `TerminalResultView{output,exitCode,signal}`（term-strip 数据源）。
- **获取路径**：mux 流 `session/event` 帧的 `view?: ToolEventView`（`{for:'call'|'result', view}`）——现有 store 已接收，只需提取。

### hunk 接受/拒绝（语义确认）
- dsh 无 pending-diff/接受概念：工具直接应用修改，diff 是“已应用”结果。设计稿的「接受全部/逐 hunk 接受/拒绝」为 UI 层交互：
  MVP 先做 UI 状态标记；「拒绝=还原 oldText」可新增受限 Rust 命令（仅会话工作区内路径 + oldText 精确校验），阶段 3 内决策。

### 提供商 CRUD（可行）
- 读：`llm.providers` → `ConfigurableProviderView{provider, displayName, settingsNs, settingsPath, active}`。
- 写：`settings.describe({ns})` 拿 schema → `settings.mutate({ns, ops})` 增删改路由；`credentials.set/unset` 管 Key。
- 结论：添加/编辑/激活/删除可实现；具体 op 按 describe schema 构造；dsh 不支持处 UI 标注（settings-rejected）。

## 7. 迭代记录

- 2026-08-14：DEV_PLAN 批准，阶段 0-5 实施完成（原 docs/DEV_PLAN.md）。
- 2026-08-15：创建 devContext；提取基线事实与候选清单；产出草案 v0。
- 2026-08-15：用户确认 4 项决策；bump 版本至 0.2.0（7 文件）；生成双语 CHANGELOG.md；`v0.1.0` 回移 bootstrap；合并 DEV_PLAN 与 devContext；README 加入 CHANGELOG 链接。