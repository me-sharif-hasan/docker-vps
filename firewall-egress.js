'use strict'

const { execFile } = require('child_process')
const { promisify } = require('util')
const execFileAsync = promisify(execFile)

// Must match RUNNER_USER in container-manager.js — pasta (podman's rootless
// network backend) opens its host-side relay sockets under whichever uid
// invoked podman, so matching on this uid's outbound sockets scopes these
// DROP rules to lab-container traffic only, and lives entirely on the host
// side: a lab container's own root/NET_ADMIN cap (granted for the user's own
// in-container ufw/iptables practice) cannot see or touch the host's OUTPUT
// chain, so it cannot undo these rules.
const RUNNER_USER = 'labrunner'

// 25/465/587: direct SMTP — the #1 throwaway-VM spam vector.
// 6667/6697: IRC — legacy botnet C2.
// 445/139: SMB — internal network scanning/worm spread.
// 23: telnet — IoT botnet scanning.
// Not exhaustive (a determined user can still tunnel any of this inside an
// allowed port like 443) but it stops casual/automated abuse cheaply.
const ABUSE_PORTS = [25, 465, 587, 6667, 6697, 445, 139, 23]

function ruleArgs (port) {
  return ['OUTPUT', '-m', 'owner', '--uid-owner', RUNNER_USER, '-p', 'tcp', '--dport', String(port), '-j', 'DROP']
}

async function ruleExists (port) {
  try {
    await execFileAsync('sudo', ['iptables', '-C', ...ruleArgs(port)])
    return true
  } catch {
    return false
  }
}

// Idempotent: safe to call on every startup/reconcile tick without piling
// up duplicate rules.
async function ensureEgressBlockRules () {
  for (const port of ABUSE_PORTS) {
    try {
      if (!(await ruleExists(port))) {
        await execFileAsync('sudo', ['iptables', '-A', ...ruleArgs(port)])
      }
    } catch (err) {
      console.error(`Egress block rule failed for port ${port}:`, err.message)
    }
  }
}

// For the admin panel's "verify it's actually active" check — reports which
// of the expected ports currently have a matching DROP rule, so a failed
// `sudo` (e.g. sudoers misconfigured after a box rebuild) is visible instead
// of silently leaving the host unprotected.
async function getEgressFirewallStatus () {
  const ports = await Promise.all(
    ABUSE_PORTS.map(async port => ({ port, blocked: await ruleExists(port) }))
  )
  return {
    runnerUser: RUNNER_USER,
    allActive: ports.every(p => p.blocked),
    ports
  }
}

module.exports = { ensureEgressBlockRules, getEgressFirewallStatus, ABUSE_PORTS }
