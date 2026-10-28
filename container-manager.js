'use strict'

const { execFile } = require('child_process')
const { promisify } = require('util')
const execFileAsync = promisify(execFile)
const path = require('path')
const fs = require('fs')
const os = require('os')
const net = require('net')
const { settings } = require('./settings')
const { logProvision } = require('./activity')
const { ensureEgressBlockRules } = require('./firewall-egress')
const { logSessionBandwidth, getRollingAvgRateBytesPerSec } = require('./bandwidth-history')

// A container's current average rate above this multiple of the system's
// 28-day rolling baseline gets flagged red in the dashboard.
const BANDWIDTH_SPIKE_MULTIPLIER = 3

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

// Podman runs as this dedicated Linux user, not the app's own (iishanto/
// ubuntu, whichever is deploying). Two independent reasons:
//  1. Egress routing: the host has a WireGuard tunnel to an exit node, with
//     an `ip rule uidrange <runner-uid> table 200` policy route sending only
//     this user's traffic through it. pasta (podman's rootless network
//     backend) inherits whatever uid invoked podman for its own host-side
//     relay sockets — giving it a uid distinct from the app's own process
//     is what makes "only lab containers' egress is tunneled" possible
//     without touching the host's own default route or any pasta network
//     flags (both were tried first; pasta's --outbound-if4/-o flags turned
//     out to corrupt the guest's own address/routing setup under real
//     systemd+port-mapping containers, and changing the host's own default
//     route risked breaking the app's/CI's own outbound traffic).
//  2. Blast radius: a container breakout now lands as this low-value
//     dedicated user — whose home holds nothing but podman's own image
//     storage — instead of the account that owns the app, its secrets,
//     and the CI deploy key.
const RUNNER_USER = 'labrunner'

const MB = 1024 * 1024
const CONTAINER_MEMORY_LIMIT = 200 * MB      // 200MB RAM hard limit
const CONTAINER_MEMORY_SWAP  = 300 * MB      // 100MB swap headroom
const CONTAINER_CPU_QUOTA    = 50000         // 50% of one core (100000 = 1 core)
const CONTAINER_CPU_PERIOD   = 100000
const CONTAINER_DISK_LIMIT   = '2g'          // enforced via XFS project quota, see assignDiskQuota
const CONTAINER_PIDS_LIMIT   = 512           // cap total process/thread count
const PORT_RANGE_START = 32000
const PORT_RANGE_END = 33000
const FIREWALL_RECONCILE_INTERVAL_MS = 5 * 60 * 1000 // 5 minutes

// Podman's own --storage-opt size= (which this originally tried to use)
// needs to mknod a backing-device node to verify project-quota support -
// mknod requires a real root capability that labrunner's rootless uid
// doesn't have, so it always failed and silently fell back to no limit at
// all (confirmed live: a lab could write to the host's full free disk).
// Fix: a dedicated XFS-formatted loop image, mounted at this path with
// -o pquota, holds labrunner's whole podman graphroot (set in
// ~labrunner/.config/containers/storage.conf) instead of the host's own
// ext4 root (which has no project-quota feature at all). Assigning the
// quota itself is then done directly via xfs_quota as true root — sudo
// here is the app's own account (not `sudo -i -u labrunner`), since only
// real root can set an XFS project id/limit, sidestepping the mknod check
// entirely rather than needing labrunner to have it.
const LAB_STORAGE_MOUNT = '/mnt/lab-storage'
const PROJECT_ID_BASE = 5000
const usedProjectIds = new Set()

function nextProjectId() {
  for (let id = PROJECT_ID_BASE; id < PROJECT_ID_BASE + MAX_CONCURRENT * 2; id++) {
    if (!usedProjectIds.has(id)) {
      usedProjectIds.add(id)
      return id
    }
  }
  throw new Error('No available disk-quota project ids')
}

