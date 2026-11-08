'use strict'

const { verifyOneTimePurchase, verifySubscription } = require('../lib/play-verifier')
const verifiedEntitlements = require('../lib/verified-entitlement-store')
const persistedLabStore = require('../lib/persisted-lab-store')
const { LIFETIME_PRO_PRODUCT_ID, SUBSCRIPTION_PRODUCT_ID } = require('../lib/constants')

// The real purchaseToken (Google's, not ours) is the only identifier that
// survives what the deviceId can't: an uninstall wipes
// flutter_secure_storage, so a reinstall - or a fresh device signed into
// the same Play account - generates a brand new deviceId with no memory of
// the old one. Restoring the purchase on that new install hands this same
// token back to us, which is how we recognize "this is the same owner,
// just a new deviceId" and move their persisted lab (and its verified
// entitlement) over rather than silently starting them a second, empty one.
function rebindIfReinstalled (purchaseToken, newDeviceId) {
  const existing = verifiedEntitlements.findByPurchaseToken(purchaseToken)
  if (!existing || existing.deviceId === newDeviceId) return
  verifiedEntitlements.remove(existing.deviceId)
  persistedLabStore.rebindDevice(existing.deviceId, newDeviceId)
}

// Under /labs/* - already JWT-guarded by server.js's onRequest hook, which
// means request.jwtPayload is always set here and already carries a
// Play-Integrity-verified packageName + debug flag (from
// /api/auth/integrity-token). This route deliberately reuses THAT
// verification rather than re-implementing its own debug/IP-whitelist
// check: the only bypass of real Play purchase verification is the same
// one that already exists for Play Integrity itself (skipDebugPackages +
// debugWhitelistIps, checked once, upstream, when the JWT was issued).
//
// Anti-forgery property: a client claiming a tier with no record here
// (and no admin grant in settings.proDeviceIds/subscriberDeviceIds) gets
// nothing - see lib/entitlement.js. This endpoint is the only way a
// deviceId's verified-entitlement-store record gets created for real.
module.exports = async function entitlementRoutes(app) {
  app.post('/labs/entitlement/verify-purchase', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    schema: {
      body: {
        type: 'object',
        required: ['deviceId', 'purchaseToken', 'kind'],
        properties: {
          deviceId: { type: 'string', maxLength: 128 },
          purchaseToken: { type: 'string', maxLength: 4096 },
          kind: { type: 'string', enum: ['lifetime_pro', 'subscription'] }
        }
      }
    }
  }, async (request, reply) => {
    const { deviceId, purchaseToken, kind } = request.body

    if (request.jwtPayload?.debug) {
      // Local/dev only - the same debug-whitelisted-IP path that already
      // bypasses real Play Integrity verification upstream. Trusting the
      // claim here, too, is not a new hole - it's the existing one.
      rebindIfReinstalled(purchaseToken, deviceId)
      verifiedEntitlements.set(deviceId, {
        kind, productId: kind === 'subscription' ? SUBSCRIPTION_PRODUCT_ID : LIFETIME_PRO_PRODUCT_ID,
        purchaseToken, packageName: request.jwtPayload.packageName,
        verifiedAt: Date.now(), lastCheckedAt: Date.now(),
        expiryTimeMillis: null, active: true, debug: true
      })
      return { success: true, data: { verified: true, debug: true } }
    }

    const packageName = request.jwtPayload?.packageName
    if (!packageName) {
      return reply.code(401).send({ success: false, error: 'Missing verified packageName on token' })
    }

    try {
      const result = kind === 'subscription'
        ? await verifySubscription(packageName, purchaseToken)
        : await verifyOneTimePurchase(packageName, LIFETIME_PRO_PRODUCT_ID, purchaseToken)

      // For a subscription, also pin which product it actually is - a
      // valid purchase token for some OTHER subscription product in this
      // app must not verify as serverkit_pro_plus.
      if (kind === 'subscription' && result.productId !== SUBSCRIPTION_PRODUCT_ID) {
        return reply.code(403).send({ success: false, error: 'Purchase token is not for the expected subscription product' })
      }

      if (!result.active) {
        return reply.code(403).send({ success: false, error: 'Purchase is not active/valid', detail: result })
      }

      rebindIfReinstalled(purchaseToken, deviceId)
      verifiedEntitlements.set(deviceId, {
        kind,
        productId: kind === 'subscription' ? SUBSCRIPTION_PRODUCT_ID : LIFETIME_PRO_PRODUCT_ID,
        purchaseToken,
        packageName,
        verifiedAt: Date.now(),
        lastCheckedAt: Date.now(),
        expiryTimeMillis: result.expiryTimeMillis ?? null,
        active: true
      })

      return { success: true, data: { verified: true } }
    } catch (err) {
      app.log.error(err)
      return reply.code(502).send({ success: false, error: `Could not verify purchase: ${err.message}` })
    }
  })
}
