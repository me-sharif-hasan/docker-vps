'use strict'

const fs = require('fs')
const path = require('path')

// Single shared settings.json — both server.js (admin routes) and
// container-manager.js (session duration lookup) need the same live
// object, not two independently-loaded copies that can drift.
const SETTINGS_FILE = path.join(__dirname, 'settings.json')

function loadSettings () {
  try {
    const loaded = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'))
    if (!Array.isArray(loaded.debugWhitelistIps)) loaded.debugWhitelistIps = []
    if (!Array.isArray(loaded.proDeviceIds)) loaded.proDeviceIds = []
    if (typeof loaded.freeSessionMinutes !== 'number') loaded.freeSessionMinutes = 30
    if (typeof loaded.proSessionMinutes !== 'number') loaded.proSessionMinutes = 120
    return loaded
  } catch {
    return {
      skipDebugPackages: process.env.SKIP_DEBUG_PACKAGES === 'true' || false,
      debugWhitelistIps: [],
      proDeviceIds: [],
      freeSessionMinutes: 30,
      proSessionMinutes: 120
    }
  }
}

const settings = loadSettings()

function saveSettings () {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2))
}

module.exports = { settings, saveSettings }
