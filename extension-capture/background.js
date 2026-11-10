// dsh-page-capture / background.js  (MV3 service worker)
// 只做三件事：
//   1. 每 2 秒 poll 一次 /ui-blocks/agent/poll（多播：登记表里每个实例都打），
//      顺带把 chrome.tabs.query({}) 的精简清单带上；没有配置就先去发现实例；
//   2. 拿到任务就激活目标标签（坑 1）→ 注入 extractor.js → 取回素材包；
//   3. 把结果 POST 回 /ui-blocks/agent/result。
// 上报开关关掉时：一个请求都不发（连轮询都不发）。
// ponytail: 用 setTimeout 自链代替 chrome.alarms（省一个权限）；2 秒一次的 fetch 本身就是
// 心跳，SW 不会 30 秒闲置被回收。真要长期关着再打开也能立刻恢复（storage.onChanged）。

const DEFAULTS = { baseUrl: '', instance: 'chrome', token: '', enabled: true, registryUrl: 'http://127.0.0.1:38520' }
const POLL_MS = 2000
const ACTIVATE_WAIT_MS = 300
const GONE = '目标已消失，请重新 list_pages'

// ---- 发现：登记台 → 缓存 → 本机小范围探测 ----------------------------------
// 没有配置 baseUrl 时不猜端口，按下面的顺序问三处。只打回环地址，不触外网。
//
// 1) 登记台（插件侧进程内建，固定绑 127.0.0.1:38520）。下面的应答形状是
//    **候选约定**，正与插件侧商定，插件侧随后按此落地：
//      GET http://127.0.0.1:38520/instances
//      → { "instances": [ { "port": 4000, "instance": "4000", "bootAt": 1730000000000 } ] }
//    port 是 DSH 实例的 HTTP 端口；instance 是实例名（缺省用端口号）；
//    bootAt 是该实例启动的毫秒时间戳（缺省 0，只影响排序）。
//    台不可达、或应答不是这个形状 → 当作"没有表"，往下走。
// 2) chrome.storage.local 里上次拿到的表（台死了直接用缓存）。
// 3) 本机探测：GET http://127.0.0.1:<port>/ui-block-extension/info，只认应答里
//    带 captureDir 的（别的服务也会 200，靠字段确认这是 DSH）。端口段
//    3000-4100、并发 6、命中即停。
const REGISTRY_TIMEOUT_MS = 1200
const PROBE = { from: 3000, to: 4100, concurrency: 6, timeoutMs: 500 }
const DISCOVER_MIN_INTERVAL_MS = 5000
const TABLE_KEY = 'registryTable'
// 标签页清单每 10 秒整份传一次，其余轮次只带指纹 tabsTag（行数 + tabId/url 长度
// 混出的短串），省重复体积。但插件侧现在把每次 poll 的 tabs 直接覆盖写——
// normalizeTabs(undefined) 回空数组，会把实例侧记着的清单清掉——所以下面这个开关
// 默认关：插件侧改成"tabs 缺失即沿用上次"之后再打开。
const TABS_FINGERPRINT_ONLY = false
const TABS_FULL_MS = 10000

// ---- 取字节（fetch 代理）---------------------------------------------------
// 内容脚本跑在页面里，取跨域图片/字体受页面的 CORS 限制（logo、app-fold.svg、
// no-application.png 就是这么 Failed to fetch 的）。service worker 带 all_urls 主机
// 权限，同样的 URL 在这里 fetch 是 200，所以字节一律走这条路取。
const FETCH_MAX_BYTES = 12 * 1024 * 1024
const FETCH_TIMEOUT_MS = 25000
const FETCH_CONCURRENCY = 4
let fetchActive = 0
const fetchPending = []

