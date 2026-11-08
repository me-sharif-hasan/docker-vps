'use strict'

const { settings } = require('./settings')
const { logProvision } = require('./activity')
const { ensureEgressBlockRules } = require('./firewall-egress')
const { logSessionBandwidth } = require('./bandwidth-history')
const { podman, buildImageIfNeeded, generateSshKeyPair, createContainer, waitForSshReady } = require('./lib/podman-client')
const { usedPorts, getRandomPort, openFirewallPort, closeFirewallPort, reconcileFirewallRules } = require('./lib/firewall-ports')
const { usedProjectIds, nextProjectId, assignDiskQuota } = require('./lib/disk-quota')
const { sessions, deviceSessions } = require('./lib/session-store')
const { getNetIoBytes, getStats, getDetailedStats } = require('./lib/container-stats')
const { MAX_CONCURRENT, FIREWALL_RECONCILE_INTERVAL_MS, PERSISTED_LAB_SWEEP_INTERVAL_MS, ENTITLEMENT_REVERIFY_INTERVAL_MS } = require('./lib/constants')
const { computeEntitlement } = require('./lib/entitlement')
const verifiedEntitlements = require('./lib/verified-entitlement-store')
const { startReverifySweep } = require('./lib/entitlement-reverify')
const persistedLabs = require('./lib/persisted-lab-lifecycle')

// Lifecycle orchestration only - this is the one module that decides policy
// (ban checks, device-session cap, pro vs free duration, teardown ordering).
// It composes podman-client/firewall-ports/disk-quota/session-store/
// container-stats rather than talking to podman or the host directly.

async function provisionContainer(uuid, deviceId, ip) {
  if (deviceId && settings.bannedDeviceIds.includes(deviceId)) {
    throw new Error('This device is banned')
  }
  if (ip && settings.bannedIps.includes(ip)) {
    throw new Error('This IP is banned')
  }

  // Entitlement decides which branch of the state machine applies -
  // subscriber / grandfathered-lifetime-pro (still within their free or
  // grace window) gets a persisted lab with no session timer; everyone
  // else (free tier, or lapsed grandfathered) gets the original ephemeral
  // flow below. See lib/entitlement.js for the tier/phase rules.
  const entitlement = computeEntitlement({ deviceId, settings, verifiedEntitlement: deviceId ? verifiedEntitlements.get(deviceId) : null })
  if (entitlement.persisted) {
    return persistedLabs.provisionPersistedLab(deviceId, uuid, ip)
  }

  if (sessions.has(uuid)) {
    throw new Error('UUID already exists')
  }

  if (deviceId) {
    const existingUuid = deviceSessions.get(deviceId)
    const existingSession = existingUuid ? sessions.get(existingUuid) : null
    if (existingSession) {
      // Already has a live session - hand that one back instead of
      // starting a second one. Shaped like a fresh provision's result
      // (sshPort, not port - server.js's route reads result.sshPort).
      const now = Date.now()
      return {
        uuid: existingSession.uuid,
        sshPort: existingSession.sshPort,
        privateKey: existingSession.privateKey,
        user: 'labuser',
        expiresAt: existingSession.expiresAt,
        timeRemainingSeconds: Math.max(0, Math.floor((existingSession.expiresAt - now) / 1000))
      }
    }
    if (existingUuid) deviceSessions.delete(deviceId) // stale, session ended since
  }

  if (sessions.size >= MAX_CONCURRENT) {
    throw new Error('Maximum concurrent sessions reached. Try again later.')
  }

  await buildImageIfNeeded()

  const { privateKey, publicKey } = await generateSshKeyPair()
  const sshPort = getRandomPort()
  usedPorts.add(sshPort)

  const projectId = nextProjectId()
  let containerId
  try {
    containerId = await createContainer(uuid, publicKey, sshPort)
    await assignDiskQuota(containerId, projectId)
    await openFirewallPort(uuid, sshPort)
    // The container is "running" the instant podman returns, but systemd
    // (dbus, journald, etc.) takes a bit to actually bring sshd up - a
    // client that connects the moment provision() responds can hit a
    // refused/reset connection. Hold the response until sshd is actually
    // accepting, so "fresh provision -> instant Open Dashboard" just works.
    await waitForSshReady(sshPort)
  } catch (err) {
    usedPorts.delete(sshPort)
    usedProjectIds.delete(projectId)
    if (containerId) await podman(['rm', '-f', containerId]).catch(() => {})
    throw err
  }

  // entitlement.durationMinutes already picked free vs lapsed-grandfathered
  // pro duration (see lib/entitlement.js) - isPro here is just for the
  // activity log/dashboard pill, not a duration decision.
  const isPro = entitlement.tier !== 'free'
  const durationMs = entitlement.durationMinutes * 60 * 1000

  const expiresAt = Date.now() + durationMs
  const session = {
    uuid,
    containerId,
    sshPort,
    projectId,
    privateKey,
    publicKey,
    createdAt: Date.now(),
    expiresAt,
    status: 'running',
    deviceId
  }

  sessions.set(uuid, session)
  if (deviceId) deviceSessions.set(deviceId, uuid)

  const timer = setTimeout(() => destroyContainer(uuid, true), durationMs)
  session.timer = timer

  logProvision({ uuid, deviceId, ip, isPro })

  return {
    uuid,
    sshPort,
    privateKey,
    user: 'labuser',
    expiresAt,
    timeRemainingSeconds: Math.floor(durationMs / 1000)
  }
}

