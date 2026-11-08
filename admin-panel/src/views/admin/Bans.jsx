import Card from '../../components/card/Card'
import ListEditor from '../../components/ListEditor'
import usePolling from '../../hooks/usePolling'
import { api } from '../../api/client'

export default function Bans() {
  const { data, error, refresh } = usePolling(api.getBans, 8000)

  return (
    <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
      <Card extra="p-5">
        <h4 className="mb-1 text-lg font-bold text-navy-700 dark:text-white">Banned devices</h4>
        <p className="mb-4 text-sm text-gray-500 dark:text-gray-400">
          Checked before every provision, free and persisted alike.
        </p>
        {error && <p className="mb-3 text-sm font-medium text-red-500">{error}</p>}
        <ListEditor
          items={data?.deviceIds || []}
          placeholder="deviceId"
          onAdd={async (id) => { await api.addBannedDevice(id); refresh() }}
          onRemove={async (id) => { await api.removeBannedDevice(id); refresh() }}
        />
      </Card>

      <Card extra="p-5">
        <h4 className="mb-1 text-lg font-bold text-navy-700 dark:text-white">Banned IPs</h4>
        <p className="mb-4 text-sm text-gray-500 dark:text-gray-400">
          Blocked at provision time, independent of device bans.
        </p>
        <ListEditor
          items={data?.ips || []}
          placeholder="1.2.3.4"
          onAdd={async (ip) => { await api.addBannedIp(ip); refresh() }}
          onRemove={async (ip) => { await api.removeBannedIp(ip); refresh() }}
        />
      </Card>
    </div>
  )
}
