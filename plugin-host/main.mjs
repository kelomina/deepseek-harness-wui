import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { parseManifest } from '@dsh-std/manifest'
import { evaluate } from './lib/admission.mjs'
import { buildHostDescriptor } from './lib/host-descriptor.mjs'
import { createStorage, namespaceFor } from './lib/storage.mjs'
import { ActivationManager, Ledger } from './lib/activation.mjs'

const PROTOCOL_REVISION = 2

// Factory kept separate from the stdio loop so tests can drive requests
// without spawning a process.
export function createHost({
  token,
  storageRoot,
  ledgerPath,
  hostVersion = '0.1.0',
  generationId,
} = {}) {
  const expectedToken = token ?? process.env.DSH_WUI_PLUGIN_HOST_TOKEN ?? ''
  const root =
    storageRoot ??
    process.env.DSH_WUI_PLUGIN_HOST_STORAGE_ROOT ??
    path.join(os.tmpdir(), 'dsh-wui-plugin-storage')
  // pluginId -> Set<string>；deny-by-default，由宿主操作者经 grants.set 显式授予
  const grants = new Map()
  // pluginId -> { manifest, manifestJson }（admission 已通过的准入集合）
  const admitted = new Map()
  let descriptor = null
  let ready = false

  const storage = createStorage({ root, getGrants: id => [...(grants.get(id) ?? [])] })
  const purgeStorage = pluginId => {
    const file = path.join(root, `${namespaceFor(pluginId)}.json`)
    try {
      fs.rmSync(file, { force: true })
    } catch {
      /* best effort */
    }
  }
  const ledger = new Ledger(
    ledgerPath ?? process.env.DSH_WUI_PLUGIN_HOST_LEDGER ?? null,
  )
  const activation = new ActivationManager({
    storageFor: () => storage,
    ledger,
  })

  const grantsFor = pluginId => [...(grants.get(pluginId) ?? [])]

  function requireAdmitted(pluginId) {
    const entry = admitted.get(pluginId)
    if (!entry) fail('PLUGIN_NOT_ADMITTED', `plugin is not admitted: ${pluginId}`)
    return entry
  }

  async function reAdmittedDecision(entry) {
    return evaluate(entry.manifestJson, { grants: grantsFor(entry.manifest.id) })
  }

  function fail(code, message) {
    const error = new Error(message ?? code)
    error.code = code
    throw error
  }

  return {
    async handleRequest(request) {
      const { id, method, params = {} } = request ?? {}
      const reply = (ok, result) => ({ id, ok, ...(ok ? { result } : { error: result }) })
      try {
        switch (method) {
          case 'hello': {
            if (!expectedToken || params?.token !== expectedToken) {
              return reply(false, { code: 'HANDSHAKE_FAILED' })
            }
            ready = true
            descriptor = buildHostDescriptor({ hostVersion, generationId })
            return reply(true, {
              ready: true,
              protocolRevision: PROTOCOL_REVISION,
              profileVersion: 'wui-admission/0.1',
              descriptor,
            })
          }
          case 'descriptor':
            assertReady()
            return reply(true, descriptor)
          case 'grants.set': {
            assertReady()
            const pluginId = requirePluginId(params)
            const perms = Array.isArray(params.permissions) ? params.permissions.filter(p => typeof p === 'string') : []
            grants.set(pluginId, new Set(perms))
            return reply(true, { pluginId, permissions: grantsFor(pluginId) })
          }
          case 'admit': {
            assertReady()
            const manifestJson = requireManifestJson(params)
            const outcome = evaluate(manifestJson, { grants: grantsFor(outcomeId(manifestJson)) })
            if (outcome.decision === 'compatible' || outcome.decision === 'compatible_degraded') {
              // 存完整解析结果（激活 driver 需要 facets.host.entry 等），而非投影
              admitted.set(outcome.manifest.id, {
                manifest: parseManifest(manifestJson),
                manifestJson,
                lastDecision: outcome.decision,
              })
            } else {
              admitted.delete(outcome.manifest?.id ?? '')
            }
            return reply(true, outcome)
          }
          case 'activate': {
            assertReady()
            const pluginId = requirePluginId(params)
            const entry = requireAdmitted(pluginId)
            const decision = await reAdmittedDecision(entry)
            if (decision.decision !== 'compatible' && decision.decision !== 'compatible_degraded') {
              fail('NOT_COMPATIBLE', `current decision is ${decision.decision}; activation refused`)
            }
            const pluginRoot = requirePluginRoot(params)
            const result = await activation.activate(pluginId, {
              manifestJson: entry.manifestJson,
              parsedManifest: entry.manifest,
              pluginRoot,
              generationId: descriptor?.runtime?.generationId,
            })
            return reply(true, { pluginId, ...result })
          }
          case 'execute': {
            assertReady()
            const pluginId = requirePluginId(params)
            if (typeof params.commandId !== 'string') fail('INVALID_KEY', 'params.commandId is required')
            const result = await activation.execute(pluginId, params.commandId, params.rawInput ?? '')
            return reply(true, result)
          }
          case 'deactivate': {
            assertReady()
            const pluginId = requirePluginId(params)
            const result = await activation.deactivate(pluginId)
            return reply(true, result)
          }
          case 'uninstall': {
            assertReady()
            const pluginId = requirePluginId(params)
            let cleanupError = null
            if (activation.isActive(pluginId)) {
              const r = await activation.deactivate(pluginId, {
                purgeStorage: params.purge === true,
                deleteStorage: purgeStorage,
              })
              cleanupError = r.cleanupError
            }
            admitted.delete(pluginId)
            grants.delete(pluginId)
            if (params.purge === true) purgeStorage(pluginId)
            return reply(true, { uninstalled: true, purged: params.purge === true, cleanupError })
          }
          case 'commands.list': {
            assertReady()
            const commands = activation.listCommands().map(c => ({ ...c, active: true }))
            for (const [pluginId, entry] of admitted) {
              if (activation.isActive(pluginId)) continue
              for (const cmd of entry.manifest.contributes?.commands ?? []) {
                commands.push({ pluginId, id: cmd.id, title: cmd.title, description: cmd.description ?? null, active: false })
              }
            }
            return reply(true, { commands })
          }
          case 'storage.get':
            assertReady()
            return reply(true, storage.get(requirePluginId(params), { key: requireKey(params, 'key') }))
          case 'storage.set':
            assertReady()
            return reply(true, storage.set(requirePluginId(params), { key: requireKey(params, 'key'), value: params.value ?? null }))
          case 'storage.delete':
            assertReady()
            return reply(true, storage.delete(requirePluginId(params), { key: requireKey(params, 'key') }))
          case 'shutdown':
            return reply(true, { bye: true })
          default:
            return reply(false, { code: 'UNKNOWN_METHOD', method })
        }
      } catch (error) {
        return reply(false, { code: error?.code ?? 'INTERNAL_ERROR', message: String(error?.message ?? error) })
      }
    },
  }

  function assertReady() {
    if (!ready || !descriptor) fail('NOT_READY', 'host is not ready (hello first)')
  }
}

