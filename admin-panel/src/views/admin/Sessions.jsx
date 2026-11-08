import { useMemo } from 'react'
import Card from '../../components/card/Card'
import DataTable from '../../components/table/DataTable'
import StatusPill from '../../components/StatusPill'
import ConfirmButton from '../../components/ConfirmButton'
import usePolling from '../../hooks/usePolling'
import { api } from '../../api/client'
import { formatBytes, formatRate } from '../../utils/format'

export default function Sessions() {
  const { data: stats, error, refresh } = usePolling(api.getStats, 4000)

  const columns = useMemo(() => [
    {
      header: 'UUID',
      accessorKey: 'uuid',
      cell: ({ getValue }) => <span className="font-mono text-xs">{getValue()}</span>
    },
    {
      header: 'Type',
      accessorFn: row => (row.persisted ? 'persisted' : 'ephemeral'),
      cell: ({ getValue }) => <StatusPill status={getValue() === 'persisted' ? 'active' : 'inactive'} />
    },
    {
      header: 'Status',
      accessorFn: row => (row.orphaned ? 'orphaned' : 'running'),
      cell: ({ getValue }) => <StatusPill status={getValue()} />
    },
    { header: 'SSH port', accessorKey: 'sshPort' },
    {
      header: 'CPU %',
      accessorKey: 'cpuPercent',
      cell: ({ getValue }) => `${getValue() ?? 0}%`
    },
    {
      header: 'Mem',
      accessorFn: row => `${row.memUsageMB ?? 0} / ${row.memLimitMB ?? 0} MB`
    },
    {
      header: 'In',
      accessorKey: 'netInBytes',
      cell: ({ getValue }) => formatBytes(getValue())
    },
    {
      header: 'Out',
      accessorKey: 'netOutBytes',
      cell: ({ getValue, row }) => (
        <span className={row.original.isBandwidthSpiking ? 'font-bold text-red-500' : ''}>
          {formatBytes(getValue())}
        </span>
      )
    },
    {
      header: 'Rate',
      accessorKey: 'currentRateBytesPerSec',
      cell: ({ getValue, row }) => (
        <span className={row.original.isBandwidthSpiking ? 'font-bold text-red-500' : ''}>
          {formatRate(getValue())}
        </span>
      )
    },
    {
      header: 'Time left',
      accessorKey: 'timeRemainingSeconds',
      cell: ({ getValue }) => (getValue() == null ? 'no limit' : `${Math.round(getValue() / 60)} min`)
    },
    {
      header: '',
      id: 'actions',
      cell: ({ row }) => (
        <ConfirmButton
          label="Force destroy"
          confirmLabel="Really destroy?"
          onConfirm={async () => {
            await api.forceDestroyContainer(row.original.fullContainerId)
            refresh()
          }}
        />
      )
    }
  ], [refresh])

  return (
    <Card extra="p-5">
      <h4 className="mb-1 text-lg font-bold text-navy-700 dark:text-white">Live sessions</h4>
      <p className="mb-4 text-sm text-gray-500 dark:text-gray-400">
        Every container currently known to podman - ephemeral and persisted alike.
      </p>
      {error && <p className="mb-3 text-sm font-medium text-red-500">{error}</p>}
      <DataTable
        columns={columns}
        data={stats?.containers || []}
        emptyText="No containers running right now."
      />
    </Card>
  )
}