// A session can outlive the in-memory sessions Map (any app restart/deploy
// wipes it, but podman containers keep running) - without this, the normal
// DELETE /labs/:uuid path threw "Session not found" for such a container
// forever, so "End Session" silently did nothing and the lab kept running
// and ticking its original countdown. Find and tear it down by name instead.
async function destroyOrphanedByUuid(uuid) {
  const containerName = `lab-${uuid}`
  let containerId
  try {
    const { stdout } = await podman(['inspect', containerName, '--format', '{{.Id}}'])
    containerId = stdout.trim()
  } catch {
    throw new Error('Session not found')
  }

  let sshPort = null
  try {
    const { stdout: portOut } = await podman(['inspect', containerName, '--format', '{{(index (index .NetworkSettings.Ports "22/tcp") 0).HostPort}}'])
    sshPort = parseInt(portOut.trim(), 10) || null
  } catch { /* port lookup best-effort */ }

  await podman(['rm', '-f', containerId])
  if (sshPort) {
    usedPorts.delete(sshPort)
    await closeFirewallPort(sshPort)
  }

  return { uuid, destroyed: true, reason: 'orphaned' }
}

async function destroyContainer(uuid, isAutoExpiry = false) {
  // A persisted lab's "end session" is a snapshot-then-stop, never a
  // destroy - the uuid never lives in the ephemeral `sessions` Map at all,
  // so without this check it would otherwise fall through to
  // destroyOrphanedByUuid below and hard `podman rm -f` someone's disk.
  if (persistedLabs.isPersistedUuid(uuid)) {
    return persistedLabs.stopPersistedLab(uuid)
  }

  const session = sessions.get(uuid)
  if (!session) {
    return destroyOrphanedByUuid(uuid)
  }

  // Clear auto-termination timer if manually destroyed
  if (session.timer && !isAutoExpiry) {
    clearTimeout(session.timer)
  }

  // Capture final bandwidth before teardown - this is the only chance to
  // read it; the container is gone right after. Best-effort: a container
  // that already died on its own (crash, OOM) won't answer `stats`, and
  // that's fine, it just means this session doesn't contribute to the
  // rolling average rather than blocking its own cleanup.
  try {
    const { bytesIn, bytesOut } = await getNetIoBytes(session.containerId)
    logSessionBandwidth({ uuid, bytesIn, bytesOut, durationSeconds: (Date.now() - session.createdAt) / 1000 })
  } catch { /* container unreachable - skip */ }

  // Drop all bookkeeping FIRST, synchronously, before the slow teardown
  // below (podman rm, firewall close - real wall-clock time). Otherwise a
  // provision() racing in on the same deviceId reads sessions/deviceSessions
  // while this container is still "alive" in the map but already mid-
  // teardown (or already gone), and hands back a dead session.
  usedPorts.delete(session.sshPort)
  usedProjectIds.delete(session.projectId)
  sessions.delete(uuid)
  if (session.deviceId && deviceSessions.get(session.deviceId) === uuid) deviceSessions.delete(session.deviceId)

  await podman(['rm', '-f', session.containerId]).catch(() => {})
  await closeFirewallPort(session.sshPort)

  return { uuid, destroyed: true, reason: isAutoExpiry ? 'expired' : 'manual' }
}