function outcomeId(manifestJson) {
  // admission.evaluate 内部会完整校验；这里只为提前取 id 做宽松解析，
  // 解析失败交给 evaluate 报 INVALID_MANIFEST。
  try {
    return String(JSON.parse(manifestJson)?.id ?? '')
  } catch {
    return ''
  }
}

function requirePluginId(params) {
  const pluginId = params?.pluginId
  if (typeof pluginId !== 'string' || pluginId.length === 0) {
    fail('INVALID_KEY', 'params.pluginId is required')
  }
  return pluginId
}

function requireKey(params, field) {
  const key = params?.[field]
  if (typeof key !== 'string') fail('INVALID_KEY', `params.${field} is required`)
  return key
}

function requireManifestJson(params) {
  const manifestJson = params?.manifestJson
  if (typeof manifestJson !== 'string' || manifestJson.length === 0) {
    fail('INVALID_KEY', 'params.manifestJson is required')
  }
  return manifestJson
}

function requirePluginRoot(params) {
  const pluginRoot = params?.pluginRoot
  if (typeof pluginRoot !== 'string' || pluginRoot.length === 0) {
    fail('INVALID_KEY', 'params.pluginRoot is required')
  }
  let stat = null
  try {
    stat = fs.statSync(pluginRoot)
  } catch {
    fail('PLUGIN_ROOT_NOT_FOUND', `pluginRoot not found: ${pluginRoot}`)
  }
  if (!stat.isDirectory() || !fs.existsSync(path.join(pluginRoot, 'dsh-plugin.json'))) {
    fail('PLUGIN_ROOT_INVALID', `pluginRoot must contain dsh-plugin.json: ${pluginRoot}`)
  }
  return pluginRoot
}

export async function serve({ input = process.stdin, output = process.stdout } = {}) {
  const host = createHost()
  const rl = readline.createInterface({ input, crlfDelay: Infinity })
  let closed = false
  rl.on('close', () => {
    closed = true
  })
  for await (const line of rl) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    let request
    try {
      request = JSON.parse(trimmed)
    } catch {
      writeLine(output, { id: null, ok: false, error: { code: 'BAD_FRAME' } })
      continue
    }
    const response = await host.handleRequest(request)
    writeLine(output, response)
    if (request?.method === 'shutdown') break
    if (closed) break
  }
}

function writeLine(output, value) {
  output.write(`${JSON.stringify(value)}\n`)
}

// Entry point when run directly: `node main.mjs`.
const isMain = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())
if (isMain || process.env.DSH_WUI_PLUGIN_HOST_CHILD === '1') {
  serve().catch(error => {
    console.error('[plugin-host] fatal:', error)
    process.exit(1)
  })
}
