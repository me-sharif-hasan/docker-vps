'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const { settings } = require('../settings')
const store = require('./persisted-lab-store')
const snapshotLog = require('./snapshot-log')
const snapshotStore = require('./snapshot-store')
const {
  podman, generateSshKeyPair, createContainer, waitForSshReady,
  containerState, importImage, exportContainerStream
} = require('./podman-client')
const { usedPorts, getRandomPort, openFirewallPort, closeFirewallPort } = require('./firewall-ports')
const { usedProjectIds, nextProjectId, assignDiskQuota } = require('./disk-quota')
const { computeEntitlement } = require('./entitlement')
const verifiedEntitlements = require('./verified-entitlement-store')
const { getNetIoBytes } = require('./container-stats')
const lifetimeBandwidth = require('./lifetime-bandwidth-store')

// Best-effort: folds this container's current cumulative net_io into its
// uuid's lifetime total (see lib/lifetime-bandwidth-store.js for why this
// can't just be "read and store the cumulative number"). Never throws -
// a container that's mid-crash or already half-gone shouldn't block the
// stop/delete it's called from over a stats read.
async function recordBandwidth(uuid, containerId) {
  try {
    const { bytesIn, bytesOut } = await getNetIoBytes(containerId)
    lifetimeBandwidth.record(uuid, containerId, bytesIn, bytesOut)
  } catch { /* container unreachable - this observation point is skipped, not fatal */ }
}

// Policy for the "persisted" branch of the lab state machine - see the
// design doc's state table (NONE -> PROVISIONING -> RUNNING -> IDLE_STOPPING
// -> SNAPSHOT_PENDING -> STOPPED -> (reconnect) RUNNING, or -> RECLAIM_GRACE
// -> DELETED). This module owns that branch; container-manager.js's
// provisionContainer/destroyContainer delegate here when an entitlement
// says `persisted: true`.

function connectionResultFrom(record) {
  return {
    uuid: record.uuid,
    sshPort: record.sshPort,
    privateKey: record.privateKey,
    user: 'labuser',
    expiresAt: null, // persisted - no session timer
    timeRemainingSeconds: null
  }
}

async function startFreshPersistedContainer(deviceId, uuid, ip) {
  const { privateKey, publicKey } = await generateSshKeyPair()
  const sshPort = getRandomPort()
  usedPorts.add(sshPort)
  const projectId = nextProjectId()

  let containerId
  try {
    containerId = await createContainer(uuid, publicKey, sshPort)
    await assignDiskQuota(containerId, projectId)
    await openFirewallPort(uuid, sshPort)
    await waitForSshReady(sshPort)
  } catch (err) {
    usedPorts.delete(sshPort)
    usedProjectIds.delete(projectId)
    if (containerId) await podman(['rm', '-f', containerId]).catch(() => {})
    throw err
  }

  const record = {
    deviceId,
    uuid,
    containerId,
    sshPort,
    projectId,
    publicKey,
    privateKey,
    state: 'running',
    createdAt: Date.now(),
    lastSeenAt: Date.now(),
    reclaimGraceStartedAt: null,
    snapshotKey: null
  }
  store.set(deviceId, record)
  return record
}

async function resumeStoppedContainer(record) {
  const containerName = `lab-${record.uuid}`
  await podman(['start', containerName])
  usedPorts.add(record.sshPort)
  await openFirewallPort(record.uuid, record.sshPort)
  await waitForSshReady(record.sshPort)

  record.state = 'running'
  record.lastSeenAt = Date.now()
  record.reclaimGraceStartedAt = null
  store.set(record.deviceId, record)
  return record
}

