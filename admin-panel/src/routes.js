import {
  MdDashboard, MdOutlineDns, MdOutlineStorage, MdVerifiedUser,
  MdBlock, MdHistory, MdSettings
} from 'react-icons/md'

// Flat route table, consumed by both the sidebar links and the router in
// App.jsx - one source of truth, same pattern the horizon template uses.
const routes = [
  { name: 'Dashboard', path: '/', icon: MdDashboard },
  { name: 'Sessions', path: '/sessions', icon: MdOutlineDns },
  { name: 'Persisted Labs', path: '/persisted-labs', icon: MdOutlineStorage },
  { name: 'Entitlements', path: '/entitlements', icon: MdVerifiedUser },
  { name: 'Bans', path: '/bans', icon: MdBlock },
  { name: 'Activity', path: '/activity', icon: MdHistory },
  { name: 'Settings', path: '/settings', icon: MdSettings }
]

export default routes
