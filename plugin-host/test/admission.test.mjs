import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { evaluate, HOST_SUPPORTS } from '../lib/admission.mjs'
import { buildHostDescriptor } from '../lib/host-descriptor.mjs'
import { createStorage, namespaceFor, QUOTA_KEYS } from '../lib/storage.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const fixture = name => fs.readFileSync(path.join(here, 'fixtures', name), 'utf8')

test('valid-plugin fixture: waiting by default, compatible_degraded once granted', () => {
  const outcome = evaluate(fixture('valid-plugin.json'))
  // deny-by-default: commands.invoke 未授予时先进入 waiting（优先于 degraded 投影）
  assert.equal(outcome.decision, 'waiting_authorization')
  assert.ok(outcome.deniedPermissions.includes('commands.invoke'))
  const granted = evaluate(fixture('valid-plugin.json'), { grants: ['commands.invoke'] })
  assert.equal(granted.decision, 'compatible_degraded')
  assert.deepEqual(granted.missingOptional, ['messages.dsh/v1alpha1#MessageObserver'])
  assert.equal(granted.commands.length, 1)
  assert.equal(granted.commands[0].id, 'com.example.echo.ping')
})

const negativeExpectations = [
  ['invalid-plugin-unknown-service.json', /requires\.services/],
  ['invalid-plugin-duplicate-command.json', /duplicate id/i],
  ['invalid-plugin-unknown-coordinate.json', /not admitted by this profile/],
  ['invalid-plugin-unknown-kind.json', /not admitted by this profile/],
  ['invalid-plugin-duplicate-coordinate.json', /duplicate contract/],
  ['invalid-plugin-client-facet.json', /INVALID_MANIFEST|facets/],
  ['invalid-plugin-worker-facet.json', /INVALID_MANIFEST|facets/],
  ['invalid-plugin-provides.json', /INVALID_MANIFEST|provides/],
]

for (const [name, pattern] of negativeExpectations) {
  test(`${name} is rejected`, () => {
    const outcome = evaluate(fixture(name))
    assert.equal(outcome.decision, 'rejected', `decision=${outcome.decision} detail=${JSON.stringify(outcome)}`)
    const text = JSON.stringify(outcome)
    // 拒绝原因应与上游 conformance 的语义族一致（宽松匹配，避免措辞耦合）
    assert.ok(
      pattern.test(text),
      `expected ${pattern} in ${text}`,
    )
  })
}

test('facet apiVersion mismatch is rejected with FACET_API_VERSION_UNAVAILABLE', () => {
  const outcome = evaluate(fixture('invalid-plugin-facet-version.json'))
  assert.equal(outcome.decision, 'rejected')
  assert.equal(outcome.reasonCode, 'FACET_API_VERSION_UNAVAILABLE')
})

test('optional without fallback is rejected per profile policy', () => {
  const outcome = evaluate(fixture('invalid-plugin-optional-no-fallback.json'))
  assert.equal(outcome.decision, 'rejected')
  assert.match(JSON.stringify(outcome), /optional contract requires a fallback/)
})

test('known family with unregistered apiVersion yields unknown (not rejected)', () => {
  const manifest = JSON.parse(fixture('valid-plugin.json'))
  manifest.requires.contracts = [{ apiVersion: 'storage.dsh/v2beta1', kind: 'LocalStorage' }]
  manifest.subscriptions = []
  const outcome = evaluate(JSON.stringify(manifest))
  assert.equal(outcome.decision, 'unknown')
  assert.deepEqual(outcome.unknownContracts, ['storage.dsh/v2beta1#LocalStorage'])
})

test('denied permissions yield waiting_authorization with deny-by-default grants', () => {
  const manifest = JSON.parse(fixture('valid-plugin.json'))
  manifest.requires.contracts = [{ apiVersion: 'commands.dsh/v1alpha1', kind: 'Command' }]
  manifest.requires.contracts.push({ apiVersion: 'storage.dsh/v1alpha1', kind: 'LocalStorage' })
  const deniedOutcome = evaluate(JSON.stringify(manifest), { grants: [] })
  assert.equal(deniedOutcome.decision, 'waiting_authorization')
  assert.ok(deniedOutcome.deniedPermissions.includes('commands.invoke'))
  const grantedOutcome = evaluate(JSON.stringify(manifest), { grants: ['commands.invoke'] })
  assert.equal(grantedOutcome.decision, 'compatible')
})

test('required unsupported protocol is rejected REQUIRED_PROTOCOL_UNAVAILABLE', () => {
  const manifest = JSON.parse(fixture('valid-plugin.json'))
  manifest.requires.contracts = [
    { apiVersion: 'messages.dsh/v1alpha1', kind: 'MessageObserver' },
  ]
  const outcome = evaluate(JSON.stringify(manifest))
  assert.equal(outcome.decision, 'rejected')
  assert.equal(outcome.reasonCode, 'REQUIRED_PROTOCOL_UNAVAILABLE')
})

test('malformed manifest json is rejected INVALID_MANIFEST', () => {
  const outcome = evaluate('{ not json')
  assert.equal(outcome.decision, 'rejected')
  assert.equal(outcome.reasonCode, 'INVALID_MANIFEST')
})

test('host descriptor advertises only mounted contracts and honest trust level', () => {
  const descriptor = buildHostDescriptor({ hostVersion: '9.9.9-test', generationId: 'gen-1' })
  assert.equal(descriptor.hostId, 'deepseek-harness-wui')
  assert.equal(descriptor.trustLevel, 'trusted-in-process')
  assert.equal(descriptor.runtime.generationId, 'gen-1')
  assert.equal(descriptor.runtime.headless, false)
  assert.equal(descriptor.facetApiVersions.join(','), 'v1alpha1')
  assert.deepEqual(
    descriptor.contracts.map(c => `${c.apiVersion}#${c.kind}`).sort(),
    [...HOST_SUPPORTS.map(s => `${s.apiVersion}#${s.kind}`)].sort(),
  )
  for (const contract of descriptor.contracts) {
    assert.equal(contract.definition.source, 'dsh-std')
    assert.match(contract.definition.package, /^@dsh-std\//)
  }
})
