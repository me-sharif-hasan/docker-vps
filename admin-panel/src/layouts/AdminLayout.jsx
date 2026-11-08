import React from 'react'
import { Routes, Route, useLocation } from 'react-router-dom'
import Navbar from '../components/navbar/Navbar'
import Sidebar from '../components/sidebar/Sidebar'
import routes from '../routes'
import Dashboard from '../views/admin/Dashboard'
import Sessions from '../views/admin/Sessions'
import PersistedLabs from '../views/admin/PersistedLabs'
import Entitlements from '../views/admin/Entitlements'
import Bans from '../views/admin/Bans'
import Activity from '../views/admin/Activity'
import Settings from '../views/admin/Settings'

const pages = {
  '/': Dashboard,
  '/sessions': Sessions,
  '/persisted-labs': PersistedLabs,
  '/entitlements': Entitlements,
  '/bans': Bans,
  '/activity': Activity,
  '/settings': Settings
}

export default function AdminLayout() {
  const location = useLocation()
  const [open, setOpen] = React.useState(window.innerWidth >= 1200)

  React.useEffect(() => {
    const onResize = () => setOpen(window.innerWidth >= 1200)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const currentRoute = routes.find(r => r.path === location.pathname)?.name || 'Dashboard'

  return (
    <div className="flex h-full w-full">
      <Sidebar open={open} onClose={() => setOpen(false)} />
      <div className="h-full w-full bg-lightPrimary dark:!bg-navy-900">
        <main className="mx-[12px] h-full flex-none transition-all md:pr-2 xl:ml-[313px]">
          <div className="h-full">
            <Navbar onOpenSidenav={() => setOpen(true)} brandText={currentRoute} />
            <div className="mx-auto mb-auto h-full min-h-[84vh] p-2 pt-5 md:pr-2">
              <Routes>
                {Object.entries(pages).map(([path, Component]) => (
                  <Route key={path} path={path} element={<Component />} />
                ))}
              </Routes>
            </div>
            <div className="p-3 text-center text-sm text-gray-500 dark:text-white/60">
              ServerKit Labs Admin
            </div>
          </div>
        </main>
      </div>
    </div>
  )
}
