'use strict'

const fs = require('fs')
const path = require('path')

// Every snapshot attempt gets a row here - success or failure. Without
// this, a silently-failing upload for one user is invisible until the
// exact moment their disk dies and the restore comes up empty. Capped so
// the file doesn't grow unbounded; old entries roll off.
const LOG_FILE = path.join(__dirname, '..', 'snapshot-log.json')
const MAX_ENTRIES = 2000

function load () {
  try {
    return JSON.parse(fs.readFileSync(LOG_FILE, 'utf8'))
  } catch {
    return []
  }
}

let entries = load()

function save () {
  fs.writeFileSync(LOG_FILE, JSON.stringify(entries, null, 2))
}

function recordAttempt ({ uuid, status, key, sizeBytes, error }) {
  entries.push({
    uuid,
    status, // 'success' | 'failure'
    key: key || null,
    sizeBytes: sizeBytes ?? null,
    error: error || null,
    timestamp: Date.now()
  })
  if (entries.length > MAX_ENTRIES) entries = entries.slice(-MAX_ENTRIES)
  save()
}

function getRecent (limit = 100) {
  return entries.slice(-limit).reverse()
}

function getRecentFailures (limit = 100) {
  return entries.filter(e => e.status === 'failure').slice(-limit).reverse()
}

module.exports = { recordAttempt, getRecent, getRecentFailures }
