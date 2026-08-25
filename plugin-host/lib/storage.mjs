import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

// Namespaced JSON file storage with grant gate (deny-by-default).
// Mirrors the @dsh-std/storage LocalStorage semantics and error codes.
// Quota follows the dsh-TUI precedent: 256 keys / 256 KiB per namespace.

export const QUOTA_KEYS = 256
export const QUOTA_BYTES = 256 * 1024

export function namespaceFor(pluginId) {
  const sanitized = String(pluginId).replace(/[^A-Za-z0-9._-]/g, '_')
  const hash = crypto.createHash('sha256').update(String(pluginId)).digest('hex').slice(0, 8)
  return `${sanitized}-${hash}`
}

function fail(code) {
  const error = new Error(code)
  error.code = code
  throw error
}

export function createStorage({ root, getGrants } = {}) {
  // getGrants(pluginId) -> Iterable<string>：按插件粒度的已授予权限（deny-by-default）。
  const grantsFor = pluginId => new Set(typeof getGrants === 'function' ? getGrants(pluginId) : [])
  fs.mkdirSync(root, { recursive: true })
  const fileFor = pluginId => path.join(root, `${namespaceFor(pluginId)}.json`)

  function readNs(pluginId) {
    try {
      return JSON.parse(fs.readFileSync(fileFor(pluginId), 'utf8'))
    } catch (error) {
      if (error.code === 'ENOENT') return {}
      throw fail('STORAGE_UNAVAILABLE')
    }
  }

  function writeNs(pluginId, data) {
    const target = fileFor(pluginId)
    const tmp = `${target}.tmp-${process.pid}-${Date.now()}`
    try {
      fs.writeFileSync(tmp, JSON.stringify(data))
      fs.renameSync(tmp, target)
    } catch (error) {
      try {
        fs.rmSync(tmp, { force: true })
      } catch {
        /* best effort */
      }
      throw fail('STORAGE_UNAVAILABLE')
    }
  }

  function checkRead(pluginId) {
    if (!grantsFor(pluginId).has('storage.local.read')) fail('PERMISSION_NOT_GRANTED')
  }
  function checkWrite(pluginId) {
    if (!grantsFor(pluginId).has('storage.local.write')) fail('PERMISSION_NOT_GRANTED')
  }

  return {
    get(pluginId, input) {
      checkRead(pluginId)
      if (typeof input?.key !== 'string' || input.key.length === 0 || input.key.length > 128) {
        fail('INVALID_KEY')
      }
      const ns = readNs(pluginId)
      return { value: Object.hasOwn(ns, input.key) ? ns[input.key] : null }
    },
    set(pluginId, input) {
      checkWrite(pluginId)
      if (typeof input?.key !== 'string' || input.key.length === 0 || input.key.length > 128) {
        fail('INVALID_KEY')
      }
      let value
      try {
        value = JSON.parse(JSON.stringify(input?.value ?? null))
        if (value !== null && typeof value !== 'object' && !Array.isArray(value) &&
            !['string', 'number', 'boolean'].includes(typeof value)) {
          fail('INVALID_VALUE')
        }
      } catch (error) {
        if (error.code === 'INVALID_VALUE') throw error
        fail('INVALID_VALUE')
      }
      const encoded = JSON.stringify(value)
      if (Buffer.byteLength(encoded, 'utf8') > QUOTA_BYTES) fail('QUOTA_EXCEEDED')
      const ns = readNs(pluginId)
      if (!Object.hasOwn(ns, input.key) && Object.keys(ns).length >= QUOTA_KEYS) {
        fail('QUOTA_EXCEEDED')
      }
      ns[input.key] = value
      writeNs(pluginId, ns)
      return { stored: true }
    },
    delete(pluginId, input) {
      checkWrite(pluginId)
      if (typeof input?.key !== 'string') fail('INVALID_KEY')
      const ns = readNs(pluginId)
      const existed = Object.hasOwn(ns, input.key)
      if (existed) {
        delete ns[input.key]
        writeNs(pluginId, ns)
      }
      return { deleted: existed }
    },
  }
}