// SW 空闲 30 秒就被回收；取字节期间（以及整轮抓取期间）每 20 秒摸一次扩展 API
// 把空闲计时器重置，别让一条慢请求把 worker 送到半路截断。
let aliveTimer = null
let aliveDepth = 0
function keepAlive(on) {
  aliveDepth = Math.max(0, aliveDepth + (on ? 1 : -1))
  if (aliveDepth > 0 && !aliveTimer) {
    aliveTimer = setInterval(function () {
      try { chrome.runtime.getPlatformInfo(function () {}) } catch (e) {}
    }, 20000)
  } else if (aliveDepth === 0 && aliveTimer) {
    clearInterval(aliveTimer)
    aliveTimer = null
  }
}

function bytesToBase64(u8) {
  let s = ''
  const CH = 0x8000
  for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH))
  return btoa(s)
}

async function fetchBytesOnce(url) {
  const ctl = new AbortController()
  const limit = setTimeout(function () { try { ctl.abort() } catch (e) {} }, FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(url, { credentials: 'include', cache: 'no-store', redirect: 'follow', signal: ctl.signal })
    if (!res.ok) throw new Error('HTTP ' + res.status)
    const declared = Number(res.headers.get('content-length') || 0)
    if (declared > FETCH_MAX_BYTES) throw new Error('超过单次取字节上限 ' + Math.round(FETCH_MAX_BYTES / 1048576) + 'MB（' + Math.round(declared / 104857.6) / 10 + 'MB）')
    const buf = new Uint8Array(await res.arrayBuffer())
    if (buf.length > FETCH_MAX_BYTES) throw new Error('超过单次取字节上限 ' + Math.round(FETCH_MAX_BYTES / 1048576) + 'MB')
    const mime = String(res.headers.get('content-type') || '').split(';')[0].trim()
    return { ok: true, base64: bytesToBase64(buf), mime: mime, bytes: buf.length, via: 'background' }
  } catch (e) {
    // 超时被中止时报的是 AbortError，写进 report.dropped 没人看得懂，换成一句人话
    if (ctl.signal.aborted) throw new Error('取字节超时 ' + Math.round(FETCH_TIMEOUT_MS / 1000) + 's')
    throw e
  } finally {
    clearTimeout(limit)
  }
}

function queueFetch(url) {
  return new Promise(function (resolve, reject) {
    fetchPending.push({ url: url, resolve: resolve, reject: reject })
    pumpFetch()
  })
}

function pumpFetch() {
  while (fetchActive < FETCH_CONCURRENCY && fetchPending.length) {
    const job = fetchPending.shift()
    fetchActive++
    keepAlive(true)
    fetchBytesOnce(job.url).then(job.resolve, function (e) { job.reject(e) }).finally(function () {
      fetchActive--
      keepAlive(false)
      pumpFetch()
    })
  }
}

let cfg = Object.assign({}, DEFAULTS)
let timer = null
let busy = false

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms) }) }

function log() {
  try { console.log.apply(console, ['[dsh-page-capture]'].concat(Array.prototype.slice.call(arguments))) } catch (e) {}
}

function badge(text, color) {
  try {
    chrome.action.setBadgeText({ text: text || '' })
    if (color) chrome.action.setBadgeBackgroundColor({ color: color })
  } catch (e) {}
}

async function readCfg() {
  const got = await chrome.storage.local.get(DEFAULTS)
  cfg = Object.assign({}, DEFAULTS, got)
  if (!cfg.instance) cfg.instance = DEFAULTS.instance
  return cfg
}

function endpoint(path, base) {
  let u = String(base).replace(/\/+$/, '') + path
  if (cfg.token) u += (u.indexOf('?') < 0 ? '?' : '&') + 'token=' + encodeURIComponent(cfg.token)
  return u
}

// ---- 发现：三处问一遍，得到"这轮要打哪些端口" ------------------------------
let targets = []          // [{ port, instance, bootAt }]；显式配置时退化成一行 baseUrl
let targetsAt = 0         // 上次发现的时间（没有表时用它限流，别每 2 秒扫一遍）
let targetsSource = 'none' // 'registry' | 'cache' | 'probe' | 'registry-empty' | 'config'
let roundFails = 0        // 连续整轮全失败（所有实例都没应答）的次数

