# 开发计划：按 docs/UIDesign.desktop.html 重构 UI

- 状态：已批准（2026-08-14）
- 进度：阶段 0-5 已完成（2026-08-14 实施），提交见 git log
- 设计稿：`docs/UIDesign.desktop.html`（单视图切换版，含 Work/Code 双模式）
- 目标：重构前端为设计稿形态（自定义标题栏 + 新侧边栏 + 6 视图），保持 Rust 后端（dsh-manager/proxy/协议层）不变。

## 背景与关键语义

- **Work 模式** = 对话式会话（消息流 + 工具卡 + 审批 + 输入区）。
- **Code 模式（AIDE）** = 显示实际代码的三栏视图：变更文件 → diff 逐 hunk 接受/拒绝 → AI 侧聊 + 底部终端/状态栏（人主导、AI 协作）。
- dsh 官方无内置 AIDE；Code 模式为本项目差异化能力，数据契约见阶段 0 结论。

## 阶段

| 阶段 | 内容 | 验收 |
|---|---|---|
| 0 | Spike 数据契约：tool/result 是否含 diff/补丁；变更文件列表重建；提供商 CRUD 写路径；hunk 接受/拒绝语义 | 数据契约结论 + 降级方案（本文档追加） |
| 1 | 壳层：decorations:false + 窗口控制；TitleBar/Sidebar；单视图切换；设计稿 tokens CSS | 无系统边框可拖拽/按钮可用；视图切换；cargo check + npm run build |
| 2 | 欢迎页 + Work 会话（hero/composer/env-bar、消息流、审批、发送/停止双态） | 发送→实时消息；审批/停止可交互 |
| 3 | Code AIDE 三栏 + term-strip + status-bar（按阶段 0 数据契约接入；允许 MVP 降级） | 按设计稿渲染；hunk/侧聊交互；≤1280 隐藏侧聊 |
| 4 | 内部页面：状态网格、工作区 ws-row、设置提供商可配置 | 与设计稿一致；CRUD 可用或标注能力边界 |
| 5 | 响应式/空态/错误态；构建运行验收；文档更新；提交推送 | 逐视图核对 + 证据记录 |

## 写集边界

- 允许：`src/` 全部前端、`src-tauri/tauri.conf.json`、`src-tauri/capabilities/`、`src-tauri/src/lib.rs`（如需新命令）、`docs/`、README/AGENTS。
- 不动：Rust `dsh-manager/proxy` 核心、`runtime/`、官方 dsh 上游。

## 主要风险

1. Code diff 数据源未知 → 阶段 0 spike；MVP 可降级（文件内容/工具结果/git diff）。
2. hunk 接受/拒绝：dsh 无“接受 diff”语义（agent 直接改文件）→ 先 UI 本地态 + 后续 git 集成。
3. 提供商 CRUD：llm.providers 只读；写路径需 spike；无 API 部分 UI 标注禁用。

## 验证与证据

- 每阶段：`npm run build`、`cd src-tauri && cargo check`、`npm run tauri dev` 运行验收（窗口/视图/无 frontend-error/链路）。
- 阶段 5：对照设计稿逐视图核对，记录证据到 docs/。

## 阶段 0 结论（2026-08-14，基于官方包类型与 README 实证）

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

