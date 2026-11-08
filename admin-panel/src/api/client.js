// Thin fetch wrapper around the real /api/admin/* endpoints
// (routes/admin-routes.js). Every call sends the admin key the user typed
// in on the sign-in screen as the x-admin-key header - checkAdminKey
// (lib/admin-auth.js) is the real server-side gate; there is no bypass or
// offline/demo mode here.

const KEY_STORAGE = 'serverkit_admin_key'

export function getAdminKey() {
  return localStorage.getItem(KEY_STORAGE) || ''
}

export function setAdminKey(key) {
  localStorage.setItem(KEY_STORAGE, key)
}

export function clearAdminKey() {
  localStorage.removeItem(KEY_STORAGE)
}

class ApiError extends Error {
  constructor(message, status) {
    super(message)
    this.status = status
  }
}

async function request(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'x-admin-key': getAdminKey()
    },
    body: body ? JSON.stringify(body) : undefined
  })

  const json = await res.json().catch(() => null)

  if (res.status === 401) {
    clearAdminKey()
    throw new ApiError(json?.error || 'Unauthorized', 401)
  }
  if (!res.ok || !json?.success) {
    throw new ApiError(json?.error || `Request failed (${res.status})`, res.status)
  }
  return json.data
}

export const api = {
  // Stats / sessions
  getStats: () => request('/api/admin/stats'),
  forceDestroyContainer: (containerId) => request(`/api/admin/containers/${containerId}`, { method: 'DELETE' }),

  // Persisted labs
  getPersistedLabs: () => request('/api/admin/persisted-labs'),
  resumePersistedLab: (uuid) => request(`/api/admin/persisted-labs/${uuid}/resume`, { method: 'POST' }),
  forceDeletePersistedLab: (uuid) => request(`/api/admin/persisted-labs/${uuid}`, { method: 'DELETE' }),

  // Settings
  getSettings: () => request('/api/admin/settings'),
  setSkipDebugPackages: (skipDebugPackages) => request('/api/admin/settings', { method: 'POST', body: { skipDebugPackages } }),

  getSessionLimits: () => request('/api/admin/session-limits'),
  setSessionLimits: (body) => request('/api/admin/session-limits', { method: 'POST', body }),

  getPersistedLabConfig: () => request('/api/admin/persisted-lab-config'),
  setPersistedLabConfig: (body) => request('/api/admin/persisted-lab-config', { method: 'POST', body }),

  getDebugWhitelist: () => request('/api/admin/debug-whitelist'),
  addDebugWhitelistIp: (ip) => request('/api/admin/debug-whitelist', { method: 'POST', body: { add: ip } }),
  removeDebugWhitelistIp: (ip) => request('/api/admin/debug-whitelist', { method: 'POST', body: { remove: ip } }),

  // Devices / entitlements
  getProDevices: () => request('/api/admin/pro-devices'),
  addProDevice: (deviceId) => request('/api/admin/pro-devices', { method: 'POST', body: { add: deviceId } }),
  removeProDevice: (deviceId) => request('/api/admin/pro-devices', { method: 'POST', body: { remove: deviceId } }),

  getSubscriberDevices: () => request('/api/admin/subscriber-devices'),
  addSubscriberDevice: (deviceId) => request('/api/admin/subscriber-devices', { method: 'POST', body: { add: deviceId } }),
  removeSubscriberDevice: (deviceId) => request('/api/admin/subscriber-devices', { method: 'POST', body: { remove: deviceId } }),

  getVerifiedEntitlements: () => request('/api/admin/verified-entitlements'),
  revokeVerifiedEntitlement: (deviceId) => request('/api/admin/verified-entitlements/revoke', { method: 'POST', body: { deviceId } }),

  // Bans
  getBans: () => request('/api/admin/bans'),
  addBannedDevice: (deviceId) => request('/api/admin/bans', { method: 'POST', body: { addDeviceId: deviceId } }),
  removeBannedDevice: (deviceId) => request('/api/admin/bans', { method: 'POST', body: { removeDeviceId: deviceId } }),
  addBannedIp: (ip) => request('/api/admin/bans', { method: 'POST', body: { addIp: ip } }),
  removeBannedIp: (ip) => request('/api/admin/bans', { method: 'POST', body: { removeIp: ip } }),

  // Activity / abuse signals
  getActivity: (limit = 200) => request(`/api/admin/activity?limit=${limit}`),
  getSuspicious: () => request('/api/admin/suspicious'),
  getFirewallStatus: () => request('/api/admin/firewall-status'),
  getSnapshotFailures: (limit = 100) => request(`/api/admin/snapshot-failures?limit=${limit}`)
}

export { ApiError }
