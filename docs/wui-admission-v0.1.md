# WUI Admission Profile v0.1（dsh-std 实验宿主准入规范）

> **Status:** Experimental / Product Policy
> **Authority:** DeepSeek Harness WUI 维护者
> **Baseline:** dsh-std community-consensus **v0.15**（pinned revision `614dfa1a`；npm `@dsh-std/*@0.1.0-rc1`）
> **实现位置：** `plugin-host/`（sidecar）+ `src-tauri/src/dsh/plugin_host.rs`（看护/授权持久化）
> **上游关系：** 本 profile 只约束本 WUI 宿主，不倒灌 dsh-TUI 准入规则，也不改变 dsh-std 公共契约语义。
> 在上游进入 Candidate/Stable 前，本宿主对外仅声明"**实验适配**"，禁止任何"官方认证/稳定"措辞。

## 1. 坐标与版本

| 项 | 值 |
|---|---|
| profileVersion | `wui-admission/0.1` |
| manifestVersion | `0.15`（community） |
| facetApiVersions | `["v1alpha1"]` |
| Host Descriptor `$schema` | `urn:dsh-wui:host-descriptor:0.1` |
| hostId | `deepseek-harness-wui` |

协议坐标（import 自 dsh-std，v0.1 宿主支持面）：

| 坐标 | kind | 权限 | v0.1 状态 |
|---|---|---|---|
| `commands.dsh/v1alpha1` | `Command` | `commands.invoke`（默认 deny，激活后随命令执行授予语义） | **支持**（资源 + 执行） |
| `storage.dsh/v1alpha1` | `LocalStorage` | `storage.local.read` / `storage.local.write`（独立 deny-by-default） | **支持** |
| `messages.dsh/v1alpha1` | `MessageObserver` | `messages.observe.read` | 已识别、未实现（required → rejected；optional → compatible_degraded） |
| `presentation.dsh/v1alpha1` | `OpenExternal` / `UserInteraction` / `ExternalRedirect` | — | 同上 |
| `workspace.dsh/v1alpha1` | `WorkspaceProvider` | — | 同上 |

决策词汇表（对齐 dsh-std/dsh-TUI 投影语义）：
`compatible` / `compatible_degraded` / `waiting_authorization` / `rejected` / `unknown`。

判定次序（fail-closed）：manifest 解析失败或结构违规 → **rejected(INVALID_MANIFEST)**；
facet apiVersion 不在支持集 → **rejected(FACET_API_VERSION_UNAVAILABLE)**；
group+kind 完全未知 → **rejected**；已知 family 但 apiVersion 未注册 → **unknown(UNKNOWN_PROTOCOL_VERSION)**；
required 缺支持 → **rejected(REQUIRED_PROTOCOL_UNAVAILABLE)**；存在未授权权限 → **waiting_authorization**
（优先于 degraded）；仅缺 optional → **compatible_degraded**；否则 **compatible**。

## 2. 包与声明完整性（对标 TUI-PKG-001/002 的 wui 投影）

- 包根唯一 `dsh-plugin.json`，由固定 revision 的 `@dsh-std/manifest` community v0.15 parser 接受。
- required/optional contracts、permissions、subscriptions、contributes 必须全部静态声明。
- `requires.services` 必须为空数组；`provides` / `facets.client` / `facets.worker` 拒绝。
- 重复 contract coordinate 或重复 command id → rejected。
- subscriptions 只能引用 event 类坐标（当前即 `messages.observe`）。
- optional contract 必须给出宿主可展示的 fallback 文案（wui 产品策略，沿用 TUI 做法）。

## 3. 运行时与信任模型

- **执行位置**：独立 Node sidecar 进程（`plugin-host/main.mjs`），stdio NDJSON + 启动 token 握手；
  无 Tauri IPC 暴露、无监听端口。
- **trustLevel 如实声明为 `trusted-in-process`**：插件代码在 sidecar 内以完整 Node 权限运行，
  **不构成 OS/进程/realm 安全边界**。安装/激活界面必须向用户展示这一点。
