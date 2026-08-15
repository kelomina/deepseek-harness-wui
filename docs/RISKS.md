# 风险与已知问题

最后更新：2026-08-14（dsh 0.1.0-rc.6）

## 高风险

| 风险 | 状态/缓解 |
|---|---|
| dsh developer preview，破坏性变更频繁 | 所有 @deepseek-ai/* 精确锁定（0.1.0-rc.6）；升级走 docs/DEVELOPMENT.md 流程 |
| npm 分发不一致（如 dsh-type-meta 未发布、部分包 latest tag 落后） | 安装 `@deepseek-ai/dsh@0.1.0-rc.6` 实测成功；用 next tag 对应版本；升级时先做安装冒烟 |
| 官方浏览器包（dsh-client-connection/client）是自定义模块加载器格式，无法直接 import | 已绕过：复用 `dsh-host-apiproxy/client` 纯 ESM 协议核心 + 复刻官方 WS 传输（MIT）；包内 `src/*` exports 指向缺失文件，不可用 |
| dsh `/api` 浏览器 Origin 围栏 | Rust 代理必选（已实现）；直连会被 403 |

## 中风险

| 风险 | 说明 |
|---|---|
| 前端协议链路仅验证到 TCP 层（WebView↔代理连接），UI 内状态需人工确认 | 下一步：交互验收 + 截图证据 |
| 应用级 API 花费/预算护栏未实现 | dsh 自带 token-meter；应用级 spend guard 属 dsh 配置域，列为后续迭代 |
| 未签名安装包触发 SmartScreen | 正式分发前做代码签名 |
| 分发依赖目标机 Node.js | 后续把 Node/dsh 打进安装包（sidecar/自包含） |
| CSP 含 `'unsafe-inline'`（dev 兼容） | 生产可收紧为 nonce/hash；记入硬限制变更流程 |

## 低风险/已记录

- 会话页历史渲染为通用映射（工具事件显示 JSON 摘要），非官方 1:1 渲染。
- 目录浏览器依赖 dsh `browse` capability；`pickDirectory`（native）未启用。
- Windows 强制终止（taskkill /F）无优雅退出；正常关窗会触发清理（已实测无残留）。

## 变更记录

- 2026-08-14：spike 实证 Origin 围栏行为（403）；确认 0.1.0-rc.6 客户端包可安装；
  确认浏览器 bundle 不可直接 import，采用 AbstractApiClient 子类方案。

## 已处置：Dependabot glib 告警（GHSA-wrw7-89jp-8q8g，2026-08-14）

- 告警：`glib` `<0.20.0` 的 `VariantStrIter` Iterator 实现存在 unsoundness（medium）。
- 无法升级原因：`tauri 2.11.5`（当前 crates.io 最新稳定版）锁定 `gtk ^0.18` → `glib ^0.18`；
  glib 0.20+ 需要 gtk-rs 0.20+ 全家桶，上游尚未升级。`cargo update -p glib --precise 0.20.0` 实测被约束拒绝。
- 影响面评估：本项目为 Windows-only 构建（WebView2）；glib/gtk 链属于非 Windows target 依赖，
  不编译进产物，应用代码不调用 glib。该告警不影响 Windows 交付物。
- 处置：GitHub Dependabot alert #1 以 `won't fix` dismiss（注释含上述证据）。
- 升级路径：tauri 发布支持 glib 0.20+ 的新版后执行 `cargo update` 并复验；届时移除本条目。

## 2026-08-14：Code 模式数据契约（已确认，UI 已接入）

- [事实] dsh 工具结果自带 diff：`ToolResultView` 的 `DiffResultView { diffs: FileDiff[] }`，
  `FileDiff { path, oldText|null, newText }`；write/edit 工具把 `FsDiffMeta{diffs}` 附加于 tool/result meta 并持久化于会话日志，
  逐 hunk、3 行上下文（官方 `dsh-tools`/`dsh-tool-fs` 类型与 README 实证）。
- 终端输出：`TerminalCallView`/`TerminalResultView{output,exitCode,signal}`；代码查看：`ReadResultView`（带行号）。
- [事实] dsh 无 pending-diff/接受语义：工具直接应用修改，diff 是"已应用"结果。设计稿的「接受全部/逐 hunk 接受/拒绝」
  为 UI 层交互（本实现为本地状态标记；「拒绝=还原 oldText」需新增受限 Rust 写文件命令，列为后续迭代）。
- 提供商 CRUD：已实现真实写路径（2026-08-14 实验实证）——`settings.mutate`（set/unset path）增删改路由，
  `credentials.set` 写 Key；添加 llm-pi-ai 路由需显式 `api`（openai-completions|openai-responses|anthropic-messages），
  保存即激活（active=true）。"默认模型"无 per-provider 字段，模型选择在新建会话时进行。
- 预设 provider 删除语义（2026-08-14 实验实证）：dsh 内置 catalog 预设（pi-ai 40+ 路由）无法从 dsh 移除；
  已配置预设删除 = `unset providers.<name>` 回退未激活（仍显示）；未配置预设删除 = 应用本地隐藏（localStorage，可恢复）；DeepSeek 官方禁删。

## 2026-08-14：模型空回复根因（已修复）——Node/dsh 不读系统代理

- [事实] 本机系统代理 127.0.0.1:7897；curl 读环境代理可访问 opencode.ai，而 Node/dsh 默认不读环境代理（需 NODE_USE_ENV_PROXY=1），
  直连被网络阻断 → dsh 报 TRANSPORT Connection error（重试后仍失败）→ 会话显示"空回复"。
- 定位链：复现事件 assistant/chunk 为 error finish（TRANSPORT）→ 注入 HTTP(S)_PROXY + NODE_USE_ENV_PROXY=1 后 opencode-go 正常回复。
- 修复：dsh-manager 启动 dsh 时注入 NODE_USE_ENV_PROXY=1 + HTTP_PROXY/HTTPS_PROXY/NO_PROXY；
  代理地址默认自动检测系统代理（HKCU Internet Settings），设置页可开关/覆盖。
- 附带：会话页现在会显示 llm/error 与错误 finish 事件（不再只见"空"）。

## 2026-08-14：UI 五项修复的协议依赖实证（已修复）

- [事实] 流式回复：dsh live mux 流以 `assistant/chunk`（`chunk.type` ∈ `text-delta`/`reasoning-delta`/`block-start`/`block-end`/`usage`/`finish`）逐 token 推送；
  持久化日志会把连续同块 delta 打包为 `text-chunks`/`reasoning-chunks` 行（storage-only，非事件）。UI 现按 (turn, step) 累积
  `text-delta`/`reasoning-delta` 形成进行中回复快照，`assistant/message` 到达后切换为正式消息。
  验证：对真实会话日志按 chunk-rows 解码规则还原 1878 个 delta 事件，累积文本/思考与最终 `assistant/message` 完全一致。
- [事实] 红色文字根因：`remark-math`/`micromark-extension-math` 把 `$$` 当作 fence，`$$\begin{aligned}` 中 `\begin{aligned}` 被当作 fence meta 剥离，
  且闭合 `$$` 需独占行首，`\end{aligned}$$` 不被识别 → 整段 math 未闭合，KaTeX 解析失败 → `.katex-error` 红色吞掉后续整篇。
  修复：渲染前把 `$$\begin{…}…\end{…}$$` 与单行 `$$…$$` 规范为 `$$` 独占一行的 fence 形式。验证：该会话全文渲染 `katex-error` 为 0。
- [事实] 会话移除：`sessions.list` 返回全部（含已归档）会话；归档集合来自 `workspace.list.archivedSessionIds` 与 `host/archived-sessions-changed`。
  修复：store 记录归档集合，左侧列表按归档过滤。
- [事实] 系统提示词：dsh 会把系统提示词快照（`@deepseek-ai/dsh-system-prompt`，source.kind=plugin）、skill catalog（source.kind=skill-catalog）、
  注入指令（source.kind=agent-instructions）作为 `user/message` 事件投影。UI 现仅渲染 source.kind === 'user' 的真实用户消息（7 个会话 23 条真实消息全部保留）。

## 2026-08-15：Agent 模式选择 + 插件管理（已实施，含桥接边界实证）

- [事实] Agent 模式：dsh apiproxy 暴露 `agentPreset.list/select/read/copy/openDocument/remove`；
  `agent-presets` settings 命名空间在配置客户端白名单内（`PRODUCT_SETTINGS_NAMESPACES`），
  「设为默认」经 `settings.mutate` 写 `default` 字段。四种内置预设来自安装内
  `config/agent-presets/{standard,code,minimal,cordis}`：标准 / PTC / 极简 / 创造模式（以安装内 preset.yml 的 name 为准）。
  `select` 仅允许空白会话（已跑过对话会返回 `agent-preset-locked`）。新建任务页 chip 为暂存选择，创建会话时应用后清除。
- [事实] 插件管理：dsh apiproxy **不暴露** 插件启停 / 导入 / 删除 RPC（宿主侧 `pluginInventory` 为 Typert 只读服务，浏览器不可达）。
  实施为 Rust 桥接：`plugins_list` 跑 `dsh web --dump-config`（composed profile 树，只读）并按行解析；
  `plugins_set_enabled` 保守编辑 `cordis.patch.yml`（备份后写 `disabled: true` 覆盖，复杂 patch 拒绝改写）；
  `plugins_import/remove` 转发 `dsh plugin --profile web add/remove`（pnpm，需本机 pnpm + 网络，可能需重启 dsh 生效）。
  条件禁用（`disabled: !!js ...`）仅标记为「条件」，不提供手动开关；「内置」按 `@deepseek-ai/` 前缀启发式判定。
- 验证：cargo 单测 5 项（解析 / 空列表启停 / 已有条目启停 / 复杂 patch 拒改 / id 校验）全部通过；
  真实 `--dump-config` 解析出 129 条（启用 102 / 禁用 25 / 条件 2）；`npm run build` 与 `cargo check` 通过。
- 未验证：未在真实 dsh 上做 live 交互（未创建会话 / 未实际执行 pnpm 导入导出，避免未经授权改动用户 dsh 状态与安装包）。

## 2026-08-15：UI 六项调整（已实施）

- [事实] 会话重命名：dsh `sessions.rename` 追加 `user` 源 `session/title`，固定标题不被自动重命名覆盖；自动重命名由
  `dsh-session-title-first-prompt-llm` 基于首个 prompt 生成（会话日志含 `session/title-llm-request`）。右侧列表右键新增「重命名」。
- [事实] 会话内 Agent 模式：`agentPreset.select` 仅对空白会话生效（已开始会话返回 `agent-preset-locked`）。
  会话视图 env-bar 新增 Agent 模式 chip（空白会话可立即更换；已开始会话列表置灰并提示固定），新建任务页 chip 仍为暂存选择。
- [事实] 会话权限配置：dsh 对浏览器（apiproxy）暴露的权限接口是 `permission` settings 命名空间（默认权限，新会话生效，schema 枚举 read-only / workspace-write / danger-full-access，
  实测 `settings.describe` 可读、`settings.mutate` 可写）。切换「当前会话」权限是宿主侧 `/permission` 命令（Typert `commands.execute`，经官方客户端进程内调用，外部浏览器经 apiproxy 不可达；
  实测经 `session.prompt` 发送 `/permission <preset>` 会被当作普通消息触发模型回合——已回滚该实现）。env-bar「权限」菜单：会话视图显示当前会话权限（`permissions` 投影），选择写入默认权限；欢迎页直接设置默认。
- [事实] 设置页滚动/垂直居上：`.view.active{height:100%}` 后，`.col-settings` 网格因 `align-content:normal`(stretch) 把行撑开导致内容居中；
  改为 `align-content:start` 恢复顶部对齐（Edge headless 实测 cardTop 202→125）。
- 插件条件禁用行（`disabled: !!js ...`）标注「插件无法启用」并禁用开关。
