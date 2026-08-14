# 部署

## 目标形态（本轮）

- **unpackaged 桌面应用**（不依赖商店/签名侧载），`npm run tauri build` 产出 NSIS/MSI 安装包。
- 安装包未签名：Windows SmartScreen 可能警告，需用户“仍要运行”；正式分发前应做代码签名。

## 构建

```powershell
npm install
cd runtime; npm install; cd ..
npm run build                 # 前端产物
npm run tauri build           # release + NSIS/MSI（targets 见 tauri.conf.json）
```

产物位置：`src-tauri/target/release/bundle/nsis/*.exe`、`bundle/msi/*.msi`。

## 运行时前置（重要）

- 应用通过 `node` 执行 dsh（bundled 模式读取 `runtime/node_modules/...`）。
- **当前分发版要求目标机安装 Node.js**；把 Node 或 dsh 打进安装包属于后续迭代
  （见 docs/RISKS.md）。
- WebView2 运行时：Windows 11 自带；Windows 10 需确认（通常已随 Edge 安装）。

## 首启行为

- 配置存于 `%APPDATA%\com.deepseekharness.wui\config.json`（原子写）。
- 默认 bundled 模式 + 端口 3080 + 自动启动 dsh；可在设置页修改。

## 发布清单

1. 固定版本核对：`runtime/package.json` 与 `package-lock.json`、`Cargo.lock`。
2. 全量验收清单（docs/DEVELOPMENT.md）通过。
3. 安装包冒烟：全新目录安装 → 启动 → dsh 拉起 → 关窗后无残留。
4. （可选）代码签名证书。
5. 记录产物哈希（Get-FileHash）到发布说明。
