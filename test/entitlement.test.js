'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { Tier, gracePhaseFor, computeEntitlement, GracePhase } = require('../lib/entitlement')

// Mirrors ssh_server_manager's ProPlusGracePolicy test cases so client and
// server stay in agreement on the boundary dates.
test('gracePhaseFor: still inside the 5 free months', () => {
  const rolloutStartedAt = new Date(2026, 0, 15)
  assert.equal(gracePhaseFor({ rolloutStartedAt, now: new Date(2026, 3, 1) }), GracePhase.FREE_LAB)
})

test('gracePhaseFor: the instant the free period ends moves to the discount grace month', () => {
  const rolloutStartedAt = new Date(2026, 0, 15)
  assert.equal(gracePhaseFor({ rolloutStartedAt, now: new Date(2026, 5, 15) }), GracePhase.DISCOUNT_GRACE)
})

test('gracePhaseFor: still inside the 1 grace month', () => {
  const rolloutStartedAt = new Date(2026, 0, 15)
  assert.equal(gracePhaseFor({ rolloutStartedAt, now: new Date(2026, 6, 10) }), GracePhase.DISCOUNT_GRACE)
})

test('gracePhaseFor: past the grace month expires', () => {
  const rolloutStartedAt = new Date(2026, 0, 15)
  assert.equal(gracePhaseFor({ rolloutStartedAt, now: new Date(2026, 6, 15) }), GracePhase.EXPIRED)
})

test('gracePhaseFor: handles a rollout date near month-end without overflowing into the wrong month', () => {
  const lateMonthRollout = new Date(2026, 0, 31)
  // +5 months from Jan 31 would overflow June (30 days) - must clamp, not roll into July.
  assert.equal(gracePhaseFor({ rolloutStartedAt: lateMonthRollout, now: new Date(2026, 5, 29) }), GracePhase.FREE_LAB)
  assert.equal(gracePhaseFor({ rolloutStartedAt: lateMonthRollout, now: new Date(2026, 5, 30) }), GracePhase.DISCOUNT_GRACE)
})

function baseSettings(overrides = {}) {
  return {
    proDeviceIds: [],
    subscriberDeviceIds: [],
    freeSessionMinutes: 30,
    proSessionMinutes: 120,
    rolloutStartedAt: new Date(2026, 0, 15).toISOString(),
    // On by default in these tests so the existing cases below keep
    // testing the feature's real behavior - the dedicated kill-switch
    // tests further down pass persistedLabsEnabled: false explicitly.
    persistedLabsEnabled: true,
    ...overrides
  }
}

test('computeEntitlement: unknown device gets the free tier, ephemeral, not persisted', () => {
  const result = computeEntitlement({ deviceId: 'd1', settings: baseSettings(), now: new Date(2026, 1, 1) })
  assert.deepEqual(result, { tier: Tier.FREE, persisted: false, durationMinutes: 30, offerEligible: false })
})

test('computeEntitlement: lifetime-pro device inside the free-lab window is persisted with no duration cap', () => {
  const settings = baseSettings({ proDeviceIds: ['d1'] })
  const result = computeEntitlement({ deviceId: 'd1', settings, now: new Date(2026, 2, 1) })
  assert.equal(result.tier, Tier.LIFETIME_PRO_FREE_LAB)
  assert.equal(result.persisted, true)
  assert.equal(result.offerEligible, false)
})

test('computeEntitlement: lifetime-pro device in the grace month stays persisted and becomes offer-eligible', () => {
  const settings = baseSettings({ proDeviceIds: ['d1'] })
  const result = computeEntitlement({ deviceId: 'd1', settings, now: new Date(2026, 5, 20) })
  assert.equal(result.tier, Tier.LIFETIME_PRO_GRACE)
  assert.equal(result.persisted, true)
  assert.equal(result.offerEligible, true)
})

test('computeEntitlement: lifetime-pro device past grace reverts to ephemeral pro-duration, not free', () => {
  const settings = baseSettings({ proDeviceIds: ['d1'] })
  const result = computeEntitlement({ deviceId: 'd1', settings, now: new Date(2026, 7, 1) })
  assert.equal(result.tier, Tier.LIFETIME_PRO_LAPSED)
  assert.equal(result.persisted, false)
  assert.equal(result.durationMinutes, 120)
  assert.equal(result.offerEligible, true)
})

test('computeEntitlement: active subscriber always wins, even past their own lapsed grandfather window', () => {
  const settings = baseSettings({ proDeviceIds: ['d1'], subscriberDeviceIds: ['d1'] })
  const result = computeEntitlement({ deviceId: 'd1', settings, now: new Date(2026, 7, 1) })
  assert.equal(result.tier, Tier.SUBSCRIBER)
  assert.equal(result.persisted, true)
  assert.equal(result.offerEligible, false)
})