async function assignDiskQuota(containerId, projectId) {
  const { stdout } = await podman(['inspect', containerId, '--format', '{{.GraphDriver.Data.UpperDir}}'])
  const upperDir = stdout.trim()
  // Overlay's copy-up does: create the file under the layer's sibling
  // `work/` dir, then rename() it into `diff/` (the actual upperdir).
  // XFS refuses rename() across directories that carry DIFFERENT project
  // ids - live-verified this exact failure: tagging only `diff/` left
  // `work/` at project 0, so every copy-up (any new file/dir a lab user
  // creates under a path that still lives in a lower image layer, which
  // at container start is everything) failed with EXDEV, breaking even
  // plain `mkdir`/`apt-get`. Both siblings need the same project id.
  const workDir = `${path.dirname(upperDir)}/work`
  for (const dir of [upperDir, workDir]) {
    await execFileAsync('sudo', ['xfs_quota', '-x', '-c', `project -s -p ${dir} ${projectId}`, LAB_STORAGE_MOUNT])
  }
  await execFileAsync('sudo', ['xfs_quota', '-x', '-c', `limit -p bhard=${CONTAINER_DISK_LIMIT} ${projectId}`, LAB_STORAGE_MOUNT])
}

// Without these, `free`, `cat /proc/meminfo`, `nproc`, `lscpu` inside a
// container read the HOST's real numbers — /proc isn't cgroup-aware on its
// own, it's one shared kernel view. lxcfs (installed + running as a host
// service, mounting FUSE-backed virtual files at this path) computes these
// per the calling process's own cgroup limits instead. Bind-mounting them
// over the container's own /proc entries is what actually makes `free -h`
// inside a lab show its real 200MB limit instead of the host's full RAM.
const LXCFS_PROC_DIR = '/var/lib/lxcfs/proc'
const LXCFS_FILES = ['cpuinfo', 'meminfo', 'stat', 'diskstats', 'swaps', 'uptime', 'loadavg']
// lscpu reads online-CPU count from sysfs, not /proc/cpuinfo — lxcfs mirrors
// this path too, cgroup/cpuset-aware the same way.
const LXCFS_CPU_ONLINE = '/var/lib/lxcfs/sys/devices/system/cpu/online'

// lxcfs's virtual cpuinfo lists the right core COUNT for the cgroup's cpu
// quota, but `nproc` reads sched_getaffinity, not /proc/cpuinfo — it still
// needs an actual cpuset restriction to report anything other than the
// host's full core count. Round-robin one real core per container (rather
// than pinning everyone to core 0) so concurrent sessions spread across
// the host's cores instead of contending for one.
let cpusetRotation = 0
function nextCpusetCpu() {
  const cpu = cpusetRotation % os.cpus().length
  cpusetRotation++
  return cpu
}

// In-memory store: uuid -> session info
const sessions = new Map()

// deviceId -> uuid. Caps one active free session per device: without this,
// provisioning is anonymous-per-request (any caller just picks its own
// uuid), so closing the app and reopening it — or simply calling provision
// again with a fresh uuid — got a brand new 30-minute session for free with
// an old one still running. deviceId is a random id the client generates
// once and persists itself; this map is how the one-active-session rule is
// actually enforced, not merely assumed client-side.
const deviceSessions = new Map()

// Track which ports are in use
const usedPorts = new Set()

function podman(args) {
  // `sudo -i -u` (not plain `-u`) — without `-i` the child keeps the caller's
  // own cwd/HOME, which labrunner can't reach (the app's home dir is 0750,
  // not in labrunner's group); `-i` gives it a real login environment
  // (HOME, cwd, XDG_RUNTIME_DIR) under its own identity.
  return execFileAsync('sudo', ['-i', '-u', RUNNER_USER, 'podman', ...args], { maxBuffer: 10 * MB })
}

// Lab SSH ports (32000-33000) aren't open by default — ufw denies incoming
// by default and nothing else opens this range. Each port is opened only
// for the lifetime of its container and tagged with a comment so it can be
// identified/rolled back, including by the startup reconciliation below in
// case the process died before it got a chance to close a rule itself.
function firewallComment(uuid) {
  return `lab-${uuid}`
}

