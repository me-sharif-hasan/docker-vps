'use strict'

const fs = require('fs')
const { S3Client, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3')
const { Upload } = require('@aws-sdk/lib-storage')

// Cloudflare R2 (S3-compatible) holds lab disk snapshots. Credentials come
// from real process env on the host (this project has no dotenv - see
// .env.example's own comment), never hardcoded.
function buildClient () {
  const accountId = process.env.R2_ACCOUNT_ID
  const accessKeyId = process.env.R2_ACCESS_KEY
  const secretAccessKey = process.env.R2_SECRET_KEY
  if (!accountId || !accessKeyId || !secretAccessKey) {
    throw new Error('R2 credentials missing - set R2_ACCOUNT_ID, R2_ACCESS_KEY, R2_SECRET_KEY')
  }
  return new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey }
  })
}

function bucketName () {
  const bucket = process.env.R2_BUCKET
  if (!bucket) throw new Error('R2 bucket missing - set R2_BUCKET')
  return bucket
}

function keyFor (uuid) {
  return `lab-snapshots/${uuid}.tar`
}

// Streams [bodyStream] (e.g. a `podman export` child process's stdout)
// straight into R2 without buffering the whole tar in memory or on local
// disk first. Returns the real uploaded size - snapshot size is what the
// user actually wrote, not the disk quota ceiling (XFS project quota is a
// ceiling, not a pre-allocated block device).
async function uploadSnapshotStream (uuid, bodyStream) {
  const client = buildClient()
  const key = keyFor(uuid)
  const upload = new Upload({
    client,
    params: { Bucket: bucketName(), Key: key, Body: bodyStream }
  })
  await upload.done()

  const head = await client.send(new HeadObjectCommand({ Bucket: bucketName(), Key: key }))
  return { key, sizeBytes: head.ContentLength ?? null }
}

async function downloadSnapshotToFile (uuid, destPath) {
  const client = buildClient()
  const key = keyFor(uuid)
  let response
  try {
    response = await client.send(new GetObjectCommand({ Bucket: bucketName(), Key: key }))
  } catch (err) {
    if (err.name === 'NoSuchKey') return false
    throw err
  }

  await new Promise((resolve, reject) => {
    const writeStream = fs.createWriteStream(destPath)
    response.Body.pipe(writeStream)
    response.Body.on('error', reject)
    writeStream.on('error', reject)
    writeStream.on('finish', resolve)
  })
  return true
}

async function deleteSnapshot (uuid) {
  const client = buildClient()
  await client.send(new DeleteObjectCommand({ Bucket: bucketName(), Key: keyFor(uuid) }))
}

module.exports = { keyFor, uploadSnapshotStream, downloadSnapshotToFile, deleteSnapshot }
