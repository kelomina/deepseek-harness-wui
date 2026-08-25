import { ProtocolCatalog } from '@dsh-std/core'
import { parseManifest, projectManifest } from '@dsh-std/manifest'
import * as commandPkg from '@dsh-std/command'
import * as storagePkg from '@dsh-std/storage'
import { KNOWN_FAMILIES, KNOWN_PERMISSIONS, PROFILE, familyKey } from './profile.mjs'

export const HOST_SUPPORTS = [
  { apiVersion: 'commands.dsh/v1alpha1', kind: 'Command' },
  { apiVersion: 'storage.dsh/v1alpha1', kind: 'LocalStorage' },
]

export function createCatalog() {
  const catalog = new ProtocolCatalog({
    name: `${PROFILE.hostId}-admission`,
    version: PROFILE.profileVersion,
  })
  commandPkg.register(catalog)
  storagePkg.register(catalog)
  return catalog
}

// registry-0.15 的订阅名（byName 解析）；仅 event 类坐标可订阅
const SUBSCRIPTION_NAMES = {
  commands: { apiVersion: 'commands.dsh/v1alpha1', kind: 'Command', event: false },
  'storage.local': { apiVersion: 'storage.dsh/v1alpha1', kind: 'LocalStorage', event: false },
  'messages.observe': { apiVersion: 'messages.dsh/v1alpha1', kind: 'MessageObserver', event: true },
}

function contractKey(entry) {
  return `${entry.apiVersion}\u0000${entry.kind}`
}

function classify(reference) {
  // -> { state: 'supported' | 'family_known_unregistered' | 'unsupported_version' | 'unknown', event? }
  const family = familyKey(reference)
  const known = KNOWN_FAMILIES.find(f => familyKey(f) === family)
  if (!known) return { state: 'unknown' }
  if (known.event !== undefined && reference.apiVersion === known.apiVersion) {
    return { state: 'exact_family', event: known.event }
  }
  return { state: 'unsupported_version', event: known.event }
}

