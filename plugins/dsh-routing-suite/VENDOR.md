# dsh-routing-suite（vendored）

本项目将第三方 DSH 插件套装 **dsh-routing-suite** 以固定版本 vendored 进仓库，
供应用在「设置 → 插件」中一键装配/卸载。所有文件来自上游 MIT/BSD 项目，
未做任何本地修改（仅复制、重组目录布局）。

## 组件

| 路径 | 组件 | 上游仓库 | 版本 | 上游 commit | 许可证 |
|---|---|---|---|---|---|
| `injector/` | dsh-super-injector（运行时注入器，dev_* 工具全家桶） | https://github.com/yjh051108/dsh-super-injector | 0.3.1（Release 构建） | `8b4099535976d1af85137ef9e93815cf14c3f094`（tag v0.3.1） | BSD-3-Clause |
| `preset/` | dsh-router-standard（思维模式路由预设） | https://github.com/yjh051108/dsh-router-standard | 0.1.0 | `a94221aaa99421f8c84503723d4efc6629b8a463`（tag v0.1.0） | MIT（派生声明见 `preset/NOTICE`） |

套装仓库：https://github.com/yjh051108/dsh-routing-suite @ `cc5049e91a54297a86dc62f21cdb72e517588190`
（套装本身只是安装链聚合，组件以各自仓库为准）。

## 来源与完整性

- `injector/` 来自 Release 资产
  `dsh-external-dsh-super-injector-0.3.1.tgz`（解压 `package/` 内容上移一层），
  该资产的 SHA-256：
  `1DFA8623B09684343843150600C4A9C58F2DA1D9D0EDFFF7134A24091C99DB4E`
- `preset/` 来自 dsh-router-standard 仓库 `preset/preset/` 四件套
  （`agent.cordis.yml` / `preset.yml` / `router-bootstrap.mjs` / `router-core.mjs`），
  并附上游仓库根部的 `LICENSE` 与 `NOTICE` 以保留署名。

## 装配语义（应用内「一键安装路由套装」执行的动作）

1. **注入器**：`dsh plugin --profile web add <本目录>/injector`（pnpm 装配，
   写 profile bundles；重启 dsh 后由 bundles 接管）。
2. **预设**：把 `<本目录>/preset` 复制到 `$DSH_HOME/.agent-presets/router-standard/`
   （dsh 官方 agent-presets 用户根目录；目录名 = preset id，符合 `^[a-z0-9][a-z0-9-]*$`）。
3. 安装完成后需**重启 dsh**：注入器由 bundle 装载；预设会在 dsh 的
   agent preset 列表（应用「设置 → Agent 模式」与新会话选择器）中出现为
   **Router Standard (experimental)**。

> **依赖链接（live 实测 2026-08-15）**：注入器 `lib/index.js` 裸导入 `schemastery` 等包，
> 而 pnpm `link:` junction 指向项目目录后 Node 无法从 profile/runtime 解析这些依赖（dsh 启动即失败）。
> 应用安装流程会在 pnpm add 后把**当前生效 runtime** 的对应包 junction 进
> `injector/node_modules/`（与上游 build.sh 同机制；该目录被 .gitignore 忽略，不入库）。
> 卸载时只解链、不动 runtime。

卸载（可逆）：`dsh plugin --profile web remove <dump-config 中解析出的包名>` +
把 `.agent-presets/router-standard` 重命名为 `.trash-<ts>`（点前缀，dsh 扫描跳过）。

## 升级/更新流程

1. 检查上游是否发布新版本（injector Releases / preset tags）。
2. 重新下载并解压（injector）或克隆（preset），按上述布局覆盖 `injector/`、`preset/`。
3. 更新本文件的版本/commit/哈希。
4. 在 `docs/RISKS.md` 记录新版本的 dsh 兼容性验证日期与边界。
5. 提交信息：`chore(plugins): bump dsh-routing-suite injector/preset to <version>`。

> 上游为第三方社区项目，非 DeepSeek 官方；行为与质量以上游为准，
> 本应用只负责装配/卸载与状态展示，不修改其代码。
