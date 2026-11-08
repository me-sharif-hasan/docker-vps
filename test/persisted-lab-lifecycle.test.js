'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')

// Mocking CJS modules here: mutate their exported functions BEFORE the
// module under test is first required, since persisted-lab-lifecycle.js
// destructures these into local consts at its own require time - patching
// the exports object afterward wouldn't reach those already-bound locals.
const podmanClient = require('../lib/podman-client')
const snapshotStore = require('../lib/snapshot-store')
const firewallPorts = require('../lib/firewall-ports')
const diskQuota = require('../lib/disk-quota')
const store = require('../lib/persisted-lab-store')

let containerStateResult = 'running'
let exportExitCode = 0
let exportStderrText = ''
let uploadSizeBytes = 123456
let downloadSnapshotFound = true

let netIoCumulativeIn = 500
let netIoCumulativeOut = 700

podmanClient.containerState = async () => containerStateResult
podmanClient.exportContainerStream = () => {
  const child = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  setImmediate(() => {
    if (exportStderrText) child.stderr.emit('data', Buffer.from(exportStderrText))
    child.emit('close', exportExitCode)
  })
  return child
}
// container-stats.js's getNetIoBytes shells out through this same mocked
// `podman` (destructured from podman-client.js at container-stats.js's own
// require time, which happens inside persisted-lab-lifecycle's require
// below - after this mock is already in place).
podmanClient.podman = async (args) => {
  if (args[0] === 'stats') {
    return { stdout: JSON.stringify([{ net_io: `${netIoCumulativeIn}B / ${netIoCumulativeOut}B` }]) }
  }
  return { stdout: '' }
}
podmanClient.importImage = async () => {}
podmanClient.createContainer = async () => 'restored-container-id'
podmanClient.waitForSshReady = async () => {}

snapshotStore.uploadSnapshotStream = async (uuid) => ({
  key: snapshotStore.keyFor(uuid),
  sizeBytes: uploadSizeBytes
})
snapshotStore.deleteSnapshot = async () => {}
snapshotStore.downloadSnapshotToFile = async () => downloadSnapshotFound

firewallPorts.closeFirewallPort = async () => {}
firewallPorts.openFirewallPort = async () => {}

diskQuota.assignDiskQuota = async () => {}

const {
  stopPersistedLab, forceDeletePersistedLab, resumeAllOnBoot, reclaimSweep,
  adminResumeLab, listPersistedLabs, bandwidthSweep
} = require('../lib/persisted-lab-lifecycle')
const lifetimeBandwidth = require('../lib/lifetime-bandwidth-store')

const DEVICE_ID = '__test_device_lifecycle__'
const UUID = '__test_uuid_lifecycle__'

function seedRecord () {
  store.set(DEVICE_ID, {
    deviceId: DEVICE_ID,
    uuid: UUID,
    containerId: 'fake-container-id',
    sshPort: 39999,
    projectId: 60000,
    publicKey: 'ssh-rsa fake',
    privateKey: 'fake',
    state: 'running',
    createdAt: Date.now(),
    lastSeenAt: Date.now(),
    reclaimGraceStartedAt: null,
    snapshotKey: null
  })
}

const { settings } = require('../settings')
// This whole file tests the persisted-lab feature itself, not the kill
// switch (see lib/entitlement.js / settings.js) - which defaults off.
settings.persistedLabsEnabled = true

test.afterEach(() => {
  store.remove(DEVICE_ID)
  lifetimeBandwidth.remove(UUID)
  containerStateResult = 'running'
  exportExitCode = 0
  exportStderrText = ''
  uploadSizeBytes = 123456
  downloadSnapshotFound = true
  netIoCumulativeIn = 500
  netIoCumulativeOut = 700
  settings.subscriberDeviceIds = settings.subscriberDeviceIds.filter(id => id !== DEVICE_ID)
  settings.proDeviceIds = settings.proDeviceIds.filter(id => id !== DEVICE_ID)
})

