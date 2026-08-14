# AGENTS.md（DeepSeek Harness Desktop）

本项目的全局协作补充。技术栈：Tauri 2 (Rust) + React/TypeScript/Vite，Windows 目标。

## 项目真相源（先读）

- 官方 dsh 协议与类型：`node_modules/@deepseek-ai/dsh-host-apiproxy/lib/types/`
- 官方浏览器传输参考：`node_modules/@deepseek-ai/dsh-client-connection/lib/client.js`（MIT）
- 上游文档：https://github.com/deepseek-ai/deepseek-harness （developer preview，破坏性变更频繁）

## 硬性约束

- 所有 `@deepseek-ai/*` 依赖**精确锁定**版本（`.npmrc` save-exact=true）；升级走文档化流程并在
  `docs/RISKS.md` 记录。
- dsh `/api` 只接受 loopback Origin（spike 实证：`Origin: tauri.localhost` → 403）。**禁止**从前端
  直连 dsh 端口；必须经 Rust 代理（`src-tauri/src/dsh/proxy.rs`）。
- 凭据零存储：本项目不保存 API Key；密钥配置全部交给 dsh（`$DSH_HOME/.credentials.yaml` / .env）。
- 提交前必须过 `scripts/hooks/pre-commit.ps1`（密钥/大文件）与 `commit-msg.ps1`（Conventional Commits）。
- 不修改 dsh 上游仓库；不提交 `runtime/node_modules`、`src-tauri/target`、`dist`、任何凭据。

## 常用命令

- `npm run dev` / `npm run build`：前端
- `npm run tauri dev`：完整开发（自动拉起 dsh）
- `cd src-tauri && cargo check/build`：Rust
- 验收默认包含：窗口标题、dsh 端口监听、代理监听、退出后无残留进程（见 docs/DEVELOPMENT.md）。

## 验证纪律

- smoke test（能编译/能启动）不等于业务完成；协议链路需以可复查证据为准（连接、监听、日志、类型）。
- dsh 处于 developer preview：任何依赖其行为的实现都要在 `docs/RISKS.md` 记录对应版本与验证日期。
