'use strict'

const Fastify = require('fastify')
const cors = require('@fastify/cors')
const {
  provisionContainer,
  destroyContainer,
  getConnectionDetails,
  getStats,
  getDetailedStats,
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

// ─────────────────────────────────────────────
// Admin — ADMIN_KEY guard (query ?key= or header x-admin-key)
// GET /api/admin/stats  — JSON
// GET /dashboard        — HTML UI
// ─────────────────────────────────────────────
function checkAdminKey (request, reply) {
  const adminKey = process.env.ADMIN_KEY
  if (!adminKey) return // no key set → open (dev mode)
  const provided = request.headers['x-admin-key'] || request.query.key
  if (provided !== adminKey) {
    reply.code(401).send({ success: false, error: 'Unauthorized' })
    return false
  }
}

app.get('/api/admin/stats', async (request, reply) => {
  if (checkAdminKey(request, reply) === false) return
  const stats = await getDetailedStats()
  return { success: true, data: stats }
})

app.get('/dashboard', async (request, reply) => {
  if (checkAdminKey(request, reply) === false) return
  const adminKey = process.env.ADMIN_KEY ? `?key=${process.env.ADMIN_KEY}` : ''
  reply.type('text/html').send(getDashboardHtml(adminKey))
})

function getDashboardHtml (qs) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>ServerKit Labs — Dashboard</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:#0f1117;color:#e2e8f0;font-family:'Segoe UI',system-ui,sans-serif;padding:24px}
  h1{font-size:1.4rem;font-weight:600;margin-bottom:24px;color:#fff}
  h1 span{color:#6366f1;font-size:0.9rem;margin-left:10px;font-weight:400}
  .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:16px;margin-bottom:28px}
  .card{background:#1e2130;border:1px solid #2d3148;border-radius:12px;padding:20px}
  .card-label{font-size:0.72rem;color:#94a3b8;text-transform:uppercase;letter-spacing:.08em;margin-bottom:8px}
  .card-value{font-size:2rem;font-weight:700;color:#fff}
  .card-value.green{color:#22c55e}
  .card-value.yellow{color:#f59e0b}
  .card-value.red{color:#ef4444}
  .card-sub{font-size:0.75rem;color:#64748b;margin-top:4px}
  table{width:100%;border-collapse:collapse;background:#1e2130;border-radius:12px;overflow:hidden;border:1px solid #2d3148}
  th{text-align:left;padding:12px 16px;font-size:0.72rem;color:#94a3b8;text-transform:uppercase;letter-spacing:.08em;border-bottom:1px solid #2d3148}
  td{padding:12px 16px;font-size:0.85rem;border-bottom:1px solid #1a1d2e;font-family:monospace}
  tr:last-child td{border-bottom:none}
  tr:hover td{background:#252840}
  .badge{display:inline-block;padding:2px 8px;border-radius:4px;font-size:0.72rem;font-weight:600}
  .badge.running{background:#14532d;color:#4ade80}
  .bar-wrap{background:#2d3148;border-radius:4px;height:6px;width:80px;display:inline-block;vertical-align:middle;margin-left:6px}
  .bar{height:6px;border-radius:4px;background:#6366f1}
  .bar.warn{background:#f59e0b}
  .bar.danger{background:#ef4444}
  .refresh{font-size:0.75rem;color:#475569;margin-bottom:16px}
  .no-data{text-align:center;padding:40px;color:#475569}
  .section-title{font-size:0.85rem;font-weight:600;color:#94a3b8;margin-bottom:12px;text-transform:uppercase;letter-spacing:.06em}
</style>
</head>
<body>
<h1>ServerKit Labs <span id="last-update">Loading...</span></h1>
<div class="refresh">Auto-refreshes every 5 seconds</div>
<div class="cards" id="cards"></div>
<div class="section-title">Active Containers</div>
<div id="table-wrap"></div>
<script>
const QS = '${qs}'
function barClass(p){return p>80?'danger':p>60?'warn':''}
function fmt(n,d=1){return n==null?'—':n.toFixed(d)}
function fmtTime(s){if(s<=0)return'Expired';const m=Math.floor(s/60);const sec=s%60;return m+'m '+sec+'s'}
function fmtDate(ts){return new Date(ts).toLocaleTimeString()}

async function load(){
  try{
    const r=await fetch('/api/admin/stats'+QS)
    const j=await r.json()
    if(!j.success)return
    const d=j.data
    document.getElementById('last-update').textContent='Updated '+new Date().toLocaleTimeString()

    const slotColor=d.availableSlots===0?'red':d.availableSlots<=3?'yellow':'green'
    document.getElementById('cards').innerHTML=\`
      <div class="card">
        <div class="card-label">Active Sessions</div>
        <div class="card-value">\${d.activeSessions}</div>
        <div class="card-sub">Max \${d.maxConcurrent}</div>
      </div>
      <div class="card">
        <div class="card-label">Available Slots</div>
        <div class="card-value \${slotColor}">\${d.availableSlots}</div>
        <div class="card-sub">of \${d.maxConcurrent}</div>
      </div>
      <div class="card">
        <div class="card-label">Total RAM Used</div>
        <div class="card-value">\${fmt(d.totalMemUsageMB)}<span style="font-size:1rem;color:#94a3b8"> MB</span></div>
        <div class="card-sub">across all containers</div>
      </div>
      <div class="card">
        <div class="card-label">Total CPU</div>
        <div class="card-value">\${fmt(d.totalCpuPercent)}<span style="font-size:1rem;color:#94a3b8"> %</span></div>
        <div class="card-sub">across all containers</div>
      </div>
    \`

    if(d.containers.length===0){
      document.getElementById('table-wrap').innerHTML='<div class="no-data">No active containers</div>'
      return
    }

    const rows=d.containers.map(c=>{
      const memP=c.memPercent??0
      const cpuP=Math.min(c.cpuPercent??0,100)
      const remaining=fmtTime(c.timeRemainingSeconds)
      return \`<tr>
        <td>\${c.uuid.slice(0,8)}…</td>
        <td>\${c.containerId}</td>
        <td>\${c.sshPort}</td>
        <td><span class="badge running">running</span></td>
        <td>
          \${fmt(c.memUsageMB)} / \${fmt(c.memLimitMB)} MB
          <span class="bar-wrap"><span class="bar \${barClass(memP)}" style="width:\${memP}%"></span></span>
        </td>
        <td>
          \${fmt(c.cpuPercent)} %
          <span class="bar-wrap"><span class="bar \${barClass(cpuP)}" style="width:\${cpuP}%"></span></span>
        </td>
        <td>\${remaining}</td>
        <td>\${fmtDate(c.createdAt)}</td>
      </tr>\`
    }).join('')

    document.getElementById('table-wrap').innerHTML=\`
      <table>
        <thead><tr>
          <th>UUID</th><th>Container ID</th><th>SSH Port</th><th>Status</th>
          <th>RAM</th><th>CPU</th><th>Expires</th><th>Started</th>
        </tr></thead>
        <tbody>\${rows}</tbody>
      </table>
    \`
  }catch(e){
    document.getElementById('last-update').textContent='Error loading'
  }
}
load()
setInterval(load,5000)
</script>
</body>
</html>`
}

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
