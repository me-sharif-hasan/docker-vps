'use strict'

const { execFile } = require('child_process')
const { promisify } = require('util')
const execFileAsync = promisify(execFile)
const path = require('path')
const fs = require('fs')
const os = require('os')

// Podman (not Docker) runs the lab containers. Reason: labs run full systemd
// as PID 1 (so labuser gets a real serviceable VPS, not just a bare shell),
// and systemd needs read-write control of its own cgroup subtree. Docker/runc
// only grants that via --privileged (which also hands the container every
// host device, e.g. real disks — the exact vulnerability this replaced) or
// --cgroupns=host (which shares the host's cgroup tree, letting a container
// tamper with unrelated host services' resource limits). Podman's
// --systemd=always uses crun's proper per-container cgroup delegation:
// systemd gets a writable, but genuinely isolated, cgroup view — verified
// manually that a container cannot reach any cgroup outside its own, and
// cannot mknod/mount any real device, all without Privileged or extra caps.
const IMAGE_NAME = 'serverkit-lab'
const MAX_CONCURRENT = 10
const SESSION_DURATION_MS = 30 * 60 * 1000 // 30 minutes

const MB = 1024 * 1024
const CONTAINER_MEMORY_LIMIT = 200 * MB      // 200MB RAM hard limit
const CONTAINER_MEMORY_SWAP  = 300 * MB      // 100MB swap headroom
const CONTAINER_CPU_QUOTA    = 50000         // 50% of one core (100000 = 1 core)
const CONTAINER_CPU_PERIOD   = 100000
const CONTAINER_DISK_LIMIT   = '2g'          // requires overlay2 + quota support
const PORT_RANGE_START = 32000
const PORT_RANGE_END = 33000

// In-memory store: uuid -> session info
const sessions = new Map()

// Track which ports are in use
const usedPorts = new Set()

function podman(args) {
  return execFileAsync('podman', args, { maxBuffer: 10 * MB })
}

function getRandomPort() {
  const available = []
  for (let p = PORT_RANGE_START; p <= PORT_RANGE_END; p++) {
    if (!usedPorts.has(p)) available.push(p)
  }
  if (available.length === 0) throw new Error('No available ports')
  return available[Math.floor(Math.random() * available.length)]
}

async function generateSshKeyPair() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-key-'))
  const keyPath = path.join(tmpDir, 'id_rsa')
  await execFileAsync('ssh-keygen', ['-t', 'rsa', '-b', '2048', '-f', keyPath, '-N', '', '-C', 'serverkit-lab'])
  const privateKey = fs.readFileSync(keyPath, 'utf8')
  const publicKey = fs.readFileSync(`${keyPath}.pub`, 'utf8')
  // Clean up temp files
  fs.rmSync(tmpDir, { recursive: true })
  return { privateKey, publicKey }
}

async function buildImageIfNeeded() {
  try {
    await podman(['image', 'inspect', IMAGE_NAME])
    return // already exists
  } catch {
    const dockerfilePath = path.join(__dirname, 'docker')
    await podman(['build', '-t', IMAGE_NAME, dockerfilePath])
  }
}

async function createContainer(uuid, publicKey, sshPort) {
  const args = [
    'run', '-d',
    '--name', `lab-${uuid}`,
    '--systemd', 'always',
    '-e', `LAB_PUBLIC_KEY=${publicKey.trim()}`,
    '-e', `LAB_UUID=${uuid}`,
    '-p', `${sshPort}:22`,
    '--memory', String(CONTAINER_MEMORY_LIMIT),
    '--memory-swap', String(CONTAINER_MEMORY_SWAP),
    '--cpus', String(CONTAINER_CPU_QUOTA / CONTAINER_CPU_PERIOD),
    '--tmpfs', '/run:rw,noexec,nosuid,size=65536k',
    '--tmpfs', '/run/lock:rw,noexec,nosuid,size=65536k',
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=128m',
    '--storage-opt', `size=${CONTAINER_DISK_LIMIT}`,
    IMAGE_NAME
  ]

  try {
    const { stdout } = await podman(args)
    return stdout.trim()
  } catch (err) {
    if (err.message && err.message.includes('storage')) {
      // storage-opt size not supported by this storage driver — retry without it
      const idx = args.indexOf('--storage-opt')
      const fallback = [...args.slice(0, idx), ...args.slice(idx + 2)]
      const { stdout } = await podman(fallback)
      return stdout.trim()
    }
    throw err
  }
}

