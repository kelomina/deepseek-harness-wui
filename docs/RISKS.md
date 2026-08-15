# 风险与已知问题

最后更新：2026-08-15（dsh 0.1.0-rc.6）

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

- 会话历史工具事件渲染已按官方 presentation 契约实现 1:1 卡片（2026-08-15，条目 8）；无 view 时回退通用 JSON 摘要。
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
