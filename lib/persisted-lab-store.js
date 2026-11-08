'use strict'

const fs = require('fs')
const path = require('path')

// Durable registry: deviceId -> persisted lab record. Unlike
// session-store.js's in-memory maps (deliberately wiped every restart -
// ephemeral labs have nothing worth keeping), this one MUST survive a
// restart: a persisted lab's whole point is that the owner's disk sticks
// around across app restarts and host reboots, so the record of which
// container belongs to which device has to as well.
//
// Record shape:
//   { deviceId, uuid, containerId, sshPort, projectId, publicKey,
//     privateKey, state, createdAt, lastSeenAt, reclaimGraceStartedAt,
//     snapshotKey }
// state one of: 'running' | 'stopped' | 'reclaim_grace' | 'deleted'

const STORE_FILE = path.join(__dirname, '..', 'persisted-labs.json')

function load () {
  try {
    const raw = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'))
    return new Map(Object.entries(raw))
  } catch {
    return new Map()
  }
}

const records = load()

function save () {
  fs.writeFileSync(STORE_FILE, JSON.stringify(Object.fromEntries(records), null, 2))
}

function get (deviceId) {
  return records.get(deviceId) || null
}

function set (deviceId, record) {
  records.set(deviceId, record)
  save()
}

function remove (deviceId) {
  records.delete(deviceId)
  save()
}

function all () {
  return Array.from(records.values())
}

function findByUuid (uuid) {
  for (const record of records.values()) {
    if (record.uuid === uuid) return record
  }
  return null
}

// Strips the SSH keypair before a record leaves the process (admin API
// responses) - the rest of the record (uuid, state, timestamps, snapshot
// key) is fine for an admin to see, the keypair is not.
function sanitize (record) {
  const { privateKey, publicKey, ...rest } = record
  return rest
}

// Moves a persisted lab's ownership from one deviceId to another - same
// uuid, container, snapshot, everything untouched. Used when a Play
// purchase restore proves a fresh install (new deviceId, since
// flutter_secure_storage is wiped on uninstall) is the same owner as an
// old one. No-op if there's nothing under oldDeviceId, or they're already
// the same key.
function rebindDevice (oldDeviceId, newDeviceId) {
  if (oldDeviceId === newDeviceId) return null
  const record = records.get(oldDeviceId)
  if (!record) return null
  records.delete(oldDeviceId)
  record.deviceId = newDeviceId
  records.set(newDeviceId, record)
  save()
  return record
}

module.exports = { get, set, remove, all, findByUuid, sanitize, rebindDevice }
