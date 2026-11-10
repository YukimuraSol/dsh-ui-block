#!/usr/bin/env node
// launch.mjs — 起一个带 dsh-page-capture 的 Chrome 并打开一个网址，把这次打开的
// 标签页身份交回来。参数固定成一套，不让调用方每次手拼。
//
// 这是产品路径之一：用户给一个网址 → 本脚本开一个干净的浏览器把页面打开 →
// 扩展上报 → 拿回 { instance, tabId } → capture_page。public 页整条链无人值守。
//
// 两条边界（硬约束，代码里不做也做不到）：
//   * 不碰 cookie、不读不写用户自己的浏览器配置——每次都用一个全新的临时 profile；
//   * 需要登录态的页面不替用户登录：脚本开出来的是空白会话，这类页面请用户在
//     他自己已登录的浏览器里打开，然后回会话说一声。
//
//   node launch.mjs --url=https://example.com
//   node launch.mjs --url=https://example.com --base-url=http://127.0.0.1:4000
//   node launch.mjs --url=https://example.com --base-url=http://127.0.0.1:4000 --close
//
// --base-url 走确定性路径：打开 chrome-extension://<扩展ID>/options.html?baseURL=<本实例>，
// options.js 读到查询参数即写进 chrome.storage.local，脚本最后把读回值打印出来。
//
// Chrome 156 起正式版停用 --load-extension（--disable-extensions-except 还会把 CDP
// 加载的扩展标成「已被屏蔽」），所以扩展改由 CDP 的 Extensions.loadUnpacked 加载，
// 启动参数里因此带 --enable-unsafe-extension-debugging 与 --remote-allow-origins=*。
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

function argValue(name, fallback) {
  const argv = process.argv.slice(2)
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--' + name) {
      const next = argv[i + 1]
      return next === undefined || next.startsWith('--') ? true : next
    }
    if (argv[i].startsWith('--' + name + '=')) return argv[i].slice(name.length + 3)
  }
  return fallback
}

const baseUrlArg = argValue('base-url', '')
const pageArg = argValue('url', '')
if (baseUrlArg === true) { console.error('--base-url 需要一个值，例如 --base-url=http://127.0.0.1:4000'); process.exit(2) }
if (pageArg === true) { console.error('--url 需要一个值，例如 --url=https://example.com'); process.exit(2) }

function freePort() {
  return new Promise(function (resolve, reject) {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', function () {
      const port = srv.address().port
      srv.close(function () { resolve(port) })
    })
  })
}

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms) }) }

function chromeCandidates() {
  return [
    process.env.CHROME_PATH || '',
    'C:' + path.sep + 'Program Files' + path.sep + 'Google' + path.sep + 'Chrome' + path.sep + 'Application' + path.sep + 'chrome.exe',
    'C:' + path.sep + 'Program Files (x86)' + path.sep + 'Google' + path.sep + 'Chrome' + path.sep + 'Application' + path.sep + 'chrome.exe',
    'C:' + path.sep + 'Program Files (x86)' + path.sep + 'Microsoft' + path.sep + 'Edge' + path.sep + 'Application' + path.sep + 'msedge.exe',
    'C:' + path.sep + 'Program Files' + path.sep + 'Microsoft' + path.sep + 'Edge' + path.sep + 'Application' + path.sep + 'msedge.exe'
  ].filter(Boolean)
}

function findChrome(explicit) {
  if (explicit && explicit !== true) {
    if (!existsSync(explicit)) throw new Error('--chrome 指的文件不存在：' + explicit)
    return explicit
  }
  for (const candidate of chromeCandidates()) if (existsSync(candidate)) return candidate
  throw new Error('找不到 Chrome/Edge，用 --chrome=<全路径> 指定')
}

async function getJson(url, ms) {
  const ctl = new AbortController()
  const limit = setTimeout(function () { try { ctl.abort() } catch (e) {} }, ms)
  try {
    const res = await fetch(url, { signal: ctl.signal, cache: 'no-store' })
    if (!res.ok) throw new Error('HTTP ' + res.status)
    return await res.json()
  } finally { clearTimeout(limit) }
}

