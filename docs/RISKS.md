# 风险与已知问题

最后更新：2026-08-24（dsh **0.1.1-rc.2**；新增 @dsh-std 生态观察条目，见文末 2026-08-24 段）

## 高风险

| 风险 | 状态/缓解 |
|---|---|
| dsh developer preview，破坏性变更频繁 | 所有 @deepseek-ai/* 精确锁定（**0.1.1-rc.2**）；升级走 docs/DEVELOPMENT.md 流程 |
| npm 分发不一致（如 dsh-type-meta 未发布、部分包 latest tag 落后） | 安装 `@deepseek-ai/dsh@0.1.1-rc.2` 实测成功；用 next tag 对应版本；升级时先做安装冒烟 |
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

- 会话历史工具事件渲染已按官方 presentation 契约实现 1:1 卡片（2026-08-15，条目 8）；无 view 时回退通用 JSON 摘要。
- 目录浏览器依赖 dsh `browse` capability；`pickDirectory`（native）未启用。
- Windows 强制终止（taskkill /F）无优雅退出；正常关窗会触发清理（已实测无残留）。

## 变更记录

- 2026-08-25：**[已修复] mac 受管运行时启动 ERR_MODULE_NOT_FOUND（@deepseek-ai/dsh-app-boot 缺失）**
  ——根因：受管安装只解压主包 tarball 不装依赖树；npm 自动 peer 解析又病态慢（>25min）。
  改为「显式 manifest 锁根 + --legacy-peer-deps + peer 闭包迭代 + bin 冒烟门禁」，
  live E2E 132s 全流程 PASS。**mac 用户需重装一次运行时**（见文末专段）。
- 2026-08-24：dsh-std 宿主 **P3 准入与证据收口**：wui-admission-v0.1.md profile 文档、
  上游 fixtures 交叉比对 12/12 PASS（evidence/dsh-std-fixtures-crosscheck-*.md）、
  任意本地插件目录激活、README/CHANGELOG 收口与措辞审计。详见文末 P3 段。
- 2026-08-24：dsh-std 宿主 **P2 执行接入落地**：插件 entry 真实激活/执行、grants 持久化（Rust 侧权威）、
  TUI-OBS-002 对标清理语义、崩溃自愈（≤2 次自动重启）、打包资源接入、E2E 证据
  evidence/dsh-std-p2-e2e-2026-08-24T14-30-29.md（20 断言 PASS）。详见文末 P2 段。
- 2026-08-24：dsh-std 宿主 **P1 最小宿主落地**（feature flag 语义：sidecar 仅显式启动，默认 stopped）：
  新增 `plugin-host/`（@dsh-std/*@0.1.0-rc1 精确锁定，node:test 24/24 绿）+ `src-tauri/src/dsh/plugin_host.rs`
  看护（cargo test --lib 34 过）+ 设置页插件 Tab 实验区。详见文末 P1 段。
- 2026-08-24：dsh-std / dsh-ecosystem-spec 生态评估 P0 spike 完成（GO），新增文末观察条目；
  实施契约见 docs/DSH_STD_HOST_PLAN.md，spike 报告见 docs/DSH_STD_SPIKE.md。
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

## 2026-08-15：0.2.0 P0 会话正确性（条目 5/8/9/10/11，已实施）

- [事实] 停止（条目 5）：`sessions.cancel` 为官方中断 RPC（dsh 0.1.0-rc.6 类型契约：「Stops an ordinary session's active turn」）。
  实现：点击停止后立即进入「正在停止」，调用 `sessions.cancel`（ok 记录 cancelAcceptedAt 证据），默认 2s 时限内 UI 切换为已停止
  （前端止流降级：冻结流式快照直到下一轮 turn/start）。`turn/end(reason.kind=aborted)` 记录 turnEndAbortedAt 证据。
  停止后不追加流式内容、UI 状态一致、可再次发送。时限 2s 为默认值，未实测调整（如后续实测需调整在 RISKS 记录原因）。
- [事实] 工具调用渲染（条目 8）：已按官方 presentation 契约实现 1:1 卡片渲染
  （DiffCallView/DiffResultView、TerminalCallView/TerminalResultView、ReadResultView、SearchResultView、WebResultView、GenericCallView）。
  无 view 时回退通用 JSON 摘要。此前「会话历史工具事件为通用映射渲染」记录已更新。
- [事实] 空消息合并（条目 9）：使用官方 `deriveEventMessage`（@deepseek-ai/dsh-session/surface）抑制空 content 的 assistant/message；
  仅思考的 assistant/message 合并到下一条有文本消息；轮末无文本时思考挂到最后一个工具卡片（不产生空消息气泡）。
  验证：fixture 测试 8/8 通过（scripts/test-render.ts）。
- [事实] 重试（条目 10）：重试 = 撤回（fork 到该消息之前的轮次边界 prevTurnEnd）+ 重发。
  dsh 0.1.0-rc.6 无「当前会话内撤回」RPC（sessions API 仅 list/search/create/history/models/selectModel/rename/fork/prompt/attachment/updateQueue/cancel），
  因此 fork 会新建会话；新会话 seed 前缀 = 到 prevTurnEnd 的事件（消息不在其中，只出现一次）。
  验证边界：以 dsh 可观察会话状态（新会话历史/seed 前缀）为准；无法直接检查模型上下文，已在 UI notice 与 RetractModal 明示。
- [事实] 撤回（条目 11）：dsh 协议不支持「当前会话内撤回」，按裁剪条件记录协议限制并降级：
  撤回 = fork@prevTurnEnd + 可选文件回退（fs_revert / git_restore_deleted），切换至新会话，原会话保留；RetractModal 明确标注协议限制与新建会话语义。
  验证边界：会话 ID 变化、原会话保留、retract/fork 状态经 sessions.list 可查。

## 2026-08-15：0.2.0 P1 运行时管理（条目 3，已实施 + live E2E 证据）

- [事实] `DownloadsApi.sessionLog` 仅用于会话日志 ZIP 下载（host-only，浏览器客户端不可达），不是运行时下载。
- 实现：自研下载管道（src-tauri/src/dsh/runtime.rs）——
  首选 npm registry（`https://registry.npmjs.org/@deepseek-ai/dsh/<version>`），版本精确锁定（禁止范围/通配），
  `dist.integrity`（sha512）为必须校验项；校验失败禁止安装。安装到 app_config_dir/runtimes/<version>，
  记录 integrity + bin.js sha256 + 安装时间；移除 = 移到 .trash-*（可逆回滚）。
- 验证：单元测试 3 项（版本校验/篡改拒绝/registry 口径）；live E2E `cargo test -- --ignored runtime_live_install_and_verify`
  （2026-08-15，网络实测下载 @deepseek-ai/dsh@0.1.0-rc.6，integrity 校验 + 解包 + 版本核对 + bin sha256 + verify ok）通过。
- 备选 GitHub release：官方未提供可信发布物，本轮未启用，记录为后续。
- 异常路径覆盖：下载失败、校验失败（拒绝安装）、磁盘空间/权限（std::io 错误透出）、已存在版本（拒绝，需先移除可回滚）、回滚/恢复。

## 2026-08-15：0.2.0 P1 WSL（条目 2，已实施；写操作经确认 + 备份）

- [事实] 本机 WSL 可用：默认发行版 CodexUbuntu（WSL 2），另有 CentOS8-stream、docker-desktop。
- `wsl.exe` 管道输出为 UTF-16LE：已实现 UTF-16LE 解码（含 BOM）；解析 `wsl --status` / `wsl -l -v`。
- 写操作边界：仅写应用 config.json 的 wsl_* 字段（默认发行版 / DSH_HOME / 工作区），最小权限、前端二次确认、保存前备份 config.json.bak-<ts>（可逆）；
  不做跨发行版系统级管理（/etc/wsl.conf、注册表等）。路径校验仅支持 `\\wsl$\<distro>\`。
- 验证：单元测试 4 项（UTF-16LE 解码、发行版表格解析、多词发行版名）。无 WSL 时 UI 显示不可用原因，不阻塞主流程。
- 未验证：未在真实 dsh 会话中使用 WSL 工作区（需用户确认创建 WSL 工作区会话后实测）。

## 2026-08-15：0.2.0 P1 工具视图（条目 1，已实施 MVP；部分降级）

- 数据源与官方类型契约一致：diff=DiffResultView/FileDiff、terminal=TerminalCallView/TerminalResultView、file=ReadResultView、web=WebSearchResultView/WebFetchResultView。
- 文件管理器：只读目录浏览（host.listDirectory browse capability）+ 会话涉及文件清单；终端/浏览器/Git 为只读记录视图（无交互式 pty / 真实浏览器 / git 操作，已标注能力边界）。
- 宽度 ≤1280 时工具面板默认折叠（CSS media query）。收集器纯函数测试 5/5 通过（scripts/test-toolviews.ts）。

## 2026-08-15：0.2.0 P2 V4-Pro 思维链降智检测（条目 4，已实施；模型可识别性为假设）

- 模型可识别性 spike：**未在真实 dsh 会话实证** V4-Pro 出现在 llm.models / session.models.current 的 id/displayName。
  实现为启发式 `isV4ProModel`（id 精确匹配 deepseek-v4-pro 或带 -xxx 后缀）；未确认前按假设处理（docs/devContext.md 同口径）。
- 检测：可配置正则（localStorage cotDetect，默认保守规则），命中显示非阻断提示（不阻断对话、不改变模型路由、不构成模型身份结论）。
- 样本评估（2026-08-15，标注样本 6 条）：TP=2 TN=4 FP=0 FN=0（scripts/test-cot.ts）。样本量小，仅作记录，不构成生产准确性结论。

## 2026-08-15：0.2.0 P2 插件 UI 兼容（条目 6，spike 结论：无独立挂载契约，已降级）

- spike（dsh 0.1.0-rc.6）：官方插件 UI 挂载 = cordis + React slot registry（@deepseek-ai/dsh-client-ui-slots 的 register/renderSlot）
  + 官方 shell（@deepseek-ai/dsh-client-web buildRenderApp 渲染 root slot）+ 模块加载/HMR（dsh-client-modules/dsh-client-hmr，/plugins/events SSE）。
- 结论：插件 UI 组件是进程内 React 组件注册（cordis fiber 生命周期 + store 席位），无第三方外壳可独立挂载的公开契约。
  按 devContext 裁剪条件降级：只读插件清单与启停（已有插件管理入口）+ 文档说明；插件 UI 挂载移出 0.2.0（后续迭代候选：官方 1:1 渲染/运行时整体嵌入）。

## 2026-08-15：运行时门禁实测（npm run tauri dev）

- [事实] 2026-08-15 12:46-12:47 实测 `npm run tauri dev`（dsh 0.1.0-rc.6 bundled）：
  - 主窗口出现，标题 `DeepSeek Harness Desktop`（deepseek-harness-wui PID 19100）；
  - dsh 端口 3080 被 node 进程监听（`runtime/node_modules/@deepseek-ai/dsh/lib/bin.js web --port 3080`）；
  - 代理在 127.0.0.1 监听（app 进程代理端口 62154）；
  - 优雅关闭（CloseMainWindow）后 app 退出、3080 释放、无残留 dsh 进程。
- 注：启动时 1420 端口已被更早（11:14）遗留的 vite dev server 占用，本次 beforeDevCommand 的 vite 绑定失败，
  app 从既有 dev server 加载；不影响上述运行时路径验证。证据文件 `evidence/runtime-gate-20260815.txt`（gitignored）。
- 代理隔离测试：`cargo test -- --ignored proxy_binds_loopback`（2026-08-15）——代理绑定 127.0.0.1、非白名单 Origin 403、无 Origin 走转发路径，通过。
## 2026-08-16：WSL 联网端到端验证（条目 2/3 闭环）+ WSL 执行模式落地

- 目标：宿主机应用内「连接 WSL 用 dsh 启动 DSH」完整闭环 —— 在 WSL 发行版内安装 Node + dsh，
  经 `wsl.exe` 前台启动 dsh，宿主机经 WSL2 localhost 转发访问其 Web 服务。
- [事实] 锁定版本：dsh **0.1.0-rc.6**、Node **v22.19.0**（满足 dsh 运行依赖 pi-ai 的 node>=22.19.0，EBADENGINE 前置）。
- [事实] WSL2 网络转发：WSL 内绑定 127.0.0.1 的端口会被宿主机 `localhost` 转发访问；
  实测 `curl http://127.0.0.1:4001` 从宿主机返回 HTTP 200 与完整 HTML。dsh 只允许绑定 127.0.0.1 / 0.0.0.0，
  且拒绝 0.0.0.0（安全约束），故依赖该转发机制，无需改 dsh 绑定。
- [事实] 进程存活策略：WSL 内后台运行 dsh，`wsl.exe` 会话结束后子进程会被清理；
  必须**前台运行**（`exec dsh --profile web --port N`）保持 `wsl.exe` 会话活跃。已实现于 manager.rs `build_command` 的 `ExecMode::Wsl`。
- [事实] 跨环境文件传输：经 UNC 路径（`\\wsl$\<distro>\...`）在宿主机与 WSL 间传文件，避免 PowerShell 管道引入 CR 导致参数解析错误
  （`--port must be a number, got "4001\r"`）。
- [事实] MITM 环境：宿主受信任根 CA 导出为 PEM 注入 WSL（`~/.dsh-node/host-ca.crt`），缓解 SSL 校验失败；
  非 MITM 环境自动降级系统 CA。
- [事实] 残留清理：WSL 内 dsh 占用端口时，宿主 `find_dsh_pids` 只查宿主 node.exe 探测不到；
  新增 `wsl_kill_stale_dsh`（依赖 `ss`，iproute2）在 `start()` 前清理 WSL 内残留进程。
- 验证：`cargo check`、`cargo test --lib`（22 passed）、`npm run build` 通过；WSL 单测 7 项与 wsl_launch_user 2 项通过。
- 未验证：宿主机应用 UI 内点「启动」的完整链路（需 WSL 发行版内已装 dsh + 应用界面操作），本次为命令行级 curl 验证。

## 2026-08-16：WSL 完整闭环 e2e（创建 + 连接 + 启动 DSH，应用真实代码路径）+ base64 启动修复

- 目标：宿主机应用「一键创建 WSL → 安装 Node/dsh → 应用内连接 WSL 用 dsh 启动 DSH」完整闭环，
  经应用真实代码路径验证（`wsl::provision` + `DshManager::start` 的 `ExecMode::Wsl`）。
- [事实] 锁定版本：dsh **0.1.0-rc.6**、Node **v22.19.0**（满足 pi-ai 运行依赖 node>=22.19.0，EBADENGINE 前置），全程实测可装可启。
- [事实] 全量 e2e（首次跑）：`cargo test --features e2e -- --ignored --nocapture wsl_provision_and_start_dsh_e2e`
  —— 创建全新发行版（web-download 通道）→ 装 build 工具 + Node v22.19.0 + `@deepseek-ai/dsh@0.1.0-rc.6` → 应用内启动 dsh →
  宿主机经 WSL2 localhost 转发访问其 Web 服务 **HTTP 200**。
- **发现并修复**：WSL 启动脚本若用 `bash -c "<多行脚本>"` 直接传参，`wsl.exe` 参数转发破坏引号/换行/`$()`，
  首行变 `""`、`NODE_BIN` 为空，dsh 以 exit 1 退出（`/bin/bash: line 1: "": command not found`）。
  **修复**：`build_command` 的 WSL 分支把脚本 **base64 编码**，经 `bash -c "echo <b64> | base64 -d | bash"` 在 WSL 内解码执行
  （base64 仅含 `A-Za-z0-9+/=`，不受转发破坏）。
- [事实] 复验（复用已装好 Node+dsh 的发行版 `DSH_E2E_REUSE_DISTRO=<name>`，只重验 start 路径）：
  state=Running 且宿主机 http_ok=true；`stop()` 后端口 4199 释放。`cargo test --lib` 23 passed。
- 测试发行版已清理（`wsl --unregister` 全部 `DshE2E*`/`DshLoopbackTest`），仅保留本机原有 CodexUbuntu/CentOS8-stream/docker-desktop。
- 测试运行方式：`DSH_E2E_CLEANUP=1` 自动 unregister；`DSH_E2E_REUSE_DISTRO=<name>` 复用已就绪发行版跳过 create/install。

## 2026-08-15：dsh-routing-suite 集成（已实施）

- 第三方套装 dsh-routing-suite（https://github.com/yjh051108/dsh-routing-suite）以固定版本 vendored 进
  `plugins/dsh-routing-suite/`（注入器 dsh-super-injector 0.3.1 Release 构建 + router-standard 预设 0.1.0），
  出处/版本/哈希见 `plugins/dsh-routing-suite/VENDOR.md`。许可证：注入器 BSD-3-Clause、预设 MIT。
- [事实] 装配语义（与套装 install.ps1 一致）：注入器走 `dsh plugin --profile web add <vendored injector>`（pnpm，
  写 profile bundles，重启后由 bundles 接管）；预设复制到 `$DSH_HOME/.agent-presets/router-standard/`
  （dsh-agent-presets 官方用户根目录 `dshHomePath('.agent-presets')`，目录名 = preset id，符合 PRESET_ID）。
- 应用内实现：设置 → 插件新增「路由套装」卡片（状态 / 一键安装 / 可回滚卸载）。安装前备份旧预设为 `.trash-<ts>`
  （点前缀，dsh 预设扫描跳过）；卸载把预设目录重命名为 `.trash-<ts>` 并 `dsh plugin remove`（按 dump-config 解析出的包名）。
  注入器由 dump-config 行 `dsh-super-injector` 探测，复用插件管理解析器。
- 验证：cargo 单测新增 3 项（注入器行探测 / preset id 扫描安全 / copy_tree 递归复制）通过，全量 15 passed；
  `cargo check`、`npm run build` 通过；vendored 注入器含构建产物 `lib/index.js`（Release tgz，SHA-256 见 VENDOR.md）。
- 未验证（live）：未在真实 dsh 上执行 pnpm 装配 / 预设复制（避免未经授权改动用户 `~/.dsh` 与安装包）；
  安装/卸载后是否在 dsh 内正常装载（dev_* 工具出现、Router Standard 可被会话选择）需用户点「一键安装」后重启 dsh 实测。
  dsh 0.1.0-rc.6 验证日期 2026-08-15；上游为第三方社区项目，行为/质量以上游为准。
## 2026-08-15：dsh-routing-suite live 安装测试（用户授权；发现并修复注入器依赖解析）

- 按应用同款命令 live 安装（DSH_HOME=`C:\Users\Saika\.dsh`，bundled dsh 0.1.0-rc.6）：
  - 注入器：`dsh plugin --profile web add <vendored injector>` → pnpm 记录
    `@dsh-external/dsh-super-injector link:...`，写入 profile `dsh.profile.bundles`，profile node_modules 建 junction；
    `dsh web --dump-config` 出现 `- id: dsh-super-injector` 行。
  - 预设：复制到 `~/.dsh/.agent-presets/router-standard/`（6 文件，agent.cordis.yml 14248B）。
- **boot 门禁首次失败**：`dsh web --port 36000` 报
  `Cannot find package 'schemastery' imported from ...injector\lib\index.js`（ERR_MODULE_NOT_FOUND）。
  根因：pnpm `link:` 在 profile node_modules 建的是指向项目目录的 junction，Node ESM 按**文件真实路径**向上解析裸导入，
  看不到 profile/runtime 的 node_modules；注入器 lib 裸导入 `schemastery`（+ type-only `cordis`、`@deepseek-ai/dsh-tools`、`dsh-llm`、`dsh-client-ui-slots`），
  而 runtime 只有 scoped 的 `@deepseek-ai/schemastery`。
- 修复：应用安装流程在 pnpm add 后，把**当前生效 runtime**（bundled `runtime/node_modules` 或受管 `runtimes/<v>/node_modules`）的
  上述包 junction 进 `injector/node_modules/`（与上游 build.sh 同机制；目录被 .gitignore 的 `node_modules` 忽略）；卸载时只解链、不动 runtime。
- **修复后 boot 通过**：`dsh web --port 36000` 2.6s 内监听 127.0.0.1，无 stderr 错误；taskkill /T 清理进程树后端口释放。
  证据：`evidence/live-suite-boot-20260815-*.txt`（gitignored）。
- 预设静态校验：`~/.dsh/.agent-presets/router-standard/agent.cordis.yml` 用 dsh 官方 `entryListSchema`（cordis-plugin-include）解析通过
  （17 顶层行，shape OK），即 dsh agent-preset 扫描不会判 broken。
- 单测：新增 junction 创建/解链（Windows，temp）与 link-pairs 校验 2 项 → 全量 17 passed。
- 未验证（live）：dev_* 工具在模型会话内实际可用、Router Standard 可被新建会话选择——需在 dsh 运行 + 有模型会话时实测（会消耗 token），未做。
## 2026-08-15：dsh-routing-suite live 会话级验证（用户授权；含模型执行边界）

通过官方 apiproxy（应用同款 AbstractApiClient，直连 127.0.0.1:dsh 端口、无 Origin）在真实会话验证：

- [事实] `agentPreset.list`：`router-standard` 被 dsh 发现（trust=user、isDefault=false、name=Router Standard (experimental)）、**无 broken**；authorable=true。
- [事实] `session.create({agentPreset:'router-standard'})` ok → 预设成功组装会话（组装失败会在此步报错）。
- [事实] **路由预设行为按设计生效**：首回合 request/header 只含核心工具 `edit/pwsh/read/write`（首回合窄化）；
  第一个持久工具调用（pwsh）后，下一请求的 request/header 展开为全量 Standard 目录（40+ 工具），
  含**注入器全套 dev_***（dev_build_plugin/dev_clear_routes/dev_fix_patch/dev_heal_links/dev_inject_plugin/dev_injected_list/dev_install_package/dev_plugin_status/dev_release_plugin/dev_reload_package/dev_scaffold_plugin/dev_self_test/dev_stage_*/dev_uninject_plugin）与**路由预设的 dev_router_status/dev_router_mode/dev_mode_subagent**。
  即：注入器 boot 注册、路由预设注册、目录展开三件事全部实测成立（request/header 证据）。
