# DeepSeek Harness Desktop

DeepSeek Harness 的 Windows 桌面前端：**Tauri 2 (Rust + WebView2) + TypeScript + Vite 全新自研 UI**，
自动托管本地 `dsh web` 进程，通过 Rust 侧反向代理接入官方协议层。

## 特性

- 自动托管 dsh：应用启动时拉起 `dsh web`（bundled / npx / 自定义路径），退出时清理进程树。
- 健康检查与看门狗：启动超时、心跳探测、自动重启（次数/窗口可配）、状态推送。
- 全新自研前端（设计稿 docs/UIDesign.desktop.html）：自定义标题栏（无边框窗口）、
  Work/Code 双模式（Work=对话式会话；Code=AIDE 三栏：变更文件 + diff 逐 hunk 接受/拒绝 + AI 侧聊 + 终端/状态栏）、
  欢迎页大输入、设置（模型提供商/API Key/运行配置）、工作区、连接状态。
- Rust 反向代理：绕过 dsh `/api` 的浏览器 Origin 信任围栏（非 loopback Origin → 403）。
- 协议层复用官方代码：`@deepseek-ai/dsh-host-apiproxy` 的 `AbstractApiClient` + zod schema，
  浏览器 WebSocket 传输参照官方 MIT 实现复刻。
- 双套硬限制：工程护栏（hooks/忽略/提交规范）+ 运行时限制（看门狗/端口/日志/单实例）。

## 环境要求

- Windows 10/11（WebView2 运行时，通常随 Edge 自带）
- Rust stable（本机 1.96，见 `rust-toolchain.toml`）
- Node.js >= 22（dsh 与前端工具链需要；npx 模式必需，bundled 模式同样需要 node 执行 dsh）

## 快速开始

```powershell
# 1. 安装前端依赖
npm install

# 2. 安装固定版本 dsh 运行时（bundled 模式）
cd runtime
npm install
cd ..

# 3. 开发运行（自动拉起 dsh）
npm run tauri dev
```

## 构建

```powershell
npm run build        # tsc + vite build（前端产物 dist/）
cd src-tauri
cargo check          # Rust 类型检查
cargo build          # debug 构建
cd ..
npm run tauri build  # release 构建 + NSIS/MSI 安装包
```

## 文档

- [变更日志](CHANGELOG.md)
- [架构](docs/ARCHITECTURE.md)
- [开发指南](docs/DEVELOPMENT.md)
- [硬限制](docs/HARD_LIMITS.md)
- [部署](docs/DEPLOYMENT.md)
- [风险与已知问题](docs/RISKS.md)
- [贡献指南](CONTRIBUTING.md)

## 上游

DeepSeek Harness（`dsh`）由 DeepSeek AI 开源（MIT），当前为 developer preview：
https://github.com/deepseek-ai/deepseek-harness

## License

MIT（与 dsh 一致）。协议层复用与参考的官方代码均保持 MIT 许可。