function timeoutSignal(ms) {
  const ctl = new AbortController()
  setTimeout(function () { try { ctl.abort() } catch (e) {} }, ms)
  return ctl.signal
}

async function fetchJson(url, ms) {
  const res = await fetch(url, { cache: 'no-store', signal: timeoutSignal(ms) })
  let json = null
  try { json = await res.json() } catch (e) { json = null }
  return { status: res.status, json: json }
}

function validPort(value) {
  const port = Number(value)
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : 0
}

function sortRows(a, b) {
  if (a.bootAt !== b.bootAt) return a.bootAt - b.bootAt
  return a.port - b.port
}

// 1) 登记台。null = 台不在这儿或应答不是约定形状（往下走缓存/探测）。
async function readRegistry() {
  const base = String(cfg.registryUrl || DEFAULTS.registryUrl).replace(/\/+$/, '')
  let r
  try { r = await fetchJson(base + '/instances', REGISTRY_TIMEOUT_MS) } catch (e) { return null }
  if (!r || r.status !== 200 || !r.json || !Array.isArray(r.json.instances)) return null
  const rows = []
  for (const item of r.json.instances) {
    if (!item || typeof item !== 'object') continue
    const port = validPort(item.port)
    if (!port) continue
    rows.push({ port: port, instance: String(item.instance || port), bootAt: Number(item.bootAt) || 0 })
  }
  return rows
}

// 2) 缓存：只认上次那份表，空的表不写（写了等于把好的缓存顶掉）。
async function readTableCache() {
  try {
    const got = await chrome.storage.local.get(TABLE_KEY)
    const table = got && got[TABLE_KEY]
    if (!table || !Array.isArray(table.instances)) return null
    const rows = []
    for (const item of table.instances) {
      const port = validPort(item && item.port)
      if (port) rows.push({ port: port, instance: String(item.instance || port), bootAt: Number(item.bootAt) || 0 })
    }
    return rows.length ? rows : null
  } catch (e) { return null }
}

async function writeTableCache(rows) {
  if (!rows || !rows.length) return
  try {
    await chrome.storage.local.set({ [TABLE_KEY]: { at: Date.now(), instances: rows } })
  } catch (e) {}
}

// 3) 本机探测：分片并发、命中即停。
async function probeOne(port) {
  try {
    const r = await fetchJson('http://127.0.0.1:' + port + '/ui-block-extension/info', PROBE.timeoutMs)
    const j = r.json
    if (r.status !== 200 || !j || typeof j !== 'object' || !j.captureDir) return null
    return { port: port, instance: String(j.name || 'dsh'), bootAt: 0 }
  } catch (e) { return null }
}

async function probeRange() {
  const hits = []
  const ports = []
  for (let port = PROBE.from; port <= PROBE.to; port += 1) ports.push(port)
  let next = 0
  const worker = async function () {
    while (next < ports.length && hits.length === 0) {
      const port = ports[next]
      next += 1
      const row = await probeOne(port)
      if (row) hits.push(row)
    }
  }
  const all = []
  for (let i = 0; i < PROBE.concurrency; i += 1) all.push(worker())
  await Promise.all(all)
  return hits.sort(sortRows)
}

async function discover() {
  const live = await readRegistry()
  if (live && live.length) {
    await writeTableCache(live)
    return { rows: live.sort(sortRows), source: 'registry' }
  }
  const cached = await readTableCache()
  if (cached) return { rows: cached.sort(sortRows), source: 'cache' }
  const hits = await probeRange()
  if (hits.length) {
    await writeTableCache(hits)
    return { rows: hits, source: 'probe' }
  }
  return { rows: [], source: live === null ? 'none' : 'registry-empty' }
}

