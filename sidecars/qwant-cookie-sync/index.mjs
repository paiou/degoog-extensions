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

    // Intercept DataDome postMessage events sent from challenge iframes to parent window
    await page.evaluateOnNewDocument(() => {
      window.addEventListener("message", (event) => {
        try {
          const data = event.data
          if (data) {
            const str = typeof data === "object" ? JSON.stringify(data) : String(data)
            if (
              str.includes("datadome") ||
              str.includes("cookie") ||
              (event.origin && event.origin.includes("captcha-delivery.com"))
            ) {
              console.log(`__DATADOME_POSTMESSAGE__:${str}`)
            }
          }
        } catch {}
      })
    })

    let observedApiStatus = null
    let searchApiOk = false
    let challengeUrl = null
    let challengeDetected = false
    let interceptedCookie = null

    // Listen for console messages from evaluateOnNewDocument
    page.on("console", (msg) => {
      const text = msg.text()
      if (text.startsWith("__DATADOME_POSTMESSAGE__:")) {
        const raw = text.slice("__DATADOME_POSTMESSAGE__:".length)
        console.log(`[QwantSync] DataDome message event received: ${raw.slice(0, 100)}...`)
        try {
          const parsed = JSON.parse(raw)
          const c = parsed.cookie || parsed.datadome
          if (c) {
            interceptedCookie = cleanDataDomeCookie(c)
            console.log(`[QwantSync] Captured cookie from postMessage: ${maskCookie(interceptedCookie)}`)
          }
        } catch {
          const m = raw.match(/datadome=([^;,\s"]+)/i)
          if (m && m[1]) {
            interceptedCookie = cleanDataDomeCookie(m[1])
            console.log(`[QwantSync] Extracted cookie from postMessage string: ${maskCookie(interceptedCookie)}`)
          }
        }
      }
    })

    // Listen for Qwant search API responses and DataDome check verification responses
    page.on("response", async (res) => {
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
          challengeDetected = true
          console.warn(`[QwantSync] Observed upstream API HTTP 403: ${u.slice(0, 65)}...`)
          try {
            const data = await res.json()
            if (data?.url) {
              challengeUrl = data.url
              console.log(`[QwantSync] Extracted challenge URL from API 403 response: ${challengeUrl.slice(0, 85)}...`)
            }
          } catch {}
        }
      }
      if (u.includes("captcha-delivery.com/captcha/check")) {
        console.log(`[QwantSync] DataDome check endpoint HTTP ${res.status()}: ${u.slice(0, 65)}...`)
        try {
          const data = await res.json()
          if (data?.cookie) {
            interceptedCookie = cleanDataDomeCookie(data.cookie)
            console.log(`[QwantSync] Captured cookie from captcha/check response: ${maskCookie(interceptedCookie)}`)
          }
        } catch {}
      }
    })

    async function simulateMouseMovement(durationMs = 2500) {
      const start = Date.now()
      while (Date.now() - start < durationMs) {
        const x = 200 + Math.floor(Math.random() * 600)
        const y = 150 + Math.floor(Math.random() * 450)
        await page.mouse.move(x, y, { steps: 5 }).catch(() => {})
        await new Promise((r) => setTimeout(r, 200 + Math.random() * 200))
      }
    }

    async function checkInBrowserApi() {
      return await page
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
    }

    // Step 1: Visit Qwant homepage first to establish session and load DataDome scripts naturally
    console.log(`[QwantSync] Loading Qwant homepage to initialize session...`)
    await page.goto("https://www.qwant.com/", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    }).catch(() => {})

    // Simulate short human presence and mouse movement
    await simulateMouseMovement(1500)

    // Step 2: Perform search by typing into the search input with realistic keystroke delays
    console.log(`[QwantSync] Typing search query to simulate user interaction...`)
    const inputSelector = "input[type='search'], input[name='q'], input[data-testid='search-input']"
    const inputFound = await page.waitForSelector(inputSelector, { timeout: 8000 }).catch(() => null)

    if (inputFound) {
      await page.click(inputSelector).catch(() => {})
      await new Promise((r) => setTimeout(r, 200))
      await page.type(inputSelector, "weather", { delay: 65 }).catch(() => {})
      await new Promise((r) => setTimeout(r, 300))
      await page.keyboard.press("Enter").catch(() => {})
    } else {
      console.log(`[QwantSync] Search input not found, navigating directly to ${TARGET_URL}...`)
      await page.goto(TARGET_URL, {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      }).catch(() => {})
    }

    // Step 3: Monitor search response and detect any DataDome challenge
    const detectStart = Date.now()
    while (Date.now() - detectStart < 6000) {
      if (searchApiOk) break
      const iframe = await page.$(
        "iframe[src*='captcha-delivery.com'], #datadome-captcha, iframe[title*='verification'], iframe[title*='captcha']"
      ).catch(() => null)
      if (iframe) {
        challengeDetected = true
        if (!challengeUrl) {
          challengeUrl = await page.evaluate((el) => el.getAttribute("src"), iframe).catch(() => null)
        }
        break
      }
      if (challengeUrl || observedApiStatus === 403) {
        challengeDetected = true
        break
      }
      await new Promise((r) => setTimeout(r, 500))
    }

    // If challenged or not yet authorized, execute resolution sequence
    if (!searchApiOk) {
      console.log(`[QwantSync] DataDome challenge or 403 detected. Initiating resolution sequence...`)

      // Check iframe again if challengeUrl was not caught by response listener
      if (!challengeUrl) {
        const iframe = await page.$(
          "iframe[src*='captcha-delivery.com'], #datadome-captcha, iframe[title*='verification'], iframe[title*='captcha']"
        ).catch(() => null)
        if (iframe) {
          challengeUrl = await page.evaluate((el) => el.getAttribute("src"), iframe).catch(() => null)
        }
      }

      if (challengeUrl) {
        console.log(`[QwantSync] DataDome challenge URL: ${challengeUrl.slice(0, 85)}...`)
      }

      // Phase 1: Wait up to 12s for in-page interstitial iframe to resolve
      console.log(`[QwantSync] Phase 1: Monitoring in-page challenge execution (waiting up to 12s)...`)
      const phase1Start = Date.now()
      while (Date.now() - phase1Start < 12000) {
        await simulateMouseMovement(1500)

        if (interceptedCookie) {
          console.log(`[QwantSync] Intercepted cookie during Phase 1: ${maskCookie(interceptedCookie)}`)
          break
        }

        // Check if page cookies were updated with valid datadome value
        const cookies = await page.cookies("https://www.qwant.com", "https://api.qwant.com")
        const dd = cookies.find((c) => c.name.toLowerCase() === "datadome")
        if (dd && dd.value && !dd.value.includes("~") && dd.value.length >= 60) {
          const test = await checkInBrowserApi()
          if (test.ok) {
            console.log(`[QwantSync] Phase 1: Challenge resolved in-page! API HTTP 200 confirmed.`)
            searchApiOk = true
            break
          }
        }

        if (searchApiOk) break
      }

      // Phase 2: If Phase 1 did not achieve verification, navigate directly to challenge URL top-level
      // (Proven by user testing: DataDome device check interstitial completes automatically when loaded top-level)
      if (!searchApiOk && !interceptedCookie && challengeUrl) {
        console.log(
          `[QwantSync] Phase 2: Resolving DataDome interstitial via direct top-level navigation: ${challengeUrl.slice(0, 85)}...`
        )
        try {
          await page.goto(challengeUrl, {
            waitUntil: "domcontentloaded",
            timeout: 25000,
          })

          const phase2Start = Date.now()
          while (Date.now() - phase2Start < 15000) {
            await simulateMouseMovement(1500)

            if (interceptedCookie) break

            // Check if redirected back to qwant.com
            const currentUrl = page.url()
            if (currentUrl.includes("qwant.com")) {
              console.log(`[QwantSync] Phase 2: Redirected back to Qwant (${currentUrl.slice(0, 60)}...)`)
              break
            }

            // Check cookies on current challenge page
            const cookies = await page.cookies()
            const dd = cookies.find((c) => c.name.toLowerCase() === "datadome")
            if (dd && dd.value && !dd.value.includes("~") && dd.value.length >= 60) {
              console.log(`[QwantSync] Phase 2: Captured valid DataDome cookie: ${maskCookie(dd.value)}`)
              interceptedCookie = dd.value
              break
            }
          }

          // Return to Qwant to finalize session if not already redirected
          if (!page.url().includes("qwant.com")) {
            console.log(`[QwantSync] Returning to Qwant to finalize session...`)
            await page.goto(TARGET_URL, { waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {})
          }
        } catch (p2Err) {
          console.warn(`[QwantSync] Phase 2 navigation warning:`, p2Err.message)
        }
      }
    }

    // If we intercepted a cookie via check or postMessage, ensure it's in the browser's cookie jar
    if (interceptedCookie) {
      await page.setCookie({
        name: "datadome",
        value: interceptedCookie,
        domain: ".qwant.com",
        path: "/",
        secure: true,
        sameSite: "Lax",
      }).catch(() => {})
    }

    // Step 4: Final in-browser API verification test with credentials: "include"
    console.log(`[QwantSync] Running final in-browser test API call to verify DataDome authorization...`)
    const testResult = await checkInBrowserApi()
    console.log(
      `[QwantSync] In-browser API check: status=${testResult.status}, ok=${testResult.ok}, isJson=${testResult.isJson}, observedApiOk=${searchApiOk}`
    )

    const isVerified = (testResult.status === 200 && testResult.isJson) || searchApiOk || Boolean(interceptedCookie)
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

    const cookieVal = datadomeCookie?.value || interceptedCookie
    if (!cookieVal) {
      throw new Error("No DataDome cookie found in verified browser session")
    }

    const actualUa = await page.evaluate(() => navigator.userAgent).catch(() => USER_AGENT)

    latestState = {
      datadome: cookieVal,
      userAgent: actualUa || USER_AGENT,
      updatedAt: Date.now(),
      expiresAt: datadomeCookie?.expires
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
