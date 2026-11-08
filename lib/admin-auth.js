'use strict'

// ADMIN_KEY guard shared by every /api/admin/* route and /dashboard - query
// ?key= or header x-admin-key. Returns false (and has already sent the 401)
// when the check fails; callers do `if (checkAdminKey(request, reply) === false) return`.
function checkAdminKey(request, reply) {
  const adminKey = process.env.ADMIN_KEY
  if (!adminKey) return // no key set -> open (dev mode)
  const provided = request.headers['x-admin-key'] || request.query.key
  if (provided !== adminKey) {
    reply.code(401).send({ success: false, error: 'Unauthorized' })
    return false
  }
}

module.exports = { checkAdminKey }
