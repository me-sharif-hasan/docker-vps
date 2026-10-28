'use strict'

const Fastify = require('fastify')
const cors = require('@fastify/cors')
const fs = require('fs')
const path = require('path')
const {
  provisionContainer,
  destroyContainer,
  forceDestroyContainer,
  getConnectionDetails,
  getStats,
  getDetailedStats,
  isUuidConflict
} = require('./container-manager')
const { isValidUuid } = require('./validate')
const { verifyIntegrityToken, signLabsJwt, verifyLabsJwt } = require('./auth')
const net = require('net')

function isValidIp (str) {
  return typeof str === 'string' && net.isIP(str) !== 0
}

// Settings — persisted to settings.json, survives restarts
const SETTINGS_FILE = path.join(__dirname, 'settings.json')

function loadSettings () {
  try {
    const loaded = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'))
    if (!Array.isArray(loaded.debugWhitelistIps)) loaded.debugWhitelistIps = []
    return loaded
  } catch {
    return {
      skipDebugPackages: process.env.SKIP_DEBUG_PACKAGES === 'true' || false,
      debugWhitelistIps: []
    }
  }
}

function saveSettings () {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2))
}

const settings = loadSettings()

const app = Fastify({
  // Trust X-Forwarded-For / X-Real-IP only when the connecting socket is
  // the local nginx (127.0.0.1/::1) — i.e. only on requests that actually
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

  // Skip Play Integrity for debug builds when the setting is enabled AND
  // the caller's IP is on the whitelist. The bypass is deliberately kept
  // (it's needed for local/dev testing) but it must not be reachable from
  // the open internet — an unlisted IP falls through to the real Play
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

// ─────────────────────────────────────────────
// POST /labs/provision
// Body: { uuid: string, deviceId?: string }
// Creates a new lab container for the given UUID. deviceId is an opaque,
// client-generated id (not tied to this uuid) used to cap one active free
// session per install — see provisionContainer's own comment on why this
// exists at all.
// Returns: ssh connection details + private key
// ─────────────────────────────────────────────
app.post('/labs/provision', {
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
    const result = await provisionContainer(uuid, deviceId)
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

app.delete('/api/admin/containers/:containerId', async (request, reply) => {
  if (checkAdminKey(request, reply) === false) return
  try {
    const result = await forceDestroyContainer(request.params.containerId)
    return { success: true, data: result }
  } catch (err) {
    return reply.code(500).send({ success: false, error: err.message })
  }
})

app.get('/api/admin/settings', async (request, reply) => {
  if (checkAdminKey(request, reply) === false) return
  return { success: true, data: settings }
})

app.post('/api/admin/settings', async (request, reply) => {
  if (checkAdminKey(request, reply) === false) return
  const { skipDebugPackages } = request.body || {}
  if (typeof skipDebugPackages === 'boolean') {
    settings.skipDebugPackages = skipDebugPackages
    saveSettings()
    return { success: true, data: settings }
  }
  return reply.code(400).send({
    success: false,
    error: 'Invalid request. Expected: { skipDebugPackages: boolean }'
  })
})

// ─────────────────────────────────────────────
// GET  /api/admin/debug-whitelist        — list whitelisted IPs
// POST /api/admin/debug-whitelist        — { add: ip } or { remove: ip }
// ─────────────────────────────────────────────
app.get('/api/admin/debug-whitelist', async (request, reply) => {
  if (checkAdminKey(request, reply) === false) return
  return { success: true, data: { ips: settings.debugWhitelistIps } }
})

app.post('/api/admin/debug-whitelist', async (request, reply) => {
  if (checkAdminKey(request, reply) === false) return
  const { add, remove } = request.body || {}

  if (add !== undefined) {
    if (!isValidIp(add)) {
      return reply.code(400).send({ success: false, error: 'Invalid IP address' })
    }
    if (!settings.debugWhitelistIps.includes(add)) settings.debugWhitelistIps.push(add)
    saveSettings()
    return { success: true, data: { ips: settings.debugWhitelistIps } }
  }

  if (remove !== undefined) {
    settings.debugWhitelistIps = settings.debugWhitelistIps.filter(ip => ip !== remove)
    saveSettings()
    return { success: true, data: { ips: settings.debugWhitelistIps } }
  }

  return reply.code(400).send({
    success: false,
    error: 'Invalid request. Expected: { add: ip } or { remove: ip }'
  })
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
  .badge.orphaned{background:#451a03;color:#fb923c}
  .bar-wrap{background:#2d3148;border-radius:4px;height:6px;width:80px;display:inline-block;vertical-align:middle;margin-left:6px}
  .bar{height:6px;border-radius:4px;background:#6366f1}
  .bar.warn{background:#f59e0b}
  .bar.danger{background:#ef4444}
  .btn-destroy{background:#7f1d1d;color:#fca5a5;border:1px solid #991b1b;border-radius:6px;padding:4px 10px;font-size:0.75rem;cursor:pointer;font-weight:600}
  .btn-destroy:hover{background:#991b1b}
  .btn-destroy:disabled{opacity:0.4;cursor:not-allowed}
  .refresh{font-size:0.75rem;color:#475569;margin-bottom:16px}
  .no-data{text-align:center;padding:40px;color:#475569}
  .section-title{font-size:0.85rem;font-weight:600;color:#94a3b8;margin-bottom:12px;text-transform:uppercase;letter-spacing:.06em}
  .settings-box{background:#1e2130;border:1px solid #2d3148;border-radius:12px;padding:16px;margin-bottom:24px}
  .setting-item{display:flex;align-items:center;justify-content:space-between;padding:12px 0;border-bottom:1px solid #2d3148}
  .setting-item:last-child{border-bottom:none}
  .setting-label{font-size:0.85rem;font-weight:500}
  .toggle-switch{position:relative;width:44px;height:24px;background:#334155;border-radius:12px;cursor:pointer;transition:background 0.2s}
  .toggle-switch.active{background:#22c55e}
  .toggle-switch .slider{position:absolute;top:2px;left:2px;width:20px;height:20px;background:#fff;border-radius:50%;transition:left 0.2s}
  .toggle-switch.active .slider{left:22px}
  .ip-list{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}
  .ip-chip{display:flex;align-items:center;gap:6px;background:#252840;border:1px solid #2d3148;border-radius:6px;padding:4px 6px 4px 10px;font-family:monospace;font-size:0.8rem}
  .ip-chip button{background:none;border:none;color:#64748b;cursor:pointer;font-size:0.9rem;line-height:1;padding:2px 4px}
  .ip-chip button:hover{color:#ef4444}
  .ip-add-row{display:flex;gap:8px;margin-top:10px}
  .ip-add-row input{flex:1;background:#0f1117;border:1px solid #2d3148;border-radius:6px;padding:8px 10px;color:#e2e8f0;font-family:monospace;font-size:0.85rem}
  .ip-add-row button{background:#3730a3;color:#e0e7ff;border:1px solid #4338ca;border-radius:6px;padding:8px 14px;font-size:0.8rem;font-weight:600;cursor:pointer}
  .ip-add-row button:hover{background:#4338ca}
  .ip-empty{font-size:0.78rem;color:#64748b;margin-top:10px}
</style>
</head>
<body>
<h1>ServerKit Labs <span id="last-update">Loading...</span></h1>
<div class="refresh">Auto-refreshes every 5 seconds</div>
<div class="settings-box">
  <div class="section-title">Settings</div>
  <div class="setting-item">
    <span class="setting-label">Skip Debug Packages (.debug)</span>
    <div class="toggle-switch" id="skip-debug-toggle" onclick="toggleSkipDebug()">
      <div class="slider"></div>
    </div>
  </div>
  <div class="setting-item" style="display:block">
    <span class="setting-label">Debug Bypass IP Whitelist</span>
    <div id="ip-list" class="ip-list"></div>
    <div class="ip-add-row">
      <input type="text" id="ip-input" placeholder="e.g. 203.0.113.42" onkeydown="if(event.key==='Enter')addIp()"/>
      <button onclick="addIp()">Add</button>
    </div>
  </div>
</div>
<div class="cards" id="cards"></div>
<div class="section-title">Active Containers</div>
<div id="table-wrap"></div>
<script>
const QS = '${qs}'
function barClass(p){return p>80?'danger':p>60?'warn':''}
function fmt(n,d=1){return n==null?'—':n.toFixed(d)}
function fmtTime(s){if(s<=0)return'Expired';const m=Math.floor(s/60);const sec=s%60;return m+'m '+sec+'s'}
function fmtDate(ts){return new Date(ts).toLocaleTimeString()}

async function toggleSkipDebug(){
  try{
    const r=await fetch('/api/admin/settings'+QS)
    const j=await r.json()
    if(!j.success)return
    const newVal=!j.data.skipDebugPackages
    const ur=await fetch('/api/admin/settings'+QS,{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({skipDebugPackages:newVal})
    })
    const uj=await ur.json()
    if(uj.success){updateSkipDebugUI(uj.data.skipDebugPackages)}
  }catch(e){alert('Failed to toggle setting')}
}

function updateSkipDebugUI(enabled){
  const toggle=document.getElementById('skip-debug-toggle')
  if(enabled){
    toggle.classList.add('active')
  }else{
    toggle.classList.remove('active')
  }
}

function renderIpList(ips){
  const el=document.getElementById('ip-list')
  if(!ips||ips.length===0){
    el.innerHTML='<div class="ip-empty">No IPs whitelisted — the .debug bypass is unreachable from anywhere.</div>'
    return
  }
  el.innerHTML=ips.map(ip=>\`<span class="ip-chip">\${ip}<button onclick="removeIp('\${ip}')" title="Remove">×</button></span>\`).join('')
}

async function loadIpList(){
  try{
    const r=await fetch('/api/admin/debug-whitelist'+QS)
    const j=await r.json()
    if(j.success)renderIpList(j.data.ips)
  }catch(e){}
}

async function addIp(){
  const input=document.getElementById('ip-input')
  const ip=input.value.trim()
  if(!ip)return
  try{
    const r=await fetch('/api/admin/debug-whitelist'+QS,{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({add:ip})
    })
    const j=await r.json()
    if(j.success){input.value='';renderIpList(j.data.ips)}else{alert('Error: '+j.error)}
  }catch(e){alert('Request failed')}
}

async function removeIp(ip){
  try{
    const r=await fetch('/api/admin/debug-whitelist'+QS,{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({remove:ip})
    })
    const j=await r.json()
    if(j.success)renderIpList(j.data.ips)
  }catch(e){alert('Request failed')}
}

async function destroy(fullId,btn){
  if(!confirm('Force destroy this container?'))return
  btn.disabled=true
  btn.textContent='Destroying…'
  try{
    const r=await fetch('/api/admin/containers/'+fullId+QS,{method:'DELETE'})
    const j=await r.json()
    if(j.success){load()}else{alert('Error: '+j.error);btn.disabled=false;btn.textContent='Destroy'}
  }catch(e){alert('Request failed');btn.disabled=false;btn.textContent='Destroy'}
}

async function load(){
  try{
    const sr=await fetch('/api/admin/settings'+QS)
    const sj=await sr.json()
    if(sj.success){updateSkipDebugUI(sj.data.skipDebugPackages)}
    loadIpList()

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
      const remaining=c.timeRemainingSeconds!=null?fmtTime(c.timeRemainingSeconds):'—'
      const statusBadge=c.orphaned
        ?'<span class="badge orphaned">orphaned</span>'
        :'<span class="badge running">running</span>'
      return \`<tr>
        <td title="\${c.uuid}">\${c.uuid.slice(0,8)}…</td>
        <td>\${c.containerId}</td>
        <td>\${c.sshPort??'—'}</td>
        <td>\${statusBadge}</td>
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
        <td><button class="btn-destroy" onclick="destroy('\${c.fullContainerId}',this)">Destroy</button></td>
      </tr>\`
    }).join('')

    document.getElementById('table-wrap').innerHTML=\`
      <table>
        <thead><tr>
          <th>UUID</th><th>Container ID</th><th>SSH Port</th><th>Status</th>
          <th>RAM</th><th>CPU</th><th>Expires</th><th>Started</th><th></th>
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
