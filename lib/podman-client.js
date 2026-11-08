'use strict'

const { execFile, spawn } = require('child_process')
const { promisify } = require('util')
const execFileAsync = promisify(execFile)
const path = require('path')
const fs = require('fs')
const os = require('os')
const net = require('net')
const {
  MB, IMAGE_NAME, RUNNER_USER, CONTAINER_MEMORY_LIMIT, CONTAINER_MEMORY_SWAP,
  CONTAINER_CPU_QUOTA, CONTAINER_CPU_PERIOD, CONTAINER_PIDS_LIMIT,
  LXCFS_PROC_DIR, LXCFS_FILES, LXCFS_CPU_ONLINE,
  SSH_READY_TIMEOUT_MS, SSH_READY_POLL_INTERVAL_MS
} = require('./constants')

// Podman (not Docker) runs the lab containers. Reason: labs run full systemd
// as PID 1 (so labuser gets a real serviceable VPS, not just a bare shell),
// and systemd needs read-write control of its own cgroup subtree. Docker/runc
// only grants that via --privileged (which also hands the container every
// host device, e.g. real disks - the exact vulnerability this replaced) or
// --cgroupns=host (which shares the host's cgroup tree, letting a container
// tamper with unrelated host services' resource limits). Podman's
// --systemd=always uses crun's proper per-container cgroup delegation:
// systemd gets a writable, but genuinely isolated, cgroup view - verified
// manually that a container cannot reach any cgroup outside its own, and
// cannot mknod/mount any real device, all without Privileged or extra caps.

function podman(args) {
  // `sudo -i -u` (not plain `-u`) - without `-i` the child keeps the caller's
  // own cwd/HOME, which labrunner can't reach (the app's home dir is 0750,
  // not in labrunner's group); `-i` gives it a real login environment
  // (HOME, cwd, XDG_RUNTIME_DIR) under its own identity.
  return execFileAsync('sudo', ['-i', '-u', RUNNER_USER, 'podman', ...args], { maxBuffer: 10 * MB })
}

async function buildImageIfNeeded() {
  try {
    await podman(['image', 'inspect', IMAGE_NAME])
    return
  } catch {
    const dockerfilePath = path.join(__dirname, '..', 'docker')
    // labrunner can't read this path directly - the app's home directory is
    // 0750 and labrunner isn't in its group, so traversal into it is
    // blocked regardless of the docker/ dir's own permissions. Stage a copy
    // somewhere labrunner owns before building.
    const stagedContext = '/tmp/serverkit-lab-build'
    await execFileAsync('sudo', ['rm', '-rf', stagedContext])
    await execFileAsync('sudo', ['cp', '-r', dockerfilePath, stagedContext])
    await execFileAsync('sudo', ['chown', '-R', `${RUNNER_USER}:${RUNNER_USER}`, stagedContext])
    await podman(['build', '-t', IMAGE_NAME, stagedContext])
  }
}

async function generateSshKeyPair() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-key-'))
  const keyPath = path.join(tmpDir, 'id_rsa')
  await execFileAsync('ssh-keygen', ['-t', 'rsa', '-b', '2048', '-f', keyPath, '-N', '', '-C', 'serverkit-lab'])
  const privateKey = fs.readFileSync(keyPath, 'utf8')
  const publicKey = fs.readFileSync(`${keyPath}.pub`, 'utf8')
  fs.rmSync(tmpDir, { recursive: true })
  return { privateKey, publicKey }
}

// Round-robin one real core per container (rather than pinning everyone to
// core 0) so concurrent sessions spread across the host's cores instead of
// contending for one. lxcfs's virtual cpuinfo lists the right core COUNT for
// the cgroup's cpu quota, but `nproc` reads sched_getaffinity, not
// /proc/cpuinfo - it still needs an actual cpuset restriction to report
// anything other than the host's full core count.
let cpusetRotation = 0
function nextCpusetCpu() {
  const cpu = cpusetRotation % os.cpus().length
  cpusetRotation++
  return cpu
}

// [imageName] defaults to the stock lab image; a restored persisted lab
// passes the one-off image `podman import` built from its R2 snapshot
// instead, so the container starts from the owner's actual disk content.
async function createContainer(uuid, publicKey, sshPort, imageName = IMAGE_NAME) {
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
    // shared PID table - memory/cpu limits don't stop it, only pids-limit
    // does. 512 covers systemd + sshd + a normal interactive session with
    // headroom, while still bounding a runaway fork loop.
    '--pids-limit', String(CONTAINER_PIDS_LIMIT),
    // NET_ADMIN/NET_RAW let labuser run ufw/iptables inside their own lab.
    // Safe to grant: podman gives each container its own private network
    // namespace (pasta backend), so this only lets them manage their own
    // virtual interface - verified the host's real nft ruleset was
    // untouched after enabling ufw inside a test container.
    '--cap-add', 'NET_ADMIN',
    '--cap-add', 'NET_RAW',
    '--tmpfs', '/run:rw,noexec,nosuid,size=65536k',
    '--tmpfs', '/run/lock:rw,noexec,nosuid,size=65536k',
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=128m',
    imageName
  ]

  const { stdout } = await podman(args)
  return stdout.trim()
}

// Polls the published port over loopback (the actual bind podman set up,
// not a podman-exec check inside the container) until sshd accepts a raw
// TCP connection, or the timeout elapses. Never throws - if sshd genuinely
// never comes up in time, the caller still returns its result rather than
// failing the whole request over a readiness check.
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

// Streams a container's merged filesystem as a tar - used to snapshot a
// persisted lab to R2 without buffering the whole tar on local disk or in
// memory first. Returns the child process so the caller can also watch
// its exit code/stderr, not just the stdout stream.
function exportContainerStream(containerId) {
  const child = spawn('sudo', ['-i', '-u', RUNNER_USER, 'podman', 'export', containerId])
  return child
}

async function containerState(containerName) {
  try {
    const { stdout } = await podman(['inspect', containerName, '--format', '{{.State.Running}}'])
    return stdout.trim() === 'true' ? 'running' : 'stopped'
  } catch {
    return 'missing'
  }
}

// Imports a tar (a prior `podman export`, e.g. restored from an R2
// snapshot) as a new local image, tagged for one-off use by a single
// restore - the caller removes the tag again once the container is up.
//
// `podman export` captures only the filesystem, not the original image's
// config (CMD/ENTRYPOINT, STOPSIGNAL, etc.) - confirmed live: importing a
// snapshot with no --change flags produced a container with no startup
// command at all ("crun: cannot find \`\` in $PATH"). These --change
// flags must mirror docker/Dockerfile's own CMD/STOPSIGNAL exactly, or a
// restored lab silently fails to boot.
async function importImage(tarPath, imageTag) {
  await podman([
    'import',
    '--change', 'CMD ["/entrypoint.sh"]',
    '--change', 'STOPSIGNAL SIGRTMIN+3',
    tarPath, imageTag
  ])
}

module.exports = {
  podman,
  buildImageIfNeeded,
  generateSshKeyPair,
  createContainer,
  waitForSshReady,
  containerState,
  importImage,
  exportContainerStream
}
