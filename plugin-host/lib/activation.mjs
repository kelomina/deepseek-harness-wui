import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import * as commandPkg from '@dsh-std/command'

// wui activation driver（wui-admission/0.1 私有；规范允许宿主自定义 driver）。
//
// 插件契约（示例见 examples/echo-plugin/）：
//   - manifest.facets.host.entry 指向包根相对 ESM 文件（.js/.mjs）
//   - 模块导出 activate(ctx)（可 async），可选导出 deactivate()
//   - ctx.registerCommand({ id, title, description?, handler })
//     handler 对齐 @dsh-std/command CommandHandler：execute({rawInput},{signal}) => {kind:'success'|'error', text?}
//   - ctx.storage 为 grant 门禁的 namespaced LocalStorage
//
// effect ledger（对标 dsh-TUI C-060 的最小实现）：append-only JSONL，
// 只记生命周期/执行元数据，禁止 payload / secret / 消息正文。

export const ACTIVATE_TIMEOUT_MS = 5_000
export const EXECUTE_TIMEOUT_MS = 10_000

export class ActivationError extends Error {
  constructor(code, message) {
    super(message ?? code)
    this.code = code
  }
}

export function validateEntryPath(entry) {
  if (typeof entry !== 'string' || entry.length === 0) {
    throw new ActivationError('INVALID_ENTRY', 'facets.host.entry is required')
  }
  if (path.isAbsolute(entry) || entry.split(/[\\/]/).includes('..')) {
    throw new ActivationError('INVALID_ENTRY', `entry must be a relative path inside the plugin root: ${entry}`)
  }
  if (!/\.(mjs|js)$/.test(entry)) {
    throw new ActivationError('INVALID_ENTRY', `entry must be a .js/.mjs ESM file: ${entry}`)
  }
  return entry
}

export class Ledger {
  constructor(filePath) {
    this.filePath = filePath ?? null
  }

  append(record) {
    if (!this.filePath) return
    try {
      fs.appendFileSync(this.filePath, `${JSON.stringify({
        ts: new Date().toISOString(),
        ...record,
      })}\n`)
    } catch {
      // ledger 写失败不阻断业务（与 fail-closed 语义相反方向：观测降级），
      // 但保持静默避免把敏感上下文带进错误通道。
    }
  }
}

export class ActivationManager {
  /**
   * @param opts.storageFor (pluginId) => storage handle（grant 门禁）
   * @param opts.ledger Ledger 实例
   */
  constructor({ storageFor, ledger } = {}) {
    this.storageFor = storageFor
    this.ledger = ledger ?? new Ledger(null)
    // pluginId -> { manifest, pluginRoot, instanceId, generationId, commands: Map<id,{def,handler}>, module }
    this.active = new Map()
  }

  /** 把宿主侧 storage（需要显式 pluginId）绑定为插件私有无参句柄。 */
  static bindStorage(raw, pluginId) {
    if (!raw) return undefined
    return {
      get: input => raw.get(pluginId, input),
      set: input => raw.set(pluginId, input),
      delete: input => raw.delete(pluginId, input),
    }
  }

  isActive(pluginId) {
    return this.active.has(pluginId)
  }

  listCommands() {
    const out = []
    for (const [pluginId, state] of this.active) {
      for (const [id, reg] of state.commands) {
        out.push({
          pluginId,
          id,
          title: reg.def.title ?? id,
          description: reg.def.description ?? null,
        })
      }
    }
    return out
  }

