import React, { createContext, useContext, useState, useCallback } from 'react'
import { api, getAdminKey, setAdminKey, clearAdminKey } from '../api/client'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [authed, setAuthed] = useState(!!getAdminKey())
  const [error, setError] = useState('')
  const [checking, setChecking] = useState(false)

  // The admin key has no separate "login" endpoint - it's just the header
  // every /api/admin/* route checks (lib/admin-auth.js). Signing in means
  // storing the key and proving it works against a real gated endpoint.
  const signIn = useCallback(async (key) => {
    setChecking(true)
    setError('')
    setAdminKey(key)
    try {
      await api.getSettings()
      setAuthed(true)
      return true
    } catch (err) {
      clearAdminKey()
      setAuthed(false)
      setError(err.message || 'Sign-in failed')
      return false
    } finally {
      setChecking(false)
    }
  }, [])

  const signOut = useCallback(() => {
    clearAdminKey()
    setAuthed(false)
  }, [])

  return (
    <AuthContext.Provider value={{ authed, error, checking, signIn, signOut }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider')
  return ctx
}
