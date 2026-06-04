'use strict'

const Fastify = require('fastify')
const cors = require('@fastify/cors')
const {
  provisionContainer,
  destroyContainer,
  getConnectionDetails,
  getStats,
  isUuidConflict
} = require('./container-manager')
const { isValidUuid } = require('./validate')
const { verifyIntegrityToken, signLabsJwt, verifyLabsJwt } = require('./auth')

const app = Fastify({
  logger: {
    transport: {
      target: 'pino-pretty',
      options: { colorize: true }
    }
  }
})

app.register(cors, { origin: true })

// ─────────────────────────────────────────────
// JWT bearer guard on all /labs/* routes
// ─────────────────────────────────────────────
app.addHook('onRequest', async (request, reply) => {
  if (!request.url.startsWith('/labs/') && request.url !== '/labs/stats') return

  const authHeader = request.headers.authorization
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return reply.code(401).send({ success: false, error: 'Missing Bearer token' })
  }

  try {
    request.jwtPayload = verifyLabsJwt(authHeader.slice(7))
  } catch {
    return reply.code(401).send({ success: false, error: 'Invalid or expired token' })
  }
})

// ─────────────────────────────────────────────
// POST /api/auth/integrity-token
// Body: { integrityToken: string, packageName: string }
// Returns: { token: string } (JWT, 1hr)
// ─────────────────────────────────────────────
app.post('/api/auth/integrity-token', async (request, reply) => {
  app.log.info({ body: request.body }, 'integrity-token raw body')

  // Accept camelCase or snake_case — app may send either
  const integrityToken = request.body?.integrityToken ?? request.body?.integrity_token ?? request.body?.token
  const packageName = request.body?.packageName ?? request.body?.package_name

  if (!integrityToken || !packageName) {
    return reply.code(400).send({
      success: false,
      error: 'Missing required fields. Expected: integrityToken (or integrity_token), packageName (or package_name)',
      received: Object.keys(request.body || {})
    })
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

// ─────────────────────────────────────────────
// POST /labs/provision
// Body: { uuid: string }
// Creates a new lab container for the given UUID
// Returns: ssh connection details + private key
// ─────────────────────────────────────────────
app.post('/labs/provision', {
  schema: {
    body: {
      type: 'object',
      required: ['uuid'],
      properties: {
        uuid: { type: 'string' }
      }
    },
    response: {
      200: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          data: {
            type: 'object',
            properties: {
              uuid: { type: 'string' },
              host: { type: 'string' },
              sshPort: { type: 'number' },
              user: { type: 'string' },
              privateKey: { type: 'string' },
              expiresAt: { type: 'number' },
              timeRemainingSeconds: { type: 'number' },
              connectCommand: { type: 'string' }
            }
          }
        }
      }
    }
  }
}, async (request, reply) => {
  const { uuid } = request.body

  if (!isValidUuid(uuid)) {
    return reply.code(400).send({
      success: false,
      error: 'Invalid UUID format. Must be a valid UUID v4.'
    })
  }

  if (isUuidConflict(uuid)) {
    return reply.code(409).send({
      success: false,
      error: 'UUID already in use. A session with this UUID already exists.'
    })
  }

  try {
    const result = await provisionContainer(uuid)
    const host = process.env.HOST_IP || '127.0.0.1'

    return {
      success: true,
      data: {
        ...result,
        host,
        connectCommand: `ssh -i <key-file> -p ${result.sshPort} labuser@${host}`,
        message: `Session will auto-terminate in 30 minutes`
      }
    }
  } catch (err) {
    const statusCode = err.message.includes('Maximum concurrent') ? 503
      : err.message.includes('already exists') ? 409
      : 500

    return reply.code(statusCode).send({
      success: false,
      error: err.message
    })
  }
})

// ─────────────────────────────────────────────
// DELETE /labs/:uuid
// Destroys the container for the given UUID
// ─────────────────────────────────────────────
app.delete('/labs/:uuid', {
  schema: {
    params: {
      type: 'object',
      required: ['uuid'],
      properties: {
        uuid: { type: 'string' }
      }
    }
  }
}, async (request, reply) => {
  const { uuid } = request.params

  if (!isValidUuid(uuid)) {
    return reply.code(400).send({
      success: false,
      error: 'Invalid UUID format.'
    })
  }

  try {
    const result = await destroyContainer(uuid)
    return { success: true, data: result }
  } catch (err) {
    const statusCode = err.message.includes('not found') ? 404 : 500
    return reply.code(statusCode).send({
      success: false,
      error: err.message
    })
  }
})

// ─────────────────────────────────────────────
// GET /labs/:uuid
// Returns SSH connection details for given UUID
// ─────────────────────────────────────────────
app.get('/labs/:uuid', {
  schema: {
    params: {
      type: 'object',
      required: ['uuid'],
      properties: {
        uuid: { type: 'string' }
      }
    }
  }
}, async (request, reply) => {
  const { uuid } = request.params

  if (!isValidUuid(uuid)) {
    return reply.code(400).send({
      success: false,
      error: 'Invalid UUID format.'
    })
  }

  try {
    const details = getConnectionDetails(uuid)
    const host = process.env.HOST_IP || '127.0.0.1'
    return {
      success: true,
      data: {
        ...details,
        host,
        connectCommand: `ssh -i <key-file> -p ${details.port} labuser@${host}`
      }
    }
  } catch (err) {
    const statusCode = err.message.includes('not found') ? 404 : 500
    return reply.code(statusCode).send({
      success: false,
      error: err.message
    })
  }
})

// ─────────────────────────────────────────────
// GET /labs/stats
// Returns current session count and capacity
// ─────────────────────────────────────────────
app.get('/labs/stats', async () => {
  return { success: true, data: getStats() }
})

// ─────────────────────────────────────────────
// GET /health
// ─────────────────────────────────────────────
app.get('/health', async () => {
  return { status: 'ok', timestamp: new Date().toISOString() }
})

// Start server
const start = async () => {
  try {
    const port = Number(process.env.PORT) || 3000
    const host = process.env.BIND_HOST || '0.0.0.0'
    await app.listen({ port, host })
    app.log.info(`ServerKit Labs API running on ${host}:${port}`)
  } catch (err) {
    app.log.error(err)
    process.exit(1)
  }
}

start()
