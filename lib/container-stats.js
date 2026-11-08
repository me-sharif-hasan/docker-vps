'use strict'

const { podman } = require('./podman-client')
const { sessions } = require('./session-store')
const persistedLabStore = require('./persisted-lab-store')
const { settings } = require('../settings')
const { getRollingAvgRateBytesPerSec } = require('../bandwidth-history')
const { MB, MAX_CONCURRENT, CONTAINER_MEMORY_LIMIT, BANDWIDTH_SPIKE_MULTIPLIER } = require('./constants')

// Parses one side of podman stats' "X / Y" strings (net_io, block_io) into
// raw bytes - same units podman prints for mem_usage, just not scaled to MB
// like parseMemToMB since callers here want byte-level precision for
// small/idle containers.
function parseBytesStr(str) {
  const m = String(str).trim().match(/^([\d.]+)\s*([KMGT]?i?B)?$/i)
  if (!m) return 0
  const value = parseFloat(m[1])
  const unit = (m[2] || 'B').toUpperCase()
  const factors = { B: 1, KB: 1024, KIB: 1024, MB, MIB: MB, GB: MB * 1024, GIB: MB * 1024, TB: MB * 1024 * 1024, TIB: MB * 1024 * 1024 }
  return value * (factors[unit] || 1)
}

function parseMemToMB(str) {
  const bytes = parseBytesStr(str)
  return bytes / MB
}

async function getNetIoBytes(containerId) {
  const { stdout } = await podman(['stats', '--no-stream', '--format', 'json', containerId])
  const stats = JSON.parse(stdout)[0]
  const [inStr, outStr] = String(stats.net_io || '0B / 0B').split('/')
  return { bytesIn: parseBytesStr(inStr), bytesOut: parseBytesStr(outStr) }
}

function getStats() {
  return {
    activeSessions: sessions.size,
    maxConcurrent: MAX_CONCURRENT,
    availableSlots: MAX_CONCURRENT - sessions.size
  }
}

async function getDetailedStats() {
  // Query Podman directly - survives service restarts where sessions Map is empty.
  const { stdout } = await podman(['ps', '-a', '--filter', 'name=^lab-', '--format', 'json'])
  const running = JSON.parse(stdout || '[]')
  const containers = []
  const rollingAvgRateBytesPerSec = getRollingAvgRateBytesPerSec()

  for (const info of running) {
    const containerName = (info.Names && info.Names[0]) || ''
    const uuid = containerName.replace(/^lab-/, '')
    const session = sessions.get(uuid) // may be null if service restarted
    // Persisted labs live in their own durable store, not the ephemeral
    // sessions Map (see persisted-lab-store.js) - checking only `session`
    // for "orphaned" made every persisted lab show as orphaned after any
    // app restart, even though it's correctly tracked, just elsewhere.
    const persistedRecord = persistedLabStore.findByUuid(uuid)
    const tracked = session || persistedRecord

    try {
      const { stdout: statsOut } = await podman(['stats', '--no-stream', '--format', 'json', info.Id])
      const stats = JSON.parse(statsOut)[0]

      const cpuPercent = parseFloat(String(stats.cpu_percent || '0').replace('%', '')) || 0
      const [memUsageStr] = String(stats.mem_usage || '0B / 0B').split('/')
      const memUsageMB = parseMemToMB(memUsageStr)
      const memLimitMB = CONTAINER_MEMORY_LIMIT / MB

      const createdAt = info.Created * 1000
      const expiresAt = persistedRecord ? null
        : session ? session.expiresAt
        : createdAt + settings.freeSessionMinutes * 60 * 1000
      const timeRemainingSeconds = expiresAt == null ? null : Math.max(0, Math.floor((expiresAt - Date.now()) / 1000))

      const portEntry = (info.Ports || []).find(p => p.container_port === 22 || p.container_port === '22')
      const sshPort = tracked ? tracked.sshPort : (portEntry ? portEntry.host_port : null)

      const [netInStr, netOutStr] = String(stats.net_io || '0B / 0B').split('/')
      const netInBytes = parseBytesStr(netInStr)
      const netOutBytes = parseBytesStr(netOutStr)
      const netTotalBytes = netInBytes + netOutBytes
      const elapsedSeconds = Math.max(1, (Date.now() - createdAt) / 1000)
      const currentRateBytesPerSec = netTotalBytes / elapsedSeconds
      // No baseline yet (first sessions ever) -> nothing to compare against,
      // so don't flag anything rather than treat zero as "infinitely over".
      const isBandwidthSpiking = rollingAvgRateBytesPerSec != null &&
        currentRateBytesPerSec > rollingAvgRateBytesPerSec * BANDWIDTH_SPIKE_MULTIPLIER

      containers.push({
        uuid,
        containerId: info.Id.slice(0, 12),
        fullContainerId: info.Id,
        containerName,
        sshPort,
        createdAt,
        expiresAt,
        timeRemainingSeconds,
        orphaned: !tracked, // running in Podman but not in sessions Map or persisted-lab-store
        persisted: !!persistedRecord,
        cpuPercent: parseFloat(cpuPercent.toFixed(2)),
        memUsageMB: parseFloat(memUsageMB.toFixed(1)),
        memLimitMB: parseFloat(memLimitMB.toFixed(1)),
        memPercent: parseFloat(((memUsageMB / memLimitMB) * 100).toFixed(1)),
        netInBytes,
        netOutBytes,
        netTotalBytes,
        currentRateBytesPerSec: Math.round(currentRateBytesPerSec),
        isBandwidthSpiking
      })
    } catch {
      containers.push({
        uuid,
        containerId: info.Id.slice(0, 12),
        fullContainerId: info.Id,
        containerName,
        sshPort: null,
        createdAt: info.Created * 1000,
        expiresAt: null,
        timeRemainingSeconds: null,
        orphaned: !tracked,
        persisted: !!persistedRecord,
        cpuPercent: null,
        memUsageMB: null,
        memLimitMB: null,
        memPercent: null,
        netInBytes: null,
        netOutBytes: null,
        netTotalBytes: null,
        currentRateBytesPerSec: null,
        isBandwidthSpiking: false
      })
    }
  }

  const totalMemMB = containers.reduce((s, c) => s + (c.memUsageMB || 0), 0)
  const totalCpu = containers.reduce((s, c) => s + (c.cpuPercent || 0), 0)
  const activeCount = running.length

  return {
    activeSessions: activeCount,
    maxConcurrent: MAX_CONCURRENT,
    availableSlots: Math.max(0, MAX_CONCURRENT - activeCount),
    totalMemUsageMB: parseFloat(totalMemMB.toFixed(1)),
    totalCpuPercent: parseFloat(totalCpu.toFixed(2)),
    rollingAvgRateBytesPerSec: rollingAvgRateBytesPerSec != null ? Math.round(rollingAvgRateBytesPerSec) : null,
    containers
  }
}

module.exports = {
  parseBytesStr,
  parseMemToMB,
  getNetIoBytes,
  getStats,
  getDetailedStats
}