async function waitVersion(port, limitMs) {
  const deadline = Date.now() + limitMs
  let last = ''
  while (Date.now() < deadline) {
    try { return await getJson('http://127.0.0.1:' + port + '/json/version', 1000) } catch (e) { last = String(e && e.message || e) }
    await sleep(120)
  }
  throw new Error('调试端口 ' + port + ' 一直没应答（' + last + '）')
}

/** 一条 CDP 请求，连到浏览器级 WebSocket（Extensions.* 只在这儿认）。 */
function cdpCall(wsUrl, method, params) {
  return new Promise(function (resolve) {
    let socket
    try { socket = new WebSocket(wsUrl) } catch (e) { resolve({ error: String(e && e.message || e) }); return }
    const kill = setTimeout(function () { try { socket.close() } catch (e) {} resolve({ error: 'CDP 超时' }) }, 8000)
    socket.addEventListener('open', function () { socket.send(JSON.stringify({ id: 1, method: method, params: params || {} })) })
    socket.addEventListener('message', function (ev) {
      let msg
      try { msg = JSON.parse(String(ev.data)) } catch (e) { return }
      if (!msg || msg.id !== 1) return
      clearTimeout(kill)
      try { socket.close() } catch (e) {}
      resolve(msg.error ? { error: String(msg.error.message || msg.error) } : (msg.result || {}))
    })
    socket.addEventListener('error', function () { clearTimeout(kill); resolve({ error: 'WebSocket 出错' }) })
  })
}

/** Chrome 156 的加载手段：CDP Extensions.loadUnpacked（等同 chrome://extensions 的「加载已解压」）。 */
async function loadUnpacked(port, captureDir) {
  const version = await getJson('http://127.0.0.1:' + port + '/json/version', 3000)
  if (!version || !version.webSocketDebuggerUrl) throw new Error('/json/version 没给 webSocketDebuggerUrl')
  const made = await cdpCall(version.webSocketDebuggerUrl, 'Extensions.loadUnpacked', { path: captureDir })
  if (made.error) throw new Error('Extensions.loadUnpacked 失败：' + made.error)
  if (!made.id) throw new Error('Extensions.loadUnpacked 没回扩展 ID')
  return String(made.id)
}

/** /json/list 里按 URL 片段找目标的 ws 地址（页面导航后 ws 地址会换，每次重找）。 */
async function findTargetWs(port, needles) {
  try {
    const list = await getJson('http://127.0.0.1:' + port + '/json/list', 1000)
    for (const needle of needles) {
      for (const target of list || []) {
        if (String(target.url || '').includes(needle) && target.webSocketDebuggerUrl) return String(target.webSocketDebuggerUrl)
      }
    }
  } catch (e) {}
  return ''
}

function evaluateOnce(wsUrl, expression) {
  return new Promise(function (resolve) {
    let socket
    try { socket = new WebSocket(wsUrl) } catch (e) { resolve({ error: String(e && e.message || e) }); return }
    const kill = setTimeout(function () { try { socket.close() } catch (e) {} resolve({ error: '超时' }) }, 3000)
    socket.addEventListener('open', function () {
      socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expression, awaitPromise: true, returnByValue: true } }))
    })
    socket.addEventListener('message', function (ev) {
      let msg
      try { msg = JSON.parse(String(ev.data)) } catch (e) { return }
      if (!msg || msg.id !== 1) return
      clearTimeout(kill)
      try { socket.close() } catch (e) {}
      if (msg.error) { resolve({ error: String(msg.error.message || msg.error) }); return }
      const details = msg.result && msg.result.exceptionDetails
      if (details) { resolve({ error: String(details.exception && details.exception.description || details.text) }); return }
      resolve({ value: msg.result && msg.result.result ? msg.result.result.value : undefined })
    })
    socket.addEventListener('error', function () { clearTimeout(kill); resolve({ error: 'WebSocket 出错' }) })
  })
}

/** 反复求值直到 accept(value) 成立（页面是异步加载/异步写 storage 的）。 */
async function evaluateUntil(port, needles, expression, accept, limitMs) {
  const deadline = Date.now() + limitMs
  let last = '没有连上'
  let attempts = 0
  while (Date.now() < deadline) {
    attempts += 1
    const wsUrl = await findTargetWs(port, needles)
    if (!wsUrl) { last = '找不到目标（' + needles.join(' / ') + '）'; await sleep(200); continue }
    const got = await evaluateOnce(wsUrl, expression)
    if (got && got.value !== undefined && accept(got.value)) return got.value
    last = got && got.error ? got.error : '读回 ' + JSON.stringify(got && got.value)
    await sleep(200)
  }
  return { error: last, attempts: attempts }
}

