'use strict'

const { settings } = require('../settings')

// Unauthenticated, nothing sensitive - the app needs these before a session
// exists (health check, and the tier-duration numbers for "free tier" /
// "pro tier" copy without baking minute counts into translated strings).
module.exports = async function publicRoutes(app) {
  app.get('/health', async () => {
    return { status: 'ok', timestamp: new Date().toISOString() }
  })

  app.get('/api/labs/config', async () => {
    return {
      success: true,
      data: {
        freeSessionMinutes: settings.freeSessionMinutes,
        proSessionMinutes: settings.proSessionMinutes
      }
    }
  })
}
