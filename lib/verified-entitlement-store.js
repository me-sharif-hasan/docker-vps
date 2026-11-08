'use strict'

const fs = require('fs')
const path = require('path')

// Durable registry: deviceId -> verified-purchase record, the real
// anti-forgery source of truth lib/entitlement.js checks before falling
// back to the admin-managed settings.proDeviceIds/subscriberDeviceIds
// comp lists. Survives restarts for the same reason persisted-lab-store.js
// does - re-verifying every purchase on every boot would be wasteful and
// slow, and a restart shouldn't silently revoke someone's entitlement.
//
// Record shape:
//   { deviceId, kind, productId, purchaseToken, verifiedAt, lastCheckedAt,
//     expiryTimeMillis, active, debug }
// kind: 'lifetime_pro' | 'subscription'

const STORE_FILE = path.join(__dirname, '..', 'verified-entitlements.json')

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
  return Array.from(records.entries()).map(([deviceId, record]) => ({ deviceId, ...record }))
}

// The anchor for surviving an app uninstall/reinstall or a phone swap: the
// locally-generated deviceId lives in flutter_secure_storage and is wiped
// with the rest of the app's data on uninstall, but a Play purchaseToken
// is Google's, not the device's - the SAME token comes back out of Play's
// own purchase-restore flow regardless of which install or device asks for
// it. Scans every verified record (small, bounded by paying user count)
// rather than keeping a second index - this only runs on the already rare
// verify-purchase path, not anything hot.
function findByPurchaseToken (purchaseToken) {
  for (const [deviceId, record] of records.entries()) {
    if (record.purchaseToken === purchaseToken) return { deviceId, ...record }
  }
  return null
}

module.exports = { get, set, remove, all, findByPurchaseToken }
