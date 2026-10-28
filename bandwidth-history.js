'use strict'

const fs = require('fs')
const path = require('path')

// Append-only log of completed sessions' total network usage, used to build
// a 28-day rolling baseline rate (bytes/sec) for the whole system. A
// currently-running container's own rate is compared against this baseline
// to flag abuse (crypto mining, data exfil, DDoS participation) that a
// fixed byte-count threshold can't adapt to as real lab traffic patterns
// change over time.
const LOG_FILE = path.join(__dirname, 'bandwidth-history.log')
const ROLLING_WINDOW_MS = 28 * 24 * 60 * 60 * 1000

let records = []

function loadExisting () {
  try {
    const lines = fs.readFileSync(LOG_FILE, 'utf8').split('\n').filter(Boolean)
    records = lines.map(line => {
      try { return JSON.parse(line) } catch { return null }
    }).filter(Boolean)
  } catch {
    records = []
  }
}

// Called once per destroyed session (manual, auto-expiry, or force-destroy)
// with its final cumulative network totals and how long it ran.
function logSessionBandwidth ({ uuid, bytesIn, bytesOut, durationSeconds }) {
  if (!durationSeconds || durationSeconds <= 0) return // nothing meaningful to average
  const entry = {
    uuid,
    bytesIn: bytesIn || 0,
    bytesOut: bytesOut || 0,
    bytesTotal: (bytesIn || 0) + (bytesOut || 0),
    durationSeconds,
    timestamp: Date.now()
  }
  records.push(entry)
  fs.appendFile(LOG_FILE, JSON.stringify(entry) + '\n', () => {})
}

// System-wide rolling average rate over the last 28 days, as bytes/sec
// combined in+out. Weighted by duration (sum of bytes / sum of seconds)
// rather than a plain average-of-rates, so one long heavy session doesn't
// get diluted by many short idle ones the same way it would with a naive
// mean. Returns null when there isn't enough history yet — callers must
// treat null as "no baseline, don't flag anything" rather than zero.
function getRollingAvgRateBytesPerSec () {
  const cutoff = Date.now() - ROLLING_WINDOW_MS
  const recent = records.filter(r => r.timestamp >= cutoff)
  if (recent.length === 0) return null

  const totalBytes = recent.reduce((s, r) => s + r.bytesTotal, 0)
  const totalSeconds = recent.reduce((s, r) => s + r.durationSeconds, 0)
  if (totalSeconds === 0) return null

  return totalBytes / totalSeconds
}

loadExisting()

module.exports = { logSessionBandwidth, getRollingAvgRateBytesPerSec }
