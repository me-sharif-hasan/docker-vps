import { MdOutlineDns, MdMemory, MdSpeed, MdOutlineStorage, MdSecurity, MdDataUsage } from 'react-icons/md'
import Widget from '../../components/widget/Widget'
import Card from '../../components/card/Card'
import usePolling from '../../hooks/usePolling'
import { api } from '../../api/client'
import { formatRate, formatBytes } from '../../utils/format'

export default function Dashboard() {
  const { data: stats, error: statsError } = usePolling(api.getStats, 5000)
  const { data: labsData, error: labsError } = usePolling(api.getPersistedLabs, 5000)
  const { data: firewall } = usePolling(api.getFirewallStatus, 15000)

  const labs = labsData?.labs || []
  const running = labs.filter(l => l.state === 'running').length
  const stopped = labs.filter(l => l.state === 'stopped').length
  const reclaimGrace = labs.filter(l => l.state === 'reclaim_grace').length
  const lifetimeTotal = labs.reduce((sum, l) => sum + (l.lifetimeBytesIn || 0) + (l.lifetimeBytesOut || 0), 0)

  return (
    <div>
      {(statsError || labsError) && (
        <Card extra="mb-4 p-4 border border-red-200">
          <p className="text-sm font-medium text-red-500">{statsError || labsError}</p>
        </Card>
      )}

      <div className="mt-2 grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-4">
        <Widget
          icon={<MdOutlineDns />}
          title="Active ephemeral sessions"
          subtitle={stats ? `${stats.activeSessions} / ${stats.maxConcurrent}` : '...'}
        />
        <Widget
          icon={<MdMemory />}
          title="Total memory in use"
          subtitle={stats ? `${stats.totalMemUsageMB} MB` : '...'}
          accent="text-blue-500"
        />
        <Widget
          icon={<MdSpeed />}
          title="Rolling bandwidth avg"
          subtitle={stats ? formatRate(stats.rollingAvgRateBytesPerSec) : '...'}
          accent="text-amber-500"
        />
        <Widget
          icon={<MdOutlineStorage />}
          title="Persisted labs running"
          subtitle={`${running} running / ${stopped} stopped / ${reclaimGrace} reclaiming`}
          accent="text-green-500"
        />
        <Widget
          icon={<MdDataUsage />}
          title="Lifetime transfer (persisted labs)"
          subtitle={formatBytes(lifetimeTotal)}
          accent="text-purple-500"
        />
      </div>

      <div className="mt-5 grid grid-cols-1 gap-5 xl:grid-cols-2">
        <Card extra="p-5">
          <h4 className="mb-3 text-lg font-bold text-navy-700 dark:text-white">Live containers</h4>
          {!stats ? (
            <p className="text-sm text-gray-500">Loading...</p>
          ) : stats.containers.length === 0 ? (
            <p className="text-sm text-gray-500 dark:text-gray-400">No containers running right now.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {stats.containers.map(c => (
                <li key={c.uuid} className="flex items-center justify-between rounded-xl bg-lightPrimary px-3 py-2 text-sm dark:bg-navy-700">
                  <span className="truncate font-mono text-navy-700 dark:text-white">{c.uuid.slice(0, 8)}...</span>
                  <span className="text-gray-500 dark:text-gray-400">
                    {c.persisted ? 'persisted' : 'ephemeral'} · {c.cpuPercent ?? 0}% cpu · {c.memUsageMB ?? 0} MB
                  </span>
                  {c.orphaned && <span className="font-bold text-red-500">orphaned</span>}
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card extra="p-5">
          <h4 className="mb-3 flex items-center gap-2 text-lg font-bold text-navy-700 dark:text-white">
            <MdSecurity /> Egress firewall
          </h4>
          {!firewall ? (
            <p className="text-sm text-gray-500">Loading...</p>
          ) : (
            <div>
              <p className={`mb-3 text-sm font-bold ${firewall.allActive ? 'text-green-600' : 'text-red-500'}`}>
                {firewall.allActive ? 'All abuse-port DROP rules active' : 'Some abuse-port rules are missing'}
              </p>
              <ul className="flex flex-col gap-2">
                {firewall.ports.map(p => (
                  <li key={p.port} className="flex items-center justify-between rounded-xl bg-lightPrimary px-3 py-2 text-sm dark:bg-navy-700">
                    <span className="font-mono text-navy-700 dark:text-white">port {p.port}</span>
                    <span className={p.blocked ? 'text-green-600' : 'text-red-500'}>
                      {p.blocked ? 'blocked' : `v4:${p.v4} v6:${p.v6}`}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Card>
      </div>
    </div>
  )
}
