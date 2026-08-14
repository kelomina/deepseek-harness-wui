# 开发指南

## 环境

- Windows + WebView2 Runtime
- Rust stable（rust-toolchain.toml 已固定）
- Node.js >= 22

首次安装：

```powershell
npm install
cd runtime; npm install; cd ..
```

## 常用命令

| 命令 | 作用 |
|---|---|
| `npm run dev` | 仅 Vite 前端（无 Rust） |
| `npm run build` | tsc 类型检查 + vite 构建（dist/） |
| `npm run tauri dev` | 完整开发：Vite + Rust + 自动拉起 dsh |
| `npm run tauri build` | release 构建 + 安装包 |
| `cd src-tauri; cargo check` | Rust 类型检查 |
| `cd src-tauri; cargo build` | Rust debug 构建 |
| `cd src-tauri; cargo clippy` | Rust lint（rust-toolchain 含 clippy） |

## 验收清单（每次改动后按风险选择）

1. `npm run build` 通过（tsc 严格模式）。
2. `cargo check` / `cargo build` 通过。
3. 运行验收（`npm run tauri dev`）：
   - 主窗口出现，标题 `DeepSeek Harness Desktop`；
   - dsh 端口（默认 3080）被 node dsh 进程监听；
   - app 进程在 127.0.0.1 有代理监听端口；
   - 优雅关闭（关窗）后：app 退出、dsh 端口释放、无残留 node dsh 进程。
4. 记录证据：进程 PID、端口、日志片段、日期与 dsh 版本。

## 协议层改动注意

- 修改 `src/lib/dsh/client.ts` 前先读官方参考：`node_modules/@deepseek-ai/dsh-client-connection/lib/client.js`
  中 `WebApiClient/readWebSocket`（MIT），以及
  `node_modules/@deepseek-ai/dsh-host-apiproxy/lib/types/` 下的 schema 与类型。
- 任何 wire 格式改动都要先在 spike 环境实测（见 docs/RISKS.md）。

## 升级 dsh

1. `runtime/package.json` 与根 `package.json`（若引用协议包）同步升级版本。
2. 重新 `npm install`（runtime 与根）。
3. 对照 `docs/RISKS.md` 记录新版本行为变化；重跑验收清单。
4. 提交信息用 `chore(runtime): bump @deepseek-ai/dsh to X`。
