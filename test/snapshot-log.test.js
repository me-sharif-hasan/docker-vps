'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const snapshotLog = require('../lib/snapshot-log')

const TEST_UUID = '__test_uuid_snapshot_log__'

test('recordAttempt + getRecent round-trips a success entry', () => {
  snapshotLog.recordAttempt({ uuid: TEST_UUID, status: 'success', key: 'lab-snapshots/x.tar', sizeBytes: 1024 })
  const recent = snapshotLog.getRecent(500)
  const entry = recent.find(e => e.uuid === TEST_UUID && e.status === 'success')
  assert.ok(entry)
  assert.equal(entry.sizeBytes, 1024)
})

test('getRecentFailures only returns failure entries', () => {
  snapshotLog.recordAttempt({ uuid: TEST_UUID, status: 'failure', error: 'R2 timeout' })
  const failures = snapshotLog.getRecentFailures(500)
  assert.ok(failures.some(e => e.uuid === TEST_UUID && e.error === 'R2 timeout'))
  assert.ok(failures.every(e => e.status === 'failure'))
})

test('getRecent returns newest first', () => {
  snapshotLog.recordAttempt({ uuid: TEST_UUID, status: 'success', key: 'a' })
  snapshotLog.recordAttempt({ uuid: TEST_UUID, status: 'success', key: 'b' })
  const recent = snapshotLog.getRecent(2)
  assert.equal(recent[0].key, 'b')
  assert.equal(recent[1].key, 'a')
})