// Local container/disk is gone (host rebuild, or the reclaim sweep had
// already wiped it locally while the R2 copy was still inside its grace
// window) - rebuild a container from the R2 snapshot. Returns null if
// there's nothing to restore (never snapshotted, or the snapshot itself is
// gone), letting the caller fall back to provisioning fresh.
async function restoreFromSnapshot(record) {
  const tmpTar = path.join(os.tmpdir(), `lab-restore-${record.uuid}.tar`)
  const found = await snapshotStore.downloadSnapshotToFile(record.uuid, tmpTar).catch(() => false)
  if (!found) return null

  const imageTag = `serverkit-lab-restore:${record.uuid}`
  const projectId = nextProjectId()
  let containerId
  try {
    await importImage(tmpTar, imageTag)
    containerId = await createContainer(record.uuid, record.publicKey, record.sshPort, imageTag)
    await assignDiskQuota(containerId, projectId)
    usedPorts.add(record.sshPort)
    await openFirewallPort(record.uuid, record.sshPort)
    await waitForSshReady(record.sshPort)
  } catch (err) {
    usedProjectIds.delete(projectId)
    if (containerId) await podman(['rm', '-f', containerId]).catch(() => {})
    throw err
  } finally {
    fs.rm(tmpTar, { force: true }, () => {})
    // No -f here, deliberately. Confirmed live on two separate hosts:
    // `podman rmi -f` doesn't just drop the tag, it cascade-removes any
    // container still using that image - which on the success path is the
    // very container this function just created and is trying to keep
    // alive. The running container dies and vanishes within seconds of
    // every restore. Without -f, rmi is a no-op (caught) while the
    // container is still using the image, and only cleans up the tag once
    // nothing references it any more (e.g. after a later forceDelete).
    await podman(['rmi', imageTag]).catch(() => {})
  }

  record.containerId = containerId
  record.projectId = projectId
  record.state = 'running'
  record.lastSeenAt = Date.now()
  record.reclaimGraceStartedAt = null
  store.set(record.deviceId, record)
  return record
}

async function provisionPersistedLab(deviceId, uuid, ip) {
  const existing = store.get(deviceId)

  if (existing) {
    const containerName = `lab-${existing.uuid}`
    const state = await containerState(containerName)

    if (state === 'running') {
      existing.lastSeenAt = Date.now()
      store.set(deviceId, existing)
      return connectionResultFrom(existing)
    }

    if (state === 'stopped') {
      const resumed = await resumeStoppedContainer(existing)
      return connectionResultFrom(resumed)
    }

    // state === 'missing': local container/disk gone. Try R2 before
    // falling through to provisioning fresh under the same device record.
    const restored = await restoreFromSnapshot(existing)
    if (restored) return connectionResultFrom(restored)
  }

  const freshUuid = existing ? existing.uuid : uuid
  const fresh = await startFreshPersistedContainer(deviceId, freshUuid, ip)
  return connectionResultFrom(fresh)
}

// Runs [uuid]'s export+upload and returns the verified result, or throws -
// never trusts `upload.done()` resolving as proof the export actually
// produced data. Confirmed live: a `podman export` that fails fast (closes
// its stdout with nothing written) still lets the S3 Upload "succeed" with
// a 0-byte object, silently overwriting the last good snapshot in R2 with
// garbage. A real lab disk is never 0 bytes, and the export child's own
// exit code is the authoritative signal - both are checked before anything
// downstream is allowed to treat this as a successful snapshot.
async function exportAndVerify(uuid, containerId) {
  const exportProcess = exportContainerStream(containerId)
  let stderr = ''
  exportProcess.stderr.on('data', chunk => { stderr += chunk })
  const exitCode = new Promise(resolve => exportProcess.on('close', resolve))

  const uploadResult = await snapshotStore.uploadSnapshotStream(uuid, exportProcess.stdout)
  const code = await exitCode
  if (code !== 0) {
    throw new Error(`podman export exited ${code}: ${stderr.trim() || '(no stderr)'}`)
  }
  if (!uploadResult.sizeBytes) {
    throw new Error('podman export produced an empty (0 byte) snapshot - refusing to treat as success')
  }
  return uploadResult
}

// Snapshot-then-stop, in that order, always. Never the reverse - a failed
// snapshot must never be followed by a stop, or the owner's most recent
// changes are gone with nothing in R2 to show for them.
async function stopPersistedLab(uuid) {
  const record = store.findByUuid(uuid)
  if (!record) throw new Error('Session not found')

  // Local container is already gone (confirmed live: a restored/imported
  // container can vanish out from under a clean `podman stop`, not just
  // exit) - nothing to export. Mark stopped without touching R2, so the
  // last real snapshot there stays the source of truth for the next
  // restore instead of being clobbered by an export of nothing.
  const state = await containerState(`lab-${record.uuid}`)
  if (state === 'missing') {
    usedPorts.delete(record.sshPort)
    await closeFirewallPort(record.sshPort).catch(() => {})
    record.state = 'stopped'
    store.set(record.deviceId, record)
    return { uuid, destroyed: false, stopped: true, snapshotted: false }
  }

  await recordBandwidth(uuid, record.containerId)

  let uploadResult
  try {
    uploadResult = await exportAndVerify(uuid, record.containerId)
    snapshotLog.recordAttempt({ uuid, status: 'success', key: uploadResult.key, sizeBytes: uploadResult.sizeBytes })
  } catch (err) {
    snapshotLog.recordAttempt({ uuid, status: 'failure', error: err.message })
    // Leave the container running - caller (idle sweep or an explicit
    // "end session" request) will see it's still running and can retry
    // later rather than losing data to a stop that never got snapshotted.
    throw new Error(`Snapshot failed, container left running: ${err.message}`)
  }

  await podman(['stop', record.containerId]).catch(() => {})
  usedPorts.delete(record.sshPort)
  await closeFirewallPort(record.sshPort)

  record.state = 'stopped'
  record.snapshotKey = uploadResult.key
  store.set(record.deviceId, record)
  return { uuid, destroyed: false, stopped: true, snapshotted: true }
}

