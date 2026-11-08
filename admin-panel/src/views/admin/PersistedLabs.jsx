import { useMemo, useState } from 'react'
import Card from '../../components/card/Card'
import DataTable from '../../components/table/DataTable'
import StatusPill from '../../components/StatusPill'
import ConfirmButton from '../../components/ConfirmButton'
import usePolling from '../../hooks/usePolling'
import { api } from '../../api/client'
import { formatBytes } from '../../utils/format'

function fmt(ts) {
  return ts ? new Date(ts).toLocaleString() : '-'
}

export default function PersistedLabs() {
  const { data, error, refresh } = usePolling(api.getPersistedLabs, 5000)
  const [actionError, setActionError] = useState('')

  const resume = async (uuid) => {
    setActionError('')
    try {
      await api.resumePersistedLab(uuid)
      refresh()
    } catch (err) {
      setActionError(err.message)
    }
  }

  const forceDelete = async (uuid) => {
    setActionError('')
    try {
      await api.forceDeletePersistedLab(uuid)
      refresh()
    } catch (err) {
      setActionError(err.message)
    }
  }

  const columns = useMemo(() => [
    { header: 'Device', accessorKey: 'deviceId', cell: ({ getValue }) => <span className="font-mono text-xs">{getValue()}</span> },
    { header: 'UUID', accessorKey: 'uuid', cell: ({ getValue }) => <span className="font-mono text-xs">{getValue().slice(0, 8)}...</span> },
    { header: 'State', accessorKey: 'state', cell: ({ getValue }) => <StatusPill status={getValue()} /> },
    { header: 'SSH port', accessorKey: 'sshPort' },
    { header: 'Last seen', accessorKey: 'lastSeenAt', cell: ({ getValue }) => fmt(getValue()) },
    {
      header: 'Reclaim grace since',
      accessorKey: 'reclaimGraceStartedAt',
      cell: ({ getValue }) => (getValue() ? fmt(getValue()) : '-')
    },
    { header: 'Snapshot', accessorKey: 'snapshotKey', cell: ({ getValue }) => getValue() ? 'yes' : 'none yet' },
    {
      header: 'Lifetime in',
      accessorKey: 'lifetimeBytesIn',
      cell: ({ getValue }) => formatBytes(getValue())
    },
    {
      header: 'Lifetime out',
      accessorKey: 'lifetimeBytesOut',
      cell: ({ getValue }) => formatBytes(getValue())
    },
    {
      header: '',
      id: 'actions',
      cell: ({ row }) => (
        <div className="flex gap-2">
          {row.original.state !== 'running' && (
            <button
              onClick={() => resume(row.original.uuid)}
              className="rounded-lg bg-green-50 px-3 py-1.5 text-xs font-bold text-green-600 hover:bg-green-100 dark:bg-green-500/10"
            >
              Resume
            </button>
          )}
          <ConfirmButton
            label="Force delete"
            confirmLabel="Really delete?"
            onConfirm={() => forceDelete(row.original.uuid)}
          />
        </div>
      )
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [])

  return (
    <Card extra="p-5">
      <h4 className="mb-1 text-lg font-bold text-navy-700 dark:text-white">Persisted labs</h4>
      <p className="mb-4 text-sm text-gray-500 dark:text-gray-400">
        The full persisted-lab-store registry - includes labs with no live container (reclaim_grace, or purely R2-backed).
      </p>
      {(error || actionError) && <p className="mb-3 text-sm font-medium text-red-500">{error || actionError}</p>}
      <DataTable columns={columns} data={data?.labs || []} emptyText="No persisted labs yet." />
    </Card>
  )
}
