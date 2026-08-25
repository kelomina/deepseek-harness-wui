// 上游 conformance fixtures × 本宿主 admission 引擎交叉比对。
// 用法：node scripts/dsh-std-fixtures-crosscheck.mjs
// 产物：evidence/dsh-std-fixtures-crosscheck-<ts>.md
//
// 目的：证明 plugin-host/lib/admission.mjs 的判定语义与 T-Auto/dsh-ecosystem-spec
// conformance suite 对同一批 fixtures 的期望一致（accept/reject 对齐；
// valid 清单在本宿主上的投影差异属宿主能力面差异，单独说明，不算偏差）。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { evaluate } from '../plugin-host/lib/admission.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const fixturesDir = path.join(repoRoot, 'plugin-host', 'test', 'fixtures')

// 上游 suite（conformance/tests/run.js）对每个 fixture 的期望：
//   valid-*        → manifest 接受（pass=true）
//   invalid-*      → 拒绝（pass=false），其中 unknown coordinate/kind 属 INVALID_MANIFEST 族拒绝
// 本宿主投影：valid 清单的最终 decision 取决于本宿主支持面与授权态（见报告正文）。
const CASES = [
  ['valid-plugin.json', { accept: true }],
  ['invalid-plugin-unknown-service.json', { accept: false }],
  ['invalid-plugin-duplicate-command.json', { accept: false }],
  ['invalid-plugin-unknown-coordinate.json', { accept: false }],
  ['invalid-plugin-unknown-kind.json', { accept: false }],
  ['invalid-plugin-duplicate-coordinate.json', { accept: false }],
  ['invalid-plugin-client-facet.json', { accept: false }],
  ['invalid-plugin-worker-facet.json', { accept: false }],
  ['invalid-plugin-provides.json', { accept: false }],
  ['invalid-plugin-subscription-capability.json', { accept: false }],
  ['invalid-plugin-optional-no-fallback.json', { accept: false }],
  ['invalid-plugin-facet-version.json', { accept: false, reasonCode: 'FACET_API_VERSION_UNAVAILABLE' }],
]

const lines = []
let passed = 0
let failed = 0

lines.push('# dsh-std fixtures × wui 宿主 admission 交叉比对\n')
lines.push(`- 时间：${new Date().toISOString()}`)
lines.push(`- 引擎：plugin-host/lib/admission.mjs（wui-admission/0.1，baseline community-consensus v0.15）`)
lines.push(`- fixtures 来源：T-Auto/dsh-ecosystem-spec conformance/fixtures（MIT，vendored 子集）\n`)

for (const [fixture, expect] of CASES) {
  const raw = fs.readFileSync(path.join(fixturesDir, fixture), 'utf8')
  let outcome
  try {
    outcome = evaluate(raw)
  } catch (error) {
    outcome = { decision: 'rejected', reasonCode: 'ENGINE_THROWN', errors: [String(error?.message ?? error)] }
  }
  const accepted = outcome.decision === 'compatible' || outcome.decision === 'compatible_degraded' || outcome.decision === 'waiting_authorization'
  const ok = acceptMatch(accepted, expect.accept) && reasonMatch(outcome, expect)
  if (ok) passed++
  else failed++
  lines.push(
    `- ${ok ? '✔' : '✘'} **${fixture}** — 上游期望=${expect.accept ? '接受' : '拒绝'}；本宿主 decision=\`${outcome.decision}\`` +
      `${outcome.reasonCode ? `（${outcome.reasonCode}）` : ''}` +
      (ok ? '' : ` ← 不匹配`),
  )
}

function acceptMatch(accepted, expectAccept) {
  return expectAccept ? accepted : !accepted
}
function reasonMatch(outcome, expect) {
  return !expect.reasonCode || outcome.reasonCode === expect.reasonCode
}

// valid 清单在本宿主的完整投影链（供人工复核）
lines.push(`\n## valid-plugin.json 在本宿主的投影链\n`)
const validRaw = fs.readFileSync(path.join(fixturesDir, 'valid-plugin.json'), 'utf8')
const noGrants = evaluate(validRaw)
const granted = evaluate(validRaw, { grants: ['commands.invoke'] })
lines.push(`1. deny-by-default（无授权）→ \`${noGrants.decision}\`${noGrants.deniedPermissions?.length ? `（待授权：${noGrants.deniedPermissions.join('、')}）` : ''}`)
lines.push(`2. 授予 commands.invoke 后 → \`${granted.decision}\`${granted.missingOptional?.length ? `（缺 optional：${granted.missingOptional.join('、')}——本宿主 v0.1 未实现 messages）` : ''}`)
lines.push(`3. 与上游 TUI 示例宿主（compatible）的差异属**宿主能力面差异**（TUI 实现 messages，本宿主未实现），非语义偏差。`)

lines.push(`\n## 结果\n`)
lines.push(`- 断言通过：${passed}`)
lines.push(`- 断言失败：${failed}`)
lines.push(`- 总体：**${failed === 0 ? 'PASS' : 'FAIL'}**`)

fs.mkdirSync(path.join(repoRoot, 'evidence'), { recursive: true })
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const outFile = path.join(repoRoot, 'evidence', `dsh-std-fixtures-crosscheck-${stamp}.md`)
fs.writeFileSync(outFile, lines.join('\n') + '\n')
console.log(lines.slice(-4).join('\n'))
console.log(`[crosscheck] report → ${outFile}`)
if (failed > 0) process.exit(1)