function isPersistedUuid(uuid) {
  return !!store.findByUuid(uuid)
}

// Admin's explicit "force destroy" action from the dashboard - an
// intentional throw-it-away, unlike the automatic idle sweep. Still
// attempts a best-effort snapshot first (no reason to lose data if R2 is
// reachable), but - deliberately unlike stopPersistedLab - proceeds with
// the deletion even if that snapshot fails, since the admin asked for
// deletion specifically, not a stop.
async function forceDeletePersistedLab(uuid) {
  const record = store.findByUuid(uuid)
  if (!record) return null

  const state = await containerState(`lab-${record.uuid}`)
  if (state !== 'missing') {
    await recordBandwidth(uuid, record.containerId)
    try {
      const result = await exportAndVerify(uuid, record.containerId)
      snapshotLog.recordAttempt({ uuid, status: 'success', key: result.key, sizeBytes: result.sizeBytes })
    } catch (err) {
      snapshotLog.recordAttempt({ uuid, status: 'failure', error: `force-delete snapshot: ${err.message}` })
    }
  }

  await podman(['rm', '-f', record.containerId]).catch(() => {})
  await snapshotStore.deleteSnapshot(uuid).catch(() => {})
  usedPorts.delete(record.sshPort)
  usedProjectIds.delete(record.projectId)
  await closeFirewallPort(record.sshPort).catch(() => {})
  store.remove(record.deviceId)

  return { destroyed: true, containerId: record.containerId, containerName: `lab-${uuid}` }
}

// Called on every GET /labs/:uuid (connection-details poll) - the only
// client heartbeat this backend has, since SSH traffic itself isn't
// observable here. No idle-stop depends on this any more; it's kept for
// the admin dashboard's "last seen" display.
function touchPersistedLab(uuid) {
  const record = store.findByUuid(uuid)
  if (!record) return null
  record.lastSeenAt = Date.now()
  store.set(record.deviceId, record)
  return record
}

// Persisted labs are meant to run continuously - cron jobs, servers,
// anything a real always-on VPS would run - so there is deliberately no
// idle-stop any more (a prior version stopped a lab after N minutes of no
// API activity, which only ever measured "app not open", not "VM not in
// use", and would silently kill a cron-only lab nobody was ever idle on).
// The only things that stop a running persisted lab now are an explicit
// owner/admin action (forceDeletePersistedLab) or its entitlement lapsing
// (reclaimSweep below).

// Brings one record's container to 'running', whatever state it's actually
// in right now - already up, merely stopped (resume), or gone entirely
// (restore from R2). Shared by the boot-time sweep below and the admin
// dashboard's manual "resume" action. Throws if there's nothing to restore.
async function resumeOne(record) {
  const state = await containerState(`lab-${record.uuid}`)
  if (state === 'running') return record
  if (state === 'stopped') return resumeStoppedContainer(record)
  const restored = await restoreFromSnapshot(record)
  if (!restored) throw new Error(`No R2 snapshot to restore ${record.uuid} from`)
  return restored
}

// Brings every lab that was running before a restart back up, so a server
// restart or host reboot is never silent downtime for the owner - without
// this, a stopped-but-not-missing lab would just sit there until the owner
// happened to reopen the app and hit /labs/provision. Call once at process
// startup, after the HTTP server is already listening.
async function resumeAllOnBoot() {
  for (const record of store.all()) {
    if (record.state !== 'running') continue
    try {
      await resumeOne(record)
    } catch (err) {
      console.error(`Boot-resume failed for ${record.uuid}:`, err.message)
    }
  }
}