- [事实] 内置 standard 预设会话同样展开 43 工具目录，含全部 17 个注入器 dev_* 工具。
- 边界：**未观察到模型实际执行 dev_* 工具**——deepseek-v4-flash（opencode-go）在本环境多轮返回**空回合**
  （有 turn/end 但无 tool/call、无 assistant/message；与 2026-08-14「模型空回复」记录同源，属模型/提供商行为，与套装无关）；
  deepseek-v4-pro 首回合未产生工具调用（全量目录未展开）。注入器 boot 自检 `super-injector/self-heal.log` 正常（两次 boot 均有 purge-stale-tools 记录）。
- 证据：`evidence/live-verify*.mjs`（探针脚本）、`evidence/live-verify*-20260815.txt`（输出）、
  `evidence/live-suite-*.dsh.log*`（dsh 日志）、会话 `~/.dsh/sessions/.../session-*.jsonl.zstd`（持久化）。探针/输出均 gitignored。
- 结论口径：安装/引导/预设/路由行为/工具挂载 = live 验证通过；dev_* 工具的实际模型调用 = 未验证（模型空回合，环境问题）。
## 2026-08-15：会话重命名补全与标题显示修复（已实施，live 取证）

- [事实] 会话标题投影位置：`sessions.list` / `session.history` 的 `projections.values.title`（插件注册投影，值类型 string；
  `SessionProjectionMap` 类型仅声明 sessionListMetadata/imageLimits，title 为插件扩展键）。user 源手动重命名优先于自动标题。