test('computeEntitlement: no deviceId is treated as free, never crashes on the membership checks', () => {
  const result = computeEntitlement({ deviceId: undefined, settings: baseSettings({ proDeviceIds: ['d1'] }), now: new Date() })
  assert.equal(result.tier, Tier.FREE)
})

// Anti-forgery: a device is NEVER granted a paid tier just by claiming
// one - only a real verified-entitlement-store record (checked against
// Play) or an explicit admin grant in settings counts.
test('computeEntitlement: no verified record and no admin grant -> free, even if the caller claims otherwise', () => {
  const result = computeEntitlement({ deviceId: 'forger', settings: baseSettings(), now: new Date() })
  assert.equal(result.tier, Tier.FREE)
  assert.equal(result.persisted, false)
})

test('computeEntitlement: an active verified subscription record grants subscriber with no admin list entry needed', () => {
  const result = computeEntitlement({
    deviceId: 'd1',
    settings: baseSettings(),
    now: new Date(),
    verifiedEntitlement: { kind: 'subscription', active: true }
  })
  assert.equal(result.tier, Tier.SUBSCRIBER)
  assert.equal(result.persisted, true)
})

test('computeEntitlement: an inactive (lapsed/refunded) verified record grants nothing', () => {
  const result = computeEntitlement({
    deviceId: 'd1',
    settings: baseSettings(),
    now: new Date(),
    verifiedEntitlement: { kind: 'subscription', active: false }
  })
  assert.equal(result.tier, Tier.FREE)
})

test('computeEntitlement: a verified lifetime_pro record alone (no admin list) grants the grandfathered free-lab phase', () => {
  const result = computeEntitlement({
    deviceId: 'd1',
    settings: baseSettings(),
    now: new Date(2026, 2, 1),
    verifiedEntitlement: { kind: 'lifetime_pro', active: true }
  })
  assert.equal(result.tier, Tier.LIFETIME_PRO_FREE_LAB)
})

test('computeEntitlement: a lapsed verified subscription still falls back to an active verified lifetime_pro record', () => {
  // This is checked via two separate computeEntitlement calls in real
  // code (the caller only passes one verifiedEntitlement per device, the
  // one record that matters), but the OR-with-admin-list structure is
  // what makes "ON_HOLD subscription -> fall back to lifetime pro" work
  // when a SEPARATE admin/verified lifetime_pro grant exists for the same
  // device - verified here via the admin-list side of the same OR.
  const settings = baseSettings({ proDeviceIds: ['d1'] })
  const result = computeEntitlement({
    deviceId: 'd1',
    settings,
    now: new Date(2026, 2, 1),
    verifiedEntitlement: { kind: 'subscription', active: false }
  })
  assert.equal(result.tier, Tier.LIFETIME_PRO_FREE_LAB)
})

// Kill switch: deploying this backend ahead of the app update that
// understands a persisted lab's response shape (null expiresAt/
// timeRemainingSeconds) must not change /labs/provision's contract for a
// real user on the currently-live app build - see settings.js and
// lib/entitlement.js's own comments.
test('computeEntitlement: kill switch forces a grandfathered lifetime-pro device back to ephemeral pro duration', () => {
  const settings = baseSettings({ proDeviceIds: ['d1'], persistedLabsEnabled: false })
  const result = computeEntitlement({ deviceId: 'd1', settings, now: new Date(2026, 2, 1) })
  assert.equal(result.tier, Tier.LIFETIME_PRO_FREE_LAB) // tier label unchanged, informational only
  assert.equal(result.persisted, false)
  assert.equal(result.durationMinutes, 120)
})

test('computeEntitlement: kill switch forces an active subscriber back to ephemeral pro duration too', () => {
  const settings = baseSettings({ subscriberDeviceIds: ['d1'], persistedLabsEnabled: false })
  const result = computeEntitlement({ deviceId: 'd1', settings, now: new Date() })
  assert.equal(result.tier, Tier.SUBSCRIBER)
  assert.equal(result.persisted, false)
  assert.equal(result.durationMinutes, 120)
})

test('computeEntitlement: kill switch does not affect the free tier at all', () => {
  const settings = baseSettings({ persistedLabsEnabled: false })
  const result = computeEntitlement({ deviceId: 'nobody', settings, now: new Date() })
  assert.deepEqual(result, { tier: Tier.FREE, persisted: false, durationMinutes: 30, offerEligible: false })
})

test('computeEntitlement: kill switch does not affect an already-ephemeral lapsed lifetime-pro device', () => {
  const settings = baseSettings({ proDeviceIds: ['d1'], persistedLabsEnabled: false })
  const result = computeEntitlement({ deviceId: 'd1', settings, now: new Date(2026, 7, 1) })
  assert.equal(result.tier, Tier.LIFETIME_PRO_LAPSED)
  assert.equal(result.persisted, false)
  assert.equal(result.durationMinutes, 120)
})
