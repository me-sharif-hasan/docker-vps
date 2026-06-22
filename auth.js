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
    console.log('[Auth] ✓ Using serviceaccount-new.json')
    return newPath
  }

  if (fs.existsSync(oldPath)) {
    console.log('[Auth] ✓ Using service-account.json (fallback)')
    return oldPath
  }

  throw new Error('No service account file found. Expected: serviceaccount-new.json or service-account.json')
}

const SERVICE_ACCOUNT_PATH = getServiceAccountPath()
console.log('[Auth] Service account path:', SERVICE_ACCOUNT_PATH)

const googleAuth = new GoogleAuth({
  keyFile: SERVICE_ACCOUNT_PATH,
  scopes: [PLAY_INTEGRITY_SCOPE]
})

let currentGoogleAuth = googleAuth

async function verifyIntegrityToken (integrityToken, packageName) {
  const url = `https://playintegrity.googleapis.com/v1/${encodeURIComponent(packageName)}:decodeIntegrityToken`

  try {
    const client = await currentGoogleAuth.getClient()
    const accessToken = await client.getAccessToken()

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
  } catch (err) {
    // Try fallback to old service account if new one fails
    const newPath = path.join(__dirname, 'serviceaccount-new.json')
    const oldPath = path.join(__dirname, 'service-account.json')
    const currentPath = SERVICE_ACCOUNT_PATH

    if (currentPath === newPath && fs.existsSync(oldPath)) {
      console.log('[Auth] ⚠️  New service account failed, trying fallback: service-account.json')

      const fallbackAuth = new GoogleAuth({
        keyFile: oldPath,
        scopes: [PLAY_INTEGRITY_SCOPE]
      })

      const client = await fallbackAuth.getClient()
      const accessToken = await client.getAccessToken()

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
        throw new Error(`Play Integrity API error (fallback) ${res.status}: ${errBody}`)
      }

      console.log('[Auth] ✓ Fallback succeeded with service-account.json')
      return res.json()
    }

    throw err
  }
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
