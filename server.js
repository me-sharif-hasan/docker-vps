'use strict'

const path = require('path')
const Fastify = require('fastify')
const cors = require('@fastify/cors')
const rateLimit = require('@fastify/rate-limit')
const fastifyStatic = require('@fastify/static')
const { verifyLabsJwt } = require('./auth')
const { startBackgroundReconciliation } = require('./container-manager')
const publicRoutes = require('./routes/public-routes')
const authRoutes = require('./routes/auth-routes')
const labsRoutes = require('./routes/labs-routes')
const entitlementRoutes = require('./routes/entitlement-routes')
const adminRoutes = require('./routes/admin-routes')

const app = Fastify({
  // Trust X-Forwarded-For / X-Real-IP only when the connecting socket is
  // the local nginx (127.0.0.1/::1) - i.e. only on requests that actually
  // came through the reverse proxy. Without a scoped list here, trustProxy
  // would either (a) left unset: always see nginx's loopback IP as
  // request.ip, breaking the debug-whitelist IP check entirely, or
  // (b) set to `true`: trust the header unconditionally, letting anyone
  // who reaches the app directly (e.g. its bound port before/without a
  // firewall rule) spoof X-Forwarded-For to impersonate a whitelisted IP.
  trustProxy: ['127.0.0.1', '::1'],
  logger: {
    transport: {
      target: 'pino-pretty',
      options: { colorize: true }
    }
  }
})

app.register(cors, { origin: true })

// Admin panel (admin-panel/, built with `npm run build` there) - static
// files only. The data underneath is still fully gated: every /api/admin/*
// route checks the x-admin-key header itself (lib/admin-auth.js), the SPA
// just asks for that key on its sign-in screen and stores it client-side.
app.register(fastifyStatic, {
  root: path.join(__dirname, 'admin-panel', 'dist'),
  prefix: '/dashboard/'
})
app.get('/dashboard', (request, reply) => reply.redirect('/dashboard/'))

// Global default - generous, just stops naive flooding. /labs/provision
// gets a much tighter per-route override since that's the one endpoint
// that actually costs resources (spins up a container).
app.register(rateLimit, { max: 60, timeWindow: '1 minute' })

// ─────────────────────────────────────────────
// JWT bearer guard on all /labs/* routes
//
// IMPORTANT: this checks request.routeOptions.url (the matched route
// PATTERN, resolved by Fastify's router after it already decoded the path)
// rather than request.url (the raw, still-percent-encoded path string).
// A prefix check against the raw url (`request.url.startsWith('/labs/')`)
// is bypassable: a path like /%6cabs/provision does not start with
// "/labs/" as a raw string, so the old check let it through, but Fastify's
// router still decodes and dispatches it to the /labs/provision handler
// unauthenticated. Matching on the resolved route closes that gap because
// it reflects what actually got dispatched, not the attacker-controlled
// raw string.
// ─────────────────────────────────────────────
app.addHook('onRequest', async (request, reply) => {
  const routeUrl = request.routeOptions && request.routeOptions.url
  if (!routeUrl || !routeUrl.startsWith('/labs')) return

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

app.register(publicRoutes)
app.register(authRoutes)
app.register(labsRoutes)
app.register(entitlementRoutes)
app.register(adminRoutes)

// Start server
const start = async () => {
  try {
    const port = Number(process.env.PORT) || 3000
    const host = process.env.BIND_HOST || '0.0.0.0'
    await app.listen({ port, host })
    app.log.info(`ServerKit Labs API running on ${host}:${port}`)
    startBackgroundReconciliation()
  } catch (err) {
    app.log.error(err)
    process.exit(1)
  }
}

start()
