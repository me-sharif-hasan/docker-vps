import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../../context/AuthContext'

export default function SignIn() {
  const [key, setKey] = useState('')
  const { signIn, error, checking } = useAuth()
  const navigate = useNavigate()

  const submit = async (e) => {
    e.preventDefault()
    const ok = await signIn(key)
    if (ok) navigate('/', { replace: true })
  }

  return (
    <div className="flex h-screen w-full items-center justify-center bg-lightPrimary dark:bg-navy-900">
      <div className="w-full max-w-md rounded-[20px] bg-white p-8 shadow-3xl shadow-shadow-500 dark:bg-navy-800 dark:shadow-none">
        <h3 className="mb-1 text-2xl font-bold text-navy-700 dark:text-white">ServerKit Labs</h3>
        <p className="mb-6 text-sm text-gray-600 dark:text-gray-400">Enter your admin key to continue.</p>

        <form onSubmit={submit}>
          <label className="mb-2 block text-sm font-bold text-navy-700 dark:text-white">Admin key</label>
          <input
            type="password"
            autoFocus
            value={key}
            onChange={(e) => setKey(e.target.value)}
            className="mb-4 w-full rounded-xl border border-gray-200 bg-white/0 p-3 text-sm text-navy-700 outline-none focus:border-brand-500 dark:border-white/10 dark:text-white"
            placeholder="ADMIN_KEY"
          />
          {error && <p className="mb-4 text-sm font-medium text-red-500">{error}</p>}
          <button
            type="submit"
            disabled={checking}
            className="w-full rounded-xl bg-brand-500 py-3 text-sm font-bold text-white transition hover:bg-brand-600 disabled:opacity-60"
          >
            {checking ? 'Checking...' : 'Sign In'}
          </button>
        </form>
      </div>
    </div>
  )
}
