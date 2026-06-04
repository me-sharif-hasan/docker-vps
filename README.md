# ServerKit Labs — Backend API

Lightweight Fastify backend that provisions ephemeral Linux containers for users.
Each container is a real Debian Linux environment accessible via SSH, auto-destroyed after 30 minutes.

---

## Architecture

```
Client App
    │
    ▼
Fastify API (port 3000)
    │
    ▼
Docker Engine (unix socket)
    │
    ▼
Lab Containers (Debian, SSH on random port 32000–33000)
```

---

## Requirements

- Node.js 18+
- Docker Engine installed and running
- The process must have access to `/var/run/docker.sock`
- `ssh-keygen` available on the host (standard on Linux/Mac)

---

## Setup

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env — set HOST_IP to your VPS public IP

# 3. Build the lab Docker image (first run only — auto-builds on first provision too)
docker build -t serverkit-lab ./docker

# 4. Start the API
npm start

# Development with auto-reload
npm run dev
```

---

## API Reference

### POST /labs/provision
Create a new lab container.

**Request body:**
```json
{ "uuid": "550e8400-e29b-41d4-a716-446655440000" }
```

**Response:**
```json
{
  "success": true,
  "data": {
    "uuid": "550e8400-e29b-41d4-a716-446655440000",
    "host": "1.2.3.4",
    "sshPort": 32145,
    "user": "labuser",
    "privateKey": "-----BEGIN RSA PRIVATE KEY-----\n...",
    "expiresAt": 1717500000000,
    "timeRemainingSeconds": 1800,
    "connectCommand": "ssh -i <key-file> -p 32145 labuser@1.2.3.4",
    "message": "Session will auto-terminate in 30 minutes"
  }
}
```

**Error responses:**
- `400` — Invalid UUID format
- `409` — UUID already in use
- `503` — Maximum concurrent sessions reached (20)
- `500` — Internal error

---

### GET /labs/:uuid
Get SSH connection details for an existing session.

**Response:**
```json
{
  "success": true,
  "data": {
    "uuid": "550e8400-...",
    "host": "1.2.3.4",
    "port": 32145,
    "user": "labuser",
    "privateKey": "-----BEGIN RSA PRIVATE KEY-----\n...",
    "expiresAt": 1717500000000,
    "timeRemainingSeconds": 1543,
    "status": "running",
    "connectCommand": "ssh -i <key-file> -p 32145 labuser@1.2.3.4"
  }
}
```

**Error responses:**
- `400` — Invalid UUID format
- `404` — Session not found or already expired

---

### DELETE /labs/:uuid
Manually destroy a container before the 30-minute auto-expiry.

**Response:**
```json
{
  "success": true,
  "data": {
    "uuid": "550e8400-...",
    "destroyed": true,
    "reason": "manual"
  }
}
```

---

### GET /labs/stats
Check current capacity.

**Response:**
```json
{
  "success": true,
  "data": {
    "activeSessions": 3,
    "maxConcurrent": 20,
    "availableSlots": 17
  }
}
```

---

### GET /health
Simple health check.

```json
{ "status": "ok", "timestamp": "2026-06-04T12:00:00.000Z" }
```

---

## UUID Rules

- Must be a valid UUID v4 format: `xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx`
- Provided by the client — the API does not generate UUIDs
- Must be unique — creating with an existing UUID returns 409
- Same UUID used for provision, get details, and destroy

---

## Container Details

- **Base image:** Debian Bookworm (slim)
- **SSH user:** `labuser` (sudo, no password)
- **Auth:** SSH key only (no password login)
- **Port:** Random from range 32000–33000, mapped to host
- **Lifetime:** 30 minutes, then auto-destroyed
- **Network:** Fully open (bridge mode, no restrictions)
- **Pre-installed:** curl, wget, vim, nano, git, htop, net-tools, ping, dig, procps

---

## Notes

- Sessions are stored in memory — restarting the server loses all session state
  (containers will still be running, clean them up with `docker rm -f $(docker ps -q --filter name=lab-)`)
- Private keys are only available at provision time and via GET /labs/:uuid — store them client-side
- On server restart, run: `docker rm -f $(docker ps -aq --filter name=lab-)` to clean orphaned containers