/** 新开一个标签指向 options.html?baseURL=…；/json/new 要 PUT（老版本才收 GET）。 */
async function openOptionsPage(port, extensionId, baseUrl) {
  const url = 'chrome-extension://' + extensionId + '/options.html' +
    (baseUrl === '' ? '' : '?baseURL=' + encodeURIComponent(baseUrl))
  for (const method of ['PUT', 'GET']) {
    try {
      const res = await fetch('http://127.0.0.1:' + port + '/json/new?' + url, { method: method, cache: 'no-store' })
      if (!res.ok) continue
      return { url: url, target: await res.json() }
    } catch (e) {}
  }
  throw new Error('打不开 options 页：' + url)
}

const STORAGE_EXPR = "chrome.storage.local.get('baseUrl').then(function (v) { return v && v.baseUrl || '' })"

/**
 * 这次打开的那个标签页的身份：capture_page 要的 { instance, tabId } 就是它。
 *
 * 匹配分三级，先把 URL 归一化再比（host 小写、空路径补尾斜杠、去掉 fragment 由
 * URL() 一条搞定）：① 归一化后相等 → exact；② 同 host 且 path 以目标为前缀
 * （重定向到更深路径）→ prefix；③ 都没有才拿第一个 http(s) 标签 → fallback，
 * 并把所有备选放进 candidates，多标签时人能看出会不会抓错。
 *
 * instance 必须是插件侧记账用的那个名字：手填的 instance 优先，留空就用后台自动生成的
 * instanceId（chrome-xxxx）。老版本写进 storage 的 "chrome" 当"没填"看，跟 background.js
 * 同一口径——两边口径不一致的话，这个 tabId 在插件侧根本对不上号。
 */
function tabInfoExpr(wantUrl) {
  return '(async function () {' +
    ' var s = await chrome.storage.local.get({ instance: "", instanceId: "" });' +
    ' var manual = String(s.instance || "").trim();' +
    ' if (manual === "chrome") manual = "";' +
    ' var name = manual || String(s.instanceId || "").trim();' +
    ' if (name === "") return { pending: true };' +
    ' var norm = function (raw) { try { var u = new URL(String(raw)); u.hash = ""; return u.href } catch (e) { return String(raw) } };' +
    ' var tabs = await chrome.tabs.query({});' +
    ' var want = ' + JSON.stringify(String(wantUrl)) + ';' +
    ' var wantHref = norm(want);' +
    ' var hit = null, matched = "", candidates = [];' +
    ' for (var i = 0; i < tabs.length; i += 1) { if (norm(tabs[i].url) === wantHref) { hit = tabs[i]; matched = "exact"; break } }' +
    ' if (!hit) {' +
    '   var wu = null; try { wu = new URL(want) } catch (e) { wu = null }' +
    '   if (wu) {' +
    '     var cut = wu.pathname === "/" ? "/" : (wu.pathname.slice(-1) === "/" ? wu.pathname : wu.pathname + "/");' +
    '     for (var j = 0; j < tabs.length; j += 1) {' +
    '       var tu = null; try { tu = new URL(String(tabs[j].url || "")) } catch (e) { tu = null }' +
    '       if (!tu) continue;' +
    '       if (tu.host === wu.host && (tu.pathname === wu.pathname || tu.pathname.indexOf(cut) === 0)) { hit = tabs[j]; matched = "prefix"; break }' +
    '     }' +
    '   }' +
    ' }' +
    ' if (!hit) {' +
    '   var httpTabs = [];' +
    '   for (var k = 0; k < tabs.length; k += 1) { if (/^https?:/i.test(String(tabs[k].url || ""))) httpTabs.push(tabs[k]) }' +
    '   if (httpTabs.length) {' +
    '     hit = httpTabs[0]; matched = "fallback";' +
    '     candidates = httpTabs.map(function (t) { return { url: String(t.url || ""), title: String(t.title || "") } });' +
    '   }' +
    ' }' +
    ' if (!hit) return null;' +
    ' return { instance: name, manual: manual !== "", tabId: hit.id, url: String(hit.url || ""), title: String(hit.title || ""), matched: matched, want: wantHref, candidates: candidates };' +
    '})()'
}

