# Curl Impersonate (Chrome) Transport

Outgoing HTTP client transport for Degoog that mimics modern Google Chrome TLS and HTTP/2 handshakes (JA3/JA4 fingerprints) and preserves Chrome User-Agent headers.

## Overview

Degoog's built-in `curl-impersonate` transport targets Firefox (`curl_firefox135`) and automatically strips caller User-Agent headers to ensure a uniform Firefox profile.

However, anti-bot protection services such as **DataDome** and **Cloudflare** bind session tokens (like the `datadome` cookie) to:
1. The client's exact TLS fingerprint (JA3 / JA4 ciphers, extensions, ALPN).
2. The client's `User-Agent` string.

When paired with a Chromium-based cookie sync sidecar (`qwant-cookie-sidecar`), sending a Chromium-issued cookie via Firefox TLS triggers immediate token-hijacking detection and **HTTP 403 Forbidden**.

`curl-impersonate-chrome` solves this by:
- Executing pre-installed Chrome impersonation binaries (`curl_chrome133a`, `curl_chrome136`, `curl_chrome131`, `curl_chrome120`, `curl_chrome116`).
- Preserving the exact Chrome `User-Agent` and `Cookie` headers provided by search engines.
- Retaining upstream response headers (like `Set-Cookie`, `x-datadome`).
- Avoiding extraneous root warmup requests.

## Requirements

Requires `curl-impersonate` Chrome binaries (included by default in the official Degoog Docker container `ghcr.io/degoog-org/degoog:latest`).
