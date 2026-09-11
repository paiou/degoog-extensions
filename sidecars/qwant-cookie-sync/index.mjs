import http from "node:http"
import fs from "node:fs/promises"
import path from "node:path"
import puppeteerExtra from "puppeteer-extra"
import StealthPlugin from "puppeteer-extra-plugin-stealth"
import puppeteerCore from "puppeteer-core"

const puppeteer = puppeteerExtra.addExtra(puppeteerCore)
puppeteer.use(StealthPlugin())

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
const USER_DATA_DIR = process.env.USER_DATA_DIR || "/data/chromium-profile"

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

function cleanDataDomeCookie(raw) {
  if (!raw || typeof raw !== "string") return ""
  let c = raw.trim()
  if ((c.startsWith('"') && c.endsWith('"')) || (c.startsWith("'") && c.endsWith("'"))) {
    c = c.slice(1, -1).trim()
  }
  if (c.toLowerCase().startsWith("cookie:")) {
    c = c.slice(7).trim()
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

  try {
    await fs.mkdir(USER_DATA_DIR, { recursive: true })
  } catch {}

  const isHeadful =
    Boolean(process.env.DISPLAY) &&
    !["true", "new", "1"].includes((process.env.HEADLESS || "").toLowerCase())

  console.log(
    `[QwantSync] Launching browser (headful: ${isHeadful}, display: ${process.env.DISPLAY || "none"}) using ${executablePath}...`
  )

  const defaultArgs = [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu-sandbox",
    "--disable-blink-features=AutomationControlled",
    "--disable-infobars",
    "--window-size=1920,1080",
    "--start-maximized",
    "--lang=en-US,en",
    "--enable-webgl",
    "--ignore-gpu-blocklist",
  ]

  let browser
  try {
    browser = await puppeteer.launch({
      executablePath,
      headless: isHeadful ? false : "new",
      userDataDir: USER_DATA_DIR,
      ignoreDefaultArgs: ["--enable-automation"],
      args: defaultArgs,
    })
  } catch (launchErr) {
    if (isHeadful) {
      console.warn(
        `[QwantSync] Headful launch failed (${launchErr.message}). Retrying with headless: "new"...`
      )
      browser = await puppeteer.launch({
        executablePath,
        headless: "new",
        userDataDir: USER_DATA_DIR,
        ignoreDefaultArgs: ["--enable-automation"],
        args: defaultArgs,
      })
    } else {
      throw launchErr
    }
  }

  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1920, height: 1080 })

    // Listen for Qwant search API responses
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
          console.log(`[QwantSync] Observed upstream API HTTP 200: ${u.slice(0, 65)}...`)
        } else if (res.status() === 403) {
          console.warn(`[QwantSync] Observed upstream API HTTP 403: ${u.slice(0, 65)}...`)
        }
      }
    })

    // Step 1: Visit Qwant homepage first to establish session and load DataDome scripts naturally
    console.log(`[QwantSync] Loading Qwant homepage to initialize session...`)
    await page.goto("https://www.qwant.com/", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    }).catch(() => {})

    // Wait 2s for DataDome base scripts to load and cookies to establish
    await new Promise((r) => setTimeout(r, 2000))

    // Step 2: Perform search by typing into the search input with realistic keystroke delays
    console.log(`[QwantSync] Typing search query to simulate user interaction...`)
    const inputSelector = "input[type='search'], input[name='q'], input[data-testid='search-input']"
    const inputFound = await page.waitForSelector(inputSelector, { timeout: 8000 }).catch(() => null)

    if (inputFound) {
      await page.click(inputSelector).catch(() => {})
      await new Promise((r) => setTimeout(r, 300))
      await page.type(inputSelector, "weather", { delay: 60 }).catch(() => {})
      await new Promise((r) => setTimeout(r, 400))
      await page.keyboard.press("Enter").catch(() => {})
    } else {
      console.log(`[QwantSync] Search input not found, navigating directly to ${TARGET_URL}...`)
      await page.goto(TARGET_URL, {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      }).catch(() => {})
    }

    // Step 3: Wait up to 12s for search API response
    const waitStart = Date.now()
    while (Date.now() - waitStart < 12000 && !searchApiOk) {
      await new Promise((r) => setTimeout(r, 1000))
    }

    // Step 4: Active in-browser API verification test with credentials: "include"
    console.log(`[QwantSync] Running in-browser test API call to verify DataDome authorization...`)
    const testResult = await page
      .evaluate(async () => {
        try {
          const res = await fetch(
            "https://api.qwant.com/v3/search/web?q=qwant&count=1&locale=en_US&offset=0&device=desktop&safesearch=1&tgp=1&displayed=true&llm=true",
            {
              credentials: "include",
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
      `[QwantSync] In-browser API check: status=${testResult.status}, ok=${testResult.ok}, isJson=${testResult.isJson}, observedApiOk=${searchApiOk}`
    )

    const isVerified = (testResult.status === 200 && testResult.isJson) || searchApiOk
    if (!isVerified) {
      latestState.lastError = `DataDome challenge active (HTTP ${testResult.status || observedApiStatus})`

      // Capture diagnostic information for user inspection
      try {
        const pageTitle = await page.title().catch(() => "")
        console.warn(`[QwantSync] Verification failed. Current page title: "${pageTitle}"`)

        // Check for DataDome captcha iframe
        const captchaFrame = await page.$(
          "iframe[src*='captcha-delivery.com'], #datadome-captcha, iframe[title*='verification'], iframe[title*='captcha']"
        ).catch(() => null)
        if (captchaFrame) {
          const src = await page.evaluate((el) => el.getAttribute("src"), captchaFrame).catch(() => "")
          console.warn(`[QwantSync] DataDome CAPTCHA iframe detected: ${src}`)
        }

        // Save diagnostic snapshot to /data
        const snapDir = path.dirname(USER_DATA_DIR)
        const screenshotPath = path.join(snapDir, "datadome-challenge.png")
        const htmlPath = path.join(snapDir, "datadome-challenge.html")
        await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {})
        const html = await page.content().catch(() => "")
        if (html) {
          await fs.writeFile(htmlPath, html, "utf-8").catch(() => {})
        }
        console.log(`[QwantSync] Diagnostic screenshot saved to ${screenshotPath}`)
      } catch (diagErr) {
        console.warn(`[QwantSync] Failed to capture diagnostic snapshot:`, diagErr.message)
      }

      throw new Error(
        `DataDome blocked browser (HTTP ${testResult.status || observedApiStatus}). Refusing to capture unverified challenge cookie.`
      )
    }

    // Extract verified cookie
    const cookies = await page.cookies("https://www.qwant.com", "https://api.qwant.com")
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

    const actualUa = await page.evaluate(() => navigator.userAgent).catch(() => USER_AGENT)

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
      try {
        await fs.mkdir(path.dirname(COOKIE_FILE), { recursive: true })
        await fs.writeFile(
          COOKIE_FILE,
          JSON.stringify(
            {
              cookie: latestState.datadome,
              datadome: latestState.datadome,
              userAgent: latestState.userAgent,
              updatedAt: latestState.updatedAt,
              expiresAt: latestState.expiresAt,
            },
            null,
            2
          ),
          "utf-8"
        )
        console.log(`[QwantSync] Cookie written to ${COOKIE_FILE}`)
      } catch (err) {
        console.error(`[QwantSync] Failed to write cookie file ${COOKIE_FILE}:`, err.message)
      }
    }

    return latestState
  } finally {
    await browser.close().catch(() => {})
    console.log(`[QwantSync] Headless browser closed to free memory.`)
  }
}

