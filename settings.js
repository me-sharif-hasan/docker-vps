'use strict'

const fs = require('fs')
const path = require('path')

// Single shared settings.json — both server.js (admin routes) and
// container-manager.js (session duration lookup) need the same live
// object, not two independently-loaded copies that can drift.
const SETTINGS_FILE = path.join(__dirname, 'settings.json')

// proDeviceIds = grandfathered lifetime-pro cohort (ad_free_forever buyers).
// subscriberDeviceIds = active serverkit_pro_plus subscribers. Both are
// stand-ins for the real Play purchase/credits verification flow (not wired
// up yet), same as proDeviceIds always was — admin marks a deviceId by hand
// via /api/admin/pro-devices or /api/admin/subscriber-devices.
function applyDefaults (loaded) {
  if (!Array.isArray(loaded.debugWhitelistIps)) loaded.debugWhitelistIps = []
  if (!Array.isArray(loaded.proDeviceIds)) loaded.proDeviceIds = []
  if (!Array.isArray(loaded.subscriberDeviceIds)) loaded.subscriberDeviceIds = []
  if (!Array.isArray(loaded.bannedDeviceIds)) loaded.bannedDeviceIds = []
  if (!Array.isArray(loaded.bannedIps)) loaded.bannedIps = []
  if (typeof loaded.freeSessionMinutes !== 'number') loaded.freeSessionMinutes = 30
  if (typeof loaded.proSessionMinutes !== 'number') loaded.proSessionMinutes = 120
  // How long a lapsed subscriber's/grandfathered user's snapshot is held
  // before it's deleted for good - see lib/persisted-lab-lifecycle.js reclaim sweep.
  if (typeof loaded.reclaimGraceDays !== 'number') loaded.reclaimGraceDays = 30
  // The single global date the lifetime-pro -> serverkit_pro_plus rollout
  // started, driving the 5-month-free + 1-month-grace window for the
  // grandfathered cohort. Must be set for real before launch - this
  // fallback is just so a fresh install doesn't crash.
  if (typeof loaded.rolloutStartedAt !== 'string') loaded.rolloutStartedAt = new Date().toISOString()
  // Kill switch, off by default - see lib/entitlement.js's own comment.
  // Deploying this backend ahead of the app update that understands a
  // persisted lab's response shape must not change behavior for real users
  // on the currently-live app build. Flip this on only once that update has
  // actually shipped.
  if (typeof loaded.persistedLabsEnabled !== 'boolean') loaded.persistedLabsEnabled = false
  return loaded
}

function loadSettings () {
  try {
    const loaded = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'))
    return applyDefaults(loaded)
  } catch {
    return applyDefaults({
      skipDebugPackages: process.env.SKIP_DEBUG_PACKAGES === 'true' || false
    })
  }
}

const settings = loadSettings()

function saveSettings () {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2))
}

module.exports = { settings, saveSettings }