async function refreshTargets() {
  const got = await discover()
  targets = got.rows
  targetsAt = Date.now()
  targetsSource = got.source
  log('discover ' + got.source + ': ' + (targets.map(function (r) { return r.port }).join(',') || 'none'))
  return targets
}

function baseOf(row) {
  return row.baseUrl || ('http://127.0.0.1:' + row.port)
}

// 显式配置了一个 baseUrl 就只打它（不发现）；没配就按实例表多播。
async function currentTargets() {
  if (cfg.baseUrl) {
    return [{ baseUrl: String(cfg.baseUrl).replace(/\/+$/, ''), port: 0, instance: cfg.instance, bootAt: 0 }]
  }
  // 没有表时别每轮扫一遍端口（扫一次 1-2 秒，2 秒一轮会打成死循环）
  if (!targets.length && Date.now() - targetsAt >= DISCOVER_MIN_INTERVAL_MS) await refreshTargets()
  return targets
}

// ---- 标签页清单：全量 / 指纹 ------------------------------------------------
let lastFullTabsAt = 0
let lastTabsTag = ''

function tabsTag(tabs) {
  let hash = 0
  for (const tab of tabs) {
    hash = (hash * 31 + tab.tabId) | 0
    hash = (hash * 31 + String(tab.url).length) | 0
    hash = (hash * 31 + (tab.focused ? 1 : 0)) | 0
  }
  return tabs.length + '-' + (hash >>> 0).toString(36)
}

function tabsPayload(tabs) {
  const tag = tabsTag(tabs)
  const full = !TABS_FINGERPRINT_ONLY || tag !== lastTabsTag || Date.now() - lastFullTabsAt >= TABS_FULL_MS
  if (!full) return { tabsTag: tag }
  lastFullTabsAt = Date.now()
  lastTabsTag = tag
  return { tabs: tabs, tabsTag: tag }
}

// ---- 坑 3：有些页永远抓不到 ------------------------------------------------
const BAD_SCHEME = /^(chrome|edge|brave|opera|vivaldi|devtools|about|view-source|chrome-extension|moz-extension|safari-extension|chrome-search):/i
const STORE = /^https?:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore|microsoftedge\.microsoft\.com\/addons|addons\.mozilla\.org)/i
const PDF = /\.pdf([?#]|$)/i

function capturable(tab) {
  const url = String((tab && tab.url) || '')
  if (!url) return { ok: false, reason: '该标签还没有 URL（可能在加载中）' }
  const m = /^([a-z0-9+.-]+):/i.exec(url)
  const scheme = m ? m[1].toLowerCase() : ''
  if (BAD_SCHEME.test(url)) return { ok: false, reason: '浏览器内部页或扩展页（' + scheme + '://）不是 DOM 页面' }
  if (STORE.test(url)) return { ok: false, reason: '扩展商店页不允许注入脚本' }
  if (scheme === 'http' || scheme === 'https') {
    if (PDF.test(url)) return { ok: false, reason: '内嵌 PDF 不是 DOM 页面' }
    return { ok: true }
  }
  if (scheme === 'file') {
    if (PDF.test(url)) return { ok: false, reason: '本地 PDF 不是 DOM 页面' }
    return { ok: true }
  }
  return { ok: false, reason: '不支持的协议：' + (scheme || '未知') }
}

async function listTabs() {
  let focusedWindow = -1
  try { focusedWindow = (await chrome.windows.getLastFocused({ windowTypes: ['normal'] })).id } catch (e) {}
  const tabs = await chrome.tabs.query({})
  const out = []
  for (const t of tabs) {
    if (t.id === undefined || t.id === null) continue
    const c = capturable(t)
    const row = { tabId: t.id, url: String(t.url || ''), title: String(t.title || ''), focused: !!t.active && t.windowId === focusedWindow, capturable: c.ok }
    if (!c.ok) row.reason = c.reason
    out.push(row)
  }
  return out
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store'
  })
  let json = null
  try { json = await res.json() } catch (e) { json = null }
  return { status: res.status, json: json }
}

