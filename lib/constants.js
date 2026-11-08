'use strict'

// Resource limits, host paths, and timing constants shared across the lab
// lifecycle modules. Centralized so changing a limit touches one file
// instead of grepping every module that happened to redeclare it.

const MB = 1024 * 1024

module.exports = {
  MB,

  IMAGE_NAME: 'serverkit-lab',
  MAX_CONCURRENT: 10,

  // Podman runs as this dedicated Linux user, not the app's own - see
  // podman-client.js for why (egress routing + blast radius).
  RUNNER_USER: 'labrunner',

  CONTAINER_MEMORY_LIMIT: 200 * MB,
  CONTAINER_MEMORY_SWAP: 300 * MB,
  CONTAINER_CPU_QUOTA: 50000, // 50% of one core (100000 = 1 core)
  CONTAINER_CPU_PERIOD: 100000,
  CONTAINER_DISK_LIMIT: '2g', // enforced via XFS project quota, see disk-quota.js
  CONTAINER_PIDS_LIMIT: 512,

  PORT_RANGE_START: 32000,
  PORT_RANGE_END: 33000,

  // Dedicated XFS-formatted loop image holding labrunner's whole podman
  // graphroot - see disk-quota.js for why this exists instead of podman's
  // own --storage-opt size=.
  LAB_STORAGE_MOUNT: '/mnt/lab-storage',
  PROJECT_ID_BASE: 5000,

  // lxcfs virtualizes these /proc and /sys paths so `free`/`nproc`/`lscpu`
  // inside a container report its cgroup limits, not the host's real ones.
  LXCFS_PROC_DIR: '/var/lib/lxcfs/proc',
  LXCFS_FILES: ['cpuinfo', 'meminfo', 'stat', 'diskstats', 'swaps', 'uptime', 'loadavg'],
  LXCFS_CPU_ONLINE: '/var/lib/lxcfs/sys/devices/system/cpu/online',

  SSH_READY_TIMEOUT_MS: 8000,
  SSH_READY_POLL_INTERVAL_MS: 150,

  // Oracle (ORACLE_BASTION_IP) is the only path in - it DNATs public SSH
  // traffic on the lab port range through the WireGuard tunnel to this
  // box's tunnel address. See firewall-ports.js.
  ORACLE_BASTION_IP: '10.200.0.1',

  FIREWALL_RECONCILE_INTERVAL_MS: 5 * 60 * 1000,

  // How often the persisted-lab idle-stop and reclaim-grace sweeps run -
  // see lib/persisted-lab-lifecycle.js.
  PERSISTED_LAB_SWEEP_INTERVAL_MS: 5 * 60 * 1000,

  // A container's current average rate above this multiple of the 28-day
  // rolling baseline gets flagged red in the dashboard.
  BANDWIDTH_SPIKE_MULTIPLIER: 3,

  // The only two Play product ids this backend will ever verify a
  // purchase token against - pinned here, never taken from the client's
  // own request body, so a forged "productId" field can't make an
  // unrelated purchase (e.g. some $0.99 IAP) verify as pro/subscriber.
  LIFETIME_PRO_PRODUCT_ID: 'remove_ads_forever',
  SUBSCRIPTION_PRODUCT_ID: 'serverkit_pro_plus',

  // How often verified-entitlement-store records get re-checked against
  // the real Play Developer API - lighter than the lab sweeps since it's
  // an external API call per record, not a local podman/file operation.
  ENTITLEMENT_REVERIFY_INTERVAL_MS: 60 * 60 * 1000
}
