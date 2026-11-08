'use strict'

const {
  provisionContainer,
  destroyContainer,
  getConnectionDetails,
  getStats,
  isUuidConflict
} = require('../container-manager')
const { isValidUuid } = require('../validate')

// Everything under /labs/* - the JWT bearer guard for this prefix is
// registered globally in server.js (see its comment on why the check is
// done against the resolved route, not the raw percent-encodable path).
module.exports = async function labsRoutes(app) {
  // ─────────────────────────────────────────────
  // POST /labs/provision
  // Body: { uuid: string, deviceId?: string }
  // Creates a new lab container for the given UUID. deviceId is an opaque,
  // client-generated id (not tied to this uuid) used to cap one active free
  // session per install - see provisionContainer's own comment on why this
  // exists at all.
  // Returns: ssh connection details + private key
  // ─────────────────────────────────────────────
  app.post('/labs/provision', {
    // Provisioning spins up a real container - 5/min/IP is plenty for a
    // legitimate user (one session at a time, device-capped anyway) and
    // blunts scripted mass-provisioning.
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    schema: {
      body: {
        type: 'object',
        required: ['uuid'],
        properties: {
          uuid: { type: 'string' },
          deviceId: { type: 'string', maxLength: 128 }
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
                // Persisted labs (lib/persisted-lab-lifecycle.js) have no
                // session timer - null, not a schema-coerced 0. Without
                // `['number', 'null']` here, fast-json-stringify silently
                // turns a real null into 0, which reads as "already
                // expired" instead of "no limit" - caught by a real
                // provision-persisted-lab test against this schema.
                expiresAt: { type: ['number', 'null'] },
                timeRemainingSeconds: { type: ['number', 'null'] },
                connectCommand: { type: 'string' },
                message: { type: 'string' }
              }
            }
          }
        }
      }
    }
  }, async (request, reply) => {
    const { uuid, deviceId } = request.body

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
      const result = await provisionContainer(uuid, deviceId, request.ip)
      const host = process.env.HOST_IP || '127.0.0.1'

      const message = result.timeRemainingSeconds == null
        ? 'Persisted lab - no session time limit'
        : `Session will auto-terminate in ${Math.round(result.timeRemainingSeconds / 60)} minutes`

      return {
        success: true,
        data: {
          ...result,
          host,
          connectCommand: `ssh -i <key-file> -p ${result.sshPort} labuser@${host}`,
          message
        }
      }
    } catch (err) {
      const statusCode = err.message.includes('banned') ? 403
        : err.message.includes('Maximum concurrent') ? 503
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
}
