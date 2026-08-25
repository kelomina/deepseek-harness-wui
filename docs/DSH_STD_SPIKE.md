# dsh-std 宿主接入 Spike 报告（P0）

> 日期：2026-08-24 · 结论：**GO**（进入 P1 最小宿主）
> 上游：https://github.com/T-Auto/dsh-ecosystem-spec（commit @ main，36 commits）
> 规范基线：`vendor/dsh-std` 固定 revision `614dfa1a`（2026-08-18，"feat: add UI contribution protocol and DSH client adapter"）
> 实施契约：见 `docs/DSH_STD_HOST_PLAN.md`

## 验证矩阵

| # | 验证项 | 命令/方法 | 结果 |
|---|---|---|---|
| V1 | standalone conformance 全套 | `npm run test:standalone`（临时克隆） | **通过**（exit 0；vendor/dsh-std 初始化+安装+构建+全部断言绿） |
| V2 | manifest 准入 CLI | `npm run validate:manifest -- --manifest conformance/fixtures/valid-plugin.json` | **通过**：`{"valid":true,"decision":"compatible"}` |
| V3 | npm 独立依赖路径 | scratch 目录 `npm i --save-exact @dsh-std/core@0.1.0-rc1 manifest/command/storage@同版` | **通过**（6 包 0 漏洞；无需 workspace 链接） |
| V4 | 协商原型（真实 fixture + npm 包） | `proto.mjs`：parse→project→catalog→negotiate 正反例 | **通过**（3 断言全绿，见下） |
| V5 | 负例语义确认 | 读 `conformance/tests/run.js` | `assert.equal(result.pass, expected)` —— 报告中负例 `pass:false` = 预期拒绝，suite 真实全绿 |

## 关键事实

- [事实] conformance suite 覆盖面充分：14 个 manifest 负例（unknown service/kind/coordinate、重复契约、facet 版本、client/worker facet、optional 缺 fallback、provides）、3 个 message payload 负例、4 个 Host Descriptor 负例（未知协议/hash 漂移/未知权限/重复契约）、9 个协商场景断言（compatible/degraded/waiting_authorization/rejected/unknown/facetMismatch）。
- [事实] API 面小而完整：`@dsh-std/core` 构建产物 ~17KB（min），导出 `ProtocolCatalog.negotiate()` 纯函数协商器；`@dsh-std/manifest` 提供 `parseManifest`/`projectManifest`/`ManifestDefinitionCatalog`；command/storage 包直接导出即用型 `protocol: ProtocolDefinition` 与 `register(catalog)`。
- [事实] 协商语义符合预期：required 缺支持 → `compatible=false, required-support-missing`；已知 group+kind 但未知 apiVersion → 可区分的 `definition-unavailable`（对应规范 unknown vs rejected 二分）。
- [事实] 兼容线锚定：spec 的 pinned revision（2026-08-18）对应 npm **0.1.0 线**（dist-tag latest=0.1.0-rc1）；npm 已于 2026-08-23 发布 `0.1.1-rc.1`（新 dev-API 兼容周期，按 architecture.md 不改已发布协议坐标）。**目标线定为 `community-v0.15` 协议坐标 + `@dsh-std/*@0.1.0-rcN` 包线**；0.1.1-rc.N 仅观察。
- [事实] v1 协议面坐标确认：`commands.dsh/v1alpha1#Command`（含 resource/runtime 两 ProtocolDefinition）、`storage.dsh/v1alpha1#LocalStorage`（权限 `storage.local.read/write`，错误码含 `PERMISSION_NOT_GRANTED`/`QUOTA_EXCEEDED`）。

## 环境摩擦（已记录，非阻断）

- Windows standalone 路径硬编码 corepack pnpm 入口（`<node_dir>/node_modules/corepack/dist/pnpm.js`）；Node ≥25 不再捆绑 corepack → 首跑失败。已在**临时克隆**打补丁回退到全局 pnpm cjs 入口后通过。
  - 对 P1 的启示：若未来在 CI 复跑该 suite，需预装 corepack（Node ≤24）或复用同类补丁；可考虑向上游提 issue。

## 工作量修正（相对原计划）

- 无架构级意外，P1 估算维持。新增两个具体利好：
  1. storage/command 包自带协议定义与校验函数，宿主侧无需手写 definition；
  2. `projectManifest` 直接产出宿主组合模型（Component/Facet），激活驱动可直接消费。

## Go/No-Go

**GO**。依据：V1–V5 全部通过；依赖路径（npm 精确锁版本）与项目既有纪律兼容；风险均落在 feature flag 隔离范围内。下一步按 `DSH_STD_HOST_PLAN.md` 进入 P1（feature flag `dshStdHost` 默认关闭）。

## 复现产物位置

- spec 克隆（含补丁）：`%TEMP%\opencode\dsh-ecosystem-spec`
- npm 原型：`%TEMP%\opencode\dshstd-proto\proto.mjs`
- vendored dsh-std revision：`614dfa1ac168db79fcf4577cf0ebb34e2e3b944b`
