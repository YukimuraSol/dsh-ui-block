// 开发与验收用，不是产品路径。
/**
 * tools/open-page.mjs — 验收/开发时用的开页工具，命令行化。
 *
 * 产品工具表里没有「打开页面」这一步：页面得先在一个装了 dsh-page-capture 的浏览器里
 * 开着，有没有、要不要自己配一台，由 agent 自己判断。这个脚本只是让人在验收时把那个
 * 前置条件一次摆好：起一个无头 Chrome，用 CDP 把打包的扩展装进去（Chrome 156 起
 * --load-extension 已停用，只能走 Extensions.loadUnpacked），把扩展指向本机某个 DSH
 * 实例，打开一个网址，钉住视口与配色，最后交回 { instance, tabId }。
 *
 *   node tools/open-page.mjs --url https://example.com --name demo
 *   node tools/open-page.mjs --url https://example.com --name demo --instance-port 4000 \
 *        --width 1440 --height 900 --color-scheme light --wait-ms 30000
 *   node tools/open-page.mjs --close --name demo     # 关掉这一个
 *   node tools/open-page.mjs --close                 # 关掉本脚本开过的全部
 *
 * 无第三方依赖。成功时先打一行 JSON（instance / tabId / url / title / pid / debugPort），
 * 然后进程**留在原地**：视口与配色的覆盖属于 CDP 会话，会话一关页面就回落到无头默认的
 * ~800x600 与系统配色，capture_page 抓到的就不再是钉住的那一版。收工用 --close。
 * 失败时自清：杀掉自己起的浏览器、删掉临时 profile，退出码 1。
 *
 * 两条边界（代码里也做不到）：不碰 cookie、不读用户自己的浏览器配置，每次都用一个
 * 全新的临时 profile；需要登录态的页面请用户在他自己的浏览器里打开。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const TAG = 'open-page'
const HERE = dirname(fileURLToPath(import.meta.url))
const STATE_DIR = join(tmpdir(), 'dsh-open-page')

/** Chrome first: Edge ships the same CDP surface, but the extension path below was measured on Chrome 156. */
const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
]
const BROWSER_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ...EDGE_CANDIDATES
].filter((candidate) => candidate !== undefined && candidate !== '')
const DEFAULT_WAIT_MS = 15000
const MIN_WAIT_MS = 1000
const MAX_WAIT_MS = 120000
const DEFAULT_VIEWPORT = { width: 1440, height: 900 }
const COLOR_SCHEMES = ['light', 'dark', 'no-preference']
const DEFAULT_COLOR_SCHEME = 'light'
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/** --key value / --key=value / --flag (true). */
function argValue(names, commandLine) {
  const flat = Array.isArray(names) ? names : [names]
  for (const name of flat) {
    for (let index = 0; index < commandLine.length; index += 1) {
      const item = commandLine[index]
      if (item === '--' + name) {
        const next = commandLine[index + 1]
        return next === undefined || next.startsWith('--') ? true : next
      }
      if (item.startsWith('--' + name + '=')) return item.slice(name.length + 3)
    }
  }
  return undefined
}

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms))
}

/** One WebSocket CDP session: one JSON message per call, errors rejected. */
async function cdpConnect(wsUrl) {
  const socket = new WebSocket(wsUrl)
  await new Promise((done, fail) => { socket.addEventListener('open', done); socket.addEventListener('error', fail) })
  let nextId = 0
  const pending = new Map()
  socket.addEventListener('message', (event) => {
    let message
    try { message = JSON.parse(String(event.data)) } catch { return }
    const settle = pending.get(message.id)
    if (settle === undefined) return
    pending.delete(message.id)
    settle(message)
  })
  const send = (method, params) => new Promise((resolveCall, reject) => {
    const id = ++nextId
    pending.set(id, (message) => {
      if (message.error !== undefined) reject(new Error(method + ': ' + String(message.error.message === undefined ? message.error : message.error.message)))
      else resolveCall(message.result === undefined ? {} : message.result)
    })
    socket.send(JSON.stringify({ id, method, params: params === undefined ? {} : params }))
  })
  return {
    send,
    close: () => { try { socket.close() } catch { /* already closed */ } },
    onClose: (fn) => { socket.addEventListener('close', fn) }
  }
}