- [事实] 旧实现 bug：`sessionTitle()` 把 `projections` 当 `{key:{value}}` 读，而真实结构是 `{asOfSeq, values:{key:value}}`，
  导致标题**从不显示**（侧栏/会话视图一直回退到会话 id 前缀），重命名 RPC 成功但 UI 无感知。
- [事实] 冷会话（blank、未 attach）`sessions.list` 行无 projections（投影缓存无行），重命名后标题只出现在 history 投影；
  已用本地标题缓存（rename 成功即写入 + 订阅 `session/title` mux 事件 + list 投影播种）覆盖。
- 实施：修复 `sessionTitle()` → `projections.values.title`；新增 `displayTitle()`（本地缓存优先）；store 增加
  `sessionTitles` 表并在 connect/refreshSessions/renameSession/mux 四路维护；会话视图头部内联重命名（铅笔→输入框，
  Enter/失焦保存、Esc 取消）；侧栏双击重命名（保留右键菜单）。
- 验证：`npm run build` 通过；用 Node 25 类型剥离直接导入 `sessionTitle.ts` 以真实投影数据验证
  （attached 有 title / cold 无投影回退 / displayTitle 本地表兜底 / 无标题返回 null）；
  wire 级 live：`sessions.rename` ok（返回 title+seq）、`session/title`(user) 事件持久化、history 投影 `title` 正确。
  证据：`evidence/test-sessiontitle.mjs`、`evidence/rename-verify-*.txt`、`evidence/title-probe.mjs`（gitignored）。

