'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const store = require('../lib/verified-entitlement-store')

const TEST_DEVICE = '__test_device_verified_entitlement_store__'

test.afterEach(() => {
  store.remove(TEST_DEVICE)
})

test('get returns null for a device with no record', () => {
  assert.equal(store.get(TEST_DEVICE), null)
})

test('set then get round-trips the record', () => {
  const record = { kind: 'subscription', productId: 'serverkit_pro_plus', active: true }
  store.set(TEST_DEVICE, record)
  assert.deepEqual(store.get(TEST_DEVICE), record)
})

test('all() includes the deviceId alongside each record', () => {
  store.set(TEST_DEVICE, { kind: 'lifetime_pro', active: true })
  const found = store.all().find(r => r.deviceId === TEST_DEVICE)
  assert.ok(found)
  assert.equal(found.kind, 'lifetime_pro')
})

test('remove deletes the record', () => {
  store.set(TEST_DEVICE, { kind: 'lifetime_pro', active: true })
  store.remove(TEST_DEVICE)
  assert.equal(store.get(TEST_DEVICE), null)
})

test('persists across a fresh require (survives what a restart would do)', () => {
  store.set(TEST_DEVICE, { kind: 'subscription', active: true })
  delete require.cache[require.resolve('../lib/verified-entitlement-store')]
  const reloaded = require('../lib/verified-entitlement-store')
  assert.deepEqual(reloaded.get(TEST_DEVICE), { kind: 'subscription', active: true })
})

test('findByPurchaseToken locates the record owning a given token', () => {
  store.set(TEST_DEVICE, { kind: 'lifetime_pro', active: true, purchaseToken: 'tok-abc-123' })
  const found = store.findByPurchaseToken('tok-abc-123')
  assert.ok(found)
  assert.equal(found.deviceId, TEST_DEVICE)
})

test('findByPurchaseToken returns null when no record has that token', () => {
  assert.equal(store.findByPurchaseToken('tok-nobody-has-this'), null)
})