/** Evaluate in one page target and return the by-value result, exceptions included. */
async function evaluateInPage(session, expression) {
  const result = await session.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails !== undefined) {
    throw new Error('page threw: ' + String(result.exceptionDetails.text === undefined ? '' : result.exceptionDetails.text)
      + ' ' + String(result.exceptionDetails.exception === undefined || result.exceptionDetails.exception.description === undefined ? '' : result.exceptionDetails.exception.description))
  }
  return result.result === undefined ? undefined : result.result.value
}

/** Retry an async condition until it is true, or fail with what was last seen. */
async function until(condition, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs
  let last = 'never tried'
  while (Date.now() < deadline) {
    try {
      if (await condition()) return
    } catch (error) {
      last = String(error && error.message === undefined ? error : error.message)
    }
    await sleep(100)
  }
  throw new Error(TAG + ': timed out waiting for ' + what + ' (' + last + ')')
}

/** A loopback port nothing is listening on right now. */
function freeTcpPort() {
  return new Promise((done, fail) => {
    const server = createServer()
    server.once('error', fail)
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      server.close(() => done(port))
    })
  })
}

/** The browser to drive, or a list of the paths that were looked at. */
function browserPath() {
  for (const candidate of BROWSER_CANDIDATES) if (existsSync(candidate)) return candidate
  throw new Error(TAG + ': no Chrome or Edge found. Looked at: ' + BROWSER_CANDIDATES.join(', ') + ' — set CHROME_PATH to the executable.')
}

/** One new tab at URL; /json/new only accepts PUT on a modern Chrome. */
async function openBrowserTab(port, url) {
  let last = ''
  for (const method of ['PUT', 'GET']) {
    try {
      const res = await fetch('http://127.0.0.1:' + String(port) + '/json/new?' + url, { method, cache: 'no-store' })
      if (!res.ok) { last = 'HTTP ' + String(res.status); continue }
      return await res.json()
    } catch (error) {
      last = String(error && error.message === undefined ? error : error.message)
    }
  }
  throw new Error('could not open a tab at ' + url + ' (' + last + ')')
}

/**
 * Wait for a tab whose URL contains needle, and hand back the target as /json/list
 * sees it NOW: /json/new answers before the navigation commits, and its
 * webSocketDebuggerUrl dies with the old document.
 */
async function waitForBrowserTarget(port, needle, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let last = 'no answer from /json/list'
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch('http://127.0.0.1:' + String(port) + '/json/list', { cache: 'no-store' })).json()
      const hit = (Array.isArray(list) ? list : []).find((target) => target.type === 'page'
        && typeof target.webSocketDebuggerUrl === 'string' && String(target.url).includes(needle))
      if (hit !== undefined) return hit
      last = 'no page target whose URL contains ' + needle
    } catch (error) {
      last = String(error && error.message === undefined ? error : error.message)
    }
    await sleep(200)
  }
  throw new Error(TAG + ': the tab ' + needle + ' never appeared in the browser (' + last + ')')
}

/** The one http(s) page target in the throwaway browser (not the options page, not about:blank). */
async function waitForHttpPageTarget(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let last = 'no answer from /json/list'
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch('http://127.0.0.1:' + String(port) + '/json/list', { cache: 'no-store' })).json()
      const hit = (Array.isArray(list) ? list : []).find((target) => target.type === 'page'
        && typeof target.webSocketDebuggerUrl === 'string' && /^https?:/i.test(String(target.url)))
      if (hit !== undefined) return hit
      last = 'no http(s) page target yet'
    } catch (error) {
      last = String(error && error.message === undefined ? error : error.message)
    }
    await sleep(100)
  }
  throw new Error(TAG + ': no http(s) page target appeared in the browser (' + last + ')')
}

/**
 * Pin the viewport and the color scheme for as long as the browser lives, then
 * reload so the page lays out at that size from its first frame instead of
 * adapting to the ~800x600 it was opened at.
 *
 * The overrides belong to the CDP SESSION, not to the browser: this is why the
 * script stays resident after printing its answer (see the header).
 */
