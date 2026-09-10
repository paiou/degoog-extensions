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
      "--window-size=1920,1080",
    ],
  })

  try {
    const page = await browser.newPage()
    await page.setUserAgent(USER_AGENT)
    await page.setViewport({ width: 1920, height: 1080 })

    // Hide navigator.webdriver
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined })
    })

    console.log(`[QwantSync] Navigating to ${TARGET_URL}...`)
    await page.goto(TARGET_URL, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    })

    console.log(`[QwantSync] Waiting for DataDome script and cookie...`)

    let datadomeCookie = null
    const startTime = Date.now()

    while (Date.now() - startTime < 20000) {
      const cookies = await page.cookies("https://www.qwant.com", "https://api.qwant.com")
      const found = cookies.find((c) => c.name.toLowerCase() === "datadome")
      if (found && found.value && !found.value.startsWith("~") && found.value.length > 20) {
        datadomeCookie = found
        break
      }
      // Small delay between checks
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }

    if (!datadomeCookie) {
      // Check document.cookie as fallback
      const docCookie = await page.evaluate(() => document.cookie).catch(() => "")
      const m = docCookie.match(/datadome=([^;]+)/)
      if (m && m[1] && !m[1].startsWith("~") && m[1].length > 20) {
        datadomeCookie = { value: m[1].trim(), expires: Date.now() / 1000 + 3600 }
      }
    }

    if (!datadomeCookie) {
      throw new Error("Timed out waiting for verified DataDome cookie from qwant.com")
    }

    const actualUa = await page.evaluate(() => navigator.userAgent).catch(() => USER_AGENT)

    latestState = {
      datadome: datadomeCookie.value,
      userAgent: actualUa || USER_AGENT,
      updatedAt: Date.now(),
      expiresAt: datadomeCookie.expires ? datadomeCookie.expires * 1000 : Date.now() + 3600 * 1000,
      lastError: null,
    }

    console.log(
      `[QwantSync] Successfully captured verified DataDome cookie: ${maskCookie(latestState.datadome)}`
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
          cookie: refreshed.datadome,
          datadome: refreshed.datadome,
          userAgent: refreshed.userAgent,
          updatedAt: refreshed.updatedAt,
        })
      )
    } catch (err) {
      res.writeHead(500)
      res.end(JSON.stringify({ success: false, error: err.message }))
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

    res.writeHead(latestState.datadome ? 200 : 503)
    res.end(
      JSON.stringify({
        success: Boolean(latestState.datadome),
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
