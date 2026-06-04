'use strict'

const Docker = require('dockerode')
const { execSync, exec } = require('child_process')
const { promisify } = require('util')
const execAsync = promisify(exec)
const crypto = require('crypto')
const path = require('path')
const fs = require('fs')
const os = require('os')

const docker = new Docker({ socketPath: '/var/run/docker.sock' })

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
  await execAsync(`ssh-keygen -t rsa -b 2048 -f ${keyPath} -N "" -C "serverkit-lab"`)
  const privateKey = fs.readFileSync(keyPath, 'utf8')
  const publicKey = fs.readFileSync(`${keyPath}.pub`, 'utf8')
  // Clean up temp files
  fs.rmSync(tmpDir, { recursive: true })
  return { privateKey, publicKey }
}

async function buildImageIfNeeded() {
  try {
    await docker.getImage(IMAGE_NAME).inspect()
    return // already exists
  } catch {
    // Image doesn't exist, build it
    const dockerfilePath = path.join(__dirname, 'docker')
    const stream = await docker.buildImage(
      { context: dockerfilePath, src: ['Dockerfile'] },
      { t: IMAGE_NAME }
    )
    await new Promise((resolve, reject) => {
      docker.modem.followProgress(stream, (err) => err ? reject(err) : resolve())
    })
  }
}

async function createContainerWithFallback(config) {
  try {
    return await docker.createContainer(config)
  } catch (err) {
    if (err.message && err.message.includes('storage')) {
      // StorageOpt not supported by this storage driver — retry without it
      const fallback = { ...config, HostConfig: { ...config.HostConfig } }
      delete fallback.HostConfig.StorageOpt
      return await docker.createContainer(fallback)
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

  const container = await createContainerWithFallback({
    Image: IMAGE_NAME,
    name: `lab-${uuid}`,
    Env: [
      `LAB_PUBLIC_KEY=${publicKey.trim()}`,
      `LAB_UUID=${uuid}`
    ],
    ExposedPorts: { '22/tcp': {} },
    HostConfig: {
      PortBindings: {
        '22/tcp': [{ HostPort: String(sshPort) }]
      },
      Privileged: true,
      Tmpfs: {
        '/run':      'rw,noexec,nosuid,size=65536k',
        '/run/lock': 'rw,noexec,nosuid,size=65536k',
        '/tmp':      'rw,noexec,nosuid,size=128m'
      },
      Memory:      CONTAINER_MEMORY_LIMIT,
      MemorySwap:  CONTAINER_MEMORY_SWAP,
      CpuQuota:    CONTAINER_CPU_QUOTA,
      CpuPeriod:   CONTAINER_CPU_PERIOD,
      StorageOpt:  { size: CONTAINER_DISK_LIMIT },
      NetworkMode: 'bridge'
    }
  })

  await container.start()

  const expiresAt = Date.now() + SESSION_DURATION_MS
  const session = {
    uuid,
    containerId: container.id,
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

  try {
    const container = docker.getContainer(session.containerId)
    await container.stop({ t: 3 }).catch(() => {}) // ignore if already stopped
    await container.remove({ force: true }).catch(() => {})
  } catch {
    // Container may already be gone — that's fine
  }

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

function isUuidConflict(uuid) {
  return sessions.has(uuid)
}

module.exports = {
  provisionContainer,
  destroyContainer,
  getConnectionDetails,
  getStats,
  isUuidConflict
}
