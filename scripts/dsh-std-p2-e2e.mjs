// dsh-std 宿主 P2 端到端验证脚本（实验特性证据采集）。
// 用法：node scripts/dsh-std-p2-e2e.mjs
// 产物：evidence/dsh-std-p2-e2e-<ts>.md
//
// 覆盖：spawn → 握手 → deny-by-default 准入 → fail-closed 激活拒绝 → 授权 →
//       兼容准入 → 激活（真实 import entry）→ 命令执行（含 storage）→ 停用后效果撤销 →
//       卸载+purge（撤权/删 storage）→ effect ledger 无 payload 泄漏 → 无残留进程。

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const mainMjs = path.join(repoRoot, 'plugin-host', 'main.mjs')
const pluginRoot = path.join(repoRoot, 'plugin-host', 'examples', 'echo-plugin')
const manifestJson = fs.readFileSync(path.join(pluginRoot, 'dsh-plugin.json'), 'utf8')
const PLUGIN_ID = 'com.example.echo'

const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'wui-p2-e2e-'))
const transcript = []
let passed = 0
let failed = 0

function assertEq(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) passed++
  else failed++
  transcript.push(`- ${ok ? '✔' : '✘'} ${name} — actual=${JSON.stringify(actual)}${ok ? '' : ` expected=${JSON.stringify(expected)}`}`)
  if (!ok) throw new Error(`assert failed: ${name}`)
}

function assertOk(name, cond, detail = '') {
  const ok = Boolean(cond)
  if (ok) passed++
  else failed++
  transcript.push(`- ${ok ? '✔' : '✘'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) throw new Error(`assert failed: ${name}`)
}

function startSidecar() {
  const child = spawn(process.execPath, [mainMjs], {
    env: {
      ...process.env,
      DSH_WUI_PLUGIN_HOST_TOKEN: 'e2e-token',
      DSH_WUI_PLUGIN_HOST_STORAGE_ROOT: path.join(workdir, 'storage'),
      DSH_WUI_PLUGIN_HOST_LEDGER: path.join(workdir, 'ledger.jsonl'),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity })
  const stderrChunks = []
  child.stderr.on('data', chunk => stderrChunks.push(String(chunk)))
  const waiters = []
  rl.on('line', line => {
    const waiter = waiters.shift()
    if (waiter) waiter(JSON.parse(line))
  })
  let nextId = 1
  const send = (method, params = {}) => {
    const id = nextId++
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout: ${method}; stderr=${stderrChunks.join('')}`)), 8000)
      waiters.push(value => {
        clearTimeout(timer)
        resolve(value)
        transcript.push(`\n> **${method}** → \`${(value.ok ? JSON.stringify(value.result) : JSON.stringify(value.error)).slice(0, 220)}\``)
      })
    })
  }
  return { child, send }
}

