import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createStorage, namespaceFor, QUOTA_BYTES, QUOTA_KEYS } from '../lib/storage.mjs'

let root

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'wui-storage-'))
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

function nsFile(pluginId) {
  return path.join(root, `${namespaceFor(pluginId)}.json`)
}

test('read/write denied by default (PERMISSION_NOT_GRANTED)', () => {
  const storage = createStorage({ root, getGrants: () => [] })
  assert.throws(() => storage.get('p1', { key: 'k' }), e => e.code === 'PERMISSION_NOT_GRANTED')
  assert.throws(() => storage.set('p1', { key: 'k', value: 1 }), e => e.code === 'PERMISSION_NOT_GRANTED')
  assert.throws(() => storage.delete('p1', { key: 'k' }), e => e.code === 'PERMISSION_NOT_GRANTED')
})

test('grants are per-plugin (no cross-plugin leakage)', () => {
  const storage = createStorage({
    root,
    getGrants: id => (id === 'plugin-a' ? ['storage.local.read', 'storage.local.write'] : []),
  })
  assert.deepEqual(storage.set('plugin-a', { key: 'k', value: 1 }), { stored: true })
  assert.throws(() => storage.set('plugin-b', { key: 'k', value: 1 }), e => e.code === 'PERMISSION_NOT_GRANTED')
  assert.throws(() => storage.get('plugin-b', { key: 'k' }), e => e.code === 'PERMISSION_NOT_GRANTED')
})

test('granted read+write roundtrip persists to namespaced file', () => {
  const storage = createStorage({ root, getGrants: () => ['storage.local.read', 'storage.local.write'] })
  assert.deepEqual(storage.set('com.example.p', { key: 'greeting', value: { text: 'hi' } }), { stored: true })
  assert.deepEqual(storage.get('com.example.p', { key: 'greeting' }), { value: { text: 'hi' } })
  assert.deepEqual(storage.get('com.example.p', { key: 'missing' }), { value: null })
  const onDisk = JSON.parse(fs.readFileSync(nsFile('com.example.p'), 'utf8'))
  assert.deepEqual(onDisk.greeting, { text: 'hi' })

  // write-only grant cannot read
  const writer = createStorage({ root, getGrants: () => ['storage.local.write'] })
  assert.throws(() => writer.get('com.example.p', { key: 'greeting' }), e => e.code === 'PERMISSION_NOT_GRANTED')

  assert.deepEqual(storage.delete('com.example.p', { key: 'greeting' }), { deleted: true })
  assert.deepEqual(storage.delete('com.example.p', { key: 'greeting' }), { deleted: false })
})

test('namespaces are isolated per plugin id', () => {
  const storage = createStorage({ root, getGrants: () => ['storage.local.read', 'storage.local.write'] })
  storage.set('plugin-a', { key: 'shared-name', value: 'a' })
  storage.set('plugin-b', { key: 'shared-name', value: 'b' })
  assert.equal(storage.get('plugin-a', { key: 'shared-name' }).value, 'a')
  assert.equal(storage.get('plugin-b', { key: 'shared-name' }).value, 'b')
  assert.notEqual(namespaceFor('plugin-a'), namespaceFor('plugin-b'))
})

test('quota enforcement: keys and byte size', () => {
  const storage = createStorage({ root, getGrants: () => ['storage.local.read', 'storage.local.write'] })
  for (let i = 0; i < QUOTA_KEYS; i++) {
    storage.set('qp', { key: `k${i}`, value: i })
  }
  assert.throws(() => storage.set('qp', { key: 'overflow', value: 1 }), e => e.code === 'QUOTA_EXCEEDED')
  assert.throws(
    () => storage.set('qp2', { key: 'big', value: 'x'.repeat(QUOTA_BYTES) }),
    e => e.code === 'QUOTA_EXCEEDED',
  )
})

test('invalid keys and values are rejected', () => {
  const storage = createStorage({ root, getGrants: () => ['storage.local.read', 'storage.local.write'] })
  assert.throws(() => storage.get('p', { key: '' }), e => e.code === 'INVALID_KEY')
  assert.throws(() => storage.get('p', {}), e => e.code === 'INVALID_KEY')
  assert.throws(
    () => storage.set('p', { key: 'k', value: 123n }),
    e => e.code === 'INVALID_VALUE',
    'BigInt is not strict JSON',
  )
})
