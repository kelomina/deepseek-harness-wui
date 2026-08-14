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
- 提供商 CRUD：llm.providers 只读；写路径 settings.mutate + credentials.set 可用；本版 UI 保存 API Key 到凭据层，
  provider 路由/默认模型字段标注"由 dsh settings 管理（开发中）"。
