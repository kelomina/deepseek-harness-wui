// WUI admission profile v0.1 — baseline: community-consensus v0.15 (dsh-std).
// Pinned @dsh-std/*@0.1.0-rc1; protocol coordinates are the compatibility axis,
// npm versions are independent (see dsh-std docs/architecture.md).
// Experimental only: this profile makes no stability claims.

export const PROFILE = {
  profileVersion: 'wui-admission/0.1',
  std: {
    repository: 'https://github.com/Yan-Zero/dsh-std',
    manifestVersion: '0.15',
    pinnedRevision: '614dfa1ac168db79fcf4577cf0ebb34e2e3b944b',
  },
  hostId: 'deepseek-harness-wui',
  facetApiVersions: ['v1alpha1'],
}

// Protocol families known to community v0.15 (from dsh-ecosystem-spec
// registry/registry-0.15.json imports/extensions). Used to distinguish
// "unknown protocol version" from "unsupported/unavailable" per suite semantics:
// unknown group+kind -> rejected; known group+kind with unregistered apiVersion -> unknown.
export const KNOWN_FAMILIES = [
  { apiVersion: 'commands.dsh/v1alpha1', kind: 'Command', event: false },
  { apiVersion: 'storage.dsh/v1alpha1', kind: 'LocalStorage', event: false },
  { apiVersion: 'messages.dsh/v1alpha1', kind: 'MessageObserver', event: true },
  { apiVersion: 'presentation.dsh/v1alpha1', kind: 'OpenExternal', event: false },
  { apiVersion: 'presentation.dsh/v1alpha1', kind: 'UserInteraction', event: false },
  { apiVersion: 'presentation.dsh/v1alpha1', kind: 'ExternalRedirect', event: false },
  { apiVersion: 'workspace.dsh/v1alpha1', kind: 'WorkspaceProvider', event: false },
]

// Permissions admitted by this profile. Deny-by-default: grants must be
// explicitly provided by the host operator (see TUI-TRUST-001 rationale).
export const KNOWN_PERMISSIONS = new Set([
  'commands.invoke',
  'storage.local.read',
  'storage.local.write',
])

export function familyKey(reference) {
  const slash = reference.apiVersion.indexOf('/')
  return `${slash < 0 ? reference.apiVersion : reference.apiVersion.slice(0, slash)}#${reference.kind}`
}