test('stopPersistedLab rejects a 0-byte export instead of recording it as success', async () => {
  seedRecord()
  uploadSizeBytes = 0
  await assert.rejects(
    () => stopPersistedLab(UUID),
    /empty \(0 byte\) snapshot/
  )
  // Container must be left alone - record still says running, never stopped.
  assert.equal(store.findByUuid(UUID).state, 'running')
})

test('stopPersistedLab rejects a nonzero export exit code', async () => {
  seedRecord()
  exportExitCode = 1
  exportStderrText = 'permission denied'
  await assert.rejects(
    () => stopPersistedLab(UUID),
    /podman export exited 1.*permission denied/
  )
  assert.equal(store.findByUuid(UUID).state, 'running')
})

test('stopPersistedLab skips export entirely when the local container is already missing', async () => {
  seedRecord()
  containerStateResult = 'missing'
  const result = await stopPersistedLab(UUID)
  assert.equal(result.snapshotted, false)
  assert.equal(store.findByUuid(UUID).state, 'stopped')
})

test('stopPersistedLab records success and stops when export is healthy', async () => {
  seedRecord()
  const result = await stopPersistedLab(UUID)
  assert.equal(result.snapshotted, true)
  assert.equal(store.findByUuid(UUID).state, 'stopped')
})

test('forceDeletePersistedLab does not attempt an export when the container is already missing', async () => {
  seedRecord()
  containerStateResult = 'missing'
  const result = await forceDeletePersistedLab(UUID)
  assert.equal(result.destroyed, true)
  assert.equal(store.findByUuid(UUID), null)
})

test('resumeAllOnBoot leaves a record alone when its container is already running', async () => {
  seedRecord()
  containerStateResult = 'running'
  await resumeAllOnBoot()
  assert.equal(store.findByUuid(UUID).containerId, 'fake-container-id')
})

test('resumeAllOnBoot resumes a record whose container merely stopped (host restart, container survived)', async () => {
  seedRecord()
  containerStateResult = 'stopped'
  await resumeAllOnBoot()
  const record = store.findByUuid(UUID)
  assert.equal(record.state, 'running')
  assert.equal(record.containerId, 'fake-container-id') // resume reuses the existing container, doesn't recreate
})

test('resumeAllOnBoot restores from R2 when the local container/disk is gone entirely', async () => {
  seedRecord()
  containerStateResult = 'missing'
  await resumeAllOnBoot()
  const record = store.findByUuid(UUID)
  assert.equal(record.state, 'running')
  assert.equal(record.containerId, 'restored-container-id')
})

test('resumeAllOnBoot never touches a record that was not running before the restart', async () => {
  seedRecord()
  const stoppedRecord = store.findByUuid(UUID)
  stoppedRecord.state = 'stopped'
  store.set(DEVICE_ID, stoppedRecord)
  containerStateResult = 'missing' // would restore if resumeAllOnBoot wrongly touched it
  await resumeAllOnBoot()
  assert.equal(store.findByUuid(UUID).state, 'stopped')
  assert.equal(store.findByUuid(UUID).containerId, 'fake-container-id')
})

test('reclaimSweep stops and starts the reclaim clock for a running lab whose entitlement has lapsed', async () => {
  seedRecord()
  // DEVICE_ID is in no comp list and has no verified purchase - entitlement.persisted is false.
  await reclaimSweep()
  const record = store.findByUuid(UUID)
  assert.equal(record.state, 'reclaim_grace')
  assert.ok(record.reclaimGraceStartedAt)
})

test('reclaimSweep leaves a running lab alone while its entitlement is still active', async () => {
  seedRecord()
  settings.subscriberDeviceIds.push(DEVICE_ID)
  await reclaimSweep()
  const record = store.findByUuid(UUID)
  assert.equal(record.state, 'running')
  assert.equal(record.reclaimGraceStartedAt, null)
})

