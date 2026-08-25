# dsh-std 合规宿主实施契约（实验适配）

> 状态：已批准（2026-08-24）· 阶段：**P0/P1/P2/P3 全部完成**（证据见 evidence/dsh-std-*；
> 唯一待办：用户应用级验收 `npm run tauri dev` 手动全流程）
> 上游规范：https://github.com/T-Auto/dsh-ecosystem-spec （community-consensus v0.15，Experimental）
> 规范基线：`Yan-Zero/dsh-std`（经 submodule 固定 revision）；npm `@dsh-std/core@0.1.1-rc.1`（2026-08-23 发布）

## 目标与非目标

**目标**：使本 WUI 成为一个诚实声明、可验证的 dsh-std 实验宿主——Node sidecar 进程隔离执行插件代码，v1 协议面 = `command` + `storage`，产出可复查的 conformance evidence。

**非目标**：
- 不进入 dsh-TUI 插件市场（那是 dsh-TUI 的产品准入 profile，与本宿主无关）；
- P1 不实现 messages / presentation（留 P2+）；
- 不宣称 Stable、Candidate 或任何"官方认证"（规范治理明确禁止，当前只能声明"实验适配"）；
- 不改动官方 dsh 协议链路语义（`src/lib/dsh/client.ts`、`src-tauri/src/dsh/proxy.rs` 的 Origin 白名单逻辑、`plugins.rs` 既有官方插件桥接行为均不动）。

## 已查证事实

| # | 事实 | 来源 |
|---|---|---|
| F1 | `@dsh-std/*` 已发布 npm；core 0.1.0-rc1（2026-08-18）/ 0.1.1-rc.1（2026-08-23），GitHub Actions OIDC 可信发布，MIT，纯 ESM，engines `^22.19 \|\| >=24` | npm registry |
| F2 | dsh-std 架构：协议可独立实现，宿主自选子集；组件模型 Component → Facet → Activation instance → Participant | dsh-std docs/architecture.md |
| F3 | dsh-TUI 先例：wire 协议桥接、grant 默认 deny、effect ledger append-only、诚实规则（未挂载的契约不得声明 compatible）、上游校验线 fail-closed | dsh-ecosystem-spec adapters/dsh-tui-v0.15.md |
| F4 | 本项目已有进程看护模式可复制：`DshManager`（Child + logs + health + cleanup），验收含"退出后无残留进程" | src-tauri/src/dsh/manager.rs:38, docs/DEVELOPMENT.md |
| F5 | `.npmrc save-exact=true` 兜底所有新依赖精确锁定 | .npmrc |
| F6 | 规范允许生态项目自带 admission profile（profile 由生态项目携带，TUI profile 不倒灌通用契约） | dsh-ecosystem-spec governance + community-consensus 文档 |

## 架构设计

```
WebView (React)                Rust (Tauri)                  plugin-host (新 Node sidecar)
┌──────────────┐   invoke/event   ┌──────────────┐  stdio NDJSON   ┌─────────────────────┐
│ 设置页插件Tab │ ◄──────────────► │ plugin_host.rs│ ◄────────────► │ @dsh-std core/manifest│
│ 命令注册表    │                  │ (镜像 manager │  + token 握手   │ manifest→negotiate→  │
│ 准入状态展示  │                  │  看护模式)    │                │ activate(command/    │
└──────────────┘                  └──────────────┘                │ storage) + 插件代码   │
                                                                  └─────────────────────┘
```

关键决策（用户已拍板）：

1. **插件执行隔离 = Node sidecar 独立进程**（复用 manager.rs 看护能力；无 Tauri IPC 暴露；有 dsh-TUI Channel wire 先例）。备选 Web Worker 已否决。
2. **v1 协议面 = command + storage**（两者均可 headless 测试；messages/presentation 留 P2+）。
3. **传输 = stdio NDJSON + 启动握手 token**（不开新端口、最小权限；localhost WS 为备选留档）。
4. **存储落点** = `app_config_dir/plugin-storage/<ns>.json`（Windows 路径；不使用 `~/.dsh-tui`）；`storage.local.read/write` 权限默认 deny。
5. **Host Descriptor 诚实规则**：仅声明真实挂载的契约；trustLevel 如实标注（sidecar 内 in-process、非 OS 边界）。

