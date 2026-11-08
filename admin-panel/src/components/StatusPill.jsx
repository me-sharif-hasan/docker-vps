const COLORS = {
  running: 'bg-green-50 text-green-600 dark:bg-green-500/10',
  stopped: 'bg-gray-100 text-gray-600 dark:bg-white/10 dark:text-white',
  reclaim_grace: 'bg-amber-50 text-amber-600 dark:bg-amber-500/10',
  missing: 'bg-red-50 text-red-600 dark:bg-red-500/10',
  active: 'bg-green-50 text-green-600 dark:bg-green-500/10',
  inactive: 'bg-gray-100 text-gray-600 dark:bg-white/10 dark:text-white',
  orphaned: 'bg-red-50 text-red-600 dark:bg-red-500/10'
}

export default function StatusPill({ status }) {
  const cls = COLORS[status] || 'bg-gray-100 text-gray-600 dark:bg-white/10 dark:text-white'
  return (
    <span className={`inline-block rounded-full px-3 py-1 text-xs font-bold capitalize ${cls}`}>
      {String(status).replace(/_/g, ' ')}
    </span>
  )
}
