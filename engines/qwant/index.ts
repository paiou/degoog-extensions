export const type = "web"

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
  "Qwant web search engine. Note: Qwant uses DataDome bot protection on its web search API. If querying directly from a datacenter IP or server, requests may be challenged (HTTP 403). Use a browser transport (such as lolcat-4play or Camoufox), a proxy, or provide a browser datadome cookie in settings."

let cachedDataDome: string | null = null

export const engine = {
  name: "Qwant",
  bangShortcut: "qwant",
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
    if (!query?.trim()) return []

    const results: Array<{
      title: string
      url: string
      snippet: string
      source: string
      thumbnail?: string
    }> = []

    try {
      const doFetch = context?.fetch ?? fetch
      const count = 10
      const currentSafeSearch = this?.safeSearch ?? engine.safeSearch ?? "moderate"
      const safeSearch = SAFE_SEARCH_MAP[currentSafeSearch] ?? "1"
      const offset = Math.max(0, ((page || 1) - 1) * count)
      const tgp = Math.floor(Math.random() * 3) + 1

      const params = new URLSearchParams({
        q: query,
        count: String(count),
        locale: formatLocale(context?.lang),
        offset: String(offset),
        device: "desktop",
        safesearch: safeSearch,
        tgp: String(tgp),
        displayed: "true",
        llm: "true",
      })

      const url = `https://api.qwant.com/v3/search/web?${params.toString()}`

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

      if (Array.isArray(itemsContainer?.mainline)) {
        for (const block of itemsContainer.mainline) {
          if (!block || typeof block !== "object") continue
          if (block.type === "ads") continue
          if (block.type && block.type !== "web") continue
          if (Array.isArray(block.items)) {
            rawItems.push(...block.items)
          }
        }
      } else if (Array.isArray(itemsContainer)) {
        rawItems.push(...itemsContainer)
      } else if (Array.isArray(resultData?.mainline)) {
        for (const block of resultData.mainline) {
          if (!block || typeof block !== "object") continue
          if (block.type === "ads") continue
          if (block.type && block.type !== "web") continue
          if (Array.isArray(block.items)) {
            rawItems.push(...block.items)
          }
        }
      } else if (Array.isArray(data?.data?.items)) {
        rawItems.push(...data.data.items)
      } else if (Array.isArray(data?.items)) {
        rawItems.push(...data.items)
      }

      for (const item of rawItems) {
        if (!item || typeof item !== "object") continue
        const rawUrl = item.url ?? item.link
        if (!rawUrl || typeof rawUrl !== "string" || !rawUrl.startsWith("http")) continue

        const title = cleanText(item.title) || rawUrl
        const snippet = cleanText(item.desc || item.description || item.snippet)

        let thumbnail: string | undefined
        const rawThumb =
          item.thumbnail ||
          item.media?.[0]?.pict?.url ||
          item.favicon ||
          undefined

        if (typeof rawThumb === "string" && rawThumb.startsWith("http")) {
          const normalizedThumb = rawThumb.replace(
            "https://s2.qwant.com",
            "https://s1.qwant.com"
          )
          thumbnail = context?.signProxyUrl
            ? context.signProxyUrl(normalizedThumb)
            : normalizedThumb
        }

        results.push({
          title,
          url: rawUrl,
          snippet,
          source: this?.name ?? engine.name,
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
