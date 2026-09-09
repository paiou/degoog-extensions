export const type = "videos"

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

function formatDuration(sec?: number): string | undefined {
  if (!sec || typeof sec !== "number") return undefined
  const totalSec = Math.round(sec > 10000 ? sec / 1000 : sec)
  if (totalSec <= 0) return undefined
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  if (m >= 60) {
    const h = Math.floor(m / 60)
    const remM = m % 60
    return `${h}:${remM.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`
  }
  return `${m}:${s.toString().padStart(2, "0")}`
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
  "Qwant videos search engine. Note: Qwant uses bot protection on its search APIs. 'curl-impersonate' (pre-installed in Degoog) or a browser transport is recommended on residential IPs."

const GLOBAL_COOKIE_KEY = "__degoog_qwant_datadome_cookie"
const GLOBAL_LAST_CONFIGURED_KEY = "__degoog_qwant_last_configured_cookie"
const GLOBAL_UA_KEY = "__degoog_qwant_user_agent"
let cachedDataDome: string | null = null
let lastConfiguredCookie = ""

const DEFAULT_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36"

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

function updateDataDomeCookie(cookie: string | null, reason = "", engineName = "Qwant Videos") {
  if (cookie && cookie.trim()) {
    const clean = cleanDataDomeCookie(cookie)
    cachedDataDome = clean
    ;(globalThis as any)[GLOBAL_COOKIE_KEY] = clean
    console.log(`[${engineName}] DataDome cookie updated [${reason}]: ${maskCookie(clean)}`)
  } else {
    cachedDataDome = null
    delete (globalThis as any)[GLOBAL_COOKIE_KEY]
    console.log(`[${engineName}] DataDome cookie cleared [${reason}]`)
  }
}

function getActiveDataDomeCookie(
  configuredCookie?: string,
  engineName = "Qwant Videos"
): { cookie: string; source: string } {
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
  if (cachedDataDome && cachedDataDome.trim()) {
    return { cookie: cachedDataDome.trim(), source: "local-cache" }
  }
  if (cleanConfigured) {
    return { cookie: cleanConfigured, source: "settings" }
  }
  return { cookie: "", source: "none" }
}

function extractDataDomeCookie(response: any): string | null {
  if (typeof response?.headers?.getSetCookie === "function") {
    const cookies: string[] = response.headers.getSetCookie() || []
    for (const c of cookies) {
      const m = c.match(/datadome=([^;]+)/)
      if (m) return m[1].trim()
    }
  }
  const rawCookie =
    response?.headers?.get?.("set-cookie") ||
    response?.headers?.get?.("x-set-cookie") ||
    ""
  const m = rawCookie.match(/datadome=([^;]+)/)
  return m ? m[1].trim() : null
}

function getEffectiveUserAgent(context?: any, configuredUa?: string): string {
  if (configuredUa && configuredUa.trim()) {
    return configuredUa.trim()
  }
  const globalUa = (globalThis as any)[GLOBAL_UA_KEY]
  if (typeof globalUa === "string" && globalUa.trim()) {
    return globalUa.trim()
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
  name: "Qwant Videos",
  bangShortcut: "qwant-videos",
  safeSearch: "moderate",
  datadomeCookie: "",
  userAgent: "",

  settingsSchema: [
    {
      key: "outgoingTransport",
      label: "Outgoing HTTP client transport",
      type: "select",
      options: ["curl-impersonate", "fetch", "curl", "curl-fallback"],
      default: "curl-impersonate",
      advanced: true,
      description:
        "Select an outgoing transport. 'curl-impersonate' (pre-installed in Degoog) is recommended on residential IPs to match browser TLS fingerprints and bypass DataDome.",
    },
    {
      key: "datadomeCookie",
      label: "DataDome Cookie",
      type: "password",
      description:
        "Optional: datadome cookie from your browser (inspect network requests on qwant.com to copy the datadome cookie value) to bypass challenges without a browser transport.",
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
    }
  ) {
    const engineName = this?.name ?? engine.name
    try {
      const doFetch = context?.fetch ?? fetch
      const safeSearch =
        SAFE_SEARCH_MAP[this?.safeSearch ?? engine.safeSearch] ?? "1"
      const locale = formatLocale(context?.lang)

      const count = 20
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

      const url = `https://api.qwant.com/v3/search/videos?${params.toString()}`

      const configuredCookie = cleanDataDomeCookie(
        context?.settings?.datadomeCookie ??
        (this?.datadomeCookie ?? engine.datadomeCookie)
      )

      const { cookie: activeCookie, source: cookieSource } =
        getActiveDataDomeCookie(configuredCookie, engineName)

      const ua = getEffectiveUserAgent(
        context,
        context?.settings?.userAgent ?? (this?.userAgent ?? engine.userAgent)
      )

      console.log(
        `[${engineName}] Search: "${query}" (page ${page || 1}). ` +
        `Cookie: ${maskCookie(activeCookie)} [source: ${cookieSource}]. ` +
        `UA: "${ua.slice(0, 45)}..."`
      )

      if (activeCookie.startsWith("~")) {
        console.warn(
          `[${engineName}] WARNING: Active cookie starts with '~', indicating an unverified challenge cookie. Request may fail with HTTP 403.`
        )
      }

      const headers: Record<string, string> = {
        Accept: "application/json, text/plain, */*",
        "Accept-Language": context?.buildAcceptLanguage?.() || "en-US,en;q=0.9",
        "User-Agent": ua,
        Referer: "https://www.qwant.com/",
        Origin: "https://www.qwant.com",
        ...(activeCookie ? { Cookie: `datadome=${activeCookie}` } : {}),
      }

      const response = await doFetch(url, { headers })

      const setCookieHeader =
        response.headers.get("set-cookie") ||
        response.headers.get("x-set-cookie") ||
        ""

      console.log(
        `[${engineName}] Upstream response: status=${response.status} ${response.statusText || ""}. ` +
        `x-datadome=${response.headers.get("x-datadome") || "none"}, ` +
        `x-dd-b=${response.headers.get("x-dd-b") || "none"}, ` +
        `set-cookie=${setCookieHeader ? "yes" : "no"}`
      )

      // Update cached datadome cookie if returned by server on successful response
      if (response.ok || response.status < 400) {
        const freshCookie = extractDataDomeCookie(response)
        if (freshCookie) {
          if (freshCookie.startsWith("~")) {
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
          `Active cookie was: ${maskCookie(activeCookie)} [source: ${cookieSource}]. ` +
          `Purging rolling cache.`
        )
        updateDataDomeCookie(null, "challenge-403", engineName)
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
              `${this?.name ?? engine.name} returned a DataDome CAPTCHA challenge. Upstream requests from datacenter/server IPs are blocked by DataDome. To resolve: configure an anti-bot browser transport (such as lolcat-4play or Camoufox), route via a proxy, or provide a datadome cookie in engine settings.`,
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
        const parts: string[] = []
        if (item.desc) parts.push(cleanText(item.desc))
        if (item.channel) parts.push(`Channel: ${cleanText(item.channel)}`)
        if (item.source) parts.push(`Source: ${cleanText(item.source)}`)
        const snippet = parts.join(" • ")

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

        const durationStr = formatDuration(item.duration)

        results.push({
          title,
          url: rawUrl,
          snippet,
          source: item.source
            ? `Qwant (${cleanText(item.source)})`
            : (this?.name ?? engine.name),
          ...(durationStr ? { duration: durationStr } : {}),
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
