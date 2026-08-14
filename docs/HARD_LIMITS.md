# 硬限制（Hard Limits）

两套限制：**工程护栏**（仓库/协作层）与**运行时限制**（应用/dsh 进程层）。修改任何限制需
在本文件记录变更原因与验证方式；运行时限制的默认值可在设置页查看（只读）。

## 1. 工程护栏

| 限制 | 实现 | 说明 |
|---|---|---|
| 忽略生成物/凭据 | `.gitignore` | node_modules、dist、target、runtime/node_modules、*.env、credentials.yaml、evidence/、logs/ |
| 行尾/编码 | `.editorconfig` + `.gitattributes` | 代码 LF UTF-8；`.bat` CRLF；二进制标记 |
| 密钥防泄漏 | `scripts/hooks/pre-commit.ps1` | 扫描 api key/token/secret/password 模式、`.env`/`*.pem`/`*.key` 文件名 |
| 大文件限制 | 同上 | > 5MB 拒绝（无 LFS；需要大资产先讨论） |
| 提交规范 | `scripts/hooks/commit-msg.ps1` | Conventional Commits（feat/fix/docs/chore/…） |
| 钩子启用 | `git config core.hooksPath scripts/hooks` | 已配置；新克隆需执行 |
| 分支保护 | 本地默认分支 `main`；远程托管后启用服务器端保护（禁止 force push 到 main、PR 必须过 CI） | 本轮无远程 |
| 版本锁定 | `.npmrc`（save-exact=true）、`rust-toolchain.toml` | 所有依赖精确版本 |

## 2. 运行时限制（dsh-manager）

| 限制 | 默认值 | 说明 |
|---|---|---|
| 启动超时 | 90s | 超时未通过健康检查 → Error + 按策略重启 |
| 健康检查间隔 | 2s | TCP 探测 127.0.0.1:<port> `/` |
| 健康失败阈值 | 连续 3 次 | Running 状态失联 → Error |
| 自动重启 | 3 次 / 600s 窗口 | 意外退出/失联时；超出进入 Error 等待人工 |
| 端口校验 | 1..=65535 | 配置校验；端口冲突由健康检查暴露 |
| 日志缓冲 | 2000 行内存环形 | 不落盘（本轮）；UI 可查看 |
| 单实例 | Tauri plugin-single-instance | 二次启动聚焦已有窗口 |
| 凭据零存储 | — | 本项目不保存 API Key；全部交给 dsh |
| WebView 基线 | CSP 限制 connect-src 到本机代理与 dev server；无远程导航 | 生产加固见 RISKS（unsafe-inline 待收紧） |
| 代理边界 | 仅绑定 127.0.0.1；Origin 白名单 | 非白名单 Origin 拒绝 |

## 变更流程

1. 修改代码或配置前先说明动机与影响（issue/PR 描述）。
2. 运行时默认值改动需同步设置页只读展示与 `docs/HARD_LIMITS.md`。
3. 验证：工程护栏用 `git commit` 负例（含密钥/大文件应被拒）；运行时限制用验收清单。
