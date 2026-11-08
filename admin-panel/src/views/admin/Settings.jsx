import { useEffect, useState } from 'react'
import Card from '../../components/card/Card'
import ListEditor from '../../components/ListEditor'
import usePolling from '../../hooks/usePolling'
import { api } from '../../api/client'

function Toggle({ checked, onChange, disabled }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      disabled={disabled}
      className={`relative h-6 w-11 rounded-full transition disabled:opacity-60 ${checked ? 'bg-brand-500' : 'bg-gray-300 dark:bg-white/20'}`}
    >
      <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition ${checked ? 'left-5' : 'left-0.5'}`} />
    </button>
  )
}

function SavedTag({ show }) {
  if (!show) return null
  return <span className="ml-3 text-xs font-bold text-green-600">Saved</span>
}

export default function Settings() {
  const { data: settings, refresh: refreshSettings } = usePolling(api.getSettings, 15000)
  const { data: sessionLimits, refresh: refreshSessionLimits } = usePolling(api.getSessionLimits, 15000)
  const { data: labConfig, refresh: refreshLabConfig } = usePolling(api.getPersistedLabConfig, 15000)
  const { data: whitelist, refresh: refreshWhitelist } = usePolling(api.getDebugWhitelist, 15000)

  const [freeMin, setFreeMin] = useState('')
  const [proMin, setProMin] = useState('')
  const [reclaimDays, setReclaimDays] = useState('')
  const [rolloutDate, setRolloutDate] = useState('')
  const [savedField, setSavedField] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    if (sessionLimits) {
      setFreeMin(String(sessionLimits.freeSessionMinutes))
      setProMin(String(sessionLimits.proSessionMinutes))
    }
  }, [sessionLimits])

  useEffect(() => {
    if (labConfig) {
      setReclaimDays(String(labConfig.reclaimGraceDays))
      setRolloutDate(labConfig.rolloutStartedAt ? labConfig.rolloutStartedAt.slice(0, 10) : '')
    }
  }, [labConfig])

  const flash = (field) => {
    setSavedField(field)
    setTimeout(() => setSavedField(''), 1500)
  }

  const saveSessionLimits = async (e) => {
    e.preventDefault()
    setError('')
    try {
      await api.setSessionLimits({ freeSessionMinutes: Number(freeMin), proSessionMinutes: Number(proMin) })
      refreshSessionLimits()
      flash('sessionLimits')
    } catch (err) {
      setError(err.message)
    }
  }

  const saveLabConfig = async (e) => {
    e.preventDefault()
    setError('')
    try {
      await api.setPersistedLabConfig({
        reclaimGraceDays: Number(reclaimDays),
        rolloutStartedAt: new Date(rolloutDate).toISOString()
      })
      refreshLabConfig()
      flash('labConfig')
    } catch (err) {
      setError(err.message)
    }
  }

  const toggleSkipDebug = async (value) => {
    setError('')
    try {
      await api.setSkipDebugPackages(value)
      refreshSettings()
    } catch (err) {
      setError(err.message)
    }
  }

  const togglePersistedLabsEnabled = async (value) => {
    setError('')
    try {
      await api.setPersistedLabConfig({ persistedLabsEnabled: value })
      refreshLabConfig()
    } catch (err) {
      setError(err.message)
    }
  }

  return (
    <div className="flex flex-col gap-5">
      {error && <p className="text-sm font-medium text-red-500">{error}</p>}

      <Card extra="p-5">
        <div className="flex items-center justify-between">
          <div>
            <h4 className="text-lg font-bold text-navy-700 dark:text-white">Debug Play Integrity bypass</h4>
            <p className="text-sm text-gray-500 dark:text-gray-400">
              Skips Play Integrity for .debug packages from whitelisted IPs only.
            </p>
          </div>
          <Toggle checked={!!settings?.skipDebugPackages} onChange={toggleSkipDebug} disabled={!settings} />
        </div>
      </Card>

      <Card extra="p-5">
        <h4 className="mb-1 text-lg font-bold text-navy-700 dark:text-white">Debug IP whitelist</h4>
        <p className="mb-4 text-sm text-gray-500 dark:text-gray-400">
          Only these IPs can use the debug bypass above.
        </p>
        <ListEditor
          items={whitelist?.ips || []}
          placeholder="127.0.0.1"
          onAdd={async (ip) => { await api.addDebugWhitelistIp(ip); refreshWhitelist() }}
          onRemove={async (ip) => { await api.removeDebugWhitelistIp(ip); refreshWhitelist() }}
        />
      </Card>

      <Card extra="p-5">
        <h4 className="mb-1 text-lg font-bold text-navy-700 dark:text-white">Session limits</h4>
        <p className="mb-4 text-sm text-gray-500 dark:text-gray-400">
          Ephemeral session duration - applied at provision time, doesn't affect sessions already running.
        </p>
        <form onSubmit={saveSessionLimits} className="flex flex-wrap items-end gap-4">
          <div>
            <label className="mb-1 block text-xs font-bold text-gray-600 dark:text-gray-400">Free (minutes)</label>
            <input
              type="number"
              min="1"
              value={freeMin}
              onChange={(e) => setFreeMin(e.target.value)}
              className="w-32 rounded-xl border border-gray-200 bg-white/0 p-2.5 text-sm text-navy-700 outline-none focus:border-brand-500 dark:border-white/10 dark:text-white"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-bold text-gray-600 dark:text-gray-400">Pro (minutes)</label>
            <input
              type="number"
              min="1"
              value={proMin}
              onChange={(e) => setProMin(e.target.value)}
              className="w-32 rounded-xl border border-gray-200 bg-white/0 p-2.5 text-sm text-navy-700 outline-none focus:border-brand-500 dark:border-white/10 dark:text-white"
            />
          </div>
          <button type="submit" className="rounded-xl bg-brand-500 px-5 py-2.5 text-sm font-bold text-white hover:bg-brand-600">
            Save
          </button>
          <SavedTag show={savedField === 'sessionLimits'} />
        </form>
      </Card>

      <Card extra="p-5 border-2 border-amber-500">
        <div className="flex items-center justify-between">
          <div>
            <h4 className="text-lg font-bold text-navy-700 dark:text-white">Persisted labs (kill switch)</h4>
            <p className="text-sm text-gray-500 dark:text-gray-400">
              OFF by default. While off, every device gets the old ephemeral-only behavior - safe to deploy this
              backend ahead of the app update, since nothing changes for a user on the currently-live app build.
              Only turn this on once that update has actually shipped.
            </p>
          </div>
          <Toggle checked={!!labConfig?.persistedLabsEnabled} onChange={togglePersistedLabsEnabled} disabled={!labConfig} />
        </div>
      </Card>

      <Card extra="p-5">
        <h4 className="mb-1 text-lg font-bold text-navy-700 dark:text-white">Persisted lab config</h4>
        <p className="mb-4 text-sm text-gray-500 dark:text-gray-400">
          Drives the lifetime-pro grace-phase math and how long a lapsed lab's snapshot is kept before deletion.
          Persisted labs have no idle-stop - they run continuously once provisioned.
        </p>
        <form onSubmit={saveLabConfig} className="flex flex-wrap items-end gap-4">
          <div>
            <label className="mb-1 block text-xs font-bold text-gray-600 dark:text-gray-400">Rollout started</label>
            <input
              type="date"
              value={rolloutDate}
              onChange={(e) => setRolloutDate(e.target.value)}
              className="rounded-xl border border-gray-200 bg-white/0 p-2.5 text-sm text-navy-700 outline-none focus:border-brand-500 dark:border-white/10 dark:text-white"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-bold text-gray-600 dark:text-gray-400">Reclaim grace (days)</label>
            <input
              type="number"
              min="1"
              value={reclaimDays}
              onChange={(e) => setReclaimDays(e.target.value)}
              className="w-32 rounded-xl border border-gray-200 bg-white/0 p-2.5 text-sm text-navy-700 outline-none focus:border-brand-500 dark:border-white/10 dark:text-white"
            />
          </div>
          <button type="submit" className="rounded-xl bg-brand-500 px-5 py-2.5 text-sm font-bold text-white hover:bg-brand-600">
            Save
          </button>
          <SavedTag show={savedField === 'labConfig'} />
        </form>
      </Card>
    </div>
  )
}