test('adminResumeLab resumes a stopped lab on demand, regardless of record.state', async () => {
  seedRecord()
  const stopped = store.findByUuid(UUID)
  stopped.state = 'reclaim_grace' // admin action must not care what state it's in
  store.set(DEVICE_ID, stopped)
  containerStateResult = 'stopped'
  const result = await adminResumeLab(UUID)
  assert.equal(result.state, 'running')
  assert.equal(store.findByUuid(UUID).state, 'running')
})

test('adminResumeLab restores from R2 when the local container is gone', async () => {
  seedRecord()
  containerStateResult = 'missing'
  const result = await adminResumeLab(UUID)
  assert.equal(result.state, 'running')
  assert.equal(result.containerId, 'restored-container-id')
})

test('adminResumeLab throws a 404-shaped error for a uuid nothing owns', async () => {
  await assert.rejects(() => adminResumeLab('nonexistent-uuid'), /No persisted lab/)
})

test('adminResumeLab throws when there is nothing to restore from', async () => {
  seedRecord()
  containerStateResult = 'missing'
  downloadSnapshotFound = false
  await assert.rejects(() => adminResumeLab(UUID), /No R2 snapshot/)
})

test('listPersistedLabs returns every record with keys stripped', async () => {
  seedRecord()
  const labs = listPersistedLabs()
  const mine = labs.find(l => l.uuid === UUID)
  assert.ok(mine)
  assert.equal(mine.deviceId, DEVICE_ID)
  assert.equal(mine.privateKey, undefined)
  assert.equal(mine.publicKey, undefined)
})

test('stopPersistedLab folds the container\'s current net_io into lifetime bandwidth', async () => {
  seedRecord()
  netIoCumulativeIn = 9000
  netIoCumulativeOut = 4000
  await stopPersistedLab(UUID)
  const bw = lifetimeBandwidth.get(UUID)
  assert.equal(bw.bytesIn, 9000)
  assert.equal(bw.bytesOut, 4000)
})

test('forceDeletePersistedLab folds the container\'s current net_io into lifetime bandwidth before removing it', async () => {
  seedRecord()
  netIoCumulativeIn = 1200
  netIoCumulativeOut = 300
  await forceDeletePersistedLab(UUID)
  const bw = lifetimeBandwidth.get(UUID)
  assert.equal(bw.bytesIn, 1200)
  assert.equal(bw.bytesOut, 300)
})

test('bandwidthSweep records usage for every running lab and skips non-running ones', async () => {
  seedRecord() // state: running
  netIoCumulativeIn = 777
  netIoCumulativeOut = 888
  await bandwidthSweep()
  const bw = lifetimeBandwidth.get(UUID)
  assert.equal(bw.bytesIn, 777)
  assert.equal(bw.bytesOut, 888)
})

test('bandwidthSweep does not touch a stopped lab', async () => {
  seedRecord()
  const stopped = store.findByUuid(UUID)
  stopped.state = 'stopped'
  store.set(DEVICE_ID, stopped)
  await bandwidthSweep()
  assert.equal(lifetimeBandwidth.get(UUID), null)
})

test('listPersistedLabs reports accumulated lifetime bandwidth per lab', async () => {
  seedRecord()
  lifetimeBandwidth.record(UUID, 'fake-container-id', 5000, 6000)
  const labs = listPersistedLabs()
  const mine = labs.find(l => l.uuid === UUID)
  assert.equal(mine.lifetimeBytesIn, 5000)
  assert.equal(mine.lifetimeBytesOut, 6000)
})

test('listPersistedLabs reports zero bandwidth for a lab that never had any recorded', async () => {
  seedRecord()
  const labs = listPersistedLabs()
  const mine = labs.find(l => l.uuid === UUID)
  assert.equal(mine.lifetimeBytesIn, 0)
  assert.equal(mine.lifetimeBytesOut, 0)
})
