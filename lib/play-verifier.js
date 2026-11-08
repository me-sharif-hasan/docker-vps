'use strict'

const { GoogleAuth } = require('google-auth-library')
const { SERVICE_ACCOUNT_PATH } = require('../auth')

// Verifies a purchase token against the real Google Play Developer API -
// the only way to actually know a client's "I'm pro"/"I'm subscribed"
// claim is genuine rather than forged. Reuses the same service account
// file auth.js already resolves for Play Integrity (it already has
// androidpublisher access - confirmed working when the serverkit_pro_plus
// subscription product itself was created through this same key).
const ANDROID_PUBLISHER_SCOPE = 'https://www.googleapis.com/auth/androidpublisher'

const googleAuth = new GoogleAuth({
  keyFile: SERVICE_ACCOUNT_PATH,
  scopes: [ANDROID_PUBLISHER_SCOPE]
})

async function authorizedFetch(url) {
  const client = await googleAuth.getClient()
  const accessToken = await client.getAccessToken()
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken.token}` }
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Play Developer API ${res.status}: ${body}`)
  }
  return res.json()
}

// purchaseState: 0 = purchased, 1 = canceled, 2 = pending.
// https://developers.google.com/android-publisher/api-ref/rest/v3/purchases.products
async function verifyOneTimePurchase(packageName, productId, purchaseToken) {
  const url = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(packageName)}/purchases/products/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(purchaseToken)}`
  const data = await authorizedFetch(url)
  return {
    active: data.purchaseState === 0,
    purchaseState: data.purchaseState,
    productId
  }
}

// subscriptionState one of SUBSCRIPTION_STATE_ACTIVE, _IN_GRACE_PERIOD,
// _ON_HOLD, _CANCELED, _EXPIRED, _PAUSED, _PENDING_PURCHASE_CANCELED.
// ACTIVE and IN_GRACE_PERIOD both count as "subscriber" - matches the
// design's "treat a late card the same as active, don't double-punish"
// rule. ON_HOLD/CANCELED/EXPIRED fall through to whatever lifetime-pro
// phase this device is separately in (lib/entitlement.js's OR logic),
// which is the same "don't double-punish" rule applied the other way.
// https://developers.google.com/android-publisher/api-ref/rest/v3/purchases.subscriptionsv2
async function verifySubscription(packageName, purchaseToken) {
  const url = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(packageName)}/purchases/subscriptionsv2/tokens/${encodeURIComponent(purchaseToken)}`
  const data = await authorizedFetch(url)
  const state = data.subscriptionState
  const active = state === 'SUBSCRIPTION_STATE_ACTIVE' || state === 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD'
  const lineItem = (data.lineItems || [])[0]
  return {
    active,
    subscriptionState: state,
    productId: lineItem?.productId ?? null,
    basePlanId: lineItem?.offerDetails?.basePlanId ?? null,
    expiryTimeMillis: lineItem?.expiryTime ? Date.parse(lineItem.expiryTime) : null
  }
}

module.exports = { verifyOneTimePurchase, verifySubscription }
