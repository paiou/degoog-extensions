declare const process: any
declare const Bun: any
export const type = "images"

export const filters = {
  size: ["small", "medium", "large"],
  color: [
    "red",
    "blue",
    "green",
    "yellow",
    "orange",
    "purple",
    "pink",
    "black",
    "gray",
    "white",
    "monochrome",
  ],
  type: ["photo", "clipart", "lineart", "animated"],
}

const SAFE_SEARCH_MAP: Record<string, string> = {
  off: "0",
  moderate: "1",
  strict: "2",
}

function cleanText(text?: string): string {
  if (!text) return ""
  return text
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function formatLocale(lang?: string): string {
  if (!lang) return "en_US"
  const clean = lang.trim().replace("-", "_")
  if (clean.includes("_")) {
    const [l, c] = clean.split("_")
    return `${l.toLowerCase()}_${c.toUpperCase()}`
  }
  const map: Record<string, string> = {
    en: "en_US",
    fr: "fr_FR",
    de: "de_DE",
    es: "es_ES",
    it: "it_IT",
    nl: "nl_NL",
    pt: "pt_PT",
    pl: "pl_PL",
    ru: "ru_RU",
    ja: "ja_JP",
    zh: "zh_CN",
    ca: "ca_ES",
    eu: "eu_ES",
  }
  const lower = clean.toLowerCase()
  return map[lower] ?? `${lower}_${lower.toUpperCase()}`
}

export const description =
  "Qwant images search engine. Directly queries Qwant's images search API. Note: Uses 'curl-impersonate' (default in Degoog) on residential IPs or an anti-bot browser transport to query without manual cookies."

const GLOBAL_COOKIE_KEY = "__degoog_qwant_datadome_cookie"
const GLOBAL_LAST_CONFIGURED_KEY = "__degoog_qwant_last_configured_cookie"
const GLOBAL_UA_KEY = "__degoog_qwant_user_agent"
let cachedDataDome: string | null = null
let lastConfiguredCookie = ""

const DEFAULT_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36"

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

const FIREFOX_BINARIES = [
  "curl_firefox135",
  "curl_firefox133",
  "curl_firefox128",
  "curl_firefox120",
  "curl_firefox117",
  "curl_firefox109",
  "curl-impersonate-firefox",
  "curl-impersonate",
] as const

let _cachedImpersonateBinary: { binary: string; family: "chrome" | "firefox" } | null = null

function checkBinaryAvailable(bin: string): boolean {
  try {
    if (typeof Bun !== "undefined" && Bun.spawnSync) {
      const res = Bun.spawnSync([bin, "--version"])
      return res.exitCode === 0
    } else if (typeof process !== "undefined") {
      const cpMod = "child_process"
      const cp: any = (process as any).getBuiltinModule?.(cpMod)
      if (cp?.spawnSync) {
        const res = cp.spawnSync(bin, ["--version"])
        return res.status === 0
      }
    }
  } catch {}
  return false
}

function getImpersonateBinary(
  preferredFamily: "chrome" | "firefox" = "chrome"
): { binary: string; family: "chrome" | "firefox" } | null {
  if (
    _cachedImpersonateBinary &&
    _cachedImpersonateBinary.family === preferredFamily
  ) {
    return _cachedImpersonateBinary
  }

  const primaryList = preferredFamily === "firefox" ? FIREFOX_BINARIES : CHROME_BINARIES
  const primaryFamily = preferredFamily === "firefox" ? "firefox" : "chrome"
  for (const bin of primaryList) {
    if (checkBinaryAvailable(bin)) {
      _cachedImpersonateBinary = { binary: bin, family: primaryFamily }
      return _cachedImpersonateBinary
    }
  }

  const secondaryList = preferredFamily === "firefox" ? CHROME_BINARIES : FIREFOX_BINARIES
  const secondaryFamily = preferredFamily === "firefox" ? "chrome" : "firefox"
  for (const bin of secondaryList) {
    if (checkBinaryAvailable(bin)) {
      _cachedImpersonateBinary = { binary: bin, family: secondaryFamily }
      return _cachedImpersonateBinary
    }
  }

  return null
}

function parseCurlResponseText(raw: string): Response {
  const matches = [...raw.matchAll(/(?:^|\r?\n)(HTTP\/[123](?:\.[0-9])?\s+(\d{3})[^\r\n]*)/g)]
  if (!matches.length) {
    return new Response(raw, { status: 502 })
  }
  const lastMatch = matches[matches.length - 1]
  const prefixLen = lastMatch[0].startsWith("\r\n") ? 2 : (lastMatch[0].startsWith("\n") ? 1 : 0)
  const lastHeaderStartIndex = lastMatch.index + prefixLen
  const afterHeaderStart = raw.slice(lastHeaderStartIndex)
  const delimMatch = afterHeaderStart.match(/\r?\n\r?\n/)
  if (!delimMatch || delimMatch.index === undefined) {
    return new Response("", { status: parseInt(lastMatch[2], 10) })
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
  return new Response(bodyText, { status, headers })
}

async function fetchWithDirectImpersonate(
  binary: string,
  url: string,
  headers: Record<string, string>,
  proxyUrl?: string,
  timeoutMs = 20000
): Promise<Response> {
  const timeoutSec = Math.max(1, Math.min(60, Math.round(timeoutMs / 1000)))
  const args = [
    "-sS",
    "-L",
    "--max-redirs",
    "5",
    "--max-time",
    String(timeoutSec),
    "-i",
  ]

  if (proxyUrl?.trim()) {
    args.push("--proxy", proxyUrl.trim())
  }

  for (const [k, v] of Object.entries(headers)) {
    if (!k.trim()) continue
    args.push("-H", `${k.replace(/[\r\n]/g, "")}: ${String(v).replace(/[\r\n]/g, "")}`)
  }

  args.push("--", url)

  if (typeof Bun !== "undefined" && Bun.spawn) {
    const proc = Bun.spawn([binary, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdoutBuf, errText, exitCode] = await Promise.all([
      Bun.readableStreamToBytes(proc.stdout),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    if (exitCode !== 0) {
      throw new Error(errText.trim() || `${binary} exited with status ${exitCode}`)
    }
    const raw = new TextDecoder().decode(stdoutBuf)
    return parseCurlResponseText(raw)
  }

  throw new Error("Bun runtime required for direct curl execution")
}

function cleanDataDomeCookie(raw?: string): string {
  if (!raw || typeof raw !== "string") return ""
  let c = raw.trim()
  if ((c.startsWith('"') && c.endsWith('"')) || (c.startsWith("'") && c.endsWith("'"))) {
    c = c.slice(1, -1).trim()
  }
  if (c.toLowerCase().startsWith("cookie:")) {
    c = c.slice(7).trim()
  }
  if (c.includes("\t")) {
    const parts = c.split("\t").map((p) => p.trim())
    const ddIdx = parts.indexOf("datadome")
    if (ddIdx !== -1 && parts[ddIdx + 1]) {
      return parts[ddIdx + 1]
    }
  }
  const m = c.match(/(?:^|;\s*)datadome=([^;]+)/i)
  if (m) {
    return m[1].trim()
  }
  if (c.startsWith("datadome=")) {
    return c.slice(9).trim()
  }
  if (c.endsWith(";")) {
    c = c.slice(0, -1).trim()
  }
  return c
}

function maskCookie(cookie?: string): string {
  if (!cookie) return "none"
  if (cookie.length <= 12) return cookie
  return `${cookie.slice(0, 6)}...${cookie.slice(-6)} (len: ${cookie.length})`
}

function updateDataDomeCookie(cookie: string | null, reason = "", engineName = "Qwant Images") {
  if (cookie && cookie.trim()) {
    const clean = cleanDataDomeCookie(cookie)
    cachedDataDome = clean
    ;(globalThis as any)[GLOBAL_COOKIE_KEY] = clean
    ;(globalThis as any)[GLOBAL_SIDECAR_COOKIE_KEY] = clean
    console.log(`[${engineName}] DataDome cookie updated [${reason}]: ${maskCookie(clean)}`)
  } else {
    cachedDataDome = null
    delete (globalThis as any)[GLOBAL_COOKIE_KEY]
    delete (globalThis as any)[GLOBAL_SIDECAR_COOKIE_KEY]
    delete (globalThis as any)[GLOBAL_SIDECAR_FETCH_TIME_KEY]
    console.log(`[${engineName}] DataDome cookie cleared [${reason}]`)
  }
}

function getActiveDataDomeCookie(
  configuredCookie?: string,
  engineName = "Qwant Images",
  forceNoCookie = false
): { cookie: string; source: string } {
  if (forceNoCookie) {
    return { cookie: "", source: "forced-clean-retry" }
  }
  const cleanConfigured = cleanDataDomeCookie(configuredCookie)
  const lastConfigured =
    (globalThis as any)[GLOBAL_LAST_CONFIGURED_KEY] || lastConfiguredCookie
  if (cleanConfigured && cleanConfigured !== lastConfigured) {
    lastConfiguredCookie = cleanConfigured
    ;(globalThis as any)[GLOBAL_LAST_CONFIGURED_KEY] = cleanConfigured
    updateDataDomeCookie(cleanConfigured, "new-settings-detected", engineName)
  }
  const globalCookie = (globalThis as any)[GLOBAL_COOKIE_KEY]
  if (typeof globalCookie === "string" && globalCookie.trim()) {
    return { cookie: globalCookie.trim(), source: "shared-cache" }
  }
  const sidecarCookie = (globalThis as any)[GLOBAL_SIDECAR_COOKIE_KEY]
  if (typeof sidecarCookie === "string" && sidecarCookie.trim()) {
    return { cookie: sidecarCookie.trim(), source: "sidecar-cache" }
  }
  if (cachedDataDome && cachedDataDome.trim()) {
    return { cookie: cachedDataDome.trim(), source: "local-cache" }
  }
  if (cleanConfigured) {
    return { cookie: cleanConfigured, source: "settings" }
  }
  if (typeof process !== "undefined") {
    const envCookie = cleanDataDomeCookie(
      process.env?.QWANT_COOKIE || process.env?.QWANT_DATADOME_COOKIE
    )
    if (envCookie) {
      return { cookie: envCookie, source: "env" }
    }
  }
  return { cookie: "", source: "none" }
}

const GLOBAL_SIDECAR_COOKIE_KEY = "__degoog_qwant_sidecar_cookie"
const GLOBAL_SIDECAR_UA_KEY = "__degoog_qwant_sidecar_ua"
const GLOBAL_SIDECAR_FETCH_TIME_KEY = "__degoog_qwant_sidecar_fetch_time"

function getEffectiveSidecarUrl(context?: any, engineInstance?: any): string {
  const fromSettings =
    typeof context?.settings?.cookieServerUrl === "string"
      ? context.settings.cookieServerUrl.trim()
      : ""
  if (fromSettings) return fromSettings

  const fromInstance =
    typeof engineInstance?.cookieServerUrl === "string"
      ? engineInstance.cookieServerUrl.trim()
      : ""
  if (fromInstance) return fromInstance

  const fromEngine =
    typeof engine.cookieServerUrl === "string"
      ? engine.cookieServerUrl.trim()
      : ""
  if (fromEngine) return fromEngine

  if (typeof process !== "undefined") {
    const fromEnv =
      process.env?.QWANT_COOKIE_SERVER_URL?.trim() ||
      process.env?.COOKIE_SERVER_URL?.trim()
    if (fromEnv) return fromEnv
  }
  return ""
}

function getEffectiveSidecarFile(context?: any, engineInstance?: any): string {
  const fromSettings =
    typeof context?.settings?.cookieFilePath === "string"
      ? context.settings.cookieFilePath.trim()
      : ""
  if (fromSettings) return fromSettings

  const fromInstance =
    typeof engineInstance?.cookieFilePath === "string"
      ? engineInstance.cookieFilePath.trim()
      : ""
  if (fromInstance) return fromInstance

  const fromEngine =
    typeof engine.cookieFilePath === "string"
      ? engine.cookieFilePath.trim()
      : ""
  if (fromEngine) return fromEngine

  if (typeof process !== "undefined") {
    const fromEnv =
      process.env?.QWANT_COOKIE_FILE?.trim() ||
      process.env?.COOKIE_FILE?.trim()
    if (fromEnv) return fromEnv
  }
  return ""
}

function getSidecarEndpoints(rawUrl: string): { cookieUrl: string; refreshUrl: string } {
  let base = rawUrl.trim().replace(/\/+$/, "")
  if (base.endsWith("/cookie")) {
    base = base.slice(0, -7).replace(/\/+$/, "")
  } else if (base.endsWith("/refresh")) {
    base = base.slice(0, -8).replace(/\/+$/, "")
  }
  return {
    cookieUrl: `${base}/cookie`,
    refreshUrl: `${base}/refresh`,
  }
}

async function syncWithSidecar(
  serverUrl?: string,
  filePath?: string,
  force = false,
  engineName = "Qwant Images"
): Promise<{ cookie: string; userAgent: string } | null> {
  const effectiveUrl =
    (typeof serverUrl === "string" && serverUrl.trim()) ||
    (typeof process !== "undefined"
      ? (process.env?.QWANT_COOKIE_SERVER_URL?.trim() || process.env?.COOKIE_SERVER_URL?.trim())
      : "") ||
    ""
  const effectiveFile =
    (typeof filePath === "string" && filePath.trim()) ||
    (typeof process !== "undefined"
      ? (process.env?.QWANT_COOKIE_FILE?.trim() || process.env?.COOKIE_FILE?.trim())
      : "") ||
    ""

  if (!effectiveUrl && !effectiveFile) return null

  const now = Date.now()
  const lastFetch = (globalThis as any)[GLOBAL_SIDECAR_FETCH_TIME_KEY] || 0
  const cachedCookie = (globalThis as any)[GLOBAL_SIDECAR_COOKIE_KEY]
  const cachedUa = (globalThis as any)[GLOBAL_SIDECAR_UA_KEY]

  // Re-use cached sidecar cookie for up to 60s unless force is requested
  if (!force && cachedCookie && now - lastFetch < 60000) {
    ;(globalThis as any)[GLOBAL_COOKIE_KEY] = cachedCookie
    cachedDataDome = cachedCookie
    if (cachedUa) {
      ;(globalThis as any)[GLOBAL_UA_KEY] = cachedUa
    }
    return { cookie: cachedCookie, userAgent: cachedUa || "" }
  }

  // 1. Try HTTP Sidecar endpoint
  if (effectiveUrl) {
    const endpoints = getSidecarEndpoints(effectiveUrl)
    const target = force ? endpoints.refreshUrl : endpoints.cookieUrl
    const method = force ? "POST" : "GET"

    try {
      console.log(`[${engineName}] Sidecar HTTP ${method}: ${target}`)
      const res = await fetch(target, {
        method,
        signal: AbortSignal.timeout(force ? 8000 : 2500),
      })
      if (res.ok) {
        const data: any = await res.json()
        if (data.hasCookie === false || (!data.cookie && !data.datadome)) {
          console.log(
            `[${engineName}] Sidecar reports no verified cookie available. Proceeding without cookie.`
          )
          return null
        }
        const cookie = cleanDataDomeCookie(data.cookie || data.datadome)
        const ua = data.userAgent?.trim() || ""
        if (cookie) {
          ;(globalThis as any)[GLOBAL_SIDECAR_COOKIE_KEY] = cookie
          ;(globalThis as any)[GLOBAL_SIDECAR_UA_KEY] = ua
          ;(globalThis as any)[GLOBAL_SIDECAR_FETCH_TIME_KEY] = now
          updateDataDomeCookie(cookie, force ? "sidecar-http-refresh" : "sidecar-http-sync", engineName)
          if (ua) {
            ;(globalThis as any)[GLOBAL_UA_KEY] = ua
          }
          return { cookie, userAgent: ua }
        } else {
          console.warn(`[${engineName}] Sidecar responded ${res.status} but returned no DataDome cookie`)
        }
      } else {
        console.warn(`[${engineName}] Sidecar HTTP responded with status ${res.status}: ${res.statusText}`)
      }
    } catch (err: any) {
      console.warn(
        `[${engineName}] Sidecar HTTP sync failed (${target}): ${err?.message || err}`
      )
    }
  }

  // 2. Try file path
  if (effectiveFile) {
    try {
      const fsMod = "fs/promises"
      const fs: any = await import(fsMod)
      const content = await fs.readFile(effectiveFile, "utf-8")
      const data = JSON.parse(content)
      const cookie = cleanDataDomeCookie(data.cookie || data.datadome)
      const ua = data.userAgent?.trim() || ""
      if (cookie) {
        ;(globalThis as any)[GLOBAL_SIDECAR_COOKIE_KEY] = cookie
        ;(globalThis as any)[GLOBAL_SIDECAR_UA_KEY] = ua
        ;(globalThis as any)[GLOBAL_SIDECAR_FETCH_TIME_KEY] = now
        updateDataDomeCookie(cookie, "sidecar-file-sync", engineName)
        if (ua) {
          ;(globalThis as any)[GLOBAL_UA_KEY] = ua
        }
        return { cookie, userAgent: ua }
      }
    } catch (err: any) {
      console.warn(
        `[${engineName}] Sidecar file sync failed (${effectiveFile}): ${err?.message || err}`
      )
    }
  }

  if (cachedCookie) {
    ;(globalThis as any)[GLOBAL_COOKIE_KEY] = cachedCookie
    cachedDataDome = cachedCookie
    if (cachedUa) {
      ;(globalThis as any)[GLOBAL_UA_KEY] = cachedUa
    }
    return { cookie: cachedCookie, userAgent: cachedUa || "" }
  }

  return null
}

function triggerSidecarRefresh(serverUrl?: string, engineName = "Qwant Images") {
  const effectiveUrl =
    (typeof serverUrl === "string" && serverUrl.trim()) ||
    (typeof process !== "undefined"
      ? (process.env?.QWANT_COOKIE_SERVER_URL?.trim() || process.env?.COOKIE_SERVER_URL?.trim())
      : "") ||
    ""
  if (!effectiveUrl) return

  const { refreshUrl } = getSidecarEndpoints(effectiveUrl)
  console.log(
    `[${engineName}] Requesting immediate background cookie refresh from sidecar: ${refreshUrl}`
  )
  fetch(refreshUrl, { method: "POST", signal: AbortSignal.timeout(5000) }).catch(
    (err) => {
      console.warn(`[${engineName}] Failed to trigger sidecar refresh (${refreshUrl}): ${err?.message || err}`)
    }
  )
}

function extractDataDomeCookie(response: any): string | null {
  if (!response?.headers) return null

  // 1. Fetch API getSetCookie()
  if (typeof response.headers.getSetCookie === "function") {
    const cookies: string[] = response.headers.getSetCookie() || []
    for (const c of cookies) {
      const m = String(c).match(/datadome=([^;]+)/i)
      if (m) return m[1].trim()
    }
  }

  // 2. Standard Headers.get()
  if (typeof response.headers.get === "function") {
    const raw =
      response.headers.get("set-cookie") ||
      response.headers.get("x-set-cookie") ||
      ""
    const m = String(raw).match(/datadome=([^;]+)/i)
    if (m) return m[1].trim()
  }

  // 3. Headers.raw() (node-fetch style)
  if (typeof response.headers.raw === "function") {
    const rawMap = response.headers.raw() || {}
    const list = rawMap["set-cookie"] || rawMap["x-set-cookie"] || []
    for (const c of Array.isArray(list) ? list : [list]) {
      const m = String(c).match(/datadome=([^;]+)/i)
      if (m) return m[1].trim()
    }
  }

  // 4. Plain object headers (e.g. { 'set-cookie': '...' } or { 'set-cookie': [...] })
  const plain =
    response.headers["set-cookie"] ||
    response.headers["x-set-cookie"] ||
    response.headers?._headers?.["set-cookie"]
  if (plain) {
    for (const c of Array.isArray(plain) ? plain : [plain]) {
      const m = String(c).match(/datadome=([^;]+)/i)
      if (m) return m[1].trim()
    }
  }

  return null
}

function getEffectiveUserAgent(context?: any, configuredUa?: string): string {
  if (configuredUa && configuredUa.trim()) {
    return configuredUa.trim()
  }
  const globalUa = (globalThis as any)[GLOBAL_UA_KEY]
  if (typeof globalUa === "string" && globalUa.trim()) {
    return globalUa.trim()
  }
  const sidecarUa = (globalThis as any)[GLOBAL_SIDECAR_UA_KEY]
  if (typeof sidecarUa === "string" && sidecarUa.trim()) {
    return sidecarUa.trim()
  }
  if (typeof process !== "undefined") {
    const envUa = process.env?.QWANT_USER_AGENT?.trim()
    if (envUa) return envUa
  }
  if (typeof context?.userAgent === "function") {
    try {
      const ua = context.userAgent()
      if (typeof ua === "string" && ua.trim()) return ua.trim()
    } catch {}
  } else if (typeof context?.userAgent === "string" && context.userAgent.trim()) {
    return context.userAgent.trim()
  }
  return DEFAULT_UA
}

export const engine = {
  name: "Qwant Images",
  bangShortcut: "qwant-images",
  safeSearch: "moderate",
  outgoingTransport: "auto",
  datadomeCookie: "",
  userAgent: "",
  cookieServerUrl: "",
  cookieFilePath: "",

  settingsSchema: [
    {
      key: "outgoingTransport",
      label: "Outgoing HTTP client transport",
      type: "select",
      options: [
        "auto",
        "curl-impersonate-chrome",
        "curl-impersonate-firefox",
        "curl-impersonate",
        "fetch",
        "curl",
        "curl-fallback",
      ],
      default: "auto",
      advanced: true,
      description:
        "Select an outgoing transport. 'auto' (recommended) matches curl-impersonate-chrome or curl-impersonate-firefox based on your active User-Agent and cookie to match TLS fingerprints and bypass DataDome.",
    },
    {
      key: "cookieServerUrl",
      label: "Cookie Sidecar URL",
      type: "text",
      advanced: true,
      description:
        "Optional URL of a local Qwant cookie sidecar (e.g. http://qwant-sidecar:3005/cookie or http://localhost:3005/cookie) that runs headless Chromium to auto-refresh DataDome cookies without slowing down searches.",
    },
    {
      key: "cookieFilePath",
      label: "Cookie Sidecar File Path",
      type: "text",
      advanced: true,
      description:
        "Optional path to a shared JSON file containing { datadome, userAgent } written by a sidecar service or cron job.",
    },
    {
      key: "datadomeCookie",
      label: "DataDome Cookie",
      type: "password",
      advanced: true,
      description:
        "Optional fallback: DataDome cookie. When provided or renewed, it is passed in request headers by all transports. Note that manually copied cookies often fail with HTTP 403 because DataDome validates that your browser's exact IP and TLS fingerprint match.",
    },
    {
      key: "userAgent",
      label: "Browser User-Agent",
      type: "text",
      advanced: true,
      description:
        "Optional: User-Agent from the browser where you obtained the DataDome cookie. If DataDome detects a User-Agent mismatch with your cookie, it will return HTTP 403.",
    },
    {
      key: "safeSearch",
      label: "Safe Search",
      type: "select",
      options: ["off", "moderate", "strict"],
      default: "moderate",
      description: "Filter explicit content from search results.",
    },
  ],

  configure(settings: Record<string, any>) {
    const engineName = this?.name ?? engine.name
    console.log(`[${engineName}] configure() called with settings keys:`, Object.keys(settings || {}))
    if (typeof settings?.safeSearch === "string") {
      this.safeSearch = settings.safeSearch
      engine.safeSearch = settings.safeSearch
    }
    if (typeof settings?.outgoingTransport === "string") {
      this.outgoingTransport = settings.outgoingTransport
      engine.outgoingTransport = settings.outgoingTransport
    }
    if (typeof settings?.cookieServerUrl === "string") {
      const u = settings.cookieServerUrl.trim()
      this.cookieServerUrl = u
      engine.cookieServerUrl = u
    }
    if (typeof settings?.cookieFilePath === "string") {
      const f = settings.cookieFilePath.trim()
      this.cookieFilePath = f
      engine.cookieFilePath = f
    }
    if (typeof settings?.userAgent === "string") {
      const ua = settings.userAgent.trim()
      this.userAgent = ua
      engine.userAgent = ua
      if (ua) {
        ;(globalThis as any)[GLOBAL_UA_KEY] = ua
        console.log(`[${engineName}] User-Agent configured: "${ua.slice(0, 50)}..."`)
      }
    }
    if (typeof settings?.datadomeCookie === "string") {
      const val = cleanDataDomeCookie(settings.datadomeCookie)
      this.datadomeCookie = val
      engine.datadomeCookie = val
      lastConfiguredCookie = val
      ;(globalThis as any)[GLOBAL_LAST_CONFIGURED_KEY] = val
      console.log(`[${engineName}] Settings updated: datadomeCookie set to ${maskCookie(val)}`)
      if (val) {
        if (val.startsWith("~")) {
          console.warn(
            `[${engineName}] WARNING: Configured cookie starts with '~'. This is an unverified challenge cookie from DataDome. Please perform an actual search on qwant.com in your browser before copying the cookie.`
          )
        }
        updateDataDomeCookie(val, "settings-save", engineName)
      } else {
        updateDataDomeCookie(null, "settings-cleared", engineName)
      }
    }
  },

  async executeSearch(
    query: string,
    page = 1,
    timeFilter?: string,
    context?: {
      lang?: string
      fetch?: typeof fetch
      signProxyUrl?: (url: string) => string
      buildAcceptLanguage?: () => string
      userAgent?: () => string | string
      settings?: Record<string, any>
      dateFrom?: string
      dateTo?: string
      imageFilter?: Record<string, string>
      pagination?: (info: { total?: number }) => void
      sentinel?: (
        response: { ok: boolean; status: number },
        engineName?: string
      ) => void
      engineError?: (
        status: string,
        message: string,
        opts?: { httpStatus?: number; engine?: string }
      ) => Error
      _qwantRetry?: boolean
      _qwantForceNoCookie?: boolean
      [key: string]: any
    }
  ): Promise<any[]> {
    const engineName = this?.name ?? engine.name
    try {
      const doFetch = context?.fetch ?? fetch
      const safeSearch =
        SAFE_SEARCH_MAP[this?.safeSearch ?? engine.safeSearch] ?? "1"
      const locale = formatLocale(context?.lang)

      const count = 30
      const offset = Math.max(0, ((page || 1) - 1) * count)
      const tgp = Math.floor(Math.random() * 3) + 1

      const params = new URLSearchParams({
        q: query,
        count: String(count),
        locale,
        offset: String(offset),
        device: "desktop",
        safesearch: safeSearch,
        tgp: String(tgp),
      })

      if (context?.imageFilter) {
        const imf = context.imageFilter
        if (imf.size && imf.size !== "any") params.set("size", imf.size)
        if (imf.color && imf.color !== "any") params.set("color", imf.color)
        if (imf.type && imf.type !== "any") params.set("imageType", imf.type)
      }

      const url = `https://api.qwant.com/v3/search/images?${params.toString()}`

      const forceNoCookie = Boolean(context?._qwantForceNoCookie)
      const sidecarUrl = getEffectiveSidecarUrl(context, this)
      const sidecarFile = getEffectiveSidecarFile(context, this)

      if (!forceNoCookie && (sidecarUrl || sidecarFile)) {
        await syncWithSidecar(sidecarUrl, sidecarFile, false, engineName)
      }

      const configuredCookie = cleanDataDomeCookie(
        context?.settings?.datadomeCookie ??
        (this?.datadomeCookie ?? engine.datadomeCookie)
      )

      const { cookie: activeCookie, source: cookieSource } =
        getActiveDataDomeCookie(configuredCookie, engineName, forceNoCookie)

      const ua = getEffectiveUserAgent(
        context,
        context?.settings?.userAgent ?? (this?.userAgent ?? engine.userAgent)
      )

      console.log(
        `[${engineName}] Search: "${query}" (page ${page || 1}). ` +
        `Cookie: ${maskCookie(activeCookie)} [source: ${cookieSource}]. ` +
        `UA: "${ua.slice(0, 45)}..."`
      )

      if (activeCookie && (activeCookie.startsWith("~") || activeCookie.endsWith("~"))) {
        console.warn(
          `[${engineName}] WARNING: Active cookie contains '~' boundary marker, indicating an unverified challenge cookie. Request may fail with HTTP 403.`
        )
      }

      const isFirefoxUa = ua.toLowerCase().includes("firefox")
      const outgoingTransportSetting =
        context?.settings?.outgoingTransport ??
        (this?.outgoingTransport ?? engine.outgoingTransport)

      const targetFamily: "chrome" | "firefox" =
        outgoingTransportSetting === "curl-impersonate-firefox"
          ? "firefox"
          : outgoingTransportSetting === "curl-impersonate-chrome"
          ? "chrome"
          : isFirefoxUa
          ? "firefox"
          : "chrome"

      const impersonateTarget = getImpersonateBinary(targetFamily)

      const headers: Record<string, string> = {
        Accept: "application/json, text/plain, */*",
        "Accept-Language": context?.buildAcceptLanguage?.() || "en-US,en;q=0.9",
        "User-Agent": ua,
        Referer: "https://www.qwant.com/",
        Origin: "https://www.qwant.com",
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-site",
        ...(activeCookie ? { Cookie: `datadome=${activeCookie}` } : {}),
      }

      // Add Chromium Client Hints when targeting Chrome browser family
      if (targetFamily === "chrome") {
        headers["sec-ch-ua"] = '"Chromium";v="133", "Not(A:Brand";v="99"'
        headers["sec-ch-ua-mobile"] = "?0"
        const platform = ua.includes("Windows")
          ? '"Windows"'
          : ua.includes("Mac")
          ? '"macOS"'
          : '"Linux"'
        headers["sec-ch-ua-platform"] = platform
      }

      const useDirectImpersonate =
        impersonateTarget !== null &&
        (!outgoingTransportSetting ||
          outgoingTransportSetting === "auto" ||
          outgoingTransportSetting === "curl-impersonate" ||
          outgoingTransportSetting.startsWith("curl-impersonate-"))

      let response: Response
      if (useDirectImpersonate && impersonateTarget) {
        console.log(
          `[${engineName}] Fetching via direct ${impersonateTarget.binary} (${impersonateTarget.family}) transport`
        )
        try {
          response = await fetchWithDirectImpersonate(
            impersonateTarget.binary,
            url,
            headers,
            context?.proxyUrl
          )
        } catch (err: any) {
          console.warn(
            `[${engineName}] Direct ${impersonateTarget.binary} failed (${err?.message || err}), falling back to context fetch`
          )
          const doFetch = context?.fetch ?? fetch
          response = await doFetch(url, { headers })
        }
      } else {
        const doFetch = context?.fetch ?? fetch
        response = await doFetch(url, { headers })
      }

      const freshCookie = extractDataDomeCookie(response)
      const headersAny = response.headers as any
      const rawSetCookie =
        (typeof response.headers.getSetCookie === "function" && response.headers.getSetCookie().length > 0) ||
        response.headers.get?.("set-cookie") ||
        response.headers.get?.("x-set-cookie") ||
        headersAny?.["set-cookie"] ||
        headersAny?.["x-set-cookie"]

      console.log(
        `[${engineName}] Upstream response: status=${response.status} ${response.statusText || ""}. ` +
        `x-datadome=${response.headers.get?.("x-datadome") || headersAny?.["x-datadome"] || "none"}, ` +
        `x-dd-b=${response.headers.get?.("x-dd-b") || headersAny?.["x-dd-b"] || "none"}, ` +
        `set-cookie=${rawSetCookie ? (freshCookie ? `yes [datadome: ${maskCookie(freshCookie)}]` : "yes [no datadome]") : "none"}`
      )

      // Update cached datadome cookie if returned by server on successful response
      if (response.ok || response.status < 400) {
        if (freshCookie) {
          if (freshCookie.startsWith("~") || freshCookie.endsWith("~")) {
            console.log(
              `[${engineName}] Ignored unverified challenge cookie in Set-Cookie: ${maskCookie(freshCookie)}`
            )
          } else if (freshCookie.length > 20) {
            console.log(
              `[${engineName}] Rolling renewal: Qwant issued fresh verified cookie ${maskCookie(freshCookie)}`
            )
            updateDataDomeCookie(freshCookie, "rolling-renewal", engineName)
          }
        }
      }

      // Check if blocked by DataDome CAPTCHA/interstitial challenge
      if (response.status === 403) {
        console.warn(
          `[${engineName}] DataDome blocked request (HTTP 403). ` +
          `Active cookie was: ${maskCookie(activeCookie)} [source: ${cookieSource}].`
        )
        updateDataDomeCookie(null, "challenge-403", engineName)
        delete (globalThis as any)[GLOBAL_SIDECAR_COOKIE_KEY]
        delete (globalThis as any)[GLOBAL_SIDECAR_FETCH_TIME_KEY]

        // Branch 1: If request failed WITH a cookie, retry immediately WITHOUT a cookie!
        // As verified, clean residential connections often succeed directly with no cookie,
        // whereas a tainted/challenged/mismatched cookie triggers guaranteed 403 blocks.
        if (activeCookie && !context?._qwantRetry) {
          console.log(
            `[${engineName}] Search failed with cookie. Retrying immediately WITHOUT cookie on clean connection...`
          )
          if (sidecarUrl) {
            triggerSidecarRefresh(sidecarUrl, engineName)
          }
          return await (this?.executeSearch ?? engine.executeSearch)(
            query,
            page,
            timeFilter,
            { ...context, _qwantRetry: true, _qwantForceNoCookie: true }
          )
        }

        // Branch 2: If request was WITHOUT a cookie and failed, attempt to obtain a verified cookie from sidecar
        if (!activeCookie && (sidecarUrl || sidecarFile) && !context?._qwantRetry) {
          console.log(
            `[${engineName}] Search without cookie returned 403. Requesting verified browser cookie from sidecar...`
          )
          const refreshed = await syncWithSidecar(
            sidecarUrl,
            sidecarFile,
            true,
            engineName
          )
          if (refreshed?.cookie) {
            console.log(
              `[${engineName}] Retrying search with verified sidecar cookie...`
            )
            return await (this?.executeSearch ?? engine.executeSearch)(
              query,
              page,
              timeFilter,
              { ...context, _qwantRetry: true }
            )
          }
        } else if (sidecarUrl) {
          triggerSidecarRefresh(sidecarUrl, engineName)
        }
        let isDataDome = response.headers.get("x-datadome") === "protected"
        if (!isDataDome) {
          try {
            const clone = response.clone ? response.clone() : response
            const text = await clone.text()
            if (
              text.includes("captcha") ||
              text.includes("datadome") ||
              text.includes("challenge")
            ) {
              isDataDome = true
            }
          } catch {
            // ignore
          }
        }

        if (isDataDome) {
          if (context?.engineError) {
            throw context.engineError(
              "captcha",
              `${this?.name ?? engine.name} returned a DataDome CAPTCHA challenge (HTTP 403). To resolve: configure a cookie sync sidecar (cookieServerUrl), run curl-impersonate on a clean residential IP, or configure an anti-bot browser transport.`,
              { httpStatus: 403, engine: this?.name ?? engine.name }
            )
          }
          throw new Error(
            `${this?.name ?? engine.name} returned a DataDome CAPTCHA challenge (HTTP 403)`
          )
        }
      }

      context?.sentinel?.(response, this?.name ?? engine.name)

      let data: any
      try {
        data = await response.json()
      } catch {
        const text = await response.text().catch(() => "")
        if (
          text.includes("captcha") ||
          text.includes("datadome") ||
          text.includes("challenge")
        ) {
          if (context?.engineError) {
            throw context.engineError(
              "captcha",
              `${this?.name ?? engine.name} returned a captcha challenge`,
              { engine: this?.name ?? engine.name }
            )
          }
          throw new Error(
            `${this?.name ?? engine.name} returned a captcha challenge`
          )
        }
        return []
      }

      if (data?.status && data.status !== "success") {
        const errorCode = data?.data?.error_code ?? data?.error_code
        if (errorCode === 24) {
          if (context?.engineError) {
            throw context.engineError(
              "rate_limited",
              `${this?.name ?? engine.name} rate limit reached`,
              { engine: this?.name ?? engine.name }
            )
          }
          throw new Error(`${this?.name ?? engine.name} rate limit reached`)
        }
        if (data?.url || data?.data?.url) {
          if (context?.engineError) {
            throw context.engineError(
              "captcha",
              `${this?.name ?? engine.name} returned a captcha challenge`,
              { engine: this?.name ?? engine.name }
            )
          }
          throw new Error(
            `${this?.name ?? engine.name} returned a captcha challenge`
          )
        }
        const message = Array.isArray(data?.data?.message)
          ? data.data.message.join(", ")
          : data?.data?.message || data?.message || `error code ${errorCode ?? "unknown"}`
        if (context?.engineError) {
          throw context.engineError(
            "blocked",
            `${this?.name ?? engine.name} API error: ${message}`,
            { engine: this?.name ?? engine.name }
          )
        }
        throw new Error(`${this?.name ?? engine.name} API error: ${message}`)
      }

      if (
        data?.url &&
        typeof data.url === "string" &&
        (data.url.includes("captcha") || data.url.includes("datadome"))
      ) {
        if (context?.engineError) {
          throw context.engineError(
            "captcha",
            `${this?.name ?? engine.name} returned a captcha challenge`,
            { engine: this?.name ?? engine.name }
          )
        }
        throw new Error(
          `${this?.name ?? engine.name} returned a captcha challenge`
        )
      }

      const total =
        data?.data?.result?.total ??
        data?.result?.total ??
        data?.data?.total ??
        data?.total
      if (typeof total === "number" && typeof context?.pagination === "function") {
        context.pagination({ total })
      }

      const resultData =
        data?.data?.result ?? data?.result ?? data?.data ?? data
      const itemsContainer = resultData?.items ?? resultData

      const rawItems: any[] = []
      if (Array.isArray(itemsContainer)) {
        rawItems.push(...itemsContainer)
      } else if (Array.isArray(itemsContainer?.items)) {
        rawItems.push(...itemsContainer.items)
      } else if (Array.isArray(resultData?.items)) {
        rawItems.push(...resultData.items)
      }

      const results: any[] = []

      for (const item of rawItems) {
        if (!item || typeof item !== "object") continue
        const rawUrl = item.url ?? item.link ?? item.media
        if (!rawUrl || typeof rawUrl !== "string" || !rawUrl.startsWith("http")) continue

        const title = cleanText(item.title) || rawUrl
        const mediaUrl = item.media || item.thumbnail || rawUrl
        const rawThumb = item.thumbnail || item.media || undefined
        let thumbnail: string | undefined
        if (typeof rawThumb === "string" && rawThumb.startsWith("http")) {
          const normalizedThumb = rawThumb.replace(
            "https://s2.qwant.com",
            "https://s1.qwant.com"
          )
          thumbnail = context?.signProxyUrl
            ? context.signProxyUrl(normalizedThumb)
            : normalizedThumb
        }
        const isGif =
          item.thumb_type === "gif" ||
          (typeof mediaUrl === "string" && mediaUrl.toLowerCase().includes(".gif")) ||
          false

        results.push({
          title,
          url: rawUrl,
          snippet: cleanText(item.title || item.desc || ""),
          source: this?.name ?? engine.name,
          imageUrl: mediaUrl,
          isGif,
          ...(thumbnail ? { thumbnail } : {}),
        })
      }

      return results
    } catch (e: any) {
      if (e?.name === "SentinelBreach") throw e
      return []
    }
  },
}

export default engine