- **授权权威**：Rust 侧 `plugin-host-grants.json`（原子写）；sidecar 内存态经 `grants.set` 同步；
  默认空 = 全部拒绝。storage 门禁按 pluginId 粒度检查。
- **效果归属**：所有注册命令归属 (pluginId, activationInstance, runtimeGenerationId) 三元组；
  deactivate 后 handler 不可达（execute → NOT_ACTIVE）。
- **effect ledger**：append-only JSONL（`plugin-host-ledger.jsonl`），只记生命周期/执行元数据
  （kind/pluginId/activationInstance/generationId/outcome/errorCode/durationMs）；
  结构性不含 payload、消息正文、secret。写失败静默降级（观测损失不阻断业务）。
- **崩溃自愈**：sidecar 意外退出自动重启 ≤2 次；重启后 grants 自动恢复，
  但 admitted/activated 集合不恢复（须重新准入+激活——安全上优于持久化运行态）。

## 4. Activation Driver（wui 私有）

community v0.15 将 activation 定义为 open versioned object；本宿主 driver 契约如下
（示例参考实现：`plugin-host/examples/echo-plugin/`）：

- `facets.host.entry`：包根相对 ESM 路径（`.js`/`.mjs`，禁绝对路径与 `..`）。
- 模块导出 `activate(ctx)`（可 async，5s 超时），可选导出 `deactivate()`（10s 内完成）。
- `ctx.registerCommand({ id, title, description?, handler })`：
  - `id` 必须与 manifest `contributes.commands[].id` 一致（宿主按清单核对展示）；
  - `handler` 形状 = `@dsh-std/command` CommandHandler：`execute({ rawInput }, { signal })`
    → `{ kind: 'success' | 'error', text? }`，经 `assertCommandHandler` 校验；
  - 单命令执行超时 10s（AbortController）；同步死循环无法被中断，依赖超时报错 + 进程自愈兜底。
- `ctx.storage`：插件私有 LocalStorage 句柄（无 pluginId 参数，宿主绑定命名空间）；
  配额 256 keys / 256 KiB per namespace；错误码对齐 `@dsh-std/storage`
  （`PERMISSION_NOT_GRANTED` / `INVALID_KEY` / `INVALID_VALUE` / `QUOTA_EXCEEDED` / `STORAGE_UNAVAILABLE`）。

## 5. 生命周期与清理（TUI-OBS-002 对标）

| 操作 | 语义 |
|---|---|
| deactivate | 调用 `deactivate()` → 移除命令注册 → 保留准入、授权与 storage |
| uninstall | deactivate + 撤销准入记录与 grants（storage 保留） |
| uninstall + purge | 再删除该插件 namespaced storage 文件 |

cleanup 失败（deactivate() 抛错）不阻塞移除，但作为 `cleanupError` 上报 UI 与 ledger。

## 6. 验证与证据

- conformance fixtures 正反例（vendored 自 T-Auto/dsh-ecosystem-spec，MIT，见
  `plugin-host/test/fixtures/PROVENANCE.md`）→ node:test 断言决策一致；
- 上游 fixtures × 本宿主 admission 引擎交叉比对报告（`evidence/dsh-std-fixtures-crosscheck-*.md`）；
- 全生命周期 E2E 存证（`evidence/dsh-std-p2-e2e-*.md`，脚本 `scripts/dsh-std-p2-e2e.mjs` 可复现）；
- 上游 standalone conformance suite 结果（P0 spike，见 `docs/DSH_STD_SPIKE.md`）。

## 7. 边界

- 不进入 dsh-TUI 市场，不受其准入约束；两生态互不影响。
- 不改动官方 dsh 协议链路（client.ts / proxy.rs / plugins.rs 既有语义不动）。
- 本文档与其实现均为 Draft/Experimental；breaking 无需迁移窗口，但每次升级必须
  复跑测试并在 `docs/RISKS.md` 记录新 revision 与验证日期。
