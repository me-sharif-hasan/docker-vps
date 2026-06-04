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
