'use strict'

const { execFile } = require('child_process')
const { promisify } = require('util')
const execFileAsync = promisify(execFile)
const { podman } = require('./podman-client')
const { PORT_RANGE_START, PORT_RANGE_END, ORACLE_BASTION_IP } = require('./constants')

// Track which ports are in use. Exported directly (mutable module state,
// same pattern session-store.js uses) - lifecycle code adds/removes entries
// as sessions come and go.
const usedPorts = new Set()

function getRandomPort() {
  const available = []
  for (let p = PORT_RANGE_START; p <= PORT_RANGE_END; p++) {
    if (!usedPorts.has(p)) available.push(p)
  }
  if (available.length === 0) throw new Error('No available ports')
  return available[Math.floor(Math.random() * available.length)]
}

// Lab SSH ports aren't open by default - ufw denies incoming by default and
// nothing else opens this range. Each port is opened only for the lifetime
// of its container and tagged with a comment so it can be identified/rolled
// back, including by reconcileFirewallRules below in case the process died
// before it got a chance to close a rule itself.
function firewallComment(uuid) {
  return `lab-${uuid}`
}

async function openFirewallPort(uuid, port) {
  await execFileAsync('sudo', ['ufw', 'allow', 'from', ORACLE_BASTION_IP, 'to', 'any', 'port', String(port), 'proto', 'tcp', 'comment', firewallComment(uuid)])
}

async function closeFirewallPort(port) {
  // Must match openFirewallPort's rule spec exactly - ufw's `delete` deletes
  // by matching the full rule, not just the port.
  await execFileAsync('sudo', ['ufw', '--force', 'delete', 'allow', 'from', ORACLE_BASTION_IP, 'to', 'any', 'port', String(port), 'proto', 'tcp']).catch(() => {})
}

// Reconciles ufw rules against live containers in both directions:
//  - a rule whose container is gone gets closed (crash before cleanup ran)
//  - a still-running container missing its rule gets opened (a session that
//    survived a restart would otherwise sit unreachable with no way for the
//    client to notice)
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

module.exports = {
  usedPorts,
  getRandomPort,
  firewallComment,
  openFirewallPort,
  closeFirewallPort,
  reconcileFirewallRules
}
