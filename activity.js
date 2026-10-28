'use strict'

const fs = require('fs')
const path = require('path')
const geoip = require('geoip-lite')

// Append-only provisioning log for abuse investigation: who (deviceId),
// from where (ip + country), when, what tier. Kept as JSONL (one JSON
// object per line) so it can grow without re-parsing the whole file on
// every write, and survives restarts (sessions Map does not).
const LOG_FILE = path.join(__dirname, 'activity.log')
const MAX_IN_MEMORY = 2000

const recent = [] // newest last, capped to MAX_IN_MEMORY
const deviceCountries = new Map() // deviceId -> Set<countryCode>

function countryForIp (ip) {
  if (!ip) return null
  const geo = geoip.lookup(ip)
  return geo ? geo.country : null // null for private/loopback/unresolvable IPs
}

function loadExisting () {
  try {
    const lines = fs.readFileSync(LOG_FILE, 'utf8').split('\n').filter(Boolean)
    for (const line of lines) {
      try {
        const entry = JSON.parse(line)
        recordInMemory(entry)
      } catch { /* skip corrupt line */ }
    }
  } catch { /* no log file yet */ }
}

function recordInMemory (entry) {
  recent.push(entry)
  if (recent.length > MAX_IN_MEMORY) recent.shift()

  if (entry.deviceId && entry.country) {
    if (!deviceCountries.has(entry.deviceId)) deviceCountries.set(entry.deviceId, new Set())
    deviceCountries.get(entry.deviceId).add(entry.country)
  }
}

function logProvision ({ uuid, deviceId, ip, isPro }) {
  const entry = {
    uuid,
    deviceId: deviceId || null,
    ip: ip || null,
    country: countryForIp(ip),
    isPro: !!isPro,
    timestamp: Date.now()
  }
  recordInMemory(entry)
  fs.appendFile(LOG_FILE, JSON.stringify(entry) + '\n', () => {})
  return entry
}

function getRecentActivity (limit = 200) {
  return recent.slice(-limit).reverse()
}

// Devices seen from more than one country — a legit user's phone IP rarely
// jumps countries; a deviceId cycling across countries is the signature of
// someone routing through different VPN/Tor exit nodes while reusing (or
// spoofing) the same device id to dodge the one-free-session cap or a ban.
function getSuspiciousDevices () {
  const result = []
  for (const [deviceId, countries] of deviceCountries) {
    if (countries.size > 1) {
      result.push({ deviceId, countries: [...countries] })
    }
  }
  return result
}

loadExisting()

module.exports = { logProvision, getRecentActivity, getSuspiciousDevices, countryForIp }