async function applyEmulation(record, viewport, colorScheme) {
  const target = await waitForHttpPageTarget(record.port, 15000)
  const session = await cdpConnect(target.webSocketDebuggerUrl)
  record.session = session
  await session.send('Emulation.setDeviceMetricsOverride', { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: false })
  await session.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: colorScheme }] })
  await session.send('Page.reload', { ignoreCache: false })
  // The evaluate can still land in the OLD document, so the navigation type is
  // part of the condition: 'reload' only holds once the new document is live.
  try {
    await until(async () => {
      try {
        return (await evaluateInPage(session, "document.readyState === 'complete' && ((performance.getEntriesByType('navigation')[0] || {}).type === 'reload')")) === true
      } catch { return false }
    }, 20000, 'the page to reload at the pinned viewport')
  } catch { /* a slow page still gets waited for by the report loop below */ }
}

/** Delete a throwaway profile, retrying while Chrome still holds a handle on it. */
async function removeProfileDir(profile) {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    try { await rm(profile, { recursive: true, force: true }); return } catch { await sleep(100) }
  }
}

/** http(s) only: a chrome:// or file:// URL is not something capture_page can extract. */
function pageUrl(value) {
  const text = String(value === undefined || value === null ? '' : value).trim()
  if (text === '') throw new Error(TAG + ': --url is required, e.g. --url https://example.com')
  let parsed
  try { parsed = new URL(text) } catch { throw new Error(TAG + ': --url is not a URL: ' + JSON.stringify(value)) }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(TAG + ': --url must be http or https, got ' + parsed.protocol + ' — a browser-internal or file page has no DOM the capture extension can extract')
  }
  return parsed.toString()
}

/** One instance name: safe to key a state file by and to store in the extension. */
function pageName(value) {
  const text = value === undefined || value === null ? '' : String(value).trim()
  if (text === '') return 'open-' + randomBytes(3).toString('hex')
  if (!NAME_RE.test(text) || text.includes('..')) {
    throw new Error(TAG + ': --name must be 1-64 chars of [A-Za-z0-9._-], starting with a letter or digit, got ' + JSON.stringify(value))
  }
  return text
}

function waitMsOf(value) {
  if (value === undefined || value === null || value === true) return DEFAULT_WAIT_MS
  const ms = Number(value)
  if (!Number.isFinite(ms) || ms <= 0) throw new Error(TAG + ': --wait-ms must be a positive number of milliseconds, got ' + JSON.stringify(value))
  return Math.min(Math.max(Math.round(ms), MIN_WAIT_MS), MAX_WAIT_MS)
}

function pixelsOf(value, fallback, key) {
  if (value === undefined || value === null || value === '' || value === true) return fallback
  const px = Number(value)
  if (!Number.isFinite(px)) throw new Error(TAG + ': --' + key + ' must be a number of CSS pixels, got ' + JSON.stringify(value))
  return Math.min(Math.max(Math.round(px), 240), 10000)
}

function colorSchemeOf(value) {
  if (value === undefined || value === null || value === true || String(value).trim() === '') return DEFAULT_COLOR_SCHEME
  const scheme = String(value).trim()
  if (!COLOR_SCHEMES.includes(scheme)) throw new Error(TAG + ': --color-scheme must be one of ' + COLOR_SCHEMES.join(', ') + ', got ' + JSON.stringify(value))
  return scheme
}

/** URL normalization for tab matching: the extension reports the final URL. */
function normalizedHref(raw) {
  try {
    const url = new URL(String(raw === undefined || raw === null ? '' : raw))
    url.hash = ''
    return url.href
  } catch {
    return String(raw === undefined || raw === null ? '' : raw)
  }
}

/**
 * The tab this run opened: exact URL first, then the same host on a deeper path
 * (a redirect), then the only http(s) tab.
 */
function matchOpenedTab(tabs, wanted) {
  const want = normalizedHref(wanted)
  const exact = tabs.find((tab) => normalizedHref(tab.url) === want)
  if (exact !== undefined) return exact
  let parsed
  try { parsed = new URL(want) } catch { parsed = null }
  if (parsed !== null) {
    const cut = parsed.pathname === '/' ? '/' : (parsed.pathname.endsWith('/') ? parsed.pathname : parsed.pathname + '/')
    const prefix = tabs.find((tab) => {
      try {
        const seen = new URL(String(tab.url))
        return seen.host === parsed.host && (seen.pathname === parsed.pathname || seen.pathname.startsWith(cut))
      } catch { return false }
    })
    if (prefix !== undefined) return prefix
  }
  const http = tabs.filter((tab) => /^https?:/i.test(String(tab.url)))
  return http.length === 1 ? http[0] : undefined
}

