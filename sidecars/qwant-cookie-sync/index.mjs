import http from "node:http"
import fs from "node:fs/promises"
import path from "node:path"
import puppeteer from "puppeteer-core"

const PORT = parseInt(process.env.PORT || "3005", 10)
const REFRESH_INTERVAL_MINUTES = parseInt(
  process.env.REFRESH_INTERVAL_MINUTES || "25",
  10
)
const COOKIE_FILE = process.env.COOKIE_FILE || ""
const TARGET_URL = process.env.QWANT_URL || "https://www.qwant.com/?q=weather&t=web"
const USER_AGENT =
  process.env.CUSTOM_USER_AGENT ||
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36"

const POSSIBLE_CHROMIUM_PATHS = [
  process.env.PUPPETEER_EXECUTABLE_PATH,
  "/usr/bin/chromium-browser",
  "/usr/bin/chromium",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/google-chrome",
  "/snap/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].filter(Boolean)

async function findChromiumPath() {
  for (const p of POSSIBLE_CHROMIUM_PATHS) {
    try {
      await fs.access(p)
      return p
    } catch {}
  }
  return null
}

let latestState = {
  datadome: "",
  userAgent: USER_AGENT,
  updatedAt: 0,
  expiresAt: 0,
  lastError: null,
}

let isRefreshing = false
let refreshPromise = null

function maskCookie(cookie) {
  if (!cookie) return "none"
  if (cookie.length <= 12) return cookie
  return `${cookie.slice(0, 6)}...${cookie.slice(-6)} (len: ${cookie.length})`
}

async function fetchCookieFromBrowser() {
  const executablePath = await findChromiumPath()
  if (!executablePath) {
    throw new Error(
      `Chromium executable not found. Checked: ${POSSIBLE_CHROMIUM_PATHS.join(", ")}. Set PUPPETEER_EXECUTABLE_PATH environment variable.`
    )
  }

  console.log(`[QwantSync] Launching headless browser using ${executablePath}...`)
  const browser = await puppeteer.launch({
    executablePath,
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-blink-features=AutomationControlled",
      "--disable-infobars",
      "--window-size=1920,1080",
      `--user-agent=${USER_AGENT}`,
      "--lang=en-US,en",
    ],
  })

  try {
    const page = await browser.newPage()
    await page.setUserAgent(USER_AGENT)
    await page.setViewport({ width: 1920, height: 1080 })

    // Stealth evasion injections
    await page.evaluateOnNewDocument(() => {
      // 1. Remove navigator.webdriver
      try {
        Object.defineProperty(navigator, "webdriver", {
          get: () => undefined,
          configurable: true,
        })
        delete navigator.__proto__.webdriver
      } catch {}

      // 2. Mock window.chrome with realistic runtime and app
      try {
        window.chrome = {
          app: {
            isInstalled: false,
            InstallState: {
              DISABLED: "disabled",
              INSTALLED: "installed",
              NOT_INSTALLED: "not_installed",
            },
            RunningState: {
              CANNOT_RUN: "cannot_run",
              READY_TO_RUN: "ready_to_run",
              RUNNING: "running",
            },
          },
          runtime: {
            OnInstalledReason: {
              CHROME_UPDATE: "chrome_update",
              INSTALL: "install",
              SHARED_MODULE_UPDATE: "shared_module_update",
              UPDATE: "update",
            },
            OnRestartRequiredReason: {
              APP_UPDATE: "app_update",
              OS_UPDATE: "os_update",
              PERIODIC: "periodic",
            },
            PlatformArch: {
              ARM: "arm",
              ARM64: "arm64",
              MIPS: "mips",
              MIPS64: "mips64",
              X86_32: "x86-32",
              X86_64: "x86-64",
            },
            PlatformNaclArch: {
              ARM: "arm",
              MIPS: "mips",
              MIPS64: "mips64",
              X86_32: "x86-32",
              X86_64: "x86-64",
            },
            PlatformOs: {
              ANDROID: "android",
              CROS: "cros",
              LINUX: "linux",
              MAC: "mac",
              OPENBSD: "openbsd",
              WIN: "win",
            },
            RequestUpdateCheckStatus: {
              NO_UPDATE: "no_update",
              THROTTLED: "throttled",
              UPDATE_AVAILABLE: "update_available",
            },
          },
          loadTimes: function () {
            return {
              requestTime: performance.timeOrigin / 1000,
              startLoadTime: performance.timeOrigin / 1000,
              commitLoadTime: performance.timeOrigin / 1000 + 0.05,
              finishDocumentLoadTime: performance.timeOrigin / 1000 + 0.1,
              firstPaintTime: performance.timeOrigin / 1000 + 0.12,
              finishLoadTime: performance.timeOrigin / 1000 + 0.2,
              wasFetchedViaSpdy: true,
              wasNpnNegotiated: true,
              npnNegotiatedProtocol: "h2",
              connectionInfo: "h2",
            }
          },
          csi: function () {
            return {
              startE: performance.timeOrigin,
              onloadT: performance.timeOrigin + 200,
              pageT: 250,
              tran: 15,
            }
          },
        }
      } catch {}

      // 3. Mock navigator.plugins & mimeTypes
      try {
        const createPlugin = (name, description, filename, mimes) => {
          const p = {
            name,
            description,
            filename,
            length: mimes.length,
            item: (i) => mimes[i],
            namedItem: (n) => mimes.find((m) => m.type === n) || null,
            [Symbol.iterator]: function* () {
              for (const m of mimes) yield m
            },
          }
          mimes.forEach((m, idx) => {
            p[idx] = m
          })
          return p
        }
        const pdfMime = {
          type: "application/pdf",
          suffixes: "pdf",
          description: "Portable Document Format",
          enabledPlugin: null,
        }
        const pdfPlugin = createPlugin(
          "Chrome PDF Viewer",
          "Portable Document Format",
          "internal-pdf-viewer",
          [pdfMime]
        )
        pdfMime.enabledPlugin = pdfPlugin

        Object.defineProperty(navigator, "plugins", {
          get: () => [pdfPlugin],
          configurable: true,
        })
        Object.defineProperty(navigator, "mimeTypes", {
          get: () => [pdfMime],
          configurable: true,
        })
      } catch {}

      // 4. Mock navigator.languages
      try {
        Object.defineProperty(navigator, "languages", {
          get: () => ["en-US", "en"],
          configurable: true,
        })
      } catch {}

      // 5. Mock WebGL vendor & renderer (avoid SwiftShader / llvmpipe bot signals)
      try {
        const getParameter = WebGLRenderingContext.prototype.getParameter
        WebGLRenderingContext.prototype.getParameter = function (parameter) {
          if (parameter === 37445) return "Google Inc. (Intel)"
          if (parameter === 37446)
            return "ANGLE (Intel, Intel(R) Iris(TM) Plus Graphics 640, OpenGL 4.1)"
          return getParameter.apply(this, arguments)
        }
        if (typeof WebGL2RenderingContext !== "undefined") {
          const getParameter2 = WebGL2RenderingContext.prototype.getParameter
          WebGL2RenderingContext.prototype.getParameter = function (parameter) {
            if (parameter === 37445) return "Google Inc. (Intel)"
            if (parameter === 37446)
              return "ANGLE (Intel, Intel(R) Iris(TM) Plus Graphics 640, OpenGL 4.1)"
            return getParameter2.apply(this, arguments)
          }
        }
      } catch {}

      // 6. Mock Notification permissions
      try {
        if (navigator.permissions && navigator.permissions.query) {
          const origQuery = navigator.permissions.query
          navigator.permissions.query = function (parameters) {
            if (parameters && parameters.name === "notifications") {
              return Promise.resolve({
                state: Notification.permission || "default",
                onchange: null,
              })
            }
            return origQuery.apply(this, arguments)
          }
        }
      } catch {}
    })

    // Listen for Qwant API responses
    let observedApiStatus = null
    let searchApiOk = false

    page.on("response", (res) => {
      const u = res.url()
      if (
        u.includes("api.qwant.com/v3/search") ||
        u.includes("api.qwant.com/api/search")
      ) {
        observedApiStatus = res.status()
        if (res.status() === 200) {
          searchApiOk = true
          console.log(
            `[QwantSync] Observed upstream API HTTP 200: ${u.slice(0, 65)}...`
          )
        } else if (res.status() === 403) {
          console.warn(
            `[QwantSync] Observed upstream API HTTP 403: ${u.slice(0, 65)}...`
          )
        }
      }
    })

    console.log(`[QwantSync] Navigating to ${TARGET_URL}...`)
    await page
      .goto(TARGET_URL, {
        waitUntil: "networkidle2",
        timeout: 30000,
      })
      .catch(() => {
        // networkidle2 might timeout if long-polling or analytics keep running; proceed to check
      })

    // Wait up to 10s for API response if not already seen
    const waitStart = Date.now()
    while (Date.now() - waitStart < 10000 && !searchApiOk) {
      if (observedApiStatus === 403) break
      await new Promise((r) => setTimeout(r, 1000))
    }

    // Active in-browser verification test
    console.log(
      `[QwantSync] Running in-browser test API call to verify DataDome authorization...`
    )
    const testResult = await page
      .evaluate(async () => {
        try {
          const res = await fetch(
            "https://api.qwant.com/v3/search/web?q=qwant&count=1&locale=en_US&offset=0&device=desktop&safesearch=1&tgp=1&displayed=true&llm=true",
            {
              headers: {
                Accept: "application/json, text/plain, */*",
                Referer: "https://www.qwant.com/",
                Origin: "https://www.qwant.com",
              },
            }
          )
          const text = await res.text().catch(() => "")
          return {
            status: res.status,
            ok: res.ok,
            isJson: text.trim().startsWith("{"),
          }
        } catch (err) {
          return { status: 0, ok: false, error: String(err) }
        }
      })
      .catch((err) => ({ status: 0, ok: false, error: err.message }))

    console.log(
      `[QwantSync] In-browser API check: status=${testResult.status}, ok=${testResult.ok}, isJson=${testResult.isJson}`
    )

    if (testResult.status !== 200 || !testResult.isJson) {
      latestState.lastError = `DataDome challenge active (HTTP ${testResult.status})`
      throw new Error(
        `DataDome blocked browser (HTTP ${testResult.status}). Refusing to capture unverified challenge cookie.`
      )
    }

    // Only when the test call returned 200 JSON do we capture the cookie!
    const cookies = await page.cookies(
      "https://www.qwant.com",
      "https://api.qwant.com"
    )
    let datadomeCookie = cookies.find((c) => c.name.toLowerCase() === "datadome")

    if (!datadomeCookie) {
      const docCookie = await page.evaluate(() => document.cookie).catch(() => "")
      const m = docCookie.match(/datadome=([^;]+)/)
      if (m && m[1]) {
        datadomeCookie = { value: m[1].trim(), expires: Date.now() / 1000 + 3600 }
      }
    }

    if (!datadomeCookie || !datadomeCookie.value) {
      throw new Error("No DataDome cookie found in verified browser session")
    }

    const actualUa = await page
      .evaluate(() => navigator.userAgent)
      .catch(() => USER_AGENT)

    latestState = {
      datadome: datadomeCookie.value,
      userAgent: actualUa || USER_AGENT,
      updatedAt: Date.now(),
      expiresAt: datadomeCookie.expires
        ? datadomeCookie.expires * 1000
        : Date.now() + 3600 * 1000,
      lastError: null,
    }

    console.log(
      `[QwantSync] Successfully captured verified DataDome cookie: ${maskCookie(
        latestState.datadome
      )}`
    )

    if (COOKIE_FILE) {
      await writeCookieFile(COOKIE_FILE, latestState)
    }

    return latestState
  } finally {
    await browser.close().catch(() => {})
    console.log(`[QwantSync] Headless browser closed to free memory.`)
  }
}

