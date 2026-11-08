'use strict'

const store = require('./verified-entitlement-store')
const { verifyOneTimePurchase, verifySubscription } = require('./play-verifier')
const { LIFETIME_PRO_PRODUCT_ID } = require('./constants')

// A purchase verified once can stop being valid later (refund, chargeback,
// subscription cancellation/expiry) - this is what actually revokes a
// verified-entitlement-store record once that happens, instead of trusting
// the one-time check forever. Debug records (the whitelisted-IP bypass)
// are never real Play purchases, so there's nothing to re-check.
async function reverifyAll() {
  for (const record of store.all()) {
    if (record.debug) continue
    if (!record.packageName) {
      console.error(`Entitlement re-verify skipped for device ${record.deviceId}: no packageName on record`)
      continue
    }

    try {
      const result = record.kind === 'subscription'
        ? await verifySubscription(record.packageName, record.purchaseToken)
        : await verifyOneTimePurchase(record.packageName, LIFETIME_PRO_PRODUCT_ID, record.purchaseToken)

      store.set(record.deviceId, {
        ...record,
        active: result.active,
        expiryTimeMillis: result.expiryTimeMillis ?? record.expiryTimeMillis ?? null,
        lastCheckedAt: Date.now()
      })
    } catch (err) {
      // Leave the record as-is on a transient API/network failure - do
      // NOT revoke entitlement just because Play's API hiccuped once.
      console.error(`Entitlement re-verify failed for device ${record.deviceId}:`, err.message)
    }
  }
}

function startReverifySweep(intervalMs) {
  setInterval(() => reverifyAll().catch(err => console.error('Entitlement reverify sweep failed:', err.message)), intervalMs)
}

module.exports = { reverifyAll, startReverifySweep }
