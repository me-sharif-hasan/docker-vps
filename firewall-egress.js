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

// This host has both nft and legacy iptables backends; the bare `iptables`
// command resolves (via update-alternatives) to the nft-compat one, which
// is NOT where ufw or real traffic actually lands (verified: its OUTPUT
// chain saw 3 packets total vs iptables-legacy's 300k+) - rules added
// through plain `iptables` are therefore silently inert. Target the legacy
// binaries explicitly so these rules land in the chains traffic really
// flows through — both of them: a live test (holding an SMTP connection
// open and checking `ss -tnp` on the host) showed pasta relaying it over
// IPv6 (smtp.gmail.com resolves dual-stack and this host prefers v6),
// which an IPv4-only rule never sees at all.
const IPTABLES_BINS = ['iptables-legacy', 'ip6tables-legacy']

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

async function ruleExists (bin, port) {
  try {
    await execFileAsync('sudo', [bin, '-C', ...ruleArgs(port)])
    return true
  } catch {
    return false
  }
}

// Idempotent: safe to call on every startup/reconcile tick without piling
// up duplicate rules.
async function ensureEgressBlockRules () {
  for (const bin of IPTABLES_BINS) {
    for (const port of ABUSE_PORTS) {
      try {
        if (!(await ruleExists(bin, port))) {
          await execFileAsync('sudo', [bin, '-A', ...ruleArgs(port)])
        }
      } catch (err) {
        console.error(`Egress block rule failed for ${bin} port ${port}:`, err.message)
      }
    }
  }
}

// For the admin panel's "verify it's actually active" check — reports which
// of the expected ports currently have a matching DROP rule in BOTH stacks,
// so a failed `sudo` or a missing v4/v6 rule is visible instead of silently
// leaving the host unprotected.
async function getEgressFirewallStatus () {
  const ports = await Promise.all(
    ABUSE_PORTS.map(async port => {
      const v4 = await ruleExists('iptables-legacy', port)
      const v6 = await ruleExists('ip6tables-legacy', port)
      return { port, blocked: v4 && v6, v4, v6 }
    })
  )
  return {
    runnerUser: RUNNER_USER,
    allActive: ports.every(p => p.blocked),
    ports
  }
}

module.exports = { ensureEgressBlockRules, getEgressFirewallStatus, ABUSE_PORTS }
