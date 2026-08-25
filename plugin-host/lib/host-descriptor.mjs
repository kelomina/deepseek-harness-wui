import os from 'node:os'
import crypto from 'node:crypto'
import { PROFILE } from './profile.mjs'
import { HOST_SUPPORTS } from './admission.mjs'

// Honest Host Descriptor (TUI-HOST-001 analogue): only contracts that are
// actually mounted in this process are advertised. trustLevel is disclosed
// truthfully: plugins run trusted-in-process inside the sidecar Node runtime;
// this is NOT an OS/process/realm security boundary.
export function buildHostDescriptor({ hostVersion, generationId } = {}) {
  const contracts = HOST_SUPPORTS.map(support => {
    const pkg = support.kind === 'Command' ? '@dsh-std/command' : '@dsh-std/storage'
    const permissions =
      support.kind === 'Command'
        ? ['commands.invoke']
        : ['storage.local.read', 'storage.local.write']
    return {
      apiVersion: support.apiVersion,
      kind: support.kind,
      definition: { source: 'dsh-std', package: pkg },
      permissions,
    }
  })
  return {
    $schema: 'urn:dsh-wui:host-descriptor:0.1',
    hostId: PROFILE.hostId,
    hostVersion: hostVersion ?? '0.0.0',
    facetApiVersions: [...PROFILE.facetApiVersions],
    contracts,
    runtime: {
      location: 'local',
      generationId:
        generationId ??
        `${process.pid}-${crypto.randomBytes(8).toString('hex')}`,
      headless: false,
    },
    trustLevel: 'trusted-in-process',
    platform: {
      os: os.platform(),
      arch: os.arch(),
      node: process.version,
    },
  }
}
