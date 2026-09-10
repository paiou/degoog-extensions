# Degoog Extensions

Custom extensions and sidecars for [Degoog](https://github.com/degoog-org/degoog).

## Included Engines

| Engine | Type | Description |
|---|---|---|
| **[Qwant](engines/qwant)** | Web Search | Fast web search powered by Qwant's API with curl-impersonate |
| **[Qwant Images](engines/qwant-images)** | Images | Image search using Qwant's `/api/search/images` endpoint |
| **[Qwant News](engines/qwant-news)** | News | Latest news search with timestamps and publishers |
| **[Qwant Videos](engines/qwant-videos)** | Videos | Video search with thumbnails, channel names, and durations |

## Sidecars

### [Qwant Cookie Sidecar](sidecars/qwant-cookie-sync) (`ghcr.io/paiou/qwant-cookie-sidecar`)

A lightweight companion container that solves Qwant's DataDome anti-bot protection:
- **0% Idle RAM:** Spins up headless Chromium for ~5 seconds every 25 minutes to execute `dd.qwant.com/tags.js` and extract a valid `datadome` cookie + matching `User-Agent`, then immediately exits.
- **Ultra-fast searches:** Degoog queries Qwant directly via `curl-impersonate` using the shared cookie, avoiding any browser overhead during searches.
- **Reactive Refresh:** Automatically prompts the sidecar for a fresh cookie and retries if an HTTP 403 challenge is ever encountered.

Docker images are automatically built and published to GitHub Container Registry on every push to `main`.

---

## Quick Start (Docker Compose)

The easiest way to run Degoog with these extensions and the Qwant Cookie Sidecar is using Docker Compose with the official Degoog image and the published sidecar image:

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
      # Mount this extensions repository into Degoog
      - ./:/app/extensions
    depends_on:
      - qwant-sidecar
    restart: unless-stopped

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

---

## Configuration

Each Qwant engine accepts the following settings in Degoog or through environment variables:

| Setting | Environment Variable | Default | Description |
|---|---|---|---|
| `cookieServerUrl` | `QWANT_COOKIE_SERVER_URL` | `""` | HTTP URL of the sidecar cookie endpoint |
| `cookieFilePath` | `QWANT_COOKIE_FILE` | `""` | Path to a shared JSON file containing `{ datadome, userAgent }` |
| `cookie` | `QWANT_COOKIE` | `""` | Static DataDome cookie value fallback |
| `customUserAgent` | `QWANT_USER_AGENT` | Chrome 133 Desktop | User-Agent matching the DataDome session |

---

## CI / CD

The repository contains an automated GitHub Actions workflow [`.github/workflows/publish-sidecar.yml`](.github/workflows/publish-sidecar.yml) that builds and publishes the `qwant-cookie-sidecar` Docker image to `ghcr.io/paiou/qwant-cookie-sidecar:latest` on every push to `main`.
