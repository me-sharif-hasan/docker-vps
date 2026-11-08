import { useMemo } from 'react'
import Card from '../../components/card/Card'
import DataTable from '../../components/table/DataTable'
import StatusPill from '../../components/StatusPill'
import usePolling from '../../hooks/usePolling'
import { api } from '../../api/client'

function fmt(ts) {
  return ts ? new Date(ts).toLocaleString() : '-'
}

export default function Activity() {
  const { data: activity, error: activityError } = usePolling(() => api.getActivity(200), 6000)
  const { data: suspicious } = usePolling(api.getSuspicious, 10000)
  const { data: failures } = usePolling(() => api.getSnapshotFailures(100), 10000)

  const activityColumns = useMemo(() => [
    { header: 'Time', accessorKey: 'timestamp', cell: ({ getValue }) => fmt(getValue()) },
    { header: 'UUID', accessorKey: 'uuid', cell: ({ getValue }) => <span className="font-mono text-xs">{getValue().slice(0, 8)}...</span> },
    { header: 'Device', accessorKey: 'deviceId', cell: ({ getValue }) => <span className="font-mono text-xs">{getValue() || '-'}</span> },
    { header: 'IP', accessorKey: 'ip' },
    { header: 'Country', accessorKey: 'country' },
    { header: 'Tier', accessorKey: 'isPro', cell: ({ getValue }) => <StatusPill status={getValue() ? 'active' : 'inactive'} /> }
  ], [])

  const failureColumns = useMemo(() => [
    { header: 'Time', accessorKey: 'timestamp', cell: ({ getValue }) => fmt(getValue()) },
    { header: 'UUID', accessorKey: 'uuid', cell: ({ getValue }) => <span className="font-mono text-xs">{getValue().slice(0, 8)}...</span> },
    { header: 'Error', accessorKey: 'error' }
  ], [])

  return (
    <div className="flex flex-col gap-5">
      <Card extra="p-5">
        <h4 className="mb-1 text-lg font-bold text-navy-700 dark:text-white">Suspicious devices</h4>
        <p className="mb-4 text-sm text-gray-500 dark:text-gray-400">
          Seen from more than one country - a VPN/Tor-hopping signal.
        </p>
        {!suspicious || suspicious.devices.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">None detected.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {suspicious.devices.map(d => (
              <li key={d.deviceId} className="flex items-center justify-between rounded-xl bg-lightPrimary px-3 py-2 text-sm dark:bg-navy-700">
                <span className="font-mono text-xs text-navy-700 dark:text-white">{d.deviceId}</span>
                <span className="text-gray-500 dark:text-gray-400">{d.countries.join(', ')}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card extra="p-5">
        <h4 className="mb-1 text-lg font-bold text-navy-700 dark:text-white">Snapshot failures</h4>
        <p className="mb-4 text-sm text-gray-500 dark:text-gray-400">
          A failed snapshot leaves the container running rather than stopping it - these need a look.
        </p>
        <DataTable columns={failureColumns} data={failures?.failures || []} emptyText="No snapshot failures." />
      </Card>

      <Card extra="p-5">
        <h4 className="mb-1 text-lg font-bold text-navy-700 dark:text-white">Recent provisioning activity</h4>
        {activityError && <p className="mb-3 text-sm font-medium text-red-500">{activityError}</p>}
        <DataTable columns={activityColumns} data={activity?.events || []} emptyText="No activity recorded yet." />
      </Card>
    </div>
  )
}
