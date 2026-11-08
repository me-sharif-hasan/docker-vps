'use strict'

const { settings } = require('../settings')
const { verifyIntegrityToken, signLabsJwt } = require('../auth')

module.exports = async function authRoutes(app) {
  // ─────────────────────────────────────────────
  // POST /api/auth/integrity-token
  // Body: { integrityToken: string, packageName: string }
  // Returns: { token: string } (JWT, 1hr)
  // ─────────────────────────────────────────────
  app.post('/api/auth/integrity-token', {
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } }
  }, async (request, reply) => {
    app.log.info({ body: request.body }, 'integrity-token raw body')

    // Accept camelCase or snake_case - app may send either
    const integrityToken = request.body?.integrityToken ?? request.body?.integrity_token ?? request.body?.token
    const packageName = request.body?.packageName ?? request.body?.package_name

    if (!integrityToken || !packageName) {
      return reply.code(400).send({
        success: false,
        error: 'Missing required fields. Expected: integrityToken (or integrity_token), packageName (or package_name)',
        received: Object.keys(request.body || {})
      })
    }

    // Skip Play Integrity for debug builds when the setting is enabled AND
    // the caller's IP is on the whitelist. The bypass is deliberately kept
    // (it's needed for local/dev testing) but it must not be reachable from
    // the open internet - an unlisted IP falls through to the real Play
    // Integrity check below like any other caller.
    const callerIp = request.ip
    if (
      settings.skipDebugPackages &&
      packageName.endsWith('.debug') &&
      settings.debugWhitelistIps.includes(callerIp)
    ) {
      const token = signLabsJwt({ packageName, debug: true })
      return { success: true, token, expiresIn: 3600 }
    }

    try {
      const verdict = await verifyIntegrityToken(integrityToken, packageName)

      app.log.info({ verdict: verdict?.tokenPayloadExternal }, 'play integrity verdict')

      const appRecognition = verdict?.tokenPayloadExternal?.appIntegrity?.appRecognitionVerdict
      const deviceRecognition = verdict?.tokenPayloadExternal?.deviceIntegrity?.deviceRecognitionVerdict ?? []

      // Accept PLAY_RECOGNIZED or UNRECOGNIZED_VERSION (valid cert, newer build not yet in Play Console)
      const appOk = appRecognition === 'PLAY_RECOGNIZED' || appRecognition === 'UNRECOGNIZED_VERSION'
      if (!appOk) {
        return reply.code(403).send({
          success: false,
          error: 'App failed integrity check',
          verdict: appRecognition
        })
      }

      // Accept any passing tier: MEETS_BASIC_INTEGRITY, MEETS_DEVICE_INTEGRITY, MEETS_STRONG_INTEGRITY
      const deviceOk = deviceRecognition.some(v =>
        v === 'MEETS_BASIC_INTEGRITY' || v === 'MEETS_DEVICE_INTEGRITY' || v === 'MEETS_STRONG_INTEGRITY'
      )
      if (!deviceOk) {
        return reply.code(403).send({
          success: false,
          error: 'Device does not meet integrity requirements',
          verdict: deviceRecognition
        })
      }

      const token = signLabsJwt({ packageName, appRecognition })

      return { success: true, token, expiresIn: 3600 }
    } catch (err) {
      app.log.error(err)
      return reply.code(500).send({ success: false, error: err.message })
    }
  })
}