## 2026-08-18：dsh 全量接入（20 个缺失请求方法 + 5 类事件；见 docs/DSH_INTEGRATION_REPORT.md）

- 接入方法（dsh 0.1.0-rc.6 类型契约，src/lib/dsh/store.ts）：
  `session.search/attachment/updateQueue`、`settings.update/replace/openDocument`、`workspace.insertBefore/insertSessionBefore`、
  `host.openPath`、`subagent.list/history/prompt/interrupt`、`skill.list`、`goal.create/edit/pause/resume/complete/clear`。
- [事实] 事件面补全：`session/queue`（队列全量快照）、`session/jobs`（后台任务快照）、`session/projection`（higher-seq-wins 投影存储，
  兼作 goal 读侧与 title/permissions/imageLimits 基线）、`session/subscribed`（基线 lastSeq）、`host/remote-event`（日志留痕）。
- [事实] goal 读侧无 RPC：goals.d.ts 注释明确读侧 = `goal` 投影（GoalProjection：goal.id/revision/objective/phase/maxGoalRounds + roundsStarted）；
  变更只回 CAS ref，UI 状态由 mux `session/projection` 帧回推。实现据此：GoalBar 从投影存储读，六个动词调用后依赖投影帧刷新。
- [推断] `session.attachment` 仅"读已引用图片"（宿主校验会话日志引用过该 id）；上传走 `session.prompt` 的 image content part
  （宿主把字节升级为持久引用）。图片预检用 `imageLimits` 投影（maxImagesPerMessage/maxImageBytes/maxMessageImageBytes/mediaTypes），
  投影缺失时跳过预检交给宿主。需 live 验证媒体类型白名单实际取值。
- [推断] 队列项编辑 `updateQueue(kind:edit)` 的 ContentBlock 按官方类型仅传 text 块；图片类队列项编辑为未验证路径。
- 设置页接线语义：DeepSeek 官方保存走 `settings.update`（补丁 + expectedRevision CAS，revision 取自 getSettingsNamespace）；
  「恢复默认」走 `settings.replace(llm-pi-ai, {})`（整体重置用户层，含 secret 移除，前端二次确认）；
  `settings.openDocument` 需宿主 hasDocument（已按 `settings.describe().hasDocument` 加 UI 门禁，live 实证见 2026-08-23 段）。
- 验证：npm run build（tsc + vite）通过、cargo check 通过（1 个既有 dead_code 警告，与本次无关）。
  **未 live 验证**：goal/subagent/skills/queue/attachment/workspace 排序/openPath/settings 等新链路——已于 2026-08-23 补齐 live 冒烟，见下方专段。
- dsh 0.1.0-rc.6 验证日期：2026-08-18（类型级）；升级依赖后需重扫 DSH_INTEGRATION_REPORT.md。


## 2026-08-23：P0 live 冒烟——2026-08-18 全量接入链路对真实 dsh 0.1.0-rc.6 验证（已收口）