// Evaluate one community v0.15 manifest against this host.
// grants: iterable of granted permission names (deny-by-default).
// Returns the wui admission projection:
//   compatible | compatible_degraded | waiting_authorization | rejected | unknown
export function evaluate(manifestJson, { grants = [], source = 'inline' } = {}) {
  const grantSet = new Set(grants)
  let manifest
  try {
    manifest = parseManifest(manifestJson)
  } catch (error) {
    return {
      decision: 'rejected',
      reasonCode: 'INVALID_MANIFEST',
      errors: [String(error?.message ?? error)],
      commands: [],
    }
  }

  const errors = []
  const requires_ = manifest.requires?.contracts ?? []

  // Community v0.15 structural rules not enforced by parse alone.
  if (Array.isArray(manifest.requires?.services) && manifest.requires.services.length > 0) {
    errors.push('requires.services must be an empty array in community v0.15')
  }
  const seen = new Set()
  for (const entry of requires_) {
    const key = contractKey(entry)
    if (seen.has(key)) errors.push(`duplicate contract coordinate: ${key.replace('\u0000', '#')}`)
    seen.add(key)
  }
  const commandIds = new Set()
  for (const cmd of manifest.contributes?.commands ?? []) {
    if (commandIds.has(cmd.id)) errors.push(`duplicate command id "${cmd.id}"`)
    commandIds.add(cmd.id)
  }
  for (const sub of manifest.subscriptions ?? []) {
    let ref = null
    if (typeof sub === 'string') {
      ref = SUBSCRIPTION_NAMES[sub] ?? null
    } else {
      const cls = classify(sub)
      ref = { apiVersion: sub.apiVersion, kind: sub.kind, event: cls.event === true }
    }
    const label = typeof sub === 'string' ? sub : `${sub.apiVersion}#${sub.kind}`
    if (!ref || !ref.event) {
      errors.push(`subscription must reference an event: ${label}`)
    }
  }
  for (const entry of requires_) {
    if (entry.optional && !entry.fallback) {
      errors.push(`optional contract requires a fallback: ${entry.apiVersion}#${entry.kind}`)
    }
  }
  for (const perm of manifest.permissions ?? []) {
    if (!KNOWN_PERMISSIONS.has(perm.name)) {
      errors.push(`unknown permission: ${perm.name}`)
    }
  }
  if (errors.length > 0) {
    return { decision: 'rejected', reasonCode: 'INVALID_MANIFEST', errors, commands: [] }
  }

  const facetApi = manifest.facets?.host?.apiVersion
  if (!PROFILE.facetApiVersions.includes(facetApi)) {
    return {
      decision: 'rejected',
      reasonCode: 'FACET_API_VERSION_UNAVAILABLE',
      facetApiVersion: facetApi,
      commands: [],
    }
  }

  // Protocol negotiation via dsh-std core (fail-closed on missing definitions).
  const catalog = createCatalog()
  const unknownContracts = []
  const missingRequired = []
  const missingOptional = []
  const unregisteredFamilies = []
  for (const entry of requires_) {
    const cls = classify(entry)
    if (cls.state === 'unknown') {
      // Unknown group+kind -> INVALID_MANIFEST per community v0.15 semantics.
      unregisteredFamilies.push(`${entry.apiVersion}#${entry.kind}`)
      continue
    }
    if (cls.state === 'unsupported_version') {
      // Known group+kind with an unregistered apiVersion -> unknown.
      unknownContracts.push(`${entry.apiVersion}#${entry.kind}`)
      continue
    }
    const supported = HOST_SUPPORTS.some(s => s.apiVersion === entry.apiVersion && s.kind === entry.kind)
    const understood =
      catalog.understands({ apiVersion: entry.apiVersion, kind: entry.kind }) && supported
    if (!understood) {
      if (entry.optional) missingOptional.push(`${entry.apiVersion}#${entry.kind}`)
      else missingRequired.push(`${entry.apiVersion}#${entry.kind}`)
    }
  }
  if (unregisteredFamilies.length > 0) {
    return {
      decision: 'rejected',
      reasonCode: 'INVALID_MANIFEST',
      errors: unregisteredFamilies.map(ref => `protocol definition is not admitted by this profile: ${ref}`),
      commands: [],
    }
  }
  if (unknownContracts.length > 0) {
    return {
      decision: 'unknown',
      reasonCode: 'UNKNOWN_PROTOCOL_VERSION',
      unknownContracts,
      commands: [],
    }
  }

  const denied = (manifest.permissions ?? [])
    .map(p => p.name)
    .filter(name => !grantSet.has(name))
  if (missingRequired.length > 0) {
    return {
      decision: 'rejected',
      reasonCode: 'REQUIRED_PROTOCOL_UNAVAILABLE',
      missingRequired,
      commands: [],
    }
  }
  const commands = (manifest.contributes?.commands ?? []).map(c => ({
    pluginId: manifest.id,
    id: c.id,
    title: c.title,
    description: c.description ?? null,
  }))
  if (denied.length > 0) {
    return {
      decision: 'waiting_authorization',
      reasonCode: 'PERMISSION_NOT_GRANTED',
      deniedPermissions: denied,
      commands,
      manifest: { id: manifest.id, name: manifest.name, version: manifest.version },
    }
  }
  if (missingOptional.length > 0) {
    return {
      decision: 'compatible_degraded',
      missingOptional,
      commands,
      manifest: { id: manifest.id, name: manifest.name, version: manifest.version },
    }
  }
  return {
    decision: 'compatible',
    missingOptional: [],
    commands,
    manifest: { id: manifest.id, name: manifest.name, version: manifest.version },
  }
}

// Project a parsed manifest into the host composition model (exposed for tests).
export function project(manifestJson) {
  return projectManifest(parseManifest(manifestJson))
}
