'use strict'

const { execFile } = require('child_process')
const { promisify } = require('util')
const execFileAsync = promisify(execFile)
const path = require('path')
const { podman } = require('./podman-client')
const { PROJECT_ID_BASE, MAX_CONCURRENT, LAB_STORAGE_MOUNT, CONTAINER_DISK_LIMIT } = require('./constants')

// Podman's own --storage-opt size= (which this originally tried to use)
// needs to mknod a backing-device node to verify project-quota support -
// mknod requires a real root capability that labrunner's rootless uid
// doesn't have, so it always failed and silently fell back to no limit at
// all (confirmed live: a lab could write to the host's full free disk).
// Fix: a dedicated XFS-formatted loop image, mounted with -o pquota, holds
// labrunner's whole podman graphroot instead of the host's own ext4 root
// (which has no project-quota feature at all). Assigning the quota itself
// is done directly via xfs_quota as true root - sudo here is the app's own
// account (not `sudo -i -u labrunner`), since only real root can set an
// XFS project id/limit, sidestepping the mknod check entirely rather than
// needing labrunner to have it.

const usedProjectIds = new Set()

function nextProjectId() {
  for (let id = PROJECT_ID_BASE; id < PROJECT_ID_BASE + MAX_CONCURRENT * 2; id++) {
    if (!usedProjectIds.has(id)) {
      usedProjectIds.add(id)
      return id
    }
  }
  throw new Error('No available disk-quota project ids')
}

async function assignDiskQuota(containerId, projectId) {
  const { stdout } = await podman(['inspect', containerId, '--format', '{{.GraphDriver.Data.UpperDir}}'])
  const upperDir = stdout.trim()
  // Overlay's copy-up does: create the file under the layer's sibling
  // `work/` dir, then rename() it into `diff/` (the actual upperdir). XFS
  // refuses rename() across directories that carry DIFFERENT project ids -
  // live-verified this exact failure: tagging only `diff/` left `work/` at
  // project 0, so every copy-up failed with EXDEV, breaking even plain
  // `mkdir`/`apt-get`. Both siblings need the same project id.
  const workDir = `${path.dirname(upperDir)}/work`
  for (const dir of [upperDir, workDir]) {
    await execFileAsync('sudo', ['xfs_quota', '-x', '-c', `project -s -p ${dir} ${projectId}`, LAB_STORAGE_MOUNT])
  }
  await execFileAsync('sudo', ['xfs_quota', '-x', '-c', `limit -p bhard=${CONTAINER_DISK_LIMIT} ${projectId}`, LAB_STORAGE_MOUNT])
}

module.exports = {
  usedProjectIds,
  nextProjectId,
  assignDiskQuota
}