function quote(value) {
  const text = String(value)
  return /\s/.test(text) || text === '' ? '"' + text + '"' : text
}

async function main() {
  const captureDir = path.resolve(String(argValue('capture-dir', HERE)))
  if (!existsSync(path.join(captureDir, 'manifest.json'))) throw new Error('capture 目录里没有 manifest.json：' + captureDir)
  const manifest = JSON.parse(readFileSync(path.join(captureDir, 'manifest.json'), 'utf8'))
  const chrome = findChrome(argValue('chrome', ''))
  const port = argValue('debug-port', '') === '' ? await freePort() : Number(argValue('debug-port', 0))
  const keepProfile = argValue('user-data-dir', '') !== '' && argValue('user-data-dir', '') !== true
  const profile = keepProfile ? path.resolve(String(argValue('user-data-dir', ''))) : mkdtempSync(path.join(os.tmpdir(), 'dsh-capture-profile-'))
  const closeAfter = argValue('close', false)
  const baseUrl = typeof baseUrlArg === 'string' ? baseUrlArg.replace(/\/+$/, '') : ''
  const page = typeof pageArg === 'string' ? pageArg : ''

  const args = [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--user-data-dir=' + profile,
    '--remote-debugging-port=' + String(port),
    // 扩展靠这两条才加载得进来（见文件头的 Chrome 156 说明）
    '--enable-unsafe-extension-debugging',
    '--remote-allow-origins=*'
  ]
  if (page !== '') args.push(page)

  const child = spawn(chrome, args, { detached: true, stdio: 'ignore', windowsHide: true })
  child.unref()

  await waitVersion(port, 20000)
  const extensionId = await loadUnpacked(port, captureDir)
  await sleep(500)

  const out = {
    pid: child.pid,
    chrome: chrome,
    debugPort: port,
    userDataDir: profile,
    captureDir: captureDir,
    extensionId: extensionId,
    extensionVersion: String(manifest.version || ''),
    command: [quote(chrome)].concat(args.map(quote)).join(' ')
  }

  let openedTargetId = ''
  if (baseUrl !== '') {
    const opened = await openOptionsPage(port, extensionId, baseUrl)
    out.optionsUrl = opened.url
    openedTargetId = opened.target && opened.target.id ? String(opened.target.id) : ''
    out.storageBack = await evaluateUntil(port, ['options.html'], STORAGE_EXPR, function (v) { return v === baseUrl }, 8000)
    out.baseUrl = baseUrl
  }

  if (page !== '') {
    const needles = ['/background.js', 'options.html']
    const tabReady = function (v) { return !!v && v.tabId !== undefined && v.tabId !== null && !!v.instance }
    let info = await evaluateUntil(port, needles, tabInfoExpr(page), tabReady, 15000)
    if (info && info.error) {
      // 背景页在睡、又没有 options 页可借时，开一个（不写 baseURL）再问一次
      await openOptionsPage(port, extensionId, '')
      info = await evaluateUntil(port, needles, tabInfoExpr(page), tabReady, 8000)
    }
    out.tab = info
    out.url = page
  }

  // 配置页写完就关掉：它是扩展自己的页面（抓不了），留在标签页清单里只会多一行噪声，
  // 而这一趟真正要报的是 --url 打开的那个页面。
  if (openedTargetId !== '') {
    try {
      const res = await fetch('http://127.0.0.1:' + port + '/json/close/' + openedTargetId, { cache: 'no-store' })
      out.optionsClosed = res.ok
    } catch (e) { out.optionsClosed = false }
    await sleep(300)
  }

  console.log(JSON.stringify(out, null, 2))
  console.log('[launch] ' + out.command)

  if (closeAfter) {
    try { process.kill(child.pid) } catch (e) {}
    await sleep(300)
    if (!keepProfile) { try { rmSync(profile, { recursive: true, force: true }) } catch (e) {} }
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (isMain) {
  main().catch(function (e) {
    console.error('[launch] 失败：' + (e && e.message || e))
    process.exitCode = 1
  })
}

// 给 hub-check 用：把"要报哪个标签页"的那段表达式单独测（URL 归一化/前缀/兜底三级）
export { tabInfoExpr }