async function provisionContainer(uuid) {
  if (sessions.has(uuid)) {
    throw new Error('UUID already exists')
  }

  if (sessions.size >= MAX_CONCURRENT) {
    throw new Error('Maximum concurrent sessions reached. Try again later.')
  }

  await buildImageIfNeeded()

  const { privateKey, publicKey } = await generateSshKeyPair()
  const sshPort = getRandomPort()
  usedPorts.add(sshPort)

  const containerId = await createContainer(uuid, publicKey, sshPort)

  const expiresAt = Date.now() + SESSION_DURATION_MS
  const session = {
    uuid,
    containerId,
    sshPort,
    privateKey,
    publicKey,
    createdAt: Date.now(),
    expiresAt,
    status: 'running'
  }

  sessions.set(uuid, session)

  // Auto-terminate after 30 mins
  const timer = setTimeout(() => destroyContainer(uuid, true), SESSION_DURATION_MS)
  session.timer = timer

  return {
    uuid,
    sshPort,
    privateKey,
    user: 'labuser',
    expiresAt,
    timeRemainingSeconds: 1800
  }
}

async function destroyContainer(uuid, isAutoExpiry = false) {
  const session = sessions.get(uuid)
  if (!session) {
    throw new Error('Session not found')
  }

  // Clear auto-termination timer if manually destroyed
  if (session.timer && !isAutoExpiry) {
    clearTimeout(session.timer)
  }

  await podman(['rm', '-f', session.containerId]).catch(() => {})

  usedPorts.delete(session.sshPort)
  sessions.delete(uuid)

  return { uuid, destroyed: true, reason: isAutoExpiry ? 'expired' : 'manual' }
}

function getConnectionDetails(uuid) {
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

function getStats() {
  return {
    activeSessions: sessions.size,
    maxConcurrent: MAX_CONCURRENT,
    availableSlots: MAX_CONCURRENT - sessions.size
  }
}

async function getDetailedStats() {
  // Query Podman directly — survives service restarts where sessions Map is empty
  const { stdout } = await podman([
    'ps', '-a', '--filter', 'name=^lab-', '--format', 'json'
  ])
  const running = JSON.parse(stdout || '[]')
  const containers = []

  for (const info of running) {
    const containerName = (info.Names && info.Names[0]) || ''
    const uuid = containerName.replace(/^lab-/, '')
    const session = sessions.get(uuid) // may be null if service restarted

    try {
      const { stdout: statsOut } = await podman([
        'stats', '--no-stream', '--format', 'json', info.Id
      ])
      const stats = JSON.parse(statsOut)[0]

      const cpuPercent = parseFloat(String(stats.cpu_percent || '0').replace('%', '')) || 0
      const [memUsageStr] = String(stats.mem_usage || '0B / 0B').split('/')
      const memUsageMB = parseMemToMB(memUsageStr)
      const memLimitMB = CONTAINER_MEMORY_LIMIT / MB

      const createdAt = info.Created * 1000
      const expiresAt = session ? session.expiresAt : createdAt + SESSION_DURATION_MS
      const timeRemainingSeconds = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000))

      const portEntry = (info.Ports || []).find(p => p.container_port === 22 || p.container_port === '22')
      const sshPort = session
        ? session.sshPort
        : (portEntry ? portEntry.host_port : null)

      containers.push({
        uuid,
        containerId: info.Id.slice(0, 12),
        fullContainerId: info.Id,
        containerName,
        sshPort,
        createdAt,
        expiresAt,
        timeRemainingSeconds,
        orphaned: !session, // running in Podman but not in sessions Map
        cpuPercent: parseFloat(cpuPercent.toFixed(2)),
        memUsageMB: parseFloat(memUsageMB.toFixed(1)),
        memLimitMB: parseFloat(memLimitMB.toFixed(1)),
        memPercent: parseFloat(((memUsageMB / memLimitMB) * 100).toFixed(1))
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
        orphaned: !session,
        cpuPercent: null,
        memUsageMB: null,
        memLimitMB: null,
        memPercent: null
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
    containers
  }
}

function parseMemToMB(str) {
  const m = String(str).trim().match(/^([\d.]+)\s*([KMGT]?i?B)?$/i)
  if (!m) return 0
  const value = parseFloat(m[1])
  const unit = (m[2] || 'B').toUpperCase()
  const factors = { B: 1, KB: 1024, KIB: 1024, MB: MB, MIB: MB, GB: MB * 1024, GIB: MB * 1024, TB: MB * 1024 * 1024, TIB: MB * 1024 * 1024 }
  const bytes = value * (factors[unit] || 1)
  return bytes / MB
}

async function forceDestroyContainer(containerId) {
  const { stdout } = await podman(['inspect', containerId, '--format', '{{.Name}}'])
  const name = stdout.trim().replace(/^\//, '')
  const uuid = name.replace(/^lab-/, '')

  await podman(['rm', '-f', containerId])

  // Clean up session if tracked
  if (sessions.has(uuid)) {
    const session = sessions.get(uuid)
    if (session.timer) clearTimeout(session.timer)
    usedPorts.delete(session.sshPort)
    sessions.delete(uuid)
  }

  return { destroyed: true, containerId, containerName: name }
}

function isUuidConflict(uuid) {
  return sessions.has(uuid)
}

module.exports = {
  provisionContainer,
  destroyContainer,
  forceDestroyContainer,
  getConnectionDetails,
  getStats,
  getDetailedStats,
  isUuidConflict
}