/** Every tab the extension can see, as { tabId, url, title } — asked IN the extension. */
async function tabsFromExtension(session) {
  const asked = await evaluateInPage(session, 'chrome.tabs.query({}).then(function (tabs) { return tabs.map(function (tab) { return { tabId: tab.id, url: String(tab.url || ""), title: String(tab.title || "") } }) })')
  return Array.isArray(asked) ? asked : []
}

/** The resident browser this process is holding, and how to let go of it. */
let residentChild
let keeper

function stateFile(name) {
  return join(STATE_DIR, name + '.json')
}

function writeState(record) {
  mkdirSync(STATE_DIR, { recursive: true })
  writeFileSync(stateFile(record.instance), JSON.stringify({
    instance: record.instance,
    pid: record.child.pid,
    chrome: record.chrome,
    debugPort: record.port,
    profile: record.profile,
    url: record.url,
    tabId: record.tabId,
    startedAt: record.startedAt
  }, null, 2))
}

function readStates() {
  if (!existsSync(STATE_DIR)) return []
  const out = []
  for (const entry of readdirSync(STATE_DIR)) {
    if (!entry.endsWith('.json')) continue
    try { out.push({ file: join(STATE_DIR, entry), record: JSON.parse(readFileSync(join(STATE_DIR, entry), 'utf8')) }) } catch { /* a torn file is not a record */ }
  }
  return out
}

/** Close the browsers a previous run kept, or just one of them. @returns the instance names closed. */
async function closeOpen(name) {
  const wanted = name === undefined || name === null || String(name).trim() === '' ? null : String(name).trim()
  const closed = []
  for (const entry of readStates()) {
    if (wanted !== null && entry.record.instance !== wanted) continue
    try { process.kill(Number(entry.record.pid)) } catch { /* already gone */ }
    if (typeof entry.record.profile === 'string' && entry.record.profile !== '') await removeProfileDir(entry.record.profile)
    try { rmSync(entry.file, { force: true }) } catch { /* gone */ }
    closed.push(String(entry.record.instance))
  }
  return closed
}

/** Poll the instance's own info route until this instance reports the tab. */
async function waitForReport(instancePort, name, notBefore, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let last = 'no answer from /ui-block-extension/info'
  while (Date.now() < deadline) {
    try {
      const res = await fetch('http://127.0.0.1:' + String(instancePort) + '/ui-block-extension/info', { cache: 'no-store' })
      const body = await res.json()
      const agents = Array.isArray(body.agents) ? body.agents : []
      const mine = agents.find((agent) => String(agent.instance) === name)
      if (mine !== undefined && Number(mine.tabs) > 0 && Date.parse(String(mine.lastSeenAt)) >= notBefore) {
        return { tabs: Number(mine.tabs), lastSeenAt: String(mine.lastSeenAt) }
      }
      last = mine === undefined ? 'the instance has not reported yet' : 'the last report was ' + String(mine.lastSeenAt) + ' (' + String(mine.tabs) + ' tab(s))'
    } catch (error) {
      last = String(error && error.message === undefined ? error : error.message)
    }
    await sleep(300)
  }
  throw new Error(TAG + ': the extension never reported instance "' + name + '" to http://127.0.0.1:' + String(instancePort) + ' within ' + String(Math.round(timeoutMs / 1000)) + 's (' + last + ').')
}

/**
 * Start a browser with the capture extension, point it at one instance, open one
 * page, pin viewport + color scheme, and hand back { instance, tabId }.
 */