// 一轮 poll 打给一个实例（多播：每个实例各收各的，任务也各回各的）
async function poll(row, payload) {
  const body = Object.assign({ instance: cfg.instance }, payload)
  const r = await postJson(endpoint('/ui-blocks/agent/poll', baseOf(row)), body)
  if (r.status !== 200) throw new Error('poll HTTP ' + r.status)
  if (!r.json || typeof r.json !== 'object') throw new Error('poll 返回的不是 JSON')
  return r.json.task || null
}

// 结果回到发任务的那个实例（row），不走别的端口
async function sendResult(taskId, payload, row) {
  const body = Object.assign({ instance: cfg.instance, taskId: taskId }, payload)
  const r = await postJson(endpoint('/ui-blocks/agent/result', baseOf(row)), body)
  if (!r.json) throw new Error('result HTTP ' + r.status + '（无 JSON）')
  if (r.json.ok === false) throw new Error('DSH 拒收：' + (r.json.error || '未知原因'))
  log('result ok ->', r.json.dir)
  return r.json
}

async function runTask(task, row) {
  keepAlive(true)
  try { return await runTaskBody(task, row) } finally { keepAlive(false) }
}

async function runTaskBody(task, row) {
  const tabId = task && task.tabId
  if (typeof tabId !== 'number') return sendResult(task && task.id, { ok: false, error: '任务缺 tabId' }, row)

  // 坑 2：目标标签可能已经被关掉——不猜替代品
  let tab
  try { tab = await chrome.tabs.get(tabId) } catch (e) { return sendResult(task.id, { ok: false, error: GONE }, row) }
  if (!tab) return sendResult(task.id, { ok: false, error: GONE }, row)

  const c = capturable(tab)
  if (!c.ok) return sendResult(task.id, { ok: false, error: '该页抓不了：' + c.reason }, row)

  // 坑 1：后台标签会偷懒（不在前台时不渲染/延迟加载），先切到前台再等 300ms
  try {
    await chrome.tabs.update(tabId, { active: true })
    try { await chrome.windows.update(tab.windowId, { focused: true }) } catch (e) {}
    await sleep(ACTIVATE_WAIT_MS)
    badge('..', '#b45309')
  } catch (e) {
    return sendResult(task.id, { ok: false, error: '该页在后台且拒绝激活，请手动切过去：' + String(e && e.message || e) }, row)
  }

  const opts = { origin: String(tab.url || ''), title: String(tab.title || '') }
  if (task.includes) opts.includes = String(task.includes)
  if (task.maxBytes) opts.maxBytes = Number(task.maxBytes)

  let out
  try {
    await chrome.scripting.executeScript({ target: { tabId: tabId }, files: ['extractor.js'] })
    const res = await chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: function (o) { return globalThis.dshPageCapture.extract(document, o) },
      args: [opts]
    })
    out = res && res[0] ? res[0].result : null
    if (!out || !out.files) throw new Error('抽取函数没有返回 files（页面可能禁止注入）')
  } catch (e) {
    return sendResult(task.id, { ok: false, error: '抓取失败：' + String(e && e.message || e) }, row)
  }

  return sendResult(task.id, { ok: true, files: out.files, report: out.report }, row)
}