探针：`evidence/p0-smoke.mjs`（应用同款 AbstractApiClient 直连 127.0.0.1:<port>、无 Origin；bundled dsh 独立实例，
DSH_HOME=用户真实 `~/.dsh`，测试后 taskkill /T 清理）。输出：`evidence/p0-smoke-20260823-1213.txt`。
专项探针：`evidence/p0-search-patch.mjs`（搜索索引启用验证），输出 `evidence/p0-search-patch-20260823.txt`。

### 结果（21 PASS + 2 项明示未验证）

| 域 | 结果 | 证据要点 |
|---|---|---|
| host.describe | PASS | canOpenPath=true |
| settings.describe | PASS | hasDocument=true；11 个命名空间（ui-onboarding…llm-pi-ai） |
| workspace.list / create / insertBefore / delete | PASS | 临时工作区（系统临时目录）建→置顶排序→删，未动用户工作区顺序 |
| sessions.list / search / attachment(updateQueue 错误契约) | PASS/记录 | 见下方发现 1 |
| skill.list | 记录 | 见下方发现 2 |
| subagent.list | PASS | entries=0, parentAvailable=false（冷会话） |
| goal 六动词（create/edit/pause/resume/complete/clear） | PASS 全链 | CAS ref 逐级返回；mux `session/projection` 帧实时回推 phase 变化 active→paused→active→complete→清除后 null |
| session.updateQueue | PASS（错误契约） | bogus id → `queue-item-not-found: queued item is no longer pending`（RPC 可达 + 类型化错误） |
| session.attachment | PASS（错误契约） | 未引用 id → `attachment-error: Image is not referenced by this session.`（与 RISKS 08-18 推断一致：仅读已引用图片） |
| workspace.insertSessionBefore / archiveSession | PASS | 测试会话建入临时工作区 → 移至末尾 → 归档，用户既有顺序零影响 |
| host.openPath | PASS | ok 路径实测（临时目录弹出资源管理器一次） |
| settings.openDocument | PASS | hasDocument=true → `{opened:true}`；设置页按钮已按 describe.hasDocument 门禁（关闭 08-18 待办） |
| mux 事件面消费 | PASS | 实测帧型：session/projection×37、session/event×35、session/subscribed×2、session/queue×4 |

### 发现 1 [事实]：会话内容搜索在 web profile 默认被禁用

- 默认组合配置（`--dump-config` 与 `--dump-default-config` 一致）：`session-query-sqlite { path: ':memory:', openAt: never }`
  ——非用户误配，是 dsh 0.1.0-rc.6 上游默认。触发时 `session.search` 返回
  `internal: session search is disabled: this deployment configures the session-query index with openAt "never"`。
- 启用路径已实证（专项探针 P1/P2/P3 全 PASS）：顶层 `--patch` 覆盖
  `{ id: session-query-sqlite, config: { path: <持久 sqlite>, openAt: first-search } }` → 搜索正常（存量 corpus 命中 20 条、hasMore=true）、
  索引文件落盘。[事实] FTS 索引仅覆盖消息文本（`persisted_docs(text)`，无 title 列），会话标题重命名不可搜。
- UI 处置（2026-08-23）：侧栏搜索遇该错误进入 `searchDisabled` 提示态（说明原因与启用方法），不再弹通用错误横幅。

### 发现 2 [事实]：skill.list 要求会话 attached（本进程内有活跃 agent）

- 冷会话（自 dsh 启动以来未产生过模型回合）调用返回 `session-not-found: … (not attached)`；
  apiproxy 实现为 `ctx.sessions.get()` + agent 注册表判定。成功路径需先有活跃回合，本轮按边界未验证（见 G1）。
- UI 处置（2026-08-23）：功能坞技能面板与 env-bar 技能菜单遇 session-not-found 进入 `skillsUnavailable` 提示态
  （"会话未激活，先发送一条消息"），不再弹通用错误横幅。

### 明示未验证（G1/G2，原因记录）

- subagent.prompt/interrupt 与真实排队流：需活跃模型回合（token 消耗；且本环境 deepseek-v4-flash 存在空回合问题，
  同 2026-08-15 routing-suite 会话级验证边界）。
- settings.update/replace：避免改动用户提供商配置；UI 已有确认门禁，类型契约以 0.1.0-rc.6 为准。
- dsh 0.1.0-rc.6 验证日期：2026-08-23。

## 2026-08-23：macOS 支持（编译级 + CI 构建；真机运行未验证）

范围：让代码在 macOS 目标可编译、运行时行为正确门控，并经 GitHub Actions macos runner 真实构建。

- 平台分支落地：
  - 系统代理探测：Windows 注册表 / macOS `scutil --proxies`（HTTP；SOCKS 忽略）/ 其余平台 None（可手动配置）。
  - 残留 dsh 进程清理：Windows PowerShell Get-CimInstance / macOS·Linux `lsof -sTCP:LISTEN` + `ps -o command=` 核对命令行（`is_dsh_cmdline` 防误杀）。
  - 路由套装注入器链接：Windows junction（mklink /J）/ Unix symlink；统一 `remove_link_best_effort`（junction 用 remove_dir 解链、symlink 回退 remove_file；真实目录不动）；悬空链接先清再建。
  - 剪贴板：macOS 原生 `pbcopy`（arboard 移出 mac 依赖树，避免 objc2 C 工具链）；Windows/Linux 保持 arboard。
  - npx 模式回退路径补 macOS 官方 pkg 与 Homebrew 位置。
  - WSL：`wsl_status` 已有优雅桩；`provision` 非 Windows 提前失败并说明；`start()` 对 WSL 执行模式显式报错。WSL 面板 UI 无需改动（读 status.reason）。
- 打包：`src-tauri/tauri.macos.conf.json`（targets: app+dmg），经 GitHub Actions `.github/workflows/build.yml`
  （push/PR/dispatch 触发；macOS job = cargo test --lib + tauri build + 上传 dmg/app；Windows job = 同口径回归 + nsis/msi）。
- 验证边界：
  - [事实] Windows 主机回归通过（cargo test --lib 29 passed；npm run build 通过）。
  - [事实] 新增 unix 分支经无依赖 shim crate 对 `aarch64-apple-darwin` 与 `x86_64-unknown-linux-gnu` 两目标 cargo check 通过
    （Tauri 自身 mac 后端含 objc2 C 构建脚本，Windows 主机无法交叉 check 整个 app——CI mac runner 是完整验证路径）。
  - [事实] CI macos-latest runner 全链路通过（run 32639578900）：cargo test --lib 真实 macOS 工具链 +
    tauri build 产出未签名 app/dmg artifact；Windows job 同绿（nsis+msi）。首跑失败两例为测试平台假设
    （CA 导出测试仅 Windows 有意义、term_exec 用例的 cmd 语法），已按平台门控/分支修复。
  - **未验证**：macOS 真机运行（无硬件）——dsh 上游 runtime 在 macOS 的启动与工具行为未实证；
    未签名 app/dmg 会触发 Gatekeeper（右键打开或 `xattr -cr` 绕过，正式分发前签名+公证，同 Windows SmartScreen 条目）。
    git hooks 为 .ps1，macOS 贡献者本地不生效（CI 兜底）。