async function launch(options) {
  const url = pageUrl(options.url)
  const name = pageName(options.name)
  const waitMs = waitMsOf(options.waitMs)
  const viewport = { width: pixelsOf(options.width, DEFAULT_VIEWPORT.width, 'width'), height: pixelsOf(options.height, DEFAULT_VIEWPORT.height, 'height') }
  const colorScheme = colorSchemeOf(options.colorScheme)
  const captureDir = resolve(String(options.captureDir === undefined || options.captureDir === true ? join(HERE, '..', 'extension-capture') : options.captureDir))
  if (!existsSync(join(captureDir, 'manifest.json'))) {
    throw new Error(TAG + ': the capture extension is missing: ' + captureDir + ' has no manifest.json. Point --capture-dir at the extension-capture folder.')
  }
  const instancePort = Number(options.instancePort === undefined ? 4000 : options.instancePort)
  if (!Number.isFinite(instancePort) || instancePort <= 0) throw new Error(TAG + ': --instance-port must be the HTTP port of a running DSH instance, got ' + JSON.stringify(options.instancePort))
  const token = options.token === undefined || options.token === true ? '' : String(options.token)
  const chrome = options.chrome === undefined || options.chrome === true || String(options.chrome).trim() === '' ? browserPath() : resolve(String(options.chrome))
  if (!existsSync(chrome)) throw new Error(TAG + ': --chrome points at a file that is not there: ' + chrome)
  // One browser per name: a second one would report the same instance and they
  // would overwrite each other's tab list.
  if (readStates().some((entry) => entry.record.instance === name)) await closeOpen(name)
  const port = await freeTcpPort()
  const profile = join(tmpdir(), 'dsh-open-page-' + randomBytes(6).toString('hex'))
  const child = spawn(chrome, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--user-data-dir=' + profile,
    '--remote-debugging-port=' + String(port),
    // Chrome 156: --load-extension is gone; these two are what let CDP load it.
    '--enable-unsafe-extension-debugging',
    '--remote-allow-origins=*',
    'about:blank'
  ], { stdio: 'ignore', windowsHide: true })
  const record = { child, chrome, port, profile, extensionId: '', name, instance: name, url, tabId: undefined, viewport, colorScheme, session: undefined, startedAt: Date.now() }
  child.once('exit', () => { removeProfileDir(profile).catch(() => {}) })
  try {
    await until(async () => (await fetch('http://127.0.0.1:' + String(port) + '/json/version')).ok, 20000, 'the headless browser to answer /json/version')
    const version = await (await fetch('http://127.0.0.1:' + String(port) + '/json/version')).json()
    if (typeof version.webSocketDebuggerUrl !== 'string') throw new Error('the browser gave no webSocketDebuggerUrl')
    const browser = await cdpConnect(version.webSocketDebuggerUrl)
    let loaded
    try { loaded = await browser.send('Extensions.loadUnpacked', { path: captureDir }) } finally { browser.close() }
    const extensionId = String(loaded.id === undefined ? '' : loaded.id)
    if (extensionId === '') throw new Error('Extensions.loadUnpacked returned no extension id')
    record.extensionId = extensionId
    // The options page is the extension's own surface: writing storage from it
    // is the same thing the page does for ?baseURL=, only with the instance too.
    await openBrowserTab(port, 'chrome-extension://' + extensionId + '/options.html')
    const optionsTab = await waitForBrowserTarget(port, 'options.html', 8000)
    const session = await cdpConnect(optionsTab.webSocketDebuggerUrl)
    const wanted = {
      baseUrl: 'http://127.0.0.1:' + String(instancePort),
      instance: name,
      enabled: true,
      ...token === '' ? {} : { token }
    }
    try {
      // The target's URL updates a beat before its document is live, so the
      // extension APIs can still be missing on the first evaluate.
      await until(async () => {
        try { return (await evaluateInPage(session, 'typeof chrome !== "undefined" && !!(chrome.storage && chrome.storage.local)')) === true } catch { return false }
      }, 8000, 'the extension APIs in the options page')
      await until(async () => {
        try { await evaluateInPage(session, 'chrome.storage.local.set(' + JSON.stringify(wanted) + ').then(function () { return 1 })'); return true } catch { return false }
      }, 8000, 'the options page to accept the baseUrl + instance')
      await until(async () => {
        const back = await evaluateInPage(session, 'chrome.storage.local.get({ baseUrl: "", instance: "", enabled: true }).then(function (v) { return JSON.stringify(v) })')
        let stored
        try { stored = JSON.parse(String(back)) } catch { stored = {} }
        return stored.baseUrl === wanted.baseUrl && stored.instance === name && stored.enabled === true
      }, 8000, 'the extension options page to store baseUrl + instance')
    } catch (error) {
      throw new Error(TAG + ': the extension never became usable in the browser it opened (' + String(error && error.message === undefined ? error : error.message)
        + '). Extension directory: ' + captureDir + '. Browser pid: ' + String(child.pid) + '.')
    }
    await openBrowserTab(port, url)
    // The launch argument leaves one about:blank tab behind. Close it BEFORE
    // waiting, so the instance's list has exactly one row for this browser.
    try {
      const list = await (await fetch('http://127.0.0.1:' + String(port) + '/json/list', { cache: 'no-store' })).json()
      for (const target of Array.isArray(list) ? list : []) {
        if (target.type === 'page' && String(target.url) === 'about:blank') {
          await fetch('http://127.0.0.1:' + String(port) + '/json/close/' + String(target.id), { cache: 'no-store' })
        }
      }
    } catch { /* the extra row is noise, not a failure */ }
    // Before the tab is reported and captured: the geometry and the color scheme
    // have to be the ones the page is READ at, not the headless defaults.
    await applyEmulation(record, viewport, colorScheme)
    const tabs = await tabsFromExtension(session)
    const tab = matchOpenedTab(tabs, url)
    if (tab === undefined) throw new Error(TAG + ': the extension sees no tab for ' + url + '. Open tabs it reported: ' + JSON.stringify(tabs))
    record.tabId = tab.tabId
    record.url = String(tab.url === undefined ? url : tab.url)
    const title = String(tab.title === undefined ? '' : tab.title)
    // Close the options page BEFORE the report we wait for: it is the extension's
    // own page, it can never be captured, and left open it is one noise row.
    if (optionsTab.id !== undefined) {
      try { await fetch('http://127.0.0.1:' + String(port) + '/json/close/' + String(optionsTab.id), { cache: 'no-store' }) } catch { /* the page is only noise */ }
    }
    // The extension sends its full tab list every 10 seconds and a fingerprint
    // on the rounds between, so a fresh poll is not the same thing as a list that
    // already contains this tab: give it one reporting cycle to catch up.
    await sleep(2200)
    const closedAt = Date.now()
    const reported = await waitForReport(instancePort, name, closedAt - 6000, waitMs)
    writeState(record)
    residentChild = child
    return { instance: name, tabId: record.tabId, url: record.url, title, pid: child.pid, debugPort: port, instance_port: instancePort, reported: reported.tabs, reportedAt: reported.lastSeenAt, captureDir, profile }
  } catch (error) {
    try { child.kill() } catch { /* already gone */ }
    await removeProfileDir(profile)
    throw error
  }
}

