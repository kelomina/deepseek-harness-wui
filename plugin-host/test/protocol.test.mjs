import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import readline from 'node:readline'
import { createHost } from '../main.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const mainMjs = path.join(here, '..', 'main.mjs')
const validManifestPath = path.join(here, 'fixtures', 'valid-plugin.json')
const validManifest = fs.readFileSync(validManifestPath, 'utf8')
const echoPluginRoot = path.join(here, '..', 'examples', 'echo-plugin')
const echoManifest = fs.readFileSync(path.join(echoPluginRoot, 'dsh-plugin.json'), 'utf8')

function startChild(env = {}) {
  const child = spawn(process.execPath, [mainMjs], {
    env: {
      ...process.env,
      DSH_WUI_PLUGIN_HOST_TOKEN: 'test-token',
      ...env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity })
  const stderrChunks = []
  child.stderr.on('data', chunk => stderrChunks.push(String(chunk)))
  const waiters = []
  rl.on('line', line => {
    const value = JSON.parse(line)
    const waiter = waiters.shift()
    if (waiter) waiter(value)
  })
  const send = request => {
    child.stdin.write(`${JSON.stringify(request)}\n`)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${request.method}: ${stderrChunks.join('')}`)), 8000)
      waiters.push(value => {
        clearTimeout(timer)
        resolve(value)
      })
    })
  }
  return { child, send, stderr: () => stderrChunks.join('') }
}

test('stdio handshake rejects wrong token and accepts correct token with descriptor', async () => {
  const session = startChild()
  try {
    const bad = await session.send({ id: 1, method: 'hello', params: { token: 'wrong' } })
    assert.equal(bad.ok, false)
    assert.equal(bad.error.code, 'HANDSHAKE_FAILED')

    const good = await session.send({ id: 2, method: 'hello', params: { token: 'test-token' } })
    assert.equal(good.ok, true)
    assert.equal(good.result.ready, true)
    assert.equal(good.result.protocolRevision, 2)
    assert.equal(good.result.descriptor.hostId, 'deepseek-harness-wui')
    assert.deepEqual(
      good.result.descriptor.contracts.map(c => c.kind).sort(),
      ['Command', 'LocalStorage'],
    )
  } finally {
    session.child.kill()
  }
})

test('full lifecycle over stdio: grant → admit → activate → execute → deactivate → uninstall(purge)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wui-host-e2e-'))
  const ledgerPath = path.join(root, 'ledger.jsonl')
  const session = startChild({
    DSH_WUI_PLUGIN_HOST_STORAGE_ROOT: root,
    DSH_WUI_PLUGIN_HOST_LEDGER: ledgerPath,
  })
  try {
    const hello = await session.send({ id: 1, method: 'hello', params: { token: 'test-token' } })
    assert.equal(hello.ok, true)

    // deny-by-default：未授权时 admit → waiting_authorization
    const denied = await session.send({ id: 2, method: 'admit', params: { manifestJson: echoManifest } })
    assert.equal(denied.result.decision, 'waiting_authorization')
    assert.ok(denied.result.deniedPermissions.includes('commands.invoke'))

    // activate 在未准入（waiting 被拒收）状态下必须拒绝（fail-closed）
    const refused = await session.send({
      id: 3,
      method: 'activate',
      params: { pluginId: 'com.example.echo', pluginRoot: echoPluginRoot },
    })
    assert.equal(refused.ok, false)
    assert.equal(refused.error.code, 'PLUGIN_NOT_ADMITTED')

    // 授权全部请求权限后重新准入 → compatible
    const grants = await session.send({
      id: 4,
      method: 'grants.set',
      params: {
        pluginId: 'com.example.echo',
        permissions: ['commands.invoke', 'storage.local.read', 'storage.local.write'],
      },
    })
    assert.equal(grants.result.permissions.length, 3)
    const admitted = await session.send({ id: 5, method: 'admit', params: { manifestJson: echoManifest } })
    assert.equal(admitted.result.decision, 'compatible')

    // 激活（真实 import 示例插件 entry）
    const activated = await session.send({
      id: 6,
      method: 'activate',
      params: { pluginId: 'com.example.echo', pluginRoot: echoPluginRoot },
    })
    assert.equal(activated.ok, true)
    assert.match(activated.result.activationInstance, /^com\.example\.echo-/)
    assert.equal(activated.result.commands.length, 2)

    // 执行命令（handler 对齐 @dsh-std/command CommandHandler 结果形状）
    const pong = await session.send({
      id: 7,
      method: 'execute',
      params: { pluginId: 'com.example.echo', commandId: 'com.example.echo.ping', rawInput: 'hello' },
    })
    assert.deepEqual(pong.result, { kind: 'success', text: 'pong: hello' })

    // storage 命令走 grant 门禁的命名空间句柄
    const remembered = await session.send({
      id: 8,
      method: 'execute',
      params: { pluginId: 'com.example.echo', commandId: 'com.example.echo.remember', rawInput: 'secret-note' },
    })
    assert.equal(remembered.result.kind, 'success')
    assert.match(remembered.result.text, /"secret-note"/)

    // 命令目录
    const commands = await session.send({ id: 9, method: 'commands.list' })
    assert.equal(commands.result.commands.filter(c => c.active).length, 2)

    // 停用后 execute 必须失败（效果归属撤销）
    await session.send({ id: 10, method: 'deactivate', params: { pluginId: 'com.example.echo' } })
    const afterDeactivate = await session.send({
      id: 11,
      method: 'execute',
      params: { pluginId: 'com.example.echo', commandId: 'com.example.echo.ping' },
    })
    assert.equal(afterDeactivate.error.code, 'NOT_ACTIVE')

    // 卸载 + purge：grants 撤销、storage 文件删除
    const uninstalled = await session.send({
      id: 12,
      method: 'uninstall',
      params: { pluginId: 'com.example.echo', purge: true },
    })
    assert.deepEqual(uninstalled.result, { uninstalled: true, purged: true, cleanupError: null })
    const reAdmitted = await session.send({ id: 13, method: 'admit', params: { manifestJson: echoManifest } })
    assert.equal(reAdmitted.result.decision, 'waiting_authorization', 'grants revoked by uninstall')

    // effect ledger 只含元数据，不含 payload/消息正文
    const ledgerText = fs.readFileSync(ledgerPath, 'utf8').trim()
    assert.ok(ledgerText.length > 0, 'ledger should have entries')
    assert.equal(ledgerText.includes('secret-note'), false, 'ledger must not contain payload text')
    assert.ok(ledgerText.includes('"kind":"activation"'), 'ledger should record activation')
    assert.ok(ledgerText.includes('"outcome":"success"'), 'ledger should record execution outcome')
  } finally {
    session.child.kill()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('handler error and unknown command are reported without killing the host', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wui-host-err-'))
  const session = startChild({
    DSH_WUI_PLUGIN_HOST_STORAGE_ROOT: root,
  })
  try {
    await session.send({ id: 1, method: 'hello', params: { token: 'test-token' } })
    await session.send({
      id: 2,
      method: 'grants.set',
      params: { pluginId: 'com.example.echo', permissions: ['commands.invoke', 'storage.local.read', 'storage.local.write'] },
    })
    await session.send({ id: 3, method: 'admit', params: { manifestJson: echoManifest } })
    await session.send({
      id: 4,
      method: 'activate',
      params: { pluginId: 'com.example.echo', pluginRoot: echoPluginRoot },
    })

    const unknown = await session.send({
      id: 5,
      method: 'execute',
      params: { pluginId: 'com.example.echo', commandId: 'nope' },
    })
    assert.equal(unknown.ok, false)
    assert.equal(unknown.error.code, 'COMMAND_NOT_FOUND')

    // 主机仍存活
    const ping = await session.send({ id: 6, method: 'commands.list' })
    assert.equal(ping.ok, true)
  } finally {
    session.child.kill()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('in-process host: storage gating follows per-plugin grants', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wui-host-inproc-'))
  const host = createHost({ token: 't', storageRoot: root })
  await host.handleRequest({ id: 0, method: 'hello', params: { token: 't' } })

  const deniedGet = await host.handleRequest({ id: 1, method: 'storage.get', params: { pluginId: 'p', key: 'k' } })
  assert.equal(deniedGet.ok, false)
  assert.equal(deniedGet.error.code, 'PERMISSION_NOT_GRANTED')

  await host.handleRequest({ id: 2, method: 'grants.set', params: { pluginId: 'p', permissions: ['storage.local.read', 'storage.local.write'] } })
  const set = await host.handleRequest({ id: 3, method: 'storage.set', params: { pluginId: 'p', key: 'k', value: [1, 2] } })
  assert.equal(set.ok, true)
  const get = await host.handleRequest({ id: 4, method: 'storage.get', params: { pluginId: 'p', key: 'k' } })
  assert.deepEqual(get.result.value, [1, 2])
  fs.rmSync(root, { recursive: true, force: true })
})
