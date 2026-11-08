import { useState } from 'react'
import { MdDelete, MdAdd } from 'react-icons/md'

// Generic "list of strings with add/remove" editor - the same pattern
// repeats across pro-devices, subscriber-devices, bans and the debug
// whitelist, each backed by a real admin-routes.js { add } / { remove }
// endpoint.
export default function ListEditor({ items, placeholder, onAdd, onRemove, error }) {
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (e) => {
    e.preventDefault()
    if (!value.trim()) return
    setBusy(true)
    try {
      await onAdd(value.trim())
      setValue('')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <form onSubmit={submit} className="mb-3 flex gap-2">
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={placeholder}
          className="flex-1 rounded-xl border border-gray-200 bg-white/0 p-2.5 text-sm text-navy-700 outline-none focus:border-brand-500 dark:border-white/10 dark:text-white"
        />
        <button
          type="submit"
          disabled={busy}
          className="flex items-center gap-1 rounded-xl bg-brand-500 px-4 py-2.5 text-sm font-bold text-white hover:bg-brand-600 disabled:opacity-60"
        >
          <MdAdd className="h-4 w-4" /> Add
        </button>
      </form>
      {error && <p className="mb-3 text-sm font-medium text-red-500">{error}</p>}
      {items.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">None.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {items.map((item) => (
            <li
              key={item}
              className="flex items-center justify-between rounded-xl bg-lightPrimary px-3 py-2 text-sm text-navy-700 dark:bg-navy-700 dark:text-white"
            >
              <span className="break-all font-mono">{item}</span>
              <button onClick={() => onRemove(item)} className="text-red-500 hover:text-red-600">
                <MdDelete className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
