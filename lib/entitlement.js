'use strict'

// Tier computation - pure, no I/O. Mirrors the Flutter app's
// ProPlusGracePolicy (ssh_server_manager/lib/features/common/providers/
// pro_plus_grace_policy.dart) so client and server agree on the grace-phase
// boundaries. Keep the two in sync if either changes.

const FREE_LAB_MONTHS = 5
const GRACE_MONTHS = 1

const GracePhase = Object.freeze({
  FREE_LAB: 'free_lab',
  DISCOUNT_GRACE: 'discount_grace',
  EXPIRED: 'expired'
})

const Tier = Object.freeze({
  FREE: 'free',
  LIFETIME_PRO_FREE_LAB: 'lifetime_pro_free_lab',
  LIFETIME_PRO_GRACE: 'lifetime_pro_grace',
  LIFETIME_PRO_LAPSED: 'lifetime_pro_lapsed',
  SUBSCRIBER: 'subscriber'
})

// Calendar-month arithmetic (not a fixed day count), matching Play's own
// P1M billing-period rollover.
function addMonths (date, months) {
  const totalMonths = date.getMonth() + months
  const year = date.getFullYear() + Math.floor(totalMonths / 12)
  const month = ((totalMonths % 12) + 12) % 12
  const daysInTargetMonth = new Date(year, month + 1, 0).getDate()
  const day = Math.min(date.getDate(), daysInTargetMonth)
  return new Date(year, month, day, date.getHours(), date.getMinutes(), date.getSeconds())
}

function gracePhaseFor ({ rolloutStartedAt, now }) {
  const freeLabEndsAt = addMonths(rolloutStartedAt, FREE_LAB_MONTHS)
  const graceEndsAt = addMonths(freeLabEndsAt, GRACE_MONTHS)
  if (now < freeLabEndsAt) return GracePhase.FREE_LAB
  if (now < graceEndsAt) return GracePhase.DISCOUNT_GRACE
  return GracePhase.EXPIRED
}

// Computes what a device is entitled to right now.
//
// [verifiedEntitlement] (null, or the device's record from
// verified-entitlement-store.js) is the real, anti-forgery source of
// truth - a purchase token actually checked against the Google Play
// Developer API (see lib/play-verifier.js), kept fresh by a periodic
// re-verify sweep. settings.proDeviceIds/subscriberDeviceIds remain as an
// admin-managed override on top of that (comps, support cases) - a client
// simply claiming a tier with no verified record and no admin grant gets
// nothing, which is the actual anti-forgery property: this function never
// trusts a self-reported tier.
function computeEntitlement ({ deviceId, settings, now = new Date(), verifiedEntitlement = null }) {
  const verifiedSubscriber = verifiedEntitlement?.kind === 'subscription' && verifiedEntitlement.active
  const verifiedLifetimePro = verifiedEntitlement?.kind === 'lifetime_pro' && verifiedEntitlement.active

  const isSubscriber = verifiedSubscriber || (!!deviceId && settings.subscriberDeviceIds.includes(deviceId))
  const isLifetimePro = verifiedLifetimePro || (!!deviceId && settings.proDeviceIds.includes(deviceId))

  let result
  if (isSubscriber) {
    result = { tier: Tier.SUBSCRIBER, persisted: true, durationMinutes: null, offerEligible: false }
  } else if (isLifetimePro) {
    const rolloutStartedAt = new Date(settings.rolloutStartedAt)
    const phase = gracePhaseFor({ rolloutStartedAt, now })

    if (phase === GracePhase.FREE_LAB) {
      result = { tier: Tier.LIFETIME_PRO_FREE_LAB, persisted: true, durationMinutes: null, offerEligible: false }
    } else if (phase === GracePhase.DISCOUNT_GRACE) {
      result = { tier: Tier.LIFETIME_PRO_GRACE, persisted: true, durationMinutes: null, offerEligible: true }
    } else {
      result = { tier: Tier.LIFETIME_PRO_LAPSED, persisted: false, durationMinutes: settings.proSessionMinutes, offerEligible: true }
    }
  } else {
    result = { tier: Tier.FREE, persisted: false, durationMinutes: settings.freeSessionMinutes, offerEligible: false }
  }

  // Kill switch for rolling this backend out ahead of the app update that
  // actually knows how to handle a persisted lab's response shape
  // (expiresAt/timeRemainingSeconds: null). While off, nobody - not even a
  // real grandfathered lifetime-pro device - can be routed into the
  // persisted branch, so /labs/provision's contract for an old, already-
  // installed app build never changes: same fields, same types, same
  // ephemeral-only behavior it already has in production today.
  if (result.persisted && !settings.persistedLabsEnabled) {
    return { ...result, persisted: false, durationMinutes: settings.proSessionMinutes }
  }
  return result
}

module.exports = { Tier, GracePhase, gracePhaseFor, computeEntitlement }
