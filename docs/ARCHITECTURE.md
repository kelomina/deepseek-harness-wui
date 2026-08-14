# 架构

## 总览

```
┌─────────────────────────── Windows 桌面应用（单实例）──────────────────────────┐
│                                                                              │
│  WebView2（前端 origin: http://tauri.localhost / http://localhost:1420）      │
│  ┌──────────────────────────────────────────────────────────────────┐        │
│  │ React + TS + Vite（全新自研 UI，Fluent 2 语义令牌）               │        │
│  │ DshApiClient（继承官方 AbstractApiClient，resolveBase→代理）      │        │
│  │  - POST /api/*（unary RPC）                                      │        │
│  │  - WS /api/events.mux、/api/events.host（事件流）                 │        │
│  └───────────────┬──────────────────────────────────────────────────┘        │
│                  │ HTTP/WS（跨源，带浏览器 Origin）                            │
│  ┌───────────────▼──────────────────────────────────────────────────┐        │
│  │ Rust（Tauri 2）                                                  │        │
│  │  - dsh-manager：进程托管/健康检查/看门狗/日志环形缓冲/配置持久化    │        │
│  │  - proxy（axum, 仅绑定 127.0.0.1）：                              │        │
│  │      校验 Origin 白名单 → 转发到 127.0.0.1:<dsh_port>（剥 Origin）│        │
│  │      WS 隧道（tokio-tungstenite 双向转发，不带 Origin）           │        │
│  └───────────────┬──────────────────────────────────────────────────┘        │
│                  │ 无 Origin 的 HTTP/WS                                      │
└──────────────────▼───────────────────────────────────────────────────────────┘
        dsh web（node runtime/node_modules/@deepseek-ai/dsh/lib/bin.js web --port N）
        - /api 信任围栏：仅接受 loopback / trustedHost
        - 会话、工作区、模型、凭据由 dsh 持久化
```

## 为什么必须有 Rust 代理

spike（2026-08-14，dsh 0.1.0-rc.6）实测：`/api` 对带非 loopback `Origin` 的请求返回 **403 forbidden**
（无 Origin 或同源请求通过；Host 伪造不触发）。WebView2 前端 origin 是 `tauri.localhost`（生产）或
`localhost:1420`（dev），**不能直连** dsh。Rust 代理在 127.0.0.1 随机端口监听，校验 Origin 白名单后
转发（剥离 Origin），从而通过围栏。白名单：`http://localhost:1420`、`http(s)://tauri.localhost`、
`tauri://localhost`。

## 协议层（复用官方代码）

- `@deepseek-ai/dsh-host-apiproxy/client`：官方 `AbstractApiClient`（纯 ESM）——rpcId 铸造、
  四象限信封、zod 校验、SSE 解码等协议不变量全部复用。
- `src/lib/dsh/client.ts`：子类 `DshApiClient`，只实现传输差异：
  - `resolveBase()` → 代理地址 `http://127.0.0.1:<proxy_port>`
  - `doFetch()` → 浏览器 fetch
  - `openMux/openHost` → WebSocket 事件流（帧解析逻辑参照官方 MIT `WebApiClient` 复刻：
    `serverRequestSchema` 解析信封 + `muxFrameSchema/hostFrameSchema` 解析载荷）
- 事件流为“拉模式”（不消费就不收帧）：store 的 `pump()` 持续迭代。

## 进程托管（dsh-manager）

- 启动命令按 `exec_mode` 构造：bundled（`node runtime/node_modules/@deepseek-ai/dsh/lib/bin.js
  web --port N`）/ npx（`node <npm>/npx-cli.js -y @deepseek-ai/dsh@0.1.0-rc.6 web --port N`）/
  path（自定义可执行或 .cmd）。
- 状态机：Stopped → Starting → Running / Error；健康检查每 2s TCP 探测 `/`；启动超时 90s；
  意外退出/失联时按 `max_restarts`（默认 3 次/600s）自动重启。
- 退出清理：应用 Exit 事件 → `taskkill /T /F` 进程树；已实测无残留。
- 配置持久化：`app_config_dir/config.json`（原子写：tmp + rename）。

## 前端数据流

- `store.ts`（AppStore，`useSyncExternalStore`）：订阅 Rust 事件（`dsh://status`、`dsh://log`）与
  dsh 事件流（mux/host），统一驱动 UI。
- 会话/工作区/模型操作全部走 `ApiProxy` 类型化接口（sessions/workspace/host/llm/settings/…）。
- 审批与提问：`approval/requested`、`question/requested` 帧带 rpcId，回答走
  `api.respond({ type:'client-response', rpcId, result:{ ok:true, value } })`。

## 目录

```
src/                  React 前端
  lib/tauri.ts        Rust 命令/事件封装
  lib/dsh/client.ts   协议客户端（官方核心 + WS 传输）
  lib/dsh/store.ts    应用状态与事件分发
  pages/              状态/设置/工作区/会话
  components/         UI 组件（FolderBrowser/LogPanel/ui）
src-tauri/src/
  dsh/config.rs       配置模型与持久化
  dsh/manager.rs      进程托管/看门狗/日志
  dsh/proxy.rs        axum 反向代理（HTTP + WS）
  lib.rs              Tauri 命令与生命周期
runtime/              固定版本 dsh（@deepseek-ai/dsh@0.1.0-rc.6）
scripts/hooks/        git 护栏 hooks
docs/                 本文档
```