// Oracle (ORACLE_BASTION_IP) is the only path in: it DNATs public SSH
// traffic on this same port range through the WireGuard tunnel to this
// box's tunnel address. Scoping the allow to that source — instead of
// "Anywhere" — means a direct connection to this host's own real public
// IP on a lab port is refused by ufw's default-deny; the bastion is the
// only route that actually reaches it.
const ORACLE_BASTION_IP = '10.200.0.1'

async function openFirewallPort(uuid, port) {
  await execFileAsync('sudo', ['ufw', 'allow', 'from', ORACLE_BASTION_IP, 'to', 'any', 'port', String(port), 'proto', 'tcp', 'comment', firewallComment(uuid)])
}

async function closeFirewallPort(port) {
  // Must match openFirewallPort's rule spec exactly — ufw's `delete` deletes
  // by matching the full rule, not just the port.
  await execFileAsync('sudo', ['ufw', '--force', 'delete', 'allow', 'from', ORACLE_BASTION_IP, 'to', 'any', 'port', String(port), 'proto', 'tcp']).catch(() => {})
}

const SSH_READY_TIMEOUT_MS = 8000
const SSH_READY_POLL_INTERVAL_MS = 150

// Polls the published port over loopback (the actual bind podman set up,
// not a podman-exec check inside the container) until sshd accepts a raw
// TCP connection, or the timeout elapses. Never throws - if sshd genuinely
// never comes up in time, provisionContainer still returns its result
// rather than failing the whole request over a readiness check.
function waitForSshReady(port, timeoutMs = SSH_READY_TIMEOUT_MS) {
  return new Promise(resolve => {
    const deadline = Date.now() + timeoutMs

    function attempt() {
      const socket = net.createConnection({ port, host: '127.0.0.1' })
      const finish = ready => {
        socket.removeAllListeners()
        socket.destroy()
        if (ready || Date.now() >= deadline) return resolve()
        setTimeout(attempt, SSH_READY_POLL_INTERVAL_MS)
      }
      socket.once('connect', () => finish(true))
      socket.once('error', () => finish(false))
      socket.setTimeout(500, () => finish(false))
    }

    attempt()
  })
}

