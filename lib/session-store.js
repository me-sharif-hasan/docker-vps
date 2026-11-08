'use strict'

// In-memory session state: uuid -> session info, and deviceId -> uuid (caps
// one active free session per device - see provisionContainer's caller for
// why that cap exists at all). Wiped by every app restart/deploy; podman
// containers themselves keep running regardless - see firewall-ports.js's
// reconcileFirewallRules and container-manager.js's destroyOrphanedByUuid
// for how a session surviving past its in-memory record gets handled.
const sessions = new Map()
const deviceSessions = new Map()

module.exports = {
  sessions,
  deviceSessions
}
