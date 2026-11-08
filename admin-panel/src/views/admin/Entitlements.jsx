import { useMemo } from 'react'
import Card from '../../components/card/Card'
import DataTable from '../../components/table/DataTable'
import StatusPill from '../../components/StatusPill'
import ConfirmButton from '../../components/ConfirmButton'
import ListEditor from '../../components/ListEditor'
import usePolling from '../../hooks/usePolling'
import { api } from '../../api/client'

function fmt(ts) {
  return ts ? new Date(ts).toLocaleString() : '-'
}

export default function Entitlements() {
  const { data: verified, refresh: refreshVerified, error: verifiedError } = usePolling(api.getVerifiedEntitlements, 8000)
  const { data: proDevices, refresh: refreshPro } = usePolling(api.getProDevices, 8000)
  const { data: subDevices, refresh: refreshSub } = usePolling(api.getSubscriberDevices, 8000)

  const columns = useMemo(() => [
    { header: 'Device', accessorKey: 'deviceId', cell: ({ getValue }) => <span className="font-mono text-xs">{getValue()}</span> },
    { header: 'Kind', accessorKey: 'kind' },
    { header: 'Product', accessorKey: 'productId' },
    { header: 'Active', accessorKey: 'active', cell: ({ getValue }) => <StatusPill status={getValue() ? 'active' : 'inactive'} /> },
    { header: 'Verified at', accessorKey: 'verifiedAt', cell: ({ getValue }) => fmt(getValue()) },
    { header: 'Expires', accessorKey: 'expiryTimeMillis', cell: ({ getValue }) => fmt(getValue()) },
    {
      header: '',
      id: 'actions',
      cell: ({ row }) => row.original.active ? (
        <ConfirmButton
          label="Revoke"
          confirmLabel="Really revoke?"
          onConfirm={async () => {
            await api.revokeVerifiedEntitlement(row.original.deviceId)
            refreshVerified()
          }}
        />
      ) : null
    }
  ], [refreshVerified])

  return (
    <div className="flex flex-col gap-5">
      <Card extra="p-5">
        <h4 className="mb-1 text-lg font-bold text-navy-700 dark:text-white">Verified entitlements</h4>
        <p className="mb-4 text-sm text-gray-500 dark:text-gray-400">
          Real Play-verified purchase records - the actual anti-forgery ledger.
        </p>
        {verifiedError && <p className="mb-3 text-sm font-medium text-red-500">{verifiedError}</p>}
        <DataTable columns={columns} data={verified?.entitlements || []} emptyText="No verified purchases yet." />
      </Card>

      <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
        <Card extra="p-5">
          <h4 className="mb-1 text-lg font-bold text-navy-700 dark:text-white">Pro devices (comp list)</h4>
          <p className="mb-4 text-sm text-gray-500 dark:text-gray-400">
            Grandfathered lifetime-pro cohort, granted by hand.
          </p>
          <ListEditor
            items={proDevices?.deviceIds || []}
            placeholder="deviceId"
            onAdd={async (id) => { await api.addProDevice(id); refreshPro() }}
            onRemove={async (id) => { await api.removeProDevice(id); refreshPro() }}
          />
        </Card>

        <Card extra="p-5">
          <h4 className="mb-1 text-lg font-bold text-navy-700 dark:text-white">Subscriber devices (comp list)</h4>
          <p className="mb-4 text-sm text-gray-500 dark:text-gray-400">
            Active serverkit_pro_plus subscribers, granted by hand.
          </p>
          <ListEditor
            items={subDevices?.deviceIds || []}
            placeholder="deviceId"
            onAdd={async (id) => { await api.addSubscriberDevice(id); refreshSub() }}
            onRemove={async (id) => { await api.removeSubscriberDevice(id); refreshSub() }}
          />
        </Card>
      </div>
    </div>
  )
}
