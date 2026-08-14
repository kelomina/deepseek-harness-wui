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