## 2026-08-23：dsh 升级 0.1.0-rc.6 → 0.1.1-rc.2（兼容性验证通过）

按 docs/DEVELOPMENT.md 升级流程执行：runtime 与根依赖精确锁定 0.1.1-rc.2（latest/next 双标签），全新安装
（根 233 包；runtime 452 包）。manager.rs Npx 模式与 wsl.rs DEFAULT_DSH_VERSION 同步升版；pi-ai 引擎要求不变
（node>=22.19.0，WSL Node 钉版仍有效）。

### 协议面 diff（对照备份的 rc.6 类型契约）

- [事实] `rpc-map.d.ts` 与 `events.d.ts` **零变化**：52 个请求方法与事件面完全一致，前端协议层无需改动。
- host.describe 返回新增 `home` 字段（增量）；错误分类移除 `settings-not-exposed` 成员（应用无引用）；
  `SessionProjectionStateMap` 类型声明微调。tsc 严格模式零改动编译通过。
- 新增设置命名空间 `agent-default-model`（settings.describe 实测可见，增量）。

### 兼容性发现与处置

1. [事实] 上游 rc.2 移除 `@deepseek-ai/dsh-client-ui-slots` 包（rc.6 存在）。注入器仅类型级引用、运行时不需要；
   应用安装器 `ensure_injector_links` 已有"目标缺失→跳过"容错（实测跳过不报错）。修复：自愈信号
   （repair_injector_links）改为"目标存在且链接缺失"才算缺失，避免 rc.2 下每次启动空转自愈。
2. [事实] web profile 默认配置不变：session-query-sqlite 仍 `{ path: ':memory:', openAt: never }`——
   搜索默认禁用与 patch 启用路径在 rc.2 复验成立（专项探针 P1/P2/P3 全 PASS）。
3. 本地残留处置：vendored 注入器 node_modules 内 5 个 junction 因本机 runtime 重装而悬空（gitignored 本地产物，
   08-15 live 安装遗留），已清除并按应用同款 LINK_PAIRS 用 rc.2 runtime 重建 4 个（ui-slots 无目标跳过）。

### live 冒烟复验（对 0.1.1-rc.2 全部通过）

- 主探针 21 PASS：goal 六动词全链（CAS ref + projection 帧回推）、updateQueue/attachment 错误契约、workspace
  create/insertBefore/insertSessionBefore/delete/archiveSession、host.openPath ok 路径、settings.describe/openDocument
  （hasDocument=true）、mux 帧消费（projection/event/subscribed/queue）。注入器在用户 profile 中随 rc.2 正常装载
  （boot 门禁即证明）。证据：`evidence/p0-smoke-rc2-<ts>.txt`、`evidence/p0-search-patch-rc2-20260823.txt`。
- Rust：cargo test --lib 29 passed（含 junction/repair 用例）；cargo check 通过。前端：npm run build、fixture 测试
  （render 8/8、toolviews 5/5）通过。
- 未跑：`npm run tauri dev` 完整运行门禁（需交互窗口；Tauri 壳层本轮零改动，dsh 启动路径已经探针实证）。
  G1/G2 边界同 08-23 早前记录（真实模型回合未验证）。
- dsh 0.1.1-rc.2 验证日期：2026-08-23。

### 接口增删扫描与接入处置（2026-08-23 补充）

- 客户端协议面零增删（rpc-map 52 方法 / events 逐字节一致）；接口级变化与接入处置详见
  `docs/DSH_INTEGRATION_REPORT.md`「七、重扫附录」。要点：
  - 新增 settings 命名空间 `agent-default-model` → 已接入（设置页默认模型卡片，CAS 写路径 live 实证）。
  - host.describe 新增 `home` → 已接入（状态页宿主主目录行）。
  - 移除 `dsh-client-ui-slots`/`dsh-client-web` 等挂载契约包 → 注入器链接对容错 + 自愈修正；插件 UI 挂载路径
    不复存在，只读清单决策维持并更新说明。
  - 其余新增/移除包均为宿主内部能力，不经 apiproxy 暴露，无需应用侧接入。

## 2026-08-23：首启前置条件检测与自动安装（Node.js / dsh 运行时）

背景：打包产物不含 dsh 与 Node，全新机器需手工准备。现落地「安装包检测提示 + 应用首启自动安装」：

- **NSIS 安装钩子**（`src-tauri/nsis-hooks.nsh`，POSTINSTALL）：读注册表 `SOFTWARE\Node.js` 检测 Node，
  缺失时弹提示告知首启将引导自动安装。不在安装器内静默装 Node——本安装器按当前用户安装无提权，
  Node MSI 需要 UAC；由应用经系统授权弹窗完成（macOS DMG 无安装期脚本，天然走应用侧）。
- **应用首启门禁**（App.tsx → SetupWizard）：启动即调用 `prereq_check_cmd`
  （find_node：PATH `node -p process.execPath` → 已知默认位置兜底；dsh = 受管版本或 bundled 存在性）。
  缺失项显示向导：
  - 装 Node：`prereq_install_node_cmd`（spawn_blocking）——下载 nodejs.org 官方 v22.19.0（win x64/arm64 msi、
    mac universal pkg），以官方 SHASUMS256.txt 做 SHA256 校验，不一致拒绝安装；
    提权静默安装（Windows PowerShell RunAs→UAC；macOS osascript administrator privileges→密码框）；
    完成后 find_node 复检（含 PATH 未刷新兜底）并校验 >=22.19（pi-ai 引擎要求）。
  - 装 dsh：复用既有受管运行时管道（runtime_install 0.1.1-rc.2 + setActive，sha512 必校验、可回滚）。
- manager 启动 dsh 改用 find_node() 绝对路径（规避安装后当前进程 PATH 未刷新）。
- 验证：cargo test --lib 32 passed（新增 SHASUMS 解析/版本比较/find_node 三测）；npm run build 通过。
- 未验证 [边界]：install_node 完整提权安装流程未在本机实测（本机 node v25 已存在，触发会真实改动用户机器）；
  下载与校验逻辑以单测+CI 编译覆盖。建议后续在干净 VM 实测一次并向导 UI 截图留证。

## 2026-08-23：[已修复] reqwest 无 TLS 后端——mac 真机「获取可用版本」秒失败根因

- 现象：mac 安装产物中设置页「获取可用版本」立即失败：`获取 npm registry 版本列表失败: error sending request for url (https://registry.npmjs.org/@deepseek-ai/dsh)`。
- 根因 [事实]：`Cargo.toml` 自 bootstrap 起对 reqwest 使用 `default-features = false` 且仅启用 `json/stream/blocking`——
  依赖树经 `cargo tree` 证实 **无任何 TLS 后端**（rustls/native-tls/schannel/security-framework 均为 0），
  所有 https 请求必然瞬间失败（Windows 构建同样受影响，此前未暴露属侥幸/历史环境差异）。