async function main() {
  const argv = process.argv.slice(2)
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('node tools/open-page.mjs --url <http(s) url> [--name <instance>] [--instance-port 4000] [--width 1440] [--height 900] [--color-scheme light|dark|no-preference] [--wait-ms 15000] [--token <token>] [--capture-dir <dir>] [--chrome <exe>]')
    console.log('node tools/open-page.mjs --close [--name <instance>]')
    return
  }
  if (argValue('close', argv) === true) {
    const closed = await closeOpen(argValue('name', argv) === true ? undefined : argValue('name', argv))
    console.log(JSON.stringify({ closed }))
    return
  }
  const answer = await launch({
    url: argValue('url', argv),
    name: argValue('name', argv),
    width: argValue('width', argv),
    height: argValue('height', argv),
    colorScheme: argValue(['color-scheme', 'colorScheme'], argv),
    waitMs: argValue(['wait-ms', 'waitMs'], argv),
    instancePort: argValue(['instance-port', 'instancePort'], argv),
    token: argValue('token', argv),
    captureDir: argValue(['capture-dir', 'captureDir'], argv),
    chrome: argValue('chrome', argv)
  })
  console.log(JSON.stringify(answer))
  // Stay resident: the CDP session holds the pinned viewport and color scheme.
  // The browser's own exit is the reliable end, so it is what ends this process.
  const keepAlive = setInterval(() => {}, 1 << 30)
  const finish = () => { clearInterval(keepAlive); process.exit(0) }
  keeper = { child: residentChild, profile: answer.profile, instance: answer.instance, keepAlive, finish }
  if (residentChild !== undefined) residentChild.once('exit', finish)
  process.on('SIGINT', stopKeeper)
  process.on('SIGTERM', stopKeeper)
}

/** Ctrl-C on the resident side: take the browser and the profile with it. */
async function stopKeeper() {
  if (keeper && keeper.child) {
    try { keeper.child.kill() } catch { /* gone */ }
    await removeProfileDir(keeper.profile)
    try { rmSync(stateFile(keeper.instance), { force: true }) } catch { /* gone */ }
  }
  if (keeper) keeper.finish()
  else process.exit(0)
}

main().catch((error) => {
  console.error(String(error && error.message === undefined ? error : error.message))
  process.exitCode = 1
})

export { matchOpenedTab, pageUrl, pageName, pixelsOf, colorSchemeOf }