async function writeCookieFile(filePath, state) {
  try {
    const dir = path.dirname(filePath)
    if (dir && dir !== ".") {
      await fs.mkdir(dir, { recursive: true })
    }
    const tempFile = `${filePath}.tmp.${Date.now()}`
    const payload = JSON.stringify(
      {
        datadome: state.datadome,
        cookie: state.datadome,
        userAgent: state.userAgent,
        updatedAt: state.updatedAt,
        expiresAt: state.expiresAt,
      },
      null,
      2
    )
    await fs.writeFile(tempFile, payload, "utf-8")
    await fs.rename(tempFile, filePath)
    console.log(`[QwantSync] Cookie written to file: ${filePath}`)
  } catch (err) {
    console.error(`[QwantSync] Failed to write cookie file ${filePath}:`, err.message)
  }
}

async function refreshCookie() {
  if (isRefreshing) {
    return refreshPromise
  }
  isRefreshing = true
  refreshPromise = fetchCookieFromBrowser()
    .catch((err) => {
      console.error(`[QwantSync] Error refreshing cookie:`, err.message)
      latestState.lastError = err.message
      throw err
    })
    .finally(() => {
      isRefreshing = false
      refreshPromise = null
    })
  return refreshPromise
}

// Check for --once CLI argument
if (process.argv.includes("--once")) {
  console.log(`[QwantSync] Running one-shot cookie retrieval...`)
  try {
    const result = await refreshCookie()
    console.log(`DATADOME_COOKIE=${result.datadome}`)
    console.log(`USER_AGENT=${result.userAgent}`)
    process.exit(0)
  } catch (err) {
    console.error(`[QwantSync] One-shot retrieval failed:`, err.message)
    process.exit(1)
  }
}