async function tick() {
  timer = null
  if (busy) { schedule(POLL_MS); return }
  busy = true
  try {
    await readCfg()
    if (!cfg.enabled) { badge('off', '#6b7280'); return }   // 关掉就一个请求都不发
    badge('on', '#2563eb')
    const rows = await currentTargets()
    if (!rows.length) { badge('?', '#b45309'); return }     // 没有实例可上报（下一轮再试）
    const tabs = await listTabs()
    const payload = tabsPayload(tabs)
    let okAny = false
    // 多播：登记表里每一个实例都打一遍，各收各的任务；结果回到发它的那个实例
    for (const row of rows) {
      try {
        const task = await poll(row, payload)
        okAny = true
        if (task) {
          log('task', task.id, 'tab', task.tabId, 'via', baseOf(row))
          await runTask(task, row)
        }
      } catch (e) {
        log('poll ' + baseOf(row) + ' failed: ' + String(e && e.message || e))
      }
    }
    roundFails = okAny ? 0 : roundFails + 1
    // 连续 3 轮整轮失败 → 换实例或重启过，重发现一次（显式配置时不猜）
    if (roundFails >= 3 && !cfg.baseUrl) { roundFails = 0; await refreshTargets() }
  } catch (e) {
    badge('!', '#b91c1c')
    log('tick failed: ' + String(e && e.message || e))
  } finally {
    busy = false
    schedule(POLL_MS)
  }
}

function schedule(ms) {
  if (timer) clearTimeout(timer)
  timer = setTimeout(function () { tick() }, ms === undefined ? POLL_MS : ms)
}

function stop() {
  if (timer) { clearTimeout(timer); timer = null }
}

// ---- 唤醒点 ----------------------------------------------------------------
chrome.runtime.onInstalled.addListener(function () { schedule(0) })
chrome.runtime.onStartup.addListener(function () { schedule(0) })
chrome.action.onClicked.addListener(function () { chrome.runtime.openOptionsPage() })
chrome.storage.onChanged.addListener(function (changes) {
  // 只变了实例表缓存（我们自己写的）→ 不重启轮询
  const keys = Object.keys(changes || {})
  if (keys.length > 0 && keys.every(function (key) { return key === TABLE_KEY })) return
  targets = []
  targetsAt = 0
  stop(); schedule(0)
})

// options 页问一句"现在什么状态"
chrome.runtime.onMessage.addListener(function (msg, sender, reply) {
  if (msg && msg.type === 'dsh-capture-status') {
    reply({
      enabled: !!cfg.enabled, baseUrl: cfg.baseUrl, instance: cfg.instance, busy: busy,
      registry: {
        source: targetsSource, at: targetsAt,
        instances: targets.map(function (r) { return { port: r.port, instance: r.instance, bootAt: r.bootAt } })
      }
    })
    return false
  }
  // options 页点「自动发现」：强制重问一遍（登记台 → 缓存 → 探测）
  if (msg && msg.type === 'dsh-capture-discover') {
    if (cfg.baseUrl) { reply({ ok: true, source: 'config', pinned: cfg.baseUrl, instances: [] }); return false }
    refreshTargets().then(function (rows) {
      reply({ ok: true, source: targetsSource, instances: rows.map(function (r) { return { port: r.port, instance: r.instance, bootAt: r.bootAt } }) })
    }, function (e) { reply({ ok: false, error: String(e && e.message || e) }) })
    return true
  }
  // 内容脚本要一个资源的字节：这里 fetch，字节(base64) + mime 回传；失败原因原样回传，
  // 由 extractor 写进 report.dropped。返回 true = 答复是异步的。
  if (msg && msg.type === 'dsh-capture-fetch') {
    const url = String(msg.url || '')
    if (!/^https?:/i.test(url) && !/^file:/i.test(url)) {
      reply({ ok: false, error: '不支持的协议：' + (url.split(':')[0] || '未知') })
      return false
    }
    keepAlive(true)
    queueFetch(url).then(
      function (r) { reply(r); keepAlive(false) },
      function (e) { reply({ ok: false, error: String((e && e.message) || e) }); keepAlive(false) }
    )
    return true
  }
  return false
})

// 测试钩子：CDP / 断点里可以直接调 __dshCaptureTick() 跑一轮
globalThis.__dshCaptureTick = function () { return tick() }
schedule(0)
