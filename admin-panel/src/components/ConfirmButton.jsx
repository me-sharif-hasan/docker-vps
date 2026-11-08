import { useState } from 'react'

// A destructive action (force-delete, revoke) needs a real "are you sure"
// step, not a toast that can be mis-clicked past. First click arms it,
// second click (within the same render) actually fires.
export default function ConfirmButton({ onConfirm, label, confirmLabel = 'Confirm?', className = '' }) {
  const [armed, setArmed] = useState(false)
  const [busy, setBusy] = useState(false)

  const click = async () => {
    if (!armed) {
      setArmed(true)
      setTimeout(() => setArmed(false), 3000)
      return
    }
    setBusy(true)
    try {
      await onConfirm()
    } finally {
      setBusy(false)
      setArmed(false)
    }
  }

  return (
    <button
      onClick={click}
      disabled={busy}
      className={`rounded-lg px-3 py-1.5 text-xs font-bold transition disabled:opacity-60 ${
        armed ? 'bg-red-500 text-white' : 'bg-red-50 text-red-600 hover:bg-red-100 dark:bg-red-500/10'
      } ${className}`}
    >
      {busy ? '...' : armed ? confirmLabel : label}
    </button>
  )
}