// Admin dashboard's manual "resume" action - unlike resumeAllOnBoot, this
// acts regardless of the record's stored state (an admin may want to bring
// a stopped or reclaim_grace lab back without waiting for the owner to
// reconnect), and throws instead of swallowing the error so the API call
// that triggered it gets a real failure back.
async function adminResumeLab(uuid) {
  const record = store.findByUuid(uuid)
  if (!record) throw new Error('No persisted lab for this uuid')
  return resumeOne(record)
}

// Sanitized snapshot of every persisted lab for the admin dashboard - the
// store itself is the authoritative source (unlike /api/admin/stats, which
// only reflects whatever's currently live in podman, missing anything
// that's reclaim_grace or purely R2-backed with no local container at all).
// Joins in the uuid's lifetime transfer total alongside it.
function listPersistedLabs() {
  return store.all().map(store.sanitize).map(record => {
    const bandwidth = lifetimeBandwidth.get(record.uuid)
    return {
      ...record,
      lifetimeBytesIn: bandwidth?.bytesIn ?? 0,
      lifetimeBytesOut: bandwidth?.bytesOut ?? 0
    }
  })
}

// A lab that never stops (the normal case now - see the always-on comment
// above) would otherwise only ever have its lifetime bandwidth folded in at
// teardown, which for a genuinely always-on subscriber may be months away
// or never. This keeps the running total current without waiting for that.
async function bandwidthSweep() {
  for (const record of store.all()) {
    if (record.state !== 'running') continue
    await recordBandwidth(record.uuid, record.containerId)
  }
}

// Reclaims a lab whose owner's entitlement has lapsed: stops a still-running
// one first (snapshotting it, same as any other stop), moves a stopped one
// into reclaim_grace, then hard-deletes (container, disk, R2 snapshot, the
// registry record) once reclaimGraceDays has elapsed in that state. Never
// deletes anything still inside its grace window - re-subscribing during
// that window is what provisionPersistedLab's restore path is for.
async function reclaimSweep() {
  const now = Date.now()
  const graceMs = settings.reclaimGraceDays * 24 * 60 * 60 * 1000

  for (const record of store.all()) {
    if (record.state === 'running') {
      const entitlement = computeEntitlement({
        deviceId: record.deviceId,
        settings,
        now: new Date(now),
        verifiedEntitlement: verifiedEntitlements.get(record.deviceId)
      })
      if (entitlement.persisted) continue
      try {
        await stopPersistedLab(record.uuid)
      } catch (err) {
        console.error(`Reclaim stop failed for ${record.uuid}:`, err.message)
        continue // leave running, entitlement check retries next sweep
      }
      const stopped = store.findByUuid(record.uuid)
      if (stopped) {
        stopped.state = 'reclaim_grace'
        stopped.reclaimGraceStartedAt = now
        store.set(stopped.deviceId, stopped)
      }
      continue
    }

    if (record.state === 'stopped') {
      const entitlement = computeEntitlement({
        deviceId: record.deviceId,
        settings,
        now: new Date(now),
        verifiedEntitlement: verifiedEntitlements.get(record.deviceId)
      })
      if (!entitlement.persisted) {
        record.state = 'reclaim_grace'
        record.reclaimGraceStartedAt = now
        store.set(record.deviceId, record)
      }
      continue
    }

    if (record.state === 'reclaim_grace') {
      if (now - record.reclaimGraceStartedAt < graceMs) continue
      await podman(['rm', '-f', record.containerId]).catch(() => {})
      await snapshotStore.deleteSnapshot(record.uuid).catch(() => {})
      usedProjectIds.delete(record.projectId)
      store.remove(record.deviceId)
    }
  }
}

function startSweeps(intervalMs) {
  setInterval(() => reclaimSweep().catch(err => console.error('Reclaim sweep failed:', err.message)), intervalMs)
  setInterval(() => bandwidthSweep().catch(err => console.error('Bandwidth sweep failed:', err.message)), intervalMs)
}

module.exports = {
  provisionPersistedLab,
  stopPersistedLab,
  isPersistedUuid,
  touchPersistedLab,
  forceDeletePersistedLab,
  resumeAllOnBoot,
  adminResumeLab,
  listPersistedLabs,
  reclaimSweep,
  bandwidthSweep,
  startSweeps
}
