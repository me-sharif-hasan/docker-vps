'use strict'

const { GoogleAuth } = require('google-auth-library')
const jwt = require('jsonwebtoken')
const path = require('path')

const SERVICE_ACCOUNT_PATH = path.join(__dirname, 'service-account.json')
const PLAY_INTEGRITY_SCOPE = 'https://www.googleapis.com/auth/playintegrity'
const JWT_SECRET = process.env.JWT_SECRET
const JWT_EXPIRY = '1h'

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