## 分阶段实施

### P0 — Spike（只读评估，临时目录，零仓库代码写入）

1. Clone dsh-ecosystem-spec 至 `%TEMP%\opencode\dsh-ecosystem-spec`；
2. 跑 `npm run test:standalone`（固定 revision 初始化 vendor/dsh-std → 安装 → 构建 → 全套 conformance）验证链路可用性；
3. 跑 `npm run validate:manifest -- --manifest <示例>` 走通准入校验；
4. 用 `@dsh-std/core@0.1.1-rc.1` 写最小协商原型脚本；确认 `registry/registry-0.15.json` 坐标与 npm 包版本对应关系，**确定目标兼容线**；
5. 产出：`docs/DSH_STD_SPIKE.md`（Go/No-Go 报告 + 工作量修正）+ `docs/RISKS.md` 生态观察条目（记录版本与验证日期）。

**退出条件**：Go/No-Go 明确结论。No-Go 时仅保留文档产出，仓库无代码变更。

### P1 — 最小宿主（feature flag `dshStdHost` 默认关闭）

写集（允许修改/新增）：根 `package.json`（精确锁 `@dsh-std/core`、`@dsh-std/manifest`）、新建顶层 `plugin-host/`（独立 npm 工程，仿 `runtime/` 先例）、新建 `src-tauri/src/dsh/plugin_host.rs`、`mod.rs` 与 `lib.rs` 注册、`src/pages/SettingsPage.tsx` 插件 Tab 实验区、`docs/RISKS.md`。

内容：sidecar 生命周期管理（spawn/health/kill，纳入现有"退出无残留"验收）、Host Descriptor 构建、parse→project→catalog→negotiate 管道、command facet（命令注册表回传 UI 渲染）、storage facet（grant 门禁 + namespaced JSON 文件）。

验收标准：
- [ ] `cd src-tauri && cargo check` 通过
- [ ] `npm run build` 通过
- [ ] conformance fixtures 正反单测通过
- [ ] flag 关闭时零行为变化（现有验收四步全过）
- [ ] 应用退出后无残留 node/plugin-host 进程

### P2 — 执行接入

示例插件端到端激活（sidecar 内 import 执行）；grant store 持久化 + 设置页授权 UI；deactivate/uninstall/purge 清理语义对标 TUI-OBS-002。验收：端到端证据存 `evidence/`；异常插件崩溃不影响主应用（sidecar 重启策略验证）。

### P3 — 准入与证据

自写 `wui-admission-v0.1.md`（基于 community-consensus v0.15 基线，不倒灌 TUI 规则）；跑对方 conformance suite 对 Host Descriptor + fixtures 出机器证据存 `evidence/`；全站措辞审计（仅"实验适配"）；README/CHANGELOG 收口。

## 风险与回滚

| 风险 | 缓解 |
|---|---|
| 规范 Draft/Experimental，5 天前刚切 0.1.1 兼容线，breaking 风险高 | P0 锁定目标兼容线；精确 pin；RISKS.md 记录版本+验证日期 |
| 生态成熟度低（18 stars / 单团队维护），存在熄火风险 | 全程 feature flag 隔离；废弃成本 = 移除一个 sidecar 模块 |
| 第三方代码执行安全面 | 无 Tauri IPC、无新监听端口、token 握手、权限默认 deny、独立进程崩溃可隔离 |
| 回滚路径 | 功能整体位于 flag 后；git revert 单 PR 即完全回退 |

## 禁止触碰边界

- `src/lib/dsh/client.ts` 协议语义；
- `src-tauri/src/dsh/proxy.rs` Origin 白名单逻辑；
- `src-tauri/src/dsh/plugins.rs` 既有官方插件桥接行为；
- 一切凭据相关配置（项目铁律：凭据零存储）。
