# Qwant Cookie Sync Sidecar

A lightweight companion service for [Degoog](https://github.com/degoog-org/degoog) that periodically executes Qwant's client-side DataDome script (`dd.qwant.com/tags.js`) in headless Chromium, captures the verified `datadome` session cookie and matching `userAgent`, and serves them to Degoog's Qwant engines over HTTP or a shared file.

## Why this approach?

1. **Zero latency impact on searches:** Degoog continues using ultra-fast `curl-impersonate` HTTP queries for each search. No browser is in the critical request path.
2. **Minimal resource usage:** The headless browser only launches for ~5 seconds every 25 minutes to refresh the cookie, and then immediately exits to release all RAM (0% idle memory).
3. **High reliability:** Because DataDome executes in a genuine Chromium environment on the same host/network, the resulting cookie and TLS/User-Agent parameters pass upstream validation.
4. **Automatic reactive retry:** If Qwant responds with HTTP 403, Degoog immediately asks the sidecar for a fresh cookie on-demand and retries the search.

---

## Running with Docker

### 1. Pull and Run from GHCR (Recommended)

Pre-built Docker images are automatically published to GitHub Container Registry (`ghcr.io`):

```bash
docker pull ghcr.io/paiou/qwant-cookie-sidecar:latest

docker run -d \
  --name qwant-sidecar \
  -p 3005:3005 \
  --restart unless-stopped \
  ghcr.io/paiou/qwant-cookie-sidecar:latest
```

### 2. Run with Docker Compose

Run Degoog (`ghcr.io/degoog-org/degoog:latest`) together with the Qwant Cookie Sidecar (`ghcr.io/paiou/qwant-cookie-sidecar:latest`):

```yaml
version: "3.8"

services:
  degoog:
    image: ghcr.io/degoog-org/degoog:latest
    ports:
      - "8080:8080"
    environment:
      - QWANT_COOKIE_SERVER_URL=http://qwant-sidecar:3005/cookie
    volumes:
      - /path/to/degoog-extensions:/app/extensions
    depends_on:
      - qwant-sidecar

  qwant-sidecar:
    image: ghcr.io/paiou/qwant-cookie-sidecar:latest
    container_name: qwant-cookie-sidecar
    environment:
      - PORT=3005
      - REFRESH_INTERVAL_MINUTES=25
    restart: unless-stopped
```

Start the stack:
```bash
docker compose up -d
```

### 3. Build Locally (Development)

```bash
docker build -t ghcr.io/paiou/qwant-cookie-sidecar:latest sidecars/qwant-cookie-sync
```

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3005` | HTTP port for the sidecar API |
| `REFRESH_INTERVAL_MINUTES` | `25` | Interval in minutes between automated background cookie refreshes |
| `COOKIE_FILE` | `""` | Optional file path to write `{ datadome, userAgent, updatedAt }` JSON |
| `PUPPETEER_EXECUTABLE_PATH` | `/usr/bin/chromium-browser` | Path to the Chromium binary |
| `CUSTOM_USER_AGENT` | Chrome 133 Desktop | Custom User-Agent to use |

---

## HTTP Endpoints

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/cookie` | Returns `{ datadome, userAgent, updatedAt }` JSON payload |
| `POST` | `/refresh` | Forces an immediate headless browser refresh and returns the new cookie |
| `GET` | `/health` | Health check endpoint returning `{ status: "ok" }` |

---

## Connecting to Degoog

In Degoog's engine settings (or environment variables), configure either:

* **HTTP Sidecar URL:** Set `cookieServerUrl` to `http://localhost:3005/cookie` (or `http://qwant-sidecar:3005/cookie` in Docker).
* **Shared File:** Mount a shared volume and set `cookieFilePath` to `/path/to/cookie.json`.
* **Environment Variables:** Set `QWANT_COOKIE_SERVER_URL=http://...` or `QWANT_COOKIE_FILE=/...`.

All four Qwant engines (`Qwant`, `Qwant Images`, `Qwant News`, `Qwant Videos`) automatically sync from this sidecar and will trigger an immediate on-demand refresh if an HTTP 403 is ever encountered.