- 修复：
  1. reqwest 启用 `rustls-tls-native-roots`（纯 Rust TLS + 加载系统根证书，兼容用户自装 MITM CA）与
     `socks`（支持系统 SOCKS 代理）；
  2. 代理解析优先级改为 环境变量（HTTPS_PROXY/HTTP_PROXY/ALL_PROXY，与 Node 行为一致）→ 平台系统探测
     （macOS scutil 补 SOCKS 兜底，返回 socks5://）；
  3. registry 元数据/版本列表/tarball 三处网络错误改带完整原因链（err_chain），后续失败可自诊断。
- 验证 [事实]：cargo test --lib 32 passed；ignored live E2E `runtime_live_install_and_verify`
  （真实 npm registry 下载 @deepseek-ai/dsh@0.1.1-rc.2 + integrity 校验）修复后通过。
  CI 双平台构建通过。待用户在 mac 上复测「获取可用版本 / 安装运行时」确认闭环。

## 2026-08-24：dsh-std / dsh-ecosystem-spec 社区生态观察（P0 spike 完成，GO）

- 背景：评估接入 https://github.com/T-Auto/dsh-ecosystem-spec（dsh-TUI 团队社区规范，锚定 Yan-Zero/dsh-std
  元协议）。决策：WUI 以 **Node sidecar** 形态成为 dsh-std 实验宿主，v1 协议面 = command + storage，
  全程 feature flag `dshStdHost` 隔离。契约见 docs/DSH_STD_HOST_PLAN.md。
- [事实] spike 全链路验证通过（2026-08-24）：standalone conformance 全绿（exit 0）、validate:manifest CLI
  compatible、npm 独立依赖路径可用、协商原型正反例断言全过。证据见 docs/DSH_STD_SPIKE.md。