// On startup, sessions are empty (in-memory, wiped by every restart/deploy)
// but ufw rules and podman containers from before the restart may still
// exist, and can now disagree with each other. Reconcile both directions:
//  - a rule whose container is gone gets closed (crash before cleanup ran)
//  - a still-running container missing its rule gets opened (a session that
//    survived a restart, e.g. because the deploy hit mid-session, would
//    otherwise be silently unreachable from outside for the rest of its
//    lifetime with no way for the client to notice)
// Also repopulates usedPorts so a fresh process doesn't hand out a port a
// surviving container is already bound to.
async function reconcileFirewallRules() {
  try {
    const { stdout } = await podman(['ps', '-a', '--filter', 'name=^lab-', '--format', 'json'])
    const live = JSON.parse(stdout || '[]')
    const livePortByUuid = new Map()
    for (const info of live) {
      const name = (info.Names && info.Names[0]) || ''
      const uuid = name.replace(/^lab-/, '')
      const portEntry = (info.Ports || []).find(p => p.container_port === 22 || p.container_port === '22')
      if (portEntry) {
        livePortByUuid.set(uuid, portEntry.host_port)
        usedPorts.add(portEntry.host_port)
      }
    }

    const { stdout: ufwOut } = await execFileAsync('sudo', ['ufw', 'status'])
    const rulesByUuid = new Map(
      ufwOut
        .split('\n')
        .map(line => line.match(/^(\d+)\/tcp\b.*#\s*(lab-\S+)/))
        .filter(Boolean)
        .map(m => [m[2].replace(/^lab-/, ''), m[1]])
    )

    for (const [uuid, port] of rulesByUuid) {
      if (!livePortByUuid.has(uuid)) await closeFirewallPort(port)
    }
    for (const [uuid, port] of livePortByUuid) {
      if (!rulesByUuid.has(uuid)) await openFirewallPort(uuid, port)
    }
  } catch (err) {
    console.error('Firewall reconciliation failed:', err.message)
  }
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
    // labrunner (see RUNNER_USER above) can't read this path directly — the
    // app's home directory is 0750 and labrunner isn't in its group, so
    // traversal into it is blocked regardless of the docker/ dir's own
    // permissions. Stage a copy somewhere labrunner owns before building.
    const stagedContext = '/tmp/serverkit-lab-build'
    await execFileAsync('sudo', ['rm', '-rf', stagedContext])
    await execFileAsync('sudo', ['cp', '-r', dockerfilePath, stagedContext])
    await execFileAsync('sudo', ['chown', '-R', `${RUNNER_USER}:${RUNNER_USER}`, stagedContext])
    await podman(['build', '-t', IMAGE_NAME, stagedContext])
  }
}

async function createContainer(uuid, publicKey, sshPort) {
  const cpusetCpu = nextCpusetCpu()
  const lxcfsMounts = [
    ...LXCFS_FILES.flatMap(f => ['--mount', `type=bind,source=${LXCFS_PROC_DIR}/${f},destination=/proc/${f},ro=true`]),
    '--mount', `type=bind,source=${LXCFS_CPU_ONLINE},destination=/sys/devices/system/cpu/online,ro=true`
  ]

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
    '--cpuset-cpus', String(cpusetCpu),
    ...lxcfsMounts,
    // Without this, a fork bomb inside the container exhausts the host's
    // shared PID table — memory/cpu limits don't stop it, only pids-limit
    // does. 512 covers systemd + sshd + a normal interactive session with
    // headroom, while still bounding a runaway fork loop.
    '--pids-limit', String(CONTAINER_PIDS_LIMIT),
    // NET_ADMIN/NET_RAW let labuser run ufw/iptables inside their own lab.
    // Safe to grant: podman gives each container its own private network
    // namespace (pasta backend), so this only lets them manage their own
    // virtual interface — verified the host's real nft ruleset (563 rules)
    // was untouched after enabling ufw inside a test container. Unrelated
    // to device/cgroup isolation, which is governed separately and unchanged.
    '--cap-add', 'NET_ADMIN',
    '--cap-add', 'NET_RAW',
    '--tmpfs', '/run:rw,noexec,nosuid,size=65536k',
    '--tmpfs', '/run/lock:rw,noexec,nosuid,size=65536k',
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=128m',
    IMAGE_NAME
  ]

  const { stdout } = await podman(args)
  return stdout.trim()
}