async function refreshCookie() {
  if (isRefreshing) {
    return refreshPromise
  }
  isRefreshing = true
  refreshPromise = (async () => {
    try {
      return await fetchCookieFromBrowser()
    } catch (err) {
      latestState.lastError = err.message
      console.error(`[QwantSync] Error refreshing cookie:`, err.message)
      throw err
    } finally {
      isRefreshing = false
      refreshPromise = null
    }
  })()
  return refreshPromise
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`)
  res.setHeader("Content-Type", "application/json")
  res.setHeader("Access-Control-Allow-Origin", "*")

  if (req.method === "OPTIONS") {
    res.writeHead(204)
    res.end()
    return
  }

  if (url.pathname === "/healthz" || url.pathname === "/health") {
    res.writeHead(200)
    res.end(
      JSON.stringify({
        status: "ok",
        hasCookie: Boolean(latestState.datadome),
        ageSeconds: latestState.updatedAt
          ? Math.round((Date.now() - latestState.updatedAt) / 1000)
          : null,
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

  if ((url.pathname === "/cookie" || url.pathname === "/") && req.method === "POST") {
    let bodyText = ""
    for await (const chunk of req) {
      bodyText += chunk
    }
    try {
      let body = {}
      try {
        body = JSON.parse(bodyText)
      } catch {
        body = { cookie: bodyText }
      }
      const rawCookie = body.cookie || body.datadome || bodyText
      const cookieVal = cleanDataDomeCookie(rawCookie)
      if (!cookieVal) {
        res.writeHead(400)
        res.end(JSON.stringify({ success: false, error: "No valid DataDome cookie provided in body" }))
        return
      }
      const ua = (body.userAgent || body.ua || "").trim() || latestState.userAgent || USER_AGENT
      latestState = {
        datadome: cookieVal,
        userAgent: ua,
        updatedAt: Date.now(),
        expiresAt: Date.now() + 3600 * 1000,
        lastError: null,
      }
      console.log(`[QwantSync] Verified cookie manually injected via POST /cookie: ${maskCookie(cookieVal)}`)
      if (COOKIE_FILE) {
        await fs.writeFile(
          COOKIE_FILE,
          JSON.stringify(latestState, null, 2),
          "utf-8"
        ).catch(() => {})
      }
      res.writeHead(200)
      res.end(
        JSON.stringify({
          success: true,
          hasCookie: true,
          cookie: latestState.datadome,
          datadome: latestState.datadome,
          userAgent: latestState.userAgent,
          updatedAt: latestState.updatedAt,
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
    // If we have no cookie yet, trigger background refresh if not already refreshing (do NOT block!)
    if (!latestState.datadome && !isRefreshing) {
      refreshCookie().catch((err) => {
        console.warn(`[QwantSync] Background refresh error:`, err?.message || err)
      })
    }

    const ageSeconds = latestState.updatedAt
      ? Math.round((Date.now() - latestState.updatedAt) / 1000)
      : null

    res.writeHead(200)
    res.end(
      JSON.stringify({
        success: Boolean(latestState.datadome),
        hasCookie: Boolean(latestState.datadome),
        cookie: latestState.datadome,
        datadome: latestState.datadome,
        userAgent: latestState.userAgent,
        updatedAt: latestState.updatedAt,
        ageSeconds,
        isRefreshing,
        lastError: latestState.lastError,
      })
    )
    return
  }

  res.writeHead(404)
  res.end(JSON.stringify({ error: "Not found" }))
})

async function loadPersistedCookie() {
  const candidates = [
    COOKIE_FILE,
    "/data/cookie.json",
    path.join(path.dirname(USER_DATA_DIR), "cookie.json"),
  ].filter(Boolean)

  for (const p of candidates) {
    try {
      const raw = await fs.readFile(p, "utf-8")
      const parsed = JSON.parse(raw)
      const c = cleanDataDomeCookie(parsed.datadome || parsed.cookie)
      if (c) {
        latestState = {
          datadome: c,
          userAgent: parsed.userAgent || USER_AGENT,
          updatedAt: parsed.updatedAt || Date.now(),
          expiresAt: parsed.expiresAt || Date.now() + 3600 * 1000,
          lastError: null,
        }
        console.log(`[QwantSync] Loaded existing cookie from ${p}: ${maskCookie(c)}`)
        return true
      }
    } catch {}
  }
  return false
}

server.listen(PORT, "0.0.0.0", async () => {
  console.log(`[QwantSync] Sidecar HTTP server listening on http://0.0.0.0:${PORT}`)
  console.log(`[QwantSync] Auto-refresh interval: ${REFRESH_INTERVAL_MINUTES} minutes`)
  if (COOKIE_FILE) {
    console.log(`[QwantSync] Output cookie file: ${COOKIE_FILE}`)
  }

  // Check if a pre-existing cookie file was mounted/supplied
  const loaded = await loadPersistedCookie()
  if (!loaded) {
    // Initial fetch on startup in background if no valid cookie loaded
    refreshCookie().catch(() => {})
  }

  // Set recurring interval
  setInterval(() => {
    console.log(`[QwantSync] Periodic scheduled refresh starting...`)
    refreshCookie().catch(() => {})
  }, REFRESH_INTERVAL_MINUTES * 60 * 1000)
})
