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
  "Qwant images search engine. Note: Qwant uses DataDome bot protection on its search APIs. 'curl-impersonate' (pre-installed in Degoog) or a browser transport is recommended on residential IPs."

let cachedDataDome: string | null = null

export const engine = {
  name: "Qwant Images",
  bangShortcut: "qwant-images",
  safeSearch: "moderate",
  datadomeCookie: "",

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
      key: "safeSearch",
      label: "Safe Search",
      type: "select",
      options: ["off", "moderate", "strict"],
      default: "moderate",
      description: "Filter explicit content from search results.",
    },
  ],

  configure(settings: Record<string, any>) {
    if (typeof settings?.safeSearch === "string") {
      this.safeSearch = settings.safeSearch
    }
    if (typeof settings?.datadomeCookie === "string") {
      this.datadomeCookie = settings.datadomeCookie.trim()
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
      userAgent?: () => string
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

      const activeCookie =
        (this?.datadomeCookie ?? engine.datadomeCookie)?.trim() ||
        cachedDataDome

      const headers: Record<string, string> = {
        Accept: "application/json, text/plain, */*",
        "Accept-Language": context?.buildAcceptLanguage?.() || "en-US,en;q=0.9",
        "User-Agent":
          context?.userAgent?.() ||
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
        Referer: "https://www.qwant.com/",
        Origin: "https://www.qwant.com",
        ...(activeCookie ? { Cookie: `datadome=${activeCookie}` } : {}),
      }

      const response = await doFetch(url, { headers })

      // Update cached datadome cookie if returned by server
      const setCookie =
        response.headers.get("set-cookie") ||
        response.headers.get("x-set-cookie") ||
        ""
      const ddMatch = setCookie.match(/datadome=([^;]+)/)
      if (ddMatch) {
        cachedDataDome = ddMatch[1]
      }

      // Check if blocked by DataDome CAPTCHA/interstitial challenge
      if (response.status === 403) {
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
