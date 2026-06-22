'use strict'

const { GoogleAuth } = require('google-auth-library')
const jwt = require('jsonwebtoken')
const path = require('path')
const fs = require('fs')

const PLAY_INTEGRITY_SCOPE = 'https://www.googleapis.com/auth/playintegrity'
const JWT_SECRET = process.env.JWT_SECRET
const JWT_EXPIRY = '1h'

// Try new service account first, fall back to old one for backward compatibility
function getServiceAccountPath() {
  const newPath = path.join(__dirname, 'serviceaccount-new.json')
  const oldPath = path.join(__dirname, 'service-account.json')

  if (fs.existsSync(newPath)) {
    console.log('[Auth] Using serviceaccount-new.json')
    return newPath
  }

  if (fs.existsSync(oldPath)) {
    console.log('[Auth] Using service-account.json (fallback)')
    return oldPath
  }

  throw new Error('No service account file found. Expected: serviceaccount-new.json or service-account.json')
}

const SERVICE_ACCOUNT_PATH = getServiceAccountPath()

const googleAuth = new GoogleAuth({
  keyFile: SERVICE_ACCOUNT_PATH,
  scopes: [PLAY_INTEGRITY_SCOPE]
})

async function verifyIntegrityToken (integrityToken, packageName) {
  const client = await googleAuth.getClient()
  const accessToken = await client.getAccessToken()

  const url = `https://playintegrity.googleapis.com/v1/${encodeURIComponent(packageName)}:decodeIntegrityToken`

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken.token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ integrity_token: integrityToken })
  })

  if (!res.ok) {
    const errBody = await res.text()
    throw new Error(`Play Integrity API error ${res.status}: ${errBody}`)
  }

  return res.json()
}

function signLabsJwt (payload) {
  if (!JWT_SECRET) throw new Error('JWT_SECRET env var not set')
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRY })
}

function verifyLabsJwt (token) {
  if (!JWT_SECRET) throw new Error('JWT_SECRET env var not set')
  return jwt.verify(token, JWT_SECRET)
}

module.exports = { verifyIntegrityToken, signLabsJwt, verifyLabsJwt }