- 风险与缓解：
  - 规范状态 Draft/Experimental，允许 breaking；`@dsh-std/core` 0.1.0→0.1.1 兼容线切换发生于 2026-08-23
    → 目标线锁定 **community-v0.15 坐标 + @dsh-std/*@0.1.0-rcN 包线**（spec pinned revision 同期），0.1.1-rc.N 仅观察；
    引入依赖时精确锁定（沿用 save-exact）并在本文件记录版本+验证日期。
  - 生态成熟度低（spec 18 stars / dsh-std 10 stars / 单团队维护），存在熄火风险 → feature flag 隔离，
    废弃成本=移除 sidecar 模块；不进 dsh-TUI 市场，无准入绑定。
  - 第三方插件代码执行安全面 → 独立 Node 进程、无 Tauri IPC、stdio NDJSON + token 握手、权限默认 deny。
  - Windows standalone conformance 对 corepack 有硬编码依赖（Node ≥25 不捆绑 corepack）→ CI 复跑需预装
    corepack 或打补丁；可向上游提 issue。
- 边界：不改动 client.ts/proxy.rs/plugins.rs 既有语义；不宣称 Stable/官方认证（治理规则禁止），
  对外措辞仅"实验适配"。

## 2026-08-24：dsh-std 宿主 P1 落地（最小宿主，实验）

- 交付 [事实]：
  - `plugin-host/`：独立 npm 工程（仿 runtime/ 先例），`@dsh-std/{core,manifest,command,storage}@0.1.0-rc1`
    精确锁定（save-exact）。stdio NDJSON + token 握手；admission 管道
    parse→结构校验→坐标分类→ProtocolCatalog 协商→权限门禁→准入投影
    （compatible / compatible_degraded / waiting_authorization / rejected / unknown）。
  - `src-tauri/src/dsh/plugin_host.rs`：进程看护（spawn/stdin+stdout 读线程/kill_tree/幂等 stop/Drop 兜底），
    镜像 DshManager 模式；RunEvent::Exit 统一清理。
  - 设置页「插件」Tab 新增实验区卡片：sidecar 启停、manifest 准入校验（grants 输入默认空=全拒）、命令目录展示。
- 测试证据 [事实]：
  - plugin-host：node:test **24/24 通过**——含上游 conformance fixtures 正反例
    （valid→waiting/degraded 投影、unknown service/kind/coordinate、重复契约/命令、facet 版本、provides/client/worker 拒绝）、
    真实子进程 stdio 握手+admit E2E、storage 配额与命名空间隔离。
  - Rust：cargo check 干净（仅既有 CollectSink dead_code warning）；cargo test --lib **34 过 / 0 失败**（2 ignored 为既有 live-E2E）。
  - 前端：npm run build 通过（chunk 体积警告为既有）。
- 语义决策 [推断]：
  - waiting_authorization 优先于 compatible_degraded（授权未给前不进入降级运行态）；
  - group+kind 完全未知 → rejected（INVALID_MANIFEST）；已知 family 但 apiVersion 未注册 → unknown（对齐上游 conformance CHANGELOG v0.15 语义）；
  - P1 不执行插件 entry（激活驱动仅聚合 contributes.commands），执行路径留 P2。
- 剩余风险：
  - 打包分发未接：tauri.conf.json resources 尚不含 plugin-host/node_modules，打包产物内 sidecar 启动会报"找不到目录"；
    P2 接入资源打包。dev 模式经 cwd 回退定位不受影响。
  - 应用级验收（npm run tauri dev 手动四步 + 无残留进程确认）待用户执行。

## 2026-08-24：dsh-std 宿主 P2 执行接入（实验）

- 交付 [事实]：
  - **插件真实执行**：sidecar 新增 activation driver（wui 私有，规范允许宿主自定义）——`activate(ctx)` 导出契约、
    `ctx.registerCommand({id,title,handler})`（handler 形状对齐 @dsh-std/command CommandHandler：
    `execute({rawInput},{signal}) → {kind,text}`，经 assertCommandHandler 校验）、`ctx.storage` 插件私有无参句柄
    （按 manifest.id 派生命名空间 + grant 门禁）、activate 5s/execute 10s 超时（AbortController）。
  - **授权持久化**：grants 权威在 Rust 侧（app_config_dir/plugin-host-grants.json，原子写），启动后自动重同步到
    sidecar；协议升级 revision=2：`grants.set` 独立方法、admit 不再接受请求级 grants（消除越权面）。
  - **清理语义（TUI-OBS-002 对标）**：deactivate=效果撤销（命令注册移除+deactivate() 钩子，保授权/storage）；
    uninstall=停用+撤准入/授权；purge=额外删除 namespaced storage 文件。
  - **effect ledger**（C-060 最小版）：append-only JSONL（plugin-host-ledger.jsonl），仅记生命周期/执行元数据
    （kind/pluginId/activationInstance/generationId/outcome/durationMs），E2E 断言无 payload 泄漏。
  - **崩溃自愈**：ensure_alive 在每个入口 try_wait；意外退出自动重启 ≤2 次（重启后 grants 自动恢复，
    准入/激活需重做——fail-closed），超限转 Error 态。
  - **打包接入**：tauri.conf.json resources 增加 ../plugin-host；示例插件 examples/echo-plugin 作为激活演示与参考实现。
  - **UI**：实验区完整流程——校验准入 → waiting 时「授权以上权限并激活」→ compatible 时「激活」→ 命令执行
    （每命令 rawInput 输入 + 结果回显）→ 停用/卸载。
- 测试证据 [事实]：
  - node:test **26/26 绿**（新增：全生命周期 stdio E2E——grant→admit(waiting)→fail-closed 拒激活→compatible→
    activate(真实 import)→execute(ping/remember 经 storage)→deactivate 后 execute=NOT_ACTIVE→uninstall+purge
    撤权删文件→ledger 无正文泄漏；handler 错误不杀宿主；per-plugin grant 隔离）。
  - cargo test --lib 34 过 / 0 败；npm run build 通过。
  - **E2E 存证：evidence/dsh-std-p2-e2e-2026-08-24T14-30-29.md（20 断言 PASS）**，脚本 scripts/dsh-std-p2-e2e.mjs 可复现。
- 语义决策 [推断]：waiting_authorization 态禁止 activate（未授权不得进入运行态）；sidecar 重启后 admitted 集合
  不恢复（内存态），要求重新准入+激活——安全上优于持久化运行态。
- 剩余风险 / 待办：
  - 非示例插件的目录选择 UI 未做（当前实验区仅内置 com.example.echo 一键激活）；P3 连同 wui-admission 文档一并补。
  - handler 同步死循环无法被 AbortController 中断（只能靠超时返回错误），进程级防护依赖 ensure_alive 自愈——已记录。
  - 应用级验收（tauri dev 手动走一遍授权→激活→执行→卸载）待用户执行。

## 2026-08-24：dsh-std 宿主 P3 收口（准入文档 + 机器证据 + 目录激活）

- 交付 [事实]：
  - **`docs/wui-admission-v0.1.md`**：wui 宿主准入 profile 文档——坐标/权限/决策次序（fail-closed）、
    声明完整性规则、信任模型（trusted-in-process 如实披露）、activation driver 契约、
    TUI-OBS-002 对标清理表、验证证据索引。不倒灌 TUI 规则，仅声明"实验适配"。
  - **上游 fixtures 交叉比对**：`scripts/dsh-std-fixtures-crosscheck.mjs` →
    **evidence/dsh-std-fixtures-crosscheck-2026-08-24T15-00-00.md（12/12 PASS）**——
    上游 conformance suite 对同一批 fixtures 的期望 × 本宿主 admission 引擎实际决策全对齐；
    valid 清单的投影差异（TUI compatible vs 本宿主 waiting→degraded）确认为宿主能力面差异而非语义偏差。
    过程中修复一个真实缺陷：字符串订阅按名称解析（byName），此前 unsupported_version+event 分支漏判。
  - **任意插件目录激活**：`plugin_host_activate_cmd` 参数化 plugin_root + 新增 example_root 查询命令；
    实验区新增"插件目录"输入（留空=内置示例），非示例插件可本地目录激活。
  - README 特性列表与 CHANGELOG [Unreleased] 收口；措辞审计：全部 dsh-std 相关文案仅"实验适配"表述，
    "官方认证"等词只出现于禁止性声明。
- 测试证据 [事实]：node:test 26/26；cargo test --lib 34 过/0 败；npm run build 通过；
  P2 E2E 复跑 PASS（evidence/dsh-std-p2-e2e-2026-08-24T15-04-47.md，20 断言）。
- 剩余风险：
  - 上游规范仍 Experimental：升级 `@dsh-std/*` 或 vendor revision 时必须复跑 crosscheck+单测+E2E 并在本文件记录。
  - handler 同步死循环限制同 P2（超时报错 + 进程自愈兜底）。
  - 应用级验收（tauri dev 手动全流程）仍待用户执行——这是唯一未闭环的验证项。

## 2026-08-25：[已修复] mac 受管运行时 ERR_MODULE_NOT_FOUND——单包解压缺依赖树 + npm peer 解析病态慢

- 现象（mac 实报）：受管安装 0.1.1-rc.2 后启动 dsh 即
  `ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/dsh-app-boot' imported from .../runtimes/0.1.1-rc.2/node_modules/@deepseek-ai/dsh/lib/bin.js`。
- 根因 [事实]（两层）：
  1. `runtime.rs install_at` 只下载解压**主包** tarball 到 node_modules，从不解析依赖树；
     而 bin.js 的依赖链需要 `@deepseek-ai/dsh-app-boot` 等 400+ 包。此前 live E2E 只验
     「下载+integrity+bin 存在」未验「可执行」，属假绿；Windows 开发机一直走 bundled 模式
    （repo 内完整 npm install）故未暴露。
  2. 直接改用 npm 自动解析又遇第二层坑：npm≥7 对该依赖图的 **peerDependencies 自动解析病态慢**
    （本机实测 >25min 不收敛，placeDep 串行推进）；且 staging 无 package.json 时 npm 会向上
    查找祖先 package.json 把依赖装进别人的树（本机复现）。
- 修复 [事实]（`runtime.rs` 重写 install_at 安装管线）：
  1. 保留自控门禁：主包 tarball 下载后先做 dist.integrity sha512 强校验；
  2. staging 写**显式 package.json** 锁定项目根（防 npm 向上遍历）；
  3. `npm install --omit=dev --legacy-peer-deps`（实测 41s 装 430 包；legacy 跳过自动 peer）；
  4. **peer 闭包迭代**（≤5 轮）：扫描树内全部包的非可选 peerDependencies，缺失者以声明范围
     显式并入 manifest 增量安装（首轮 21 个 peers 仅 7s；optional peers 如 cordis-plugin-hmr 正确跳过）；
  5. 版本精确匹配校验 + **bin.js 启动冒烟门禁**（`node bin.js --version` 必须成功，
     任何残余依赖缺失在安装期即中止并回滚）；
  6. npm 直连失败（ENOTFOUND/ECONN* 特征）时自动带系统代理重试一次（npm 与 Node 同样默认不读系统代理）。
- 验证 [事实]：
  - 单测 39 过/0 败（新增 find_npm_cli、run_with_timeout 超时杀进程、env 注入探针、truncate_tail）；
  - live ignored E2E `runtime_live_install_and_verify` **PASS（132s 全流程）**：
    真实 registry 下载 → 校验 → legacy 安装 → peer 补装 → 冒烟 → verify_at ok；
  - 手动复现链完整：坏产物冒烟失败可复现用户报错签名（ERR_MODULE_NOT_FOUND cordis-plugin-group）→
    闭包补齐后冒烟 exit=0 输出 0.1.1-rc.2。
- **mac 用户操作指引**：升级到含本修复的版本后，进 设置 → DSH 运行时 →
  先「移除」0.1.1-rc.2（自动备份为 .trash-* 可回滚）→ 再「安装」0.1.1-rc.2（约 1-3 分钟，
  结束前会自动完成启动冒烟）。旧坏产物不重装无法自愈（bin hash 记录仍一致，verify 无法感知缺依赖）。
- 剩余风险：
  - verify_at 仍只做 hash 复验不做冒烟（避免 VerifyReport 结构变更牵动前端）；冒烟门禁在安装期一次性把关，
    后续文件损坏场景维持既有 hash 语义。
  - npm 解析耗时随上游依赖图变化波动；900s/轮超时 + 失败信息带 stderr 尾部，可诊断。
  - flate2/tar crate 已无调用方（tarball 不再手动解包），留在 Cargo.toml 待后续清理。