const sidecar = startSidecar()
try {
  transcript.push(`# dsh-std 宿主 P2 端到端验证\n`)
  transcript.push(`- 时间：${new Date().toISOString()}`)
  transcript.push(`- 平台：${process.platform}/${process.arch} node ${process.version}`)
  transcript.push(`- 插件：${PLUGIN_ID}（plugin-host/examples/echo-plugin）`)

  // 1. 握手
  const hello = await sidecar.send('hello', { token: 'wrong' })
  assertOk('错误 token 被拒（ok=false）', hello.ok === false)
  assertEq('错误 token 错误码', hello.error?.code, 'HANDSHAKE_FAILED')
  const ready = await sidecar.send('hello', { token: 'e2e-token' })
  assertOk('握手成功且广告 Command/LocalStorage 两契约',
    ready.result.descriptor.contracts.length === 2)

  // 2. deny-by-default 准入
  const deniedAdmit = await sidecar.send('admit', { manifestJson })
  assertEq('未授权时准入决策', deniedAdmit.result.decision, 'waiting_authorization')

  // 3. waiting 状态下激活被拒（fail-closed）
  const refusedActivate = await sidecar.send('activate', { pluginId: PLUGIN_ID, pluginRoot })
  assertEq('waiting 态激活被拒', refusedActivate.error?.code, 'PLUGIN_NOT_ADMITTED')

  // 4. 授权 → 重新准入 compatible
  await sidecar.send('grants.set', {
    pluginId: PLUGIN_ID,
    permissions: ['commands.invoke', 'storage.local.read', 'storage.local.write'],
  })
  const grantedAdmit = await sidecar.send('admit', { manifestJson })
  assertEq('授权后准入决策', grantedAdmit.result.decision, 'compatible')

  // 5. 激活（真实 import dist/main.js 并执行 activate(ctx)）
  const activated = await sidecar.send('activate', { pluginId: PLUGIN_ID, pluginRoot })
  assertOk('激活成功（含 activationInstance）', typeof activated.result.activationInstance === 'string')
  assertEq('注册命令数（ping + remember）',
    activated.result.commands.map(c => c.id).sort(),
    ['com.example.echo.ping', 'com.example.echo.remember'])

  // 6. 执行命令（@dsh-std/command handler 结果形状）
  const pong = await sidecar.send('execute', {
    pluginId: PLUGIN_ID, commandId: 'com.example.echo.ping', rawInput: 'evidence-run',
  })
  assertEq('ping 命令返回', pong.result, { kind: 'success', text: 'pong: evidence-run' })

  const remember = await sidecar.send('execute', {
    pluginId: PLUGIN_ID, commandId: 'com.example.echo.remember', rawInput: 'note-42',
  })
  assertEq('remember 命令（经 grant 门禁 storage）返回',
    remember.result.text, 'stored="note-42"')

  // 7. 停用后效果撤销
  const deactivated = await sidecar.send('deactivate', { pluginId: PLUGIN_ID })
  assertEq('停用成功且无清理异常', deactivated.result.cleanupError, null)
  const afterDeactivate = await sidecar.send('execute', {
    pluginId: PLUGIN_ID, commandId: 'com.example.echo.ping',
  })
  assertEq('停用后 execute 被拒', afterDeactivate.error?.code, 'NOT_ACTIVE')

  // 8. 卸载 + purge：撤权 + 删 namespaced storage；重新准入回到 waiting
  const uninstalled = await sidecar.send('uninstall', { pluginId: PLUGIN_ID, purge: true })
  assertEq('卸载+purge 完成', uninstalled.result, { uninstalled: true, purged: true, cleanupError: null })
  const reAdmit = await sidecar.send('admit', { manifestJson })
  assertEq('撤权后重新准入回到 waiting', reAdmit.result.decision, 'waiting_authorization')
  const storageDirBeforePurgeCheck = path.join(workdir, 'storage')
  const leftoverFiles = fs.existsSync(storageDirBeforePurgeCheck)
    ? fs.readdirSync(storageDirBeforePurgeCheck).filter(f => f.startsWith('com.example.echo') && f.endsWith('.json'))
    : []
  assertOk('purge 后无插件 storage 文件残留', leftoverFiles.length === 0, `leftover=${JSON.stringify(leftoverFiles)}`)

  // 9. effect ledger 元数据纪律（不含 payload 正文）
  const ledgerText = fs.readFileSync(path.join(workdir, 'ledger.jsonl'), 'utf8')
  assertOk('ledger 记录 activation/deactivation/command_execution',
    ledgerText.includes('"kind":"activation"') && ledgerText.includes('"kind":"deactivation"') &&
    ledgerText.includes('"kind":"command_execution"'))
  assertOk('ledger 不含消息正文/payload', !ledgerText.includes('note-42') && !ledgerText.includes('evidence-run'))
  assertOk('ledger 含 runtime generation 归属', ledgerText.includes('"generationId"'))

  // 10. 优雅关闭，无残留进程
  const bye = await sidecar.send('shutdown')
  assertOk('shutdown 响应正常', bye.ok === true)
  // 关闭 stdin 触发子进程 readline 收尾；3s 内未退则强杀兜底
  sidecar.child.stdin.end()
  const exited = await new Promise(resolve => {
    const killer = setTimeout(() => {
      sidecar.child.kill()
      resolve('killed-after-grace')
    }, 3000)
    sidecar.child.once('exit', code => {
      clearTimeout(killer)
      resolve(code)
    })
  })
  assertOk('sidecar 进程退出（优雅或兜底强杀）', exited === 0 || exited === 'killed-after-grace', `exit=${exited}`)
} catch (error) {
  transcript.push(`\n**异常终止**: ${error.message}`)
} finally {
  try { sidecar.child.kill() } catch { /* already dead */ }
}

transcript.push(`\n## 结果\n`)
transcript.push(`- 断言通过：${passed}`)
transcript.push(`- 断言失败：${failed}`)
transcript.push(`- 总体：**${failed === 0 ? 'PASS' : 'FAIL'}**`)

fs.mkdirSync(path.join(repoRoot, 'evidence'), { recursive: true })
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const outFile = path.join(repoRoot, 'evidence', `dsh-std-p2-e2e-${stamp}.md`)
fs.writeFileSync(outFile, transcript.join('\n') + '\n')
console.log(transcript.slice(-4).join('\n'))
console.log(`[e2e] transcript → ${outFile}`)
fs.rmSync(workdir, { recursive: true, force: true })
if (failed > 0) process.exit(1)