  async activate(pluginId, { manifestJson, parsedManifest, pluginRoot, generationId }) {
    if (this.active.has(pluginId)) {
      throw new ActivationError('ALREADY_ACTIVE', `plugin already active: ${pluginId}`)
    }
    const entry = validateEntryPath(parsedManifest?.facets?.host?.entry)
    const entryAbs = path.join(pluginRoot, entry)
    if (!fs.existsSync(entryAbs)) {
      throw new ActivationError('ENTRY_NOT_FOUND', `entry not found: ${entryAbs}`)
    }

    const instanceId = `${pluginId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    const commands = new Map()
    const storageHandle = ActivationManager.bindStorage(this.storageFor ? this.storageFor(pluginId) : undefined, pluginId)

    const ctx = {
      pluginId,
      activationInstance: instanceId,
      runtimeGeneration: generationId ?? 'gen-local',
      registerCommand: def => {
        if (typeof def?.id !== 'string' || def.id.length === 0) {
          throw new ActivationError('INVALID_COMMAND_DEF', 'command def.id is required')
        }
        commandPkg.assertCommandHandler(def.handler)
        if (commands.has(def.id)) {
          throw new ActivationError('DUPLICATE_COMMAND', `duplicate registered command id: ${def.id}`)
        }
        commands.set(def.id, { def, handler: def.handler })
      },
      get storage() {
        return storageHandle
      },
    }

    let mod
    try {
      mod = await import(pathToFileURL(entryAbs).href)
    } catch (error) {
      this.ledger.append({ kind: 'activation_error', pluginId, activationInstance: instanceId, errorCode: 'ENTRY_LOAD_FAILED' })
      throw new ActivationError('ENTRY_LOAD_FAILED', `failed to import ${entry}: ${error?.message ?? error}`)
    }
    if (typeof mod.activate !== 'function') {
      throw new ActivationError('ACTIVATE_MISSING', 'plugin module must export activate(ctx)')
    }

    const deadline = Date.now() + ACTIVATE_TIMEOUT_MS
    await Promise.race([
      Promise.resolve(mod.activate(ctx)).catch(error => {
        this.ledger.append({ kind: 'activation_error', pluginId, activationInstance: instanceId, errorCode: 'ACTIVATE_FAILED' })
        throw new ActivationError('ACTIVATE_FAILED', `activate() threw: ${error?.message ?? error}`)
      }),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new ActivationError('ACTIVATE_TIMEOUT', `activate() exceeded ${ACTIVATE_TIMEOUT_MS}ms`)),
          Math.max(0, deadline - Date.now()),
        ),
      ),
    ])

    const state = {
      manifest: parsedManifest,
      manifestJson,
      pluginRoot,
      instanceId,
      generationId: generationId ?? 'gen-local',
      commands,
      module: mod,
    }
    this.active.set(pluginId, state)
    this.ledger.append({
      kind: 'activation',
      pluginId,
      activationInstance: instanceId,
      generationId: state.generationId,
      commands: [...commands.keys()],
    })
    return { activationInstance: instanceId, commands: this.listCommands().filter(c => c.pluginId === pluginId) }
  }

  async execute(pluginId, commandId, rawInput) {
    const state = this.active.get(pluginId)
    if (!state) throw new ActivationError('NOT_ACTIVE', `plugin not active: ${pluginId}`)
    const reg = state.commands.get(commandId)
    if (!reg) throw new ActivationError('COMMAND_NOT_FOUND', `command not found: ${commandId}`)

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), EXECUTE_TIMEOUT_MS)
    const started = Date.now()
    try {
      const result = await reg.handler.execute(
        { rawInput: rawInput ?? '' },
        { signal: controller.signal },
      )
      const outcome =
        result && typeof result === 'object' && 'kind' in result
          ? result
          : { kind: 'success', text: result === undefined ? '' : String(result) }
      this.ledger.append({
        kind: 'command_execution',
        pluginId,
        activationInstance: state.instanceId,
        commandId,
        outcome: outcome.kind,
        durationMs: Date.now() - started,
      })
      return outcome
    } catch (error) {
      this.ledger.append({
        kind: 'command_execution',
        pluginId,
        activationInstance: state.instanceId,
        commandId,
        outcome: 'error',
        errorCode: error?.code === 'ABORT_ERR' ? 'TIMEOUT' : 'HANDLER_ERROR',
        durationMs: Date.now() - started,
      })
      return { kind: 'error', text: String(error?.message ?? error) }
    } finally {
      clearTimeout(timer)
    }
  }

  async deactivate(pluginId, { purgeStorage = false, deleteStorage } = {}) {
    const state = this.active.get(pluginId)
    if (!state) throw new ActivationError('NOT_ACTIVE', `plugin not active: ${pluginId}`)
    let cleanupError = null
    if (typeof state.module.deactivate === 'function') {
      try {
        await state.module.deactivate()
      } catch (error) {
        cleanupError = String(error?.message ?? error)
      }
    }
    this.active.delete(pluginId)
    this.ledger.append({
      kind: 'deactivation',
      pluginId,
      activationInstance: state.instanceId,
      purgeStorage,
      cleanupError,
    })
    if (purgeStorage && typeof deleteStorage === 'function') {
      deleteStorage(pluginId)
    }
    return { deactivated: true, cleanupError }
  }
}
