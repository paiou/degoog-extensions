# Qwant Videos Search Engine for Degoog

Video search engine extension for [Degoog](https://github.com/degoog-org/degoog) using Qwant.

## Features

- **Direct API queries:** Queries Qwant's backend video search API (`/api/search/videos`) with curl-impersonate.
- **DataDome Protection Bypass:** Compatible with the [`qwant-cookie-sidecar`](../../sidecars/qwant-cookie-sync) to automatically fetch and roll valid DataDome session cookies.
- **Zero Overhead:** Keeps fast curl-impersonate transport while offloading browser JS execution to an on-demand sidecar.
- **Automatic 403 Recovery:** Automatically triggers on-demand cookie refresh and retries if a request is challenged.

## Quick Start with Docker Compose

Run the official Degoog image alongside the Qwant Cookie Sidecar:

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

## Configuration

Settings can be specified in Degoog's engine configuration UI, or via environment variables:

| Setting | Environment Variable | Default | Description |
|---|---|---|---|
| `cookieServerUrl` | `QWANT_COOKIE_SERVER_URL` | `""` | URL to the sidecar cookie endpoint (e.g., `http://qwant-sidecar:3005/cookie`) |
| `cookieFilePath` | `QWANT_COOKIE_FILE` | `""` | Optional path to a shared JSON file written by the sidecar |
| `cookie` | `QWANT_COOKIE` | `""` | Static DataDome cookie value fallback |
| `customUserAgent` | `QWANT_USER_AGENT` | Chrome 133 Desktop | User-Agent matching the DataDome cookie |
