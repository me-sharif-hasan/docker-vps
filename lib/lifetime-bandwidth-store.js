'use strict'

const fs = require('fs')
const path = require('path')

// Durable registry: uuid -> cumulative lifetime bytes transferred, across
// every container incarnation that uuid has ever had (fresh, resumed, or
// restored-from-snapshot).
//
// `podman stats`' net_io is cumulative since the CONTAINER OBJECT's own
// creation, not since the uuid first existed - it keeps counting across a
// plain stop/start (same object), but resets to 0 whenever a NEW container
// object is created for the same uuid (a restore-from-snapshot always
// creates one). Naively re-reading and adding that cumulative number on
// every observation would double-count everything already added before,
// and naively resetting on every observation would undercount by losing
// whatever a since-replaced container had already racked up.
//
// record() instead tracks, per uuid, the last containerId observed and the
// cumulative reading that came with it. Same containerId -> add only the
// delta since that reading. Different containerId (a new incarnation) ->
// the old container's own final reading was already folded in at its own
// last observation, so this new cumulative number is added in full, fresh.
const STORE_FILE = path.join(__dirname, '..', 'lifetime-bandwidth.json')

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

function get (uuid) {
  return records.get(uuid) || null
}

function record (uuid, containerId, cumulativeIn, cumulativeOut) {
  const existing = records.get(uuid) || {
    bytesIn: 0, bytesOut: 0, lastContainerId: null, lastCumulativeIn: 0, lastCumulativeOut: 0
  }

  const sameContainer = existing.lastContainerId === containerId
  const baseIn = sameContainer ? existing.lastCumulativeIn : 0
  const baseOut = sameContainer ? existing.lastCumulativeOut : 0

  existing.bytesIn += Math.max(0, cumulativeIn - baseIn)
  existing.bytesOut += Math.max(0, cumulativeOut - baseOut)
  existing.lastContainerId = containerId
  existing.lastCumulativeIn = cumulativeIn
  existing.lastCumulativeOut = cumulativeOut

  records.set(uuid, existing)
  save()
  return existing
}

function remove (uuid) {
  records.delete(uuid)
  save()
}

module.exports = { get, record, remove }