function getConnectionDetails(uuid) {
  const persistedRecord = persistedLabs.touchPersistedLab(uuid)
  if (persistedRecord) {
    return {
      uuid,
      host: process.env.HOST_IP || '127.0.0.1',
      port: persistedRecord.sshPort,
      user: 'labuser',
      privateKey: persistedRecord.privateKey,
      expiresAt: null,
      timeRemainingSeconds: null,
      status: persistedRecord.state
    }
  }

  const session = sessions.get(uuid)
  if (!session) {
    throw new Error('Session not found')
  }

  const now = Date.now()
  const timeRemainingSeconds = Math.max(0, Math.floor((session.expiresAt - now) / 1000))

  return {
    uuid,
    host: process.env.HOST_IP || '127.0.0.1',
    port: session.sshPort,
    user: 'labuser',
    privateKey: session.privateKey,
    expiresAt: session.expiresAt,
    timeRemainingSeconds,
    status: timeRemainingSeconds > 0 ? 'running' : 'expired'
  }
}

async function forceDestroyContainer(containerId) {
  const { stdout } = await podman(['inspect', containerId, '--format', '{{.Name}}'])
  const name = stdout.trim().replace(/^\//, '')
  const uuid = name.replace(/^lab-/, '')

  if (persistedLabs.isPersistedUuid(uuid)) {
    return persistedLabs.forceDeletePersistedLab(uuid)
  }

  const session = sessions.get(uuid)
  let sshPort = session ? session.sshPort : null
  if (!sshPort) {
    try {
      const { stdout: portOut } = await podman(['inspect', containerId, '--format', '{{(index (index .NetworkSettings.Ports "22/tcp") 0).HostPort}}'])
      sshPort = parseInt(portOut.trim(), 10) || null
    } catch { /* container may already be gone */ }
  }

  // Only log bandwidth when we have a real session (accurate createdAt for
  // duration). An orphaned container (service restarted, session map wiped)
  // has no reliable start time here, so skip rather than log a bogus rate.
  if (session) {
    try {
      const { bytesIn, bytesOut } = await getNetIoBytes(containerId)
      logSessionBandwidth({ uuid, bytesIn, bytesOut, durationSeconds: (Date.now() - session.createdAt) / 1000 })
    } catch { /* container unreachable - skip */ }
  }

  // Clean up bookkeeping before the slow teardown below - see
  // destroyContainer's comment on why the order matters.
  if (session) {
    if (session.timer) clearTimeout(session.timer)
    usedPorts.delete(session.sshPort)
    usedProjectIds.delete(session.projectId)
    sessions.delete(uuid)
    if (session.deviceId && deviceSessions.get(session.deviceId) === uuid) deviceSessions.delete(session.deviceId)
  }

  await podman(['rm', '-f', containerId])
  if (sshPort) await closeFirewallPort(sshPort)

  return { destroyed: true, containerId, containerName: name }
}

function isUuidConflict(uuid) {
  return sessions.has(uuid)
}

// Run once at startup (handles state left over from a crash/restart), then
// keep re-reconciling periodically. A one-time run only catches drift that
// existed at process start - a stray ufw rule left behind later (e.g. by a
// raw `podman rm -f` outside the app) would otherwise sit open on the
// internet indefinitely with nothing to notice it.
//
// Deliberately NOT called as a module-load side effect (require()-ing this
// file used to shell out to sudo/podman/ufw immediately) - the caller
// (server.js's start()) invokes this explicitly once the app is up, which
// also means this module can be required in a test without a live host.
function startBackgroundReconciliation() {
  reconcileFirewallRules()
  ensureEgressBlockRules()
  setInterval(reconcileFirewallRules, FIREWALL_RECONCILE_INTERVAL_MS)
  setInterval(ensureEgressBlockRules, FIREWALL_RECONCILE_INTERVAL_MS)
  // Persisted labs are meant to run continuously - a restart must not be
  // silent downtime for whatever's running inside (cron jobs etc.) until
  // the owner happens to reopen the app.
  persistedLabs.resumeAllOnBoot().catch(err => console.error('Boot-resume sweep failed:', err.message))
  persistedLabs.startSweeps(PERSISTED_LAB_SWEEP_INTERVAL_MS)
  startReverifySweep(ENTITLEMENT_REVERIFY_INTERVAL_MS)
}

module.exports = {
  provisionContainer,
  destroyContainer,
  forceDestroyContainer,
  getConnectionDetails,
  getStats,
  getDetailedStats,
  isUuidConflict,
  startBackgroundReconciliation
}
