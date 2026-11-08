'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const lifetimeBandwidth = require('../lib/lifetime-bandwidth-store')

const UUID = '__test_uuid_lifetime_bandwidth__'

test.afterEach(() => {
  lifetimeBandwidth.remove(UUID)
})

test('record() accumulates the delta across repeated observations of the same container', () => {
  lifetimeBandwidth.record(UUID, 'container-a', 1000, 2000)
  lifetimeBandwidth.record(UUID, 'container-a', 1500, 2800) // same container, counters only grew
  const result = lifetimeBandwidth.get(UUID)
  assert.equal(result.bytesIn, 1500)
  assert.equal(result.bytesOut, 2800)
})

test('record() does not double-count when called again with an unchanged cumulative reading', () => {
  lifetimeBandwidth.record(UUID, 'container-a', 1000, 2000)
  lifetimeBandwidth.record(UUID, 'container-a', 1000, 2000) // a sweep tick with nothing new
  const result = lifetimeBandwidth.get(UUID)
  assert.equal(result.bytesIn, 1000)
  assert.equal(result.bytesOut, 2000)
})

test('record() folds in the previous container\'s final total when a new container id appears (restore)', () => {
  lifetimeBandwidth.record(UUID, 'container-a', 5000, 6000) // old container's life, ending here
  lifetimeBandwidth.record(UUID, 'container-b', 100, 200) // restored - counters reset to near-zero
  const result = lifetimeBandwidth.get(UUID)
  // 5000+100 in, 6000+200 out - the old container's total is preserved, the new
  // container's reset counters are added in full rather than subtracted against.
  assert.equal(result.bytesIn, 5100)
  assert.equal(result.bytesOut, 6200)
})

test('get() returns null for a uuid with no recorded bandwidth', () => {
  assert.equal(lifetimeBandwidth.get('__nonexistent__'), null)
})