async function provisionContainer(uuid, deviceId, ip) {
  if (sessions.has(uuid)) {
    throw new Error('UUID already exists')
  }

  if (deviceId && settings.bannedDeviceIds.includes(deviceId)) {
    throw new Error('This device is banned')
  }
  if (ip && settings.bannedIps.includes(ip)) {
    throw new Error('This IP is banned')
  }

  if (deviceId) {
    const existingUuid = deviceSessions.get(deviceId)
    const existingSession = existingUuid ? sessions.get(existingUuid) : null
    if (existingSession) {
      // Already has a live session — hand that one back instead of
      // starting a second one. Shaped like a fresh provision's result
      // (sshPort, not port — server.js's route reads result.sshPort).
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

  // Pro status is a stand-in for the real purchase/credits flow (not wired
  // up yet) — admin marks a deviceId pro by hand via /api/admin/pro-devices.
  const isPro = !!(deviceId && settings.proDeviceIds.includes(deviceId))
  const durationMs = (isPro ? settings.proSessionMinutes : settings.freeSessionMinutes) * 60 * 1000

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
  const session = sessions.get(uuid)
  if (!session) {
    return destroyOrphanedByUuid(uuid)
  }

  // Clear auto-termination timer if manually destroyed
  if (session.timer && !isAutoExpiry) {
    clearTimeout(session.timer)
  }

  // Capture final bandwidth before teardown — this is the only chance to
  // read it; the container is gone right after. Best-effort: a container
  // that already died on its own (crash, OOM) won't answer `stats`, and
  // that's fine, it just means this session doesn't contribute to the
  // rolling average rather than blocking its own cleanup.
  try {
    const { bytesIn, bytesOut } = await getNetIoBytes(session.containerId)
    logSessionBandwidth({ uuid, bytesIn, bytesOut, durationSeconds: (Date.now() - session.createdAt) / 1000 })
  } catch { /* container unreachable - skip */ }

  // Drop all bookkeeping FIRST, synchronously, before the slow teardown
  // below (podman rm, firewall close — real wall-clock time). Otherwise a
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
  const rollingAvgRateBytesPerSec = getRollingAvgRateBytesPerSec()

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
      const expiresAt = session ? session.expiresAt : createdAt + settings.freeSessionMinutes * 60 * 1000
      const timeRemainingSeconds = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000))

      const portEntry = (info.Ports || []).find(p => p.container_port === 22 || p.container_port === '22')
      const sshPort = session
        ? session.sshPort
        : (portEntry ? portEntry.host_port : null)

      const [netInStr, netOutStr] = String(stats.net_io || '0B / 0B').split('/')
      const netInBytes = parseBytesStr(netInStr)
      const netOutBytes = parseBytesStr(netOutStr)
      const netTotalBytes = netInBytes + netOutBytes
      const elapsedSeconds = Math.max(1, (Date.now() - createdAt) / 1000)
      const currentRateBytesPerSec = netTotalBytes / elapsedSeconds
      // No baseline yet (first sessions ever) → nothing to compare against,
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
        orphaned: !session, // running in Podman but not in sessions Map
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
        orphaned: !session,
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

// Parses one side of podman stats' "X / Y" strings (net_io, block_io) into
// raw bytes — same units podman prints for mem_usage, just not scaled to MB
// like parseMemToMB below since callers here want byte-level precision for
// small/idle containers.
function parseBytesStr(str) {
  const m = String(str).trim().match(/^([\d.]+)\s*([KMGT]?i?B)?$/i)
  if (!m) return 0
  const value = parseFloat(m[1])
  const unit = (m[2] || 'B').toUpperCase()
  const factors = { B: 1, KB: 1024, KIB: 1024, MB, MIB: MB, GB: MB * 1024, GIB: MB * 1024, TB: MB * 1024 * 1024, TIB: MB * 1024 * 1024 }
  return value * (factors[unit] || 1)
}

async function getNetIoBytes(containerId) {
  const { stdout } = await podman(['stats', '--no-stream', '--format', 'json', containerId])
  const stats = JSON.parse(stdout)[0]
  const [inStr, outStr] = String(stats.net_io || '0B / 0B').split('/')
  return { bytesIn: parseBytesStr(inStr), bytesOut: parseBytesStr(outStr) }
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

  const session = sessions.get(uuid)
  let sshPort = session ? session.sshPort : null
  if (!sshPort) {
    try {
      const { stdout: portOut } = await podman(['inspect', containerId, '--format', '{{(index (index .NetworkSettings.Ports "22/tcp") 0).HostPort}}'])
      sshPort = parseInt(portOut.trim(), 10) || null
    } catch { /* container may already be gone */ }
  }

  // Only log bandwidth when we have a real session (accurate createdAt for
  // duration). An orphaned container (service restarted, session map wiped
  // - see reconcileFirewallRules' comment on why this happens) has no
  // reliable start time here, so skip rather than log a bogus rate.
  if (session) {
    try {
      const { bytesIn, bytesOut } = await getNetIoBytes(containerId)
      logSessionBandwidth({ uuid, bytesIn, bytesOut, durationSeconds: (Date.now() - session.createdAt) / 1000 })
    } catch { /* container unreachable - skip */ }
  }

  // Clean up bookkeeping before the slow teardown below — see
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
// existed at process start — a stray ufw rule left behind later (e.g. by a
// raw `podman rm -f` outside the app, or any cleanup path that errors
// between removing the container and closing its port) would otherwise sit
// open on the internet indefinitely with nothing to notice it.
reconcileFirewallRules()
ensureEgressBlockRules()
setInterval(reconcileFirewallRules, FIREWALL_RECONCILE_INTERVAL_MS)
setInterval(ensureEgressBlockRules, FIREWALL_RECONCILE_INTERVAL_MS)

module.exports = {
  provisionContainer,
  destroyContainer,
  forceDestroyContainer,
  getConnectionDetails,
  getStats,
  getDetailedStats,
  isUuidConflict
}
