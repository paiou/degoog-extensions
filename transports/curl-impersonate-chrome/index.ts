declare const Bun: any
declare const Buffer: any
declare const process: any

export interface TransportFetchOptions {
  method?: string
  headers?: Record<string, string>
  body?: string
  timeoutMs?: number
  signal?: AbortSignal
}

export interface TransportContext {
  proxyUrl?: string
  engineId?: string
  fetch: (url: string, init?: RequestInit) => Promise<Response>
  useCache: <T>(namespace: string, ttlMs?: number) => any
}

const CHROME_BINARIES = [
  "curl_chrome133a",
  "curl_chrome136",
  "curl_chrome131",
  "curl_chrome120",
  "curl_chrome116",
  "curl_chrome107",
  "curl_chrome104",
  "curl_chrome100",
  "curl-impersonate-chrome",
] as const

const DEFAULT_CHROME_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36"

let _resolvedBinary: string | null = null

function resolveBinary(): string | null {
  if (_resolvedBinary) return _resolvedBinary
  for (const bin of CHROME_BINARIES) {
    try {
      if (typeof Bun !== "undefined" && Bun.spawnSync) {
        const res = Bun.spawnSync([bin, "--version"])
        if (res.exitCode === 0) {
          _resolvedBinary = bin
          return bin
        }
      } else if (typeof process !== "undefined") {
        const cpMod = "child_process"
        const cp: any = (process as any).getBuiltinModule?.(cpMod)
        if (cp?.spawnSync) {
          const res = cp.spawnSync(bin, ["--version"])
          if (res.status === 0) {
            _resolvedBinary = bin
            return bin
          }
        }
      }
    } catch {}
  }
  // Default fallback if synchronous probing is inconclusive
  return CHROME_BINARIES[0]
}

function parseCurlResponse(raw: string): { status: number; headers: Headers; body: string } {
  const matches = [...raw.matchAll(/(?:^|\r?\n)(HTTP\/[123](?:\.[0-9])?\s+(\d{3})[^\r\n]*)/g)]
  if (!matches.length) {
    return { status: 502, headers: new Headers(), body: raw }
  }
  const lastMatch = matches[matches.length - 1]
  const prefixLen = lastMatch[0].startsWith("\r\n") ? 2 : (lastMatch[0].startsWith("\n") ? 1 : 0)
  const lastHeaderStartIndex = lastMatch.index + prefixLen
  const afterHeaderStart = raw.slice(lastHeaderStartIndex)
  const delimMatch = afterHeaderStart.match(/\r?\n\r?\n/)
  if (!delimMatch || delimMatch.index === undefined) {
    return { status: parseInt(lastMatch[2], 10), headers: new Headers(), body: "" }
  }
  const headerText = afterHeaderStart.slice(0, delimMatch.index)
  const bodyText = afterHeaderStart.slice(delimMatch.index + delimMatch[0].length)
  const status = parseInt(lastMatch[2], 10)
  const headers = new Headers()
  for (const line of headerText.split(/\r?\n/).slice(1)) {
    const colon = line.indexOf(":")
    if (colon > 0) {
      headers.append(line.slice(0, colon).trim(), line.slice(colon + 1).trim())
    }
  }
  return { status, headers, body: bodyText }
}

export default class CurlImpersonateChromeTransport {
  name = "curl-impersonate-chrome"
  displayName = "Curl Impersonate (Chrome)"
  description =
    "Uses curl-impersonate Chrome binary to mimic modern Chromium TLS fingerprints (JA3/JA4) and preserve Chrome User-Agent. Ideal for bypass of DataDome and Cloudflare."

  available(): boolean {
    return resolveBinary() !== null
  }

  async fetch(
    url: string,
    options: TransportFetchOptions = {},
    context?: TransportContext
  ): Promise<Response> {
    const binary = resolveBinary()
    if (!binary) {
      throw new Error(
        "No curl-impersonate Chrome binary found (probed: " +
          CHROME_BINARIES.join(", ") +
          "). Ensure curl-impersonate is installed."
      )
    }

    const method = (options.method ?? "GET").toUpperCase()
    const timeoutSec = Math.max(
      1,
      Math.min(300, Math.round((options.timeoutMs ?? 30000) / 1000))
    )

    const args: string[] = [
      "-sS",
      "-L",
      "--max-redirs",
      "5",
      "--max-time",
      String(timeoutSec),
      "-i", // output response headers
    ]

    const proxyUrl = context?.proxyUrl
    if (proxyUrl && proxyUrl.trim()) {
      args.push("--proxy", proxyUrl.trim())
    }

    if (method !== "GET" && method !== "HEAD") {
      args.push("-X", method)
    }

    if (options.body && ["POST", "PUT", "PATCH"].includes(method)) {
      args.push("--data-binary", options.body)
    }

    // Preserve caller's headers, default User-Agent if not provided
    const headersMap: Record<string, string> = {}
    let hasUa = false
    for (const [k, v] of Object.entries(options.headers ?? {})) {
      if (!k.trim()) continue
      const lower = k.toLowerCase()
      if (lower === "user-agent") hasUa = true
      headersMap[k] = String(v)
    }

    if (!hasUa) {
      headersMap["User-Agent"] = DEFAULT_CHROME_UA
    }

    for (const [k, v] of Object.entries(headersMap)) {
      args.push("-H", `${k.replace(/[\r\n]/g, "")}: ${v.replace(/[\r\n]/g, "")}`)
    }

    args.push("--", url)

    let stdoutText = ""
    let stderrText = ""
    let exitCode = 0

    if (typeof Bun !== "undefined" && Bun.spawn) {
      const proc = Bun.spawn([binary, ...args], {
        stdout: "pipe",
        stderr: "pipe",
      })

      if (options.signal) {
        options.signal.addEventListener("abort", () => {
          try {
            proc.kill()
          } catch {}
        })
      }

      const [stdoutBuf, errText, code] = await Promise.all([
        Bun.readableStreamToBytes(proc.stdout),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      stdoutText = new TextDecoder().decode(stdoutBuf)
      stderrText = errText
      exitCode = code
    } else {
      const cpMod = "child_process"
      const cp: any = await import(cpMod)
      const proc = cp.spawn(binary, args)
      if (options.signal) {
        options.signal.addEventListener("abort", () => {
          try {
            proc.kill()
          } catch {}
        })
      }

      const stdoutChunks: any[] = []
      const stderrChunks: any[] = []

      proc.stdout.on("data", (d: any) => stdoutChunks.push(Buffer.from(d)))
      proc.stderr.on("data", (d: any) => stderrChunks.push(Buffer.from(d)))

      exitCode = await new Promise<number>((resolve, reject) => {
        proc.on("error", reject)
        proc.on("close", (code: number) => resolve(code ?? 0))
      })

      stdoutText = Buffer.concat(stdoutChunks).toString("utf-8")
      stderrText = Buffer.concat(stderrChunks).toString("utf-8")
    }

    if (exitCode !== 0) {
      throw new Error(
        stderrText.trim() || `${binary} exited with status ${exitCode}`
      )
    }

    const parsed = parseCurlResponse(stdoutText)
    return new Response(parsed.body, {
      status: parsed.status,
      headers: parsed.headers,
    })
  }
}
