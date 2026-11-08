'use strict'

const net = require('net')
const { getRecentActivity, getSuspiciousDevices } = require('../activity')
const { getEgressFirewallStatus } = require('../firewall-egress')
const { forceDestroyContainer, getDetailedStats } = require('../container-manager')
const { settings, saveSettings } = require('../settings')
const { checkAdminKey } = require('../lib/admin-auth')
const snapshotLog = require('../lib/snapshot-log')
const verifiedEntitlements = require('../lib/verified-entitlement-store')
const persistedLabStore = require('../lib/persisted-lab-store')
const persistedLabs = require('../lib/persisted-lab-lifecycle')

function isValidIp(str) {
  return typeof str === 'string' && net.isIP(str) !== 0
}

// All ADMIN_KEY-guarded routes (query ?key= or header x-admin-key) plus the
// /dashboard HTML page that drives them.
module.exports = async function adminRoutes(app) {
  app.get('/api/admin/stats', async (request, reply) => {
    if (checkAdminKey(request, reply) === false) return
    const stats = await getDetailedStats()
    return { success: true, data: stats }
  })

  app.delete('/api/admin/containers/:containerId', async (request, reply) => {
    if (checkAdminKey(request, reply) === false) return
    try {
      const result = await forceDestroyContainer(request.params.containerId)
      return { success: true, data: result }
    } catch (err) {
      return reply.code(500).send({ success: false, error: err.message })
    }
  })

  app.get('/api/admin/settings', async (request, reply) => {
    if (checkAdminKey(request, reply) === false) return
    return { success: true, data: settings }
  })

  app.post('/api/admin/settings', async (request, reply) => {
    if (checkAdminKey(request, reply) === false) return
    const { skipDebugPackages } = request.body || {}
    if (typeof skipDebugPackages === 'boolean') {
      settings.skipDebugPackages = skipDebugPackages
      saveSettings()
      return { success: true, data: settings }
    }
    return reply.code(400).send({
      success: false,
      error: 'Invalid request. Expected: { skipDebugPackages: boolean }'
    })
  })

  // ─────────────────────────────────────────────
  // GET  /api/admin/debug-whitelist        — list whitelisted IPs
  // POST /api/admin/debug-whitelist        — { add: ip } or { remove: ip }
  // ─────────────────────────────────────────────
  app.get('/api/admin/debug-whitelist', async (request, reply) => {
    if (checkAdminKey(request, reply) === false) return
    return { success: true, data: { ips: settings.debugWhitelistIps } }
  })

  app.post('/api/admin/debug-whitelist', async (request, reply) => {
    if (checkAdminKey(request, reply) === false) return
    const { add, remove } = request.body || {}

    if (add !== undefined) {
      if (!isValidIp(add)) {
        return reply.code(400).send({ success: false, error: 'Invalid IP address' })
      }
      if (!settings.debugWhitelistIps.includes(add)) settings.debugWhitelistIps.push(add)
      saveSettings()
      return { success: true, data: { ips: settings.debugWhitelistIps } }
    }

    if (remove !== undefined) {
      settings.debugWhitelistIps = settings.debugWhitelistIps.filter(ip => ip !== remove)
      saveSettings()
      return { success: true, data: { ips: settings.debugWhitelistIps } }
    }

    return reply.code(400).send({
      success: false,
      error: 'Invalid request. Expected: { add: ip } or { remove: ip }'
    })
  })

  // ─────────────────────────────────────────────
  // GET  /api/admin/session-limits        — { freeSessionMinutes, proSessionMinutes }
  // POST /api/admin/session-limits        — { freeSessionMinutes?, proSessionMinutes? }
  // Duration applied by provisionContainer at provision time; a change here
  // does not affect sessions already running, only ones created afterward.
  // ─────────────────────────────────────────────
  app.get('/api/admin/session-limits', async (request, reply) => {
    if (checkAdminKey(request, reply) === false) return
    return {
      success: true,
      data: {
        freeSessionMinutes: settings.freeSessionMinutes,
        proSessionMinutes: settings.proSessionMinutes
      }
    }
  })

  app.post('/api/admin/session-limits', async (request, reply) => {
    if (checkAdminKey(request, reply) === false) return
    const { freeSessionMinutes, proSessionMinutes } = request.body || {}

    if (freeSessionMinutes === undefined && proSessionMinutes === undefined) {
      return reply.code(400).send({
        success: false,
        error: 'Invalid request. Expected: { freeSessionMinutes?: number, proSessionMinutes?: number }'
      })
    }

    if (freeSessionMinutes !== undefined) {
      if (typeof freeSessionMinutes !== 'number' || freeSessionMinutes <= 0) {
        return reply.code(400).send({ success: false, error: 'freeSessionMinutes must be a positive number' })
      }
      settings.freeSessionMinutes = freeSessionMinutes
    }

    if (proSessionMinutes !== undefined) {
      if (typeof proSessionMinutes !== 'number' || proSessionMinutes <= 0) {
        return reply.code(400).send({ success: false, error: 'proSessionMinutes must be a positive number' })
      }
      settings.proSessionMinutes = proSessionMinutes
    }

    saveSettings()
    return {
      success: true,
      data: {
        freeSessionMinutes: settings.freeSessionMinutes,
        proSessionMinutes: settings.proSessionMinutes
      }
    }
  })

  // ─────────────────────────────────────────────
  // GET  /api/admin/pro-devices        — list deviceIds granted the pro duration
  // POST /api/admin/pro-devices        — { add: deviceId } or { remove: deviceId }
  // Stand-in for the real purchase/credits flow (not wired up yet): admin
  // marks a deviceId pro by hand, provisionContainer looks it up at
  // provision time to pick freeSessionMinutes vs proSessionMinutes.
  // ─────────────────────────────────────────────
  app.get('/api/admin/pro-devices', async (request, reply) => {
    if (checkAdminKey(request, reply) === false) return
    return { success: true, data: { deviceIds: settings.proDeviceIds } }
  })

  app.post('/api/admin/pro-devices', async (request, reply) => {
    if (checkAdminKey(request, reply) === false) return
    const { add, remove } = request.body || {}

    if (add !== undefined) {
      if (typeof add !== 'string' || !add || add.length > 128) {
        return reply.code(400).send({ success: false, error: 'Invalid deviceId' })
      }
      if (!settings.proDeviceIds.includes(add)) settings.proDeviceIds.push(add)
      saveSettings()
      return { success: true, data: { deviceIds: settings.proDeviceIds } }
    }

    if (remove !== undefined) {
      settings.proDeviceIds = settings.proDeviceIds.filter(id => id !== remove)
      saveSettings()
      return { success: true, data: { deviceIds: settings.proDeviceIds } }
    }

    return reply.code(400).send({
      success: false,
      error: 'Invalid request. Expected: { add: deviceId } or { remove: deviceId }'
    })
  })

  // ─────────────────────────────────────────────
  // GET  /api/admin/subscriber-devices        — list deviceIds with an active serverkit_pro_plus subscription
  // POST /api/admin/subscriber-devices        — { add: deviceId } or { remove: deviceId }
  // Stand-in for the real Play subscription verification flow (not wired
  // up yet), same as /api/admin/pro-devices always was for lifetime pro.
  // computeEntitlement (lib/entitlement.js) checks this before proDeviceIds
  // - an active subscriber always outranks the grandfathered lifetime-pro
  // phase they may also be in.
  // ─────────────────────────────────────────────
  app.get('/api/admin/subscriber-devices', async (request, reply) => {
    if (checkAdminKey(request, reply) === false) return
    return { success: true, data: { deviceIds: settings.subscriberDeviceIds } }
  })

  app.post('/api/admin/subscriber-devices', async (request, reply) => {
    if (checkAdminKey(request, reply) === false) return
    const { add, remove } = request.body || {}

    if (add !== undefined) {
      if (typeof add !== 'string' || !add || add.length > 128) {
        return reply.code(400).send({ success: false, error: 'Invalid deviceId' })
      }
      if (!settings.subscriberDeviceIds.includes(add)) settings.subscriberDeviceIds.push(add)
      saveSettings()
      return { success: true, data: { deviceIds: settings.subscriberDeviceIds } }
    }

    if (remove !== undefined) {
      settings.subscriberDeviceIds = settings.subscriberDeviceIds.filter(id => id !== remove)
      saveSettings()
      return { success: true, data: { deviceIds: settings.subscriberDeviceIds } }
    }

    return reply.code(400).send({
      success: false,
      error: 'Invalid request. Expected: { add: deviceId } or { remove: deviceId }'
    })
  })

  // ─────────────────────────────────────────────
  // GET  /api/admin/persisted-lab-config      — { persistedLabsEnabled, rolloutStartedAt, reclaimGraceDays }
  // POST /api/admin/persisted-lab-config      — any subset of the same fields
  // Drives lib/entitlement.js's grace-phase math and
  // lib/persisted-lab-lifecycle.js's reclaim sweep. A change here is picked
  // up on its next sweep tick, not retroactively for labs already mid-sweep.
  // Persisted labs have no idle-stop setting any more - they're meant to
  // run continuously, like a real always-on VPS.
  //
  // persistedLabsEnabled is the kill switch (default off) for rolling this
  // backend out before the app update that understands a persisted lab's
  // response shape has shipped - see lib/entitlement.js's own comment.
  // ─────────────────────────────────────────────
  app.get('/api/admin/persisted-lab-config', async (request, reply) => {
    if (checkAdminKey(request, reply) === false) return
    return {
      success: true,
      data: {
        persistedLabsEnabled: settings.persistedLabsEnabled,
        rolloutStartedAt: settings.rolloutStartedAt,
        reclaimGraceDays: settings.reclaimGraceDays
      }
    }
  })

  app.post('/api/admin/persisted-lab-config', async (request, reply) => {
    if (checkAdminKey(request, reply) === false) return
    const { persistedLabsEnabled, rolloutStartedAt, reclaimGraceDays } = request.body || {}

    if (persistedLabsEnabled !== undefined) {
      if (typeof persistedLabsEnabled !== 'boolean') {
        return reply.code(400).send({ success: false, error: 'persistedLabsEnabled must be a boolean' })
      }
      settings.persistedLabsEnabled = persistedLabsEnabled
    }

    if (rolloutStartedAt !== undefined) {
      if (typeof rolloutStartedAt !== 'string' || Number.isNaN(Date.parse(rolloutStartedAt))) {
        return reply.code(400).send({ success: false, error: 'rolloutStartedAt must be an ISO date string' })
      }
      settings.rolloutStartedAt = rolloutStartedAt
    }

    if (reclaimGraceDays !== undefined) {
      if (typeof reclaimGraceDays !== 'number' || reclaimGraceDays <= 0) {
        return reply.code(400).send({ success: false, error: 'reclaimGraceDays must be a positive number' })
      }
      settings.reclaimGraceDays = reclaimGraceDays
    }

    if (persistedLabsEnabled === undefined && rolloutStartedAt === undefined && reclaimGraceDays === undefined) {
      return reply.code(400).send({
        success: false,
        error: 'Invalid request. Expected any of: persistedLabsEnabled, rolloutStartedAt, reclaimGraceDays'
      })
    }

    saveSettings()
    return {
      success: true,
      data: {
        persistedLabsEnabled: settings.persistedLabsEnabled,
        rolloutStartedAt: settings.rolloutStartedAt,
        reclaimGraceDays: settings.reclaimGraceDays
      }
    }
  })

  // ─────────────────────────────────────────────
  // GET  /api/admin/verified-entitlements        — all real Play-verified
  //   purchase records (deviceId, kind, productId, active, timestamps).
  //   This is the actual anti-forgery ledger - distinct from the
  //   proDeviceIds/subscriberDeviceIds comp lists, which stay admin-only.
  // POST /api/admin/verified-entitlements/revoke — { deviceId } forces a
  //   record inactive immediately (abuse/chargeback), without waiting for
  //   the next re-verify sweep.
  // ─────────────────────────────────────────────
  app.get('/api/admin/verified-entitlements', async (request, reply) => {
    if (checkAdminKey(request, reply) === false) return
    return { success: true, data: { entitlements: verifiedEntitlements.all() } }
  })

  app.post('/api/admin/verified-entitlements/revoke', async (request, reply) => {
    if (checkAdminKey(request, reply) === false) return
    const { deviceId } = request.body || {}
    if (typeof deviceId !== 'string' || !deviceId) {
      return reply.code(400).send({ success: false, error: 'Invalid deviceId' })
    }
    const record = verifiedEntitlements.get(deviceId)
    if (!record) {
      return reply.code(404).send({ success: false, error: 'No verified entitlement for this deviceId' })
    }
    verifiedEntitlements.set(deviceId, { ...record, active: false })
    return { success: true, data: { deviceId, active: false } }
  })

  // ─────────────────────────────────────────────
  // GET /api/admin/snapshot-failures — recent failed R2 snapshot attempts.
  // A failed snapshot leaves the container running rather than stopping it
  // (see stopPersistedLab) - this is how an admin notices one is stuck
  // retrying instead of finding out only when a restore comes up empty.
  // ─────────────────────────────────────────────
  app.get('/api/admin/snapshot-failures', async (request, reply) => {
    if (checkAdminKey(request, reply) === false) return
    const limit = Number(request.query.limit) || 100
    return { success: true, data: { failures: snapshotLog.getRecentFailures(limit) } }
  })

  // ─────────────────────────────────────────────
  // GET  /api/admin/bans               — { deviceIds, ips }
  // POST /api/admin/bans               — { addDeviceId? } | { removeDeviceId? }
  //                                       | { addIp? } | { removeIp? }
  // Checked by provisionContainer before a session is created (both free and
  // pro - abuse-prevention is orthogonal to tier, see /api/labs/config's
  // tier split which is duration-only).
  // ─────────────────────────────────────────────
  app.get('/api/admin/bans', async (request, reply) => {
    if (checkAdminKey(request, reply) === false) return
    return { success: true, data: { deviceIds: settings.bannedDeviceIds, ips: settings.bannedIps } }
  })

  app.post('/api/admin/bans', async (request, reply) => {
    if (checkAdminKey(request, reply) === false) return
    const { addDeviceId, removeDeviceId, addIp, removeIp } = request.body || {}

    if (addDeviceId !== undefined) {
      if (typeof addDeviceId !== 'string' || !addDeviceId || addDeviceId.length > 128) {
        return reply.code(400).send({ success: false, error: 'Invalid deviceId' })
      }
      if (!settings.bannedDeviceIds.includes(addDeviceId)) settings.bannedDeviceIds.push(addDeviceId)
      saveSettings()
      return { success: true, data: { deviceIds: settings.bannedDeviceIds, ips: settings.bannedIps } }
    }

    if (removeDeviceId !== undefined) {
      settings.bannedDeviceIds = settings.bannedDeviceIds.filter(id => id !== removeDeviceId)
      saveSettings()
      return { success: true, data: { deviceIds: settings.bannedDeviceIds, ips: settings.bannedIps } }
    }

    if (addIp !== undefined) {
      if (!isValidIp(addIp)) {
        return reply.code(400).send({ success: false, error: 'Invalid IP address' })
      }
      if (!settings.bannedIps.includes(addIp)) settings.bannedIps.push(addIp)
      saveSettings()
      return { success: true, data: { deviceIds: settings.bannedDeviceIds, ips: settings.bannedIps } }
    }

    if (removeIp !== undefined) {
      settings.bannedIps = settings.bannedIps.filter(ip => ip !== removeIp)
      saveSettings()
      return { success: true, data: { deviceIds: settings.bannedDeviceIds, ips: settings.bannedIps } }
    }

    return reply.code(400).send({
      success: false,
      error: 'Invalid request. Expected one of: addDeviceId, removeDeviceId, addIp, removeIp'
    })
  })

  // ─────────────────────────────────────────────
  // GET /api/admin/activity        — recent provisioning events: ip, country,
  //                                   deviceId, uuid, tier, timestamp
  // GET /api/admin/suspicious      — deviceIds seen from more than one country
  //                                   (VPN/Tor-hopping signal)
  // GET /api/admin/firewall-status — live check that the outbound abuse-port
  //                                   DROP rules are actually in place
  // ─────────────────────────────────────────────
  app.get('/api/admin/activity', async (request, reply) => {
    if (checkAdminKey(request, reply) === false) return
    const limit = Number(request.query.limit) || 200
    return { success: true, data: { events: getRecentActivity(limit) } }
  })

  app.get('/api/admin/suspicious', async (request, reply) => {
    if (checkAdminKey(request, reply) === false) return
    return { success: true, data: { devices: getSuspiciousDevices() } }
  })

  app.get('/api/admin/firewall-status', async (request, reply) => {
    if (checkAdminKey(request, reply) === false) return
    const status = await getEgressFirewallStatus()
    return { success: true, data: status }
  })

  // ─────────────────────────────────────────────
  // GET    /api/admin/persisted-labs             — every persisted-lab-store
  //   record (deviceId, uuid, state, timestamps, snapshotKey). The
  //   authoritative list - unlike /api/admin/stats, this also shows labs
  //   that are reclaim_grace or purely R2-backed with no live container.
  // POST   /api/admin/persisted-labs/:uuid/resume — bring one back up now,
  //   regardless of its stored state (resume if merely stopped, restore
  //   from R2 if the local container/disk is gone).
  // DELETE /api/admin/persisted-labs/:uuid        — force-delete by uuid
  //   directly. Unlike DELETE /api/admin/containers/:containerId, this
  //   works even when there's no live container to inspect (purely
  //   R2-backed, or already in reclaim_grace).
  // ─────────────────────────────────────────────
  app.get('/api/admin/persisted-labs', async (request, reply) => {
    if (checkAdminKey(request, reply) === false) return
    return { success: true, data: { labs: persistedLabs.listPersistedLabs() } }
  })

  app.post('/api/admin/persisted-labs/:uuid/resume', async (request, reply) => {
    if (checkAdminKey(request, reply) === false) return
    try {
      const record = await persistedLabs.adminResumeLab(request.params.uuid)
      return { success: true, data: persistedLabStore.sanitize(record) }
    } catch (err) {
      const statusCode = err.message.includes('No persisted lab') ? 404 : 500
      return reply.code(statusCode).send({ success: false, error: err.message })
    }
  })

  app.delete('/api/admin/persisted-labs/:uuid', async (request, reply) => {
    if (checkAdminKey(request, reply) === false) return
    const result = await persistedLabs.forceDeletePersistedLab(request.params.uuid)
    if (!result) return reply.code(404).send({ success: false, error: 'No persisted lab for this uuid' })
    return { success: true, data: result }
  })
}