// Start HTTP Server
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`)

  res.setHeader("Content-Type", "application/json")
  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "Content-Type")

  if (req.method === "OPTIONS") {
    res.writeHead(204)
    res.end()
    return
  }

  if (url.pathname === "/health") {
    res.writeHead(200)
    res.end(
      JSON.stringify({
        status: "ok",
        hasCookie: Boolean(latestState.datadome),
        updatedAt: latestState.updatedAt,
        lastError: latestState.lastError,
      })
    )
    return
  }

  if (url.pathname === "/refresh" && req.method === "POST") {
    console.log(`[QwantSync] Immediate refresh requested via POST /refresh`)
    try {
      const refreshed = await refreshCookie()
      res.writeHead(200)
      res.end(
        JSON.stringify({
          success: true,
          hasCookie: true,
          cookie: refreshed.datadome,
          datadome: refreshed.datadome,
          userAgent: refreshed.userAgent,
          updatedAt: refreshed.updatedAt,
        })
      )
    } catch (err) {
      res.writeHead(200)
      res.end(
        JSON.stringify({
          success: false,
          hasCookie: false,
          cookie: "",
          datadome: "",
          error: err.message,
        })
      )
    }
    return
  }

  if (url.pathname === "/raw") {
    res.setHeader("Content-Type", "text/plain")
    res.writeHead(200)
    res.end(latestState.datadome || "")
    return
  }

  if (url.pathname === "/" || url.pathname === "/cookie") {
    // If we have no cookie yet, attempt initial fetch
    if (!latestState.datadome && !isRefreshing) {
      try {
        await refreshCookie()
      } catch {}
    }

    const ageSeconds = latestState.updatedAt
      ? Math.round((Date.now() - latestState.updatedAt) / 1000)
      : null

    res.writeHead(latestState.datadome ? 200 : 200)
    res.end(
      JSON.stringify({
        success: Boolean(latestState.datadome),
        hasCookie: Boolean(latestState.datadome),
        cookie: latestState.datadome,
        datadome: latestState.datadome,
        userAgent: latestState.userAgent,
        updatedAt: latestState.updatedAt,
        ageSeconds,
        lastError: latestState.lastError,
      })
    )
    return
  }

  res.writeHead(404)
  res.end(JSON.stringify({ error: "Not found" }))
})

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[QwantSync] Sidecar HTTP server listening on http://0.0.0.0:${PORT}`)
  console.log(`[QwantSync] Auto-refresh interval: ${REFRESH_INTERVAL_MINUTES} minutes`)
  if (COOKIE_FILE) {
    console.log(`[QwantSync] Output cookie file: ${COOKIE_FILE}`)
  }

  // Initial fetch on startup
  refreshCookie().catch(() => {})

  // Set recurring interval
  setInterval(() => {
    console.log(`[QwantSync] Periodic scheduled refresh starting...`)
    refreshCookie().catch(() => {})
  }, REFRESH_INTERVAL_MINUTES * 60 * 1000)
})
