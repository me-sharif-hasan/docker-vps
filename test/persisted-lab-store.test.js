'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const store = require('../lib/persisted-lab-store')

// These touch the real persisted-labs.json (gitignored - holds private
// keys in production, nothing sensitive here) - every test cleans up its
// own device id so repeated runs don't accumulate test data.
const TEST_DEVICE = '__test_device_persisted_lab_store__'
const TEST_DEVICE_2 = '__test_device_persisted_lab_store_2__'

test.afterEach(() => {
  store.remove(TEST_DEVICE)
  store.remove(TEST_DEVICE_2)
})

test('get returns null for a device with no record', () => {
  assert.equal(store.get(TEST_DEVICE), null)
})

test('set then get round-trips the record', () => {
  const record = { deviceId: TEST_DEVICE, uuid: 'u1', state: 'running' }
  store.set(TEST_DEVICE, record)
  assert.deepEqual(store.get(TEST_DEVICE), record)
})

test('findByUuid locates a record by its uuid field, not the map key', () => {
  store.set(TEST_DEVICE, { deviceId: TEST_DEVICE, uuid: 'u-findme', state: 'stopped' })
  const found = store.findByUuid('u-findme')
  assert.ok(found)
  assert.equal(found.deviceId, TEST_DEVICE)
})

test('findByUuid returns null for a uuid nothing owns', () => {
  assert.equal(store.findByUuid('no-such-uuid'), null)
})

test('remove deletes the record', () => {
  store.set(TEST_DEVICE, { deviceId: TEST_DEVICE, uuid: 'u2', state: 'running' })
  store.remove(TEST_DEVICE)
  assert.equal(store.get(TEST_DEVICE), null)
})

test('persists across a fresh require (survives what a restart would do)', () => {
  store.set(TEST_DEVICE, { deviceId: TEST_DEVICE, uuid: 'u-survive', state: 'running' })
  delete require.cache[require.resolve('../lib/persisted-lab-store')]
  const reloaded = require('../lib/persisted-lab-store')
  assert.deepEqual(reloaded.get(TEST_DEVICE), { deviceId: TEST_DEVICE, uuid: 'u-survive', state: 'running' })
})

test('rebindDevice moves a record to a new deviceId, updating the record\'s own deviceId field too', () => {
  store.set(TEST_DEVICE, { deviceId: TEST_DEVICE, uuid: 'u-rebind', state: 'running' })
  const moved = store.rebindDevice(TEST_DEVICE, TEST_DEVICE_2)
  assert.equal(moved.uuid, 'u-rebind')
  assert.equal(moved.deviceId, TEST_DEVICE_2)
  assert.equal(store.get(TEST_DEVICE), null)
  assert.ok(store.get(TEST_DEVICE_2))
  assert.equal(store.get(TEST_DEVICE_2).deviceId, TEST_DEVICE_2)
})

test('rebindDevice is a no-op when the old deviceId owns nothing', () => {
  assert.equal(store.rebindDevice('__nobody_owns_this__', TEST_DEVICE_2), null)
  assert.equal(store.get(TEST_DEVICE_2), null)
})

test('rebindDevice is a no-op when old and new deviceId are the same', () => {
  store.set(TEST_DEVICE, { deviceId: TEST_DEVICE, uuid: 'u-same', state: 'running' })
  assert.equal(store.rebindDevice(TEST_DEVICE, TEST_DEVICE), null)
  assert.ok(store.get(TEST_DEVICE))
})
