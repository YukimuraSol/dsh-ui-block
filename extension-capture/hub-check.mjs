// hub-check.mjs — 离线验「发现 + 多播上报 + 缓存」这三段，不需要 DSH、不需要浏览器。
//
// 做法：把 background.js 原文用 new Function 装进一个假 chrome（storage 用内存 Map、
// tabs.query 给两条固定标签、scripting 回一段假素材），再起三个本地 http 服务——
// 一个假登记台（GET /instances）+ 两个假实例（POST /ui-blocks/agent/poll 与 /result）——
// 然后手动跑 tick。于是"一轮 poll 打到两个端口、各自收到、结果各回各的端口"是被
// 真实发出去的 HTTP 请求证明的，不是靠读代码猜的。
//
// 单独跑：node hub-check.mjs
// 被 self-check.mjs 调：runHubChecks(assert) 把断言并进它那份清单。
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
// launch.mjs 里的标签页匹配表达式单独测：它只吃 chrome.tabs 的结果，不需要真浏览器。
// launch.mjs 自己用 isMain 守住，被 import 时不会起 Chrome。
import { tabInfoExpr } from './launch.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const realSetTimeout = setTimeout
const silent = { log() {}, info() {}, warn() {}, error() {} }

// 一段「够大」的假 PNG 载荷：只证明通道把截图当二进制文件搬进 files[]，不是真截图。
// base64 9200 字符 ≈ 6900 字节，跨过「字节 > 5000」那道门槛，与真实 1440x900 PNG 的量级一致。
const FAKE_PNG_DATA_URL = 'data:image/png;base64,' + 'iVBORw0KGgoAAAANSUhEUg'.repeat(400)
const TAB_A = { id: 11, url: 'http://example.test/a', title: 'A', windowId: 1, active: false }
const TAB_B = { id: 12, url: 'https://example.test/b', title: 'B', windowId: 1, active: false }

/** 假 chrome：行为对齐 MV3 里用到的那些 API，storage 用外部传入的 Map（跨"重启"复用）。 */
function makeChrome(store, env) {
  const listeners = { message: [], storageChanged: [] }
  // 现场账：tabs.update 调用按顺序记下来（env.activeTabId 就是"此刻哪个 tab 是 active"），
  // windows.update 单独记——抓取流程一次都不许调它（那是抢焦点的唯一来源）。
  env.tabUpdates = env.tabUpdates || []
  env.windowUpdates = env.windowUpdates || []
  const log = function (line) { if (env.order) env.order.push(line) }
  const api = {
    storage: {
      local: {
        async get(keys) {
          if (keys === null || keys === undefined) return Object.fromEntries(store)
          if (typeof keys === 'string') return store.has(keys) ? { [keys]: store.get(keys) } : {}
          if (Array.isArray(keys)) {
            const out = {}
            for (const key of keys) if (store.has(key)) out[key] = store.get(key)
            return out
          }
          const out = {}
          for (const [key, fallback] of Object.entries(keys)) out[key] = store.has(key) ? store.get(key) : fallback
          return out
        },
        async set(values) {
          const changes = {}
          for (const [key, value] of Object.entries(values)) {
            changes[key] = { oldValue: store.get(key), newValue: value }
            store.set(key, value)
          }
          for (const fn of listeners.storageChanged) fn(changes, 'local')
        }
      },
      onChanged: { addListener(fn) { listeners.storageChanged.push(fn) } }
    },
    runtime: {
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
      onMessage: { addListener(fn) { listeners.message.push(fn) } },
      // MV3 回调式 API 失败时靠 runtime.lastError 报；假 chrome 也要有这个口，
      // 否则「captureVisibleTab 抛错」这条路径在离线自检里根本走不到。
      get lastError() { return env.lastError },
      getPlatformInfo(cb) { if (cb) cb({ os: 'win' }) },
      openOptionsPage() {},
      async sendMessage() { return { enabled: true, baseUrl: store.get('baseUrl') || '', instance: 'chrome', registry: { source: 'none', at: 0, instances: [] } } }
    },
    action: {
      onClicked: { addListener() {} },
      setBadgeText(o) { env.badge = String(o && o.text || '') },
      setBadgeBackgroundColor() {}
    },
    windows: {
      async getLastFocused() { return { id: 1 } },
      async get(id) { return { id: id, focused: !!env.windowFocused } },
      async update(id, props) { env.windowUpdates.push({ id: id, props: Object.assign({}, props) }); return { id: id } }
    },
    tabs: {
      async query(filter) {
        const rows = [TAB_A, TAB_B].filter(function (t) {
          if (!filter || typeof filter !== 'object') return true
          if (filter.windowId !== undefined && t.windowId !== filter.windowId) return false
          if (filter.active !== undefined && (t.id === env.activeTabId) !== !!filter.active) return false
          return true
        })
        return rows
      },
      async get(id) {
        const tab = [TAB_A, TAB_B].find((t) => t.id === id)
        if (!tab) throw new Error('No tab with id: ' + id)
        return tab
      },
      // 参考截图：成功时回 env.capture.dataUrl（默认一段 > 5000 字节的假 PNG 载荷），
      // 失败时设 env.lastError 并回 undefined —— 与 MV3 的真实行为一致。
      captureVisibleTab(windowId, options, cb) {
        env.captureCalls = (env.captureCalls || 0) + 1
        env.captureArgs = { windowId: windowId, format: options && options.format }
        const mode = env.capture || { ok: true }
        if (mode.ok === false) { env.lastError = { message: mode.error || 'Failed to capture visible tab' }; cb(undefined); return }
        env.lastError = null
        cb(mode.dataUrl || FAKE_PNG_DATA_URL)
      },
      async update(id, props) {
        env.tabUpdates.push({ id: id, props: Object.assign({}, props) })
        log('tabs.update:' + id + (props && props.active ? ' active' : ''))
        if (props && props.active) env.activeTabId = id
        return Object.assign({}, [TAB_A, TAB_B].find((t) => t.id === id) || { id: id }, props)
      }
    },
    scripting: {
      async executeScript(options) {
        if (options && options.files) return []
        log('extract')
        // extractor 会带一份 report.screenshot 的环境事实进来；background 负责把 PNG 落成
        // files[] 里的一项，或把失败写进 screenshot.error。env.noShotFacts 用来模拟老版本 extractor。
        const facts = env.noShotFacts === true ? {} : {
          screenshot: { mode: 'viewport', path: 'reference/viewport.png', width: 1280, height: 800, dpr: 1, scrollY: 0, scrollHeight: 2400, captureViewport: { width: 1280, height: 800, dpr: 1 } }
        }
        return [{ result: { files: [{ path: 'entry.html', content: '<html></html>', bytes: 13, base64: false }], report: Object.assign({ bytes: 13, files: [], dropped: [] }, facts) } }]
      }
    }
  }
  return { api, listeners }
}

/**
 * 装一份 background.js。计时器被换掉：ms 在 (0,1000) 之间（只有沉睡等待 300ms）立刻跑，
 * 其余（poll 自链 2000ms、fetch 超时 1200ms）不跑——这样"一轮"完全由调用方驱动。
 */
function loadBackground(chromeApi) {
  const src = readFileSync(path.join(HERE, 'background.js'), 'utf8')
  delete globalThis.__dshCaptureTick
  const fakeTimeout = function (fn, ms) {
    if (ms > 0 && ms < 1000) return realSetTimeout(fn, 0)
    return 0
  }
  const noInterval = function () { return 0 }
  new Function('chrome', 'console', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', src)(
    chromeApi, silent, fakeTimeout, function () {}, noInterval, function () {}
  )
  const tick = globalThis.__dshCaptureTick
  if (typeof tick !== 'function') throw new Error('background.js 没有挂出 __dshCaptureTick')
  return tick
}

function startServer(handler) {
  return new Promise(function (resolve) {
    const server = createServer(handler)
    server.listen(0, '127.0.0.1', function () {
      resolve({ server, port: server.address().port })
    })
  })
}

function readBody(req) {
  return new Promise(function (resolve) {
    let text = ''
    req.on('data', function (chunk) { text += chunk })
    req.on('end', function () {
      try { resolve(JSON.parse(text)) } catch (e) { resolve({ raw: text }) }
    })
  })
}

function json(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), 'cache-control': 'no-store' })
  res.end(text)
}

export async function runHubChecks(assert) {
  const store = new Map()
  const registryHits = []
  // order 是「谁先谁后」的共享账：假 chrome 的 tabs.update 与下面的 /result 各记一笔，
  // 用来证明"结果送回之后才切回原 tab"。
  const instanceA = { polls: [], results: [], queue: [{ id: 't-A1', tabId: 11 }], order: [] }
  const instanceB = { polls: [], results: [], queue: [] }

  const registry = await startServer(async function (req, res) {
    const url = new URL(String(req.url || '/'), 'http://127.0.0.1')
    registryHits.push(req.method + ' ' + url.pathname)
    if (url.pathname === '/instances' && req.method === 'GET') {
      json(res, 200, { instances: [
        { port: aPort, instance: 'fake-a', bootAt: 1730000000000 },
        { port: bPort, instance: 'fake-b', bootAt: 1730000001000 }
      ] })
      return
    }
    json(res, 404, { ok: false })
  })
  let aPort = 0
  let bPort = 0
  const a = await startServer(async function (req, res) {
    const url = new URL(String(req.url || '/'), 'http://127.0.0.1')
    if (url.pathname.endsWith('/poll')) {
      const body = await readBody(req)
      instanceA.polls.push({ body })
      json(res, 200, { task: instanceA.queue.shift() || null })
      return
    }
    if (url.pathname.endsWith('/result')) {
      const body = await readBody(req)
      instanceA.results.push({ body })
      instanceA.order.push('result:' + String(body && body.taskId))
      json(res, 200, { ok: true, dir: 'out/fake-a' })
      return
    }
    json(res, 404, {})
  })
  const b = await startServer(async function (req, res) {
    const url = new URL(String(req.url || '/'), 'http://127.0.0.1')
    if (url.pathname.endsWith('/poll')) {
      const body = await readBody(req)
      instanceB.polls.push({ body })
      json(res, 200, { task: instanceB.queue.shift() || null })
      return
    }
    if (url.pathname.endsWith('/result')) {
      const body = await readBody(req)
      instanceB.results.push({ body })
      json(res, 200, { ok: true, dir: 'out/fake-b' })
      return
    }
    json(res, 404, {})
  })
  aPort = a.port
  bPort = b.port

  const env = { badge: '' }
  const first = makeChrome(store, env)
  store.set('registryUrl', 'http://127.0.0.1:' + registry.port)
  const tick1 = loadBackground(first.api)
  await tick1()

  // ---- 1. ext-bootstrap：没有配置 baseUrl 时先去登记台取表 ------------------
  const portsPolled = [instanceA.polls.length ? aPort : 0, instanceB.polls.length ? bPort : 0].filter(Boolean).sort()
  assert('ext-bootstrap：没有配置时向 /instances 取实例表，一轮打到表里两个实例',
    registryHits.some((hit) => hit === 'GET /instances') &&
      instanceA.polls.length === 1 && instanceB.polls.length === 1 &&
      portsPolled.length === 2,
    'GET /instances ' + registryHits.length + ' 次；poll → 127.0.0.1:' + aPort + ' ×' + instanceA.polls.length +
      '、127.0.0.1:' + bPort + ' ×' + instanceB.polls.length +
      '；两边的 body.instance=' + JSON.stringify([instanceA.polls[0].body.instance, instanceB.polls[0].body.instance]) +
      '；tabs=' + (instanceA.polls[0].body.tabs || []).length + ' 行 + tabsTag=' + String(instanceA.polls[0].body.tabsTag || '缺'))

  // ---- 2. ext-multicast：任务结果只回到发它的那个实例 ----------------------
  assert('ext-multicast：任务由 A 下发、结果只回 A（B 一次 result 都没收到）',
    instanceA.results.length === 1 && instanceB.results.length === 0 &&
      instanceA.results[0].body.taskId === 't-A1' && instanceA.results[0].body.ok === true,
    'A 收到 result ' + instanceA.results.length + ' 条（taskId=' + String(instanceA.results[0] && instanceA.results[0].body.taskId) +
      '，ok=' + String(instanceA.results[0] && instanceA.results[0].body.ok) + '）；B 收到 result ' + instanceB.results.length + ' 条')

  // ---- 2b. tabs-fingerprint：同一份清单的第二轮只带 tabsTag，不重发整份 ------
  const firstTag = instanceA.polls[0].body.tabsTag
  await tick1()
  const secondPoll = instanceA.polls[1] ? instanceA.polls[1].body : null
  assert('tabs-fingerprint：第二轮同一份清单只带 tabsTag（不发 tabs，插件侧沿用上次）',
    !!secondPoll && secondPoll.tabs === undefined && String(secondPoll.tabsTag) === String(firstTag),
    '第 1 轮 tabs=' + (instanceA.polls[0].body.tabs || []).length + ' 行 / tag=' + String(firstTag) +
      '；第 2 轮 tabs=' + (secondPoll && secondPoll.tabs === undefined ? '（无该字段）' : JSON.stringify(secondPoll && secondPoll.tabs)) +
      ' / tag=' + String(secondPoll && secondPoll.tabsTag))

  // ---- 3. ext-cache：实例表写进 storage ----------------------------------
  const cached = store.get('registryTable')
  const cachedPorts = cached && Array.isArray(cached.instances) ? cached.instances.map((row) => row.port).sort() : []
  assert('ext-cache：登记表写进 chrome.storage（registryTable）',
    cachedPorts.length === 2 && cachedPorts[0] === Math.min(aPort, bPort) && cachedPorts[1] === Math.max(aPort, bPort),
    'storage.registryTable.instances = ' + JSON.stringify(cachedPorts) + '，at=' + String(cached && cached.at))

  // ---- 4. ext-cache：台死了 + 扩展重启，仍按缓存里的表上报 ----------------
  await new Promise(function (resolve) { registry.server.close(resolve) })
  const pollsABefore = instanceA.polls.length
  const pollsBBefore = instanceB.polls.length
  const second = makeChrome(store, env)
  const tick2 = loadBackground(second.api)
  await tick2()
  let status = null
  for (const fn of second.listeners.message) {
    fn({ type: 'dsh-capture-status' }, {}, function (answer) { status = answer })
  }
  assert('ext-cache：登记台停掉 + 扩展重启后仍用缓存里的实例表上报',
    instanceA.polls.length === pollsABefore + 1 && instanceB.polls.length === pollsBBefore + 1 &&
      status && status.registry && status.registry.source === 'cache',
    '台已关；重启后 A 又收到 ' + (instanceA.polls.length - pollsABefore) + ' 次 poll、B 又收到 ' +
      (instanceB.polls.length - pollsBBefore) + ' 次；status.registry.source=' + String(status && status.registry && status.registry.source))

  // ---- 4b. instance 自动名：两台浏览器（两份独立 storage）各自生成，不许撞 ----
  // 直接钉 baseUrl，免得跑到本机端口探测上去（那会碰到真实的 DSH 实例）。
  const autoNames = []
  for (let i = 0; i < 2; i += 1) {
    const fresh = new Map()
    fresh.set('baseUrl', 'http://127.0.0.1:' + aPort)
    const fake = makeChrome(fresh, { badge: '' })
    const run = loadBackground(fake.api)
    await run()
    const lastBody = instanceA.polls[instanceA.polls.length - 1].body
    autoNames.push({ stored: String(fresh.get('instanceId') || ''), used: String(lastBody.instance || '') })
  }
  const wellFormed = autoNames.every((row) => /^chrome-[0-9a-f]{4}$/.test(row.stored) && row.used === row.stored)
  assert('instance 自动名：两份独立 storage 各生成 chrome-xxxx、互不相同，poll 里用的就是它',
    wellFormed && autoNames[0].stored !== autoNames[1].stored,
    '浏览器1=' + JSON.stringify(autoNames[0]) + '；浏览器2=' + JSON.stringify(autoNames[1]))

  // ---- 5. options.html?baseURL= 写进 storage ------------------------------
  const optionsStore = new Map()
  const elements = {}
  const document = {
    getElementById(id) {
      if (!elements[id]) elements[id] = { id, value: '', checked: false, textContent: '', addEventListener() {} }
      return elements[id]
    }
  }
  const optionsChrome = makeChrome(optionsStore, { badge: '' })
  globalThis.location = { search: '?baseURL=' + encodeURIComponent('http://127.0.0.1:4000') }
  const optionsSrc = readFileSync(path.join(HERE, 'options.js'), 'utf8')
  new Function('chrome', 'document', 'console', 'fetch', optionsSrc)(optionsChrome.api, document, silent, fetch)
  await new Promise(function (resolve) { realSetTimeout(resolve, 80) })
  const back = await optionsChrome.api.storage.local.get('baseUrl')
  assert('cdp-launch-spec：options.html?baseURL= 写进 chrome.storage 且回填输入框',
    optionsStore.get('baseUrl') === 'http://127.0.0.1:4000' && back.baseUrl === 'http://127.0.0.1:4000' &&
      elements.baseUrl && elements.baseUrl.value === 'http://127.0.0.1:4000',
    'storage.baseUrl 读回 = ' + JSON.stringify(String(back.baseUrl || '')) + '；输入框 = ' + JSON.stringify(String(elements.baseUrl && elements.baseUrl.value)))

  // ---- 6. launch 的标签页匹配：URL 归一化三级 ------------------------------
  // 落地 URL 与传入写法常常差一个尾斜杠或一个 fragment，按字符串直比就会退化成
  // "第一个 http(s) 标签"——多标签浏览器里就是拿错页。这里用假 chrome 跑那段表达式。
  const fakeTabs = [
    { id: 1, url: 'https://example.com/', title: 'Example' },
    { id: 2, url: 'https://other.test/x', title: 'Other' }
  ]
  const fakeTabChrome = function (tabs) {
    return {
      storage: { local: { async get(defaults) { return Object.assign({}, defaults, { instanceId: 'chrome-abcd' }) } } },
      tabs: { async query() { return tabs } }
    }
  }
  const runTabInfo = function (want, tabs) {
    const fn = new Function('chrome', 'URL', 'return ' + tabInfoExpr(want))
    return fn(fakeTabChrome(tabs || fakeTabs), URL)
  }
  const noSlash = await runTabInfo('https://example.com')
  const withSlash = await runTabInfo('https://example.com/')
  const withHash = await runTabInfo('https://example.com/#x')
  const miss = await runTabInfo('https://missing.test/', fakeTabs)
  assert('launch 标签页匹配：无尾斜杠 / 带尾斜杠 / 带 fragment 三种写法都命中 exact，未命中才 fallback 并带 candidates',
    noSlash.matched === 'exact' && withSlash.matched === 'exact' && withHash.matched === 'exact' &&
      noSlash.tabId === 1 && withSlash.tabId === 1 && withHash.tabId === 1 &&
      miss.matched === 'fallback' && Array.isArray(miss.candidates) && miss.candidates.length === 2,
    'matched=' + [noSlash.matched, withSlash.matched, withHash.matched, miss.matched].join('/') +
      '；归一化后 want=' + noSlash.want + '；fallback candidates=' + JSON.stringify(miss.candidates.map(function (c) { return c.url })))

  // ---- 7. 不抢焦点：源码里没有窗口置前 ------------------------------------
  // 用户的窗口被提到前台、焦点被抢走，"唯一来源"就是抓之前那次窗口置前。
  // 这里用正则源码扫描（而不是跑一遍）钉住：这两个东西不许再出现。
  const bgSrc = readFileSync(path.join(HERE, 'background.js'), 'utf8')
  const hitsWindowUpdate = /chrome\s*\.\s*windows\s*\.\s*update/.test(bgSrc)
  const hitsFocusedTrue = /\bfocused\s*:\s*true\b/.test(bgSrc)
  assert('ext-no-focus：background.js 里不出现 chrome.windows.update，也不出现 focused 置真（不抢用户焦点）',
    !hitsWindowUpdate && !hitsFocusedTrue,
    'chrome.windows.update ' + (hitsWindowUpdate ? '命中' : '0 处') + '；focused 置真 ' + (hitsFocusedTrue ? '命中' : '0 处') +
      '；' + bgSrc.split('\n').length + ' 行源码')

  // ---- 8. 现场三段：记原 active → 激活 → 抓 → finally 恢复 ----------------
  const hasRestoreFn = /async function restoreActiveTab\s*\(/.test(bgSrc)
  const iRemember = bgSrc.indexOf('await activeTabOf(')
  const iActivate = bgSrc.indexOf('chrome.tabs.update(tabId, { active: true })')
  const iRestore = bgSrc.indexOf('await restoreActiveTab(')
  const restoreInFinally = /finally\s*\{[^}]*restoreActiveTab\(/s.test(bgSrc)
  assert('ext-restore-source：有 restoreActiveTab()，且顺序是「记原 active → 切目标 → 抓 → finally 恢复」（失败也恢复）',
    hasRestoreFn && restoreInFinally && iRemember >= 0 && iActivate > iRemember && iRestore > iActivate,
    '函数 restoreActiveTab ' + (hasRestoreFn ? '在' : '缺') + '；在 finally 里 ' + (restoreInFinally ? '是' : '否') +
      '；下标 记=' + iRemember + ' 切=' + iActivate + ' 恢复=' + iRestore)

  // ---- 9. 假 chrome 桩：抓完真的把原 tab 切回，且全程不碰窗口焦点 --------
  const envR = { badge: '', activeTabId: 11, order: instanceA.order }   // 原本 11(A) 是 active，任务抓 12(B)
  const storeR = new Map([['baseUrl', 'http://127.0.0.1:' + aPort]])
  const fakeR = makeChrome(storeR, envR)
  instanceA.queue.push({ id: 't-restore', tabId: 12 })
  const tickR = loadBackground(fakeR.api)
  await tickR()
  const seqR = envR.tabUpdates.map(function (row) { return row.id + (row.props && row.props.active ? '→active' : '') })
  const lastResultR = instanceA.results[instanceA.results.length - 1]
  const iActR = instanceA.order.indexOf('tabs.update:12 active')
  const iExtractR = instanceA.order.indexOf('extract')
  const iRestoreR = instanceA.order.indexOf('tabs.update:11 active')
  assert('ext-restore（假 chrome 桩）：抓完把原 active tab 切回（顺序 激活→抽取→切回），窗口 update 一次都没调',
    seqR.length === 2 && seqR[0] === '12→active' && seqR[1] === '11→active' &&
      envR.windowUpdates.length === 0 && !!lastResultR && lastResultR.body.ok === true &&
      lastResultR.body.taskId === 't-restore' && iActR >= 0 && iActR < iExtractR && iExtractR < iRestoreR,
    'tabs.update 顺序 ' + JSON.stringify(seqR) + '；windows.update ' + envR.windowUpdates.length + ' 次' +
      '；调用顺序 ' + JSON.stringify(instanceA.order.filter(function (l) { return /^(extract|tabs\.update)/.test(l) })) +
      '；ok=' + String(lastResultR && lastResultR.body.ok))

  // ---- 10. 参考截图（成功路径，假 chrome 桩）-----------------------------
  // 只证明「cap 得到的 PNG 被当成 files[] 里的一项搬走，且字节进了 report 的账」。
  const envS = { badge: '', activeTabId: 11, order: [], capture: { ok: true } }
  const fakeS = makeChrome(new Map([['baseUrl', 'http://127.0.0.1:' + aPort]]), envS)
  instanceA.queue.push({ id: 't-shot', tabId: 12 })
  await loadBackground(fakeS.api)()
  const bodyS = (instanceA.results[instanceA.results.length - 1] || {}).body || {}
  const shotFile = (bodyS.files || []).find(function (file) { return file.path === 'reference/viewport.png' })
  const shotRep = bodyS.report && bodyS.report.screenshot ? bodyS.report.screenshot : {}
  const shotB64 = String(FAKE_PNG_DATA_URL).split(',')[1]
  const shotWant = Math.floor(shotB64.length * 3 / 4) - ((/=*$/.exec(shotB64) || [''])[0].length)
  assert('参考截图（假 chrome 桩）：PNG 落成 files[] 的 reference/viewport.png，字节与 total 都记账',
    bodyS.ok === true && !!shotFile && shotFile.base64 === true && shotFile.bytes === shotWant &&
      shotRep.bytes === shotWant && Number(bodyS.report.bytes) === 13 + shotWant &&
      (bodyS.report.files || []).some(function (file) { return file.path === 'reference/viewport.png' && file.bytes === shotWant }) &&
      envS.captureArgs && envS.captureArgs.format === 'png' && envS.captureCalls === 1,
    'files: ' + (shotFile ? shotFile.path + ' ' + shotFile.bytes + ' B (base64)' : '（缺）') +
      '；report.screenshot.bytes=' + String(shotRep.bytes) + '；report.bytes=' + String(bodyS.report && bodyS.report.bytes) +
      '（entry 13 + 图 ' + shotWant + '）；format=' + String(envS.captureArgs && envS.captureArgs.format) + '；调用 ' + String(envS.captureCalls) + ' 次')

  // ---- 11. 参考截图（失败路径）：不崩、抓取照常完成 -----------------------
  const envF = { badge: '', activeTabId: 11, order: [], capture: { ok: false, error: 'Failed to capture visible tab' } }
  const fakeF = makeChrome(new Map([['baseUrl', 'http://127.0.0.1:' + aPort]]), envF)
  instanceA.queue.push({ id: 't-shot-fail', tabId: 12 })
  await loadBackground(fakeF.api)()
  const bodyF = (instanceA.results[instanceA.results.length - 1] || {}).body || {}
  const shotF = bodyF.report && bodyF.report.screenshot ? bodyF.report.screenshot : {}
  const noShotFile = !(bodyF.files || []).some(function (file) { return file.path === 'reference/viewport.png' })
  assert('参考截图失败不阻塞抓取：ok=true、没有 viewport 文件、report.screenshot.error 照实写',
    bodyF.ok === true && noShotFile && String(shotF.error || '').indexOf('Failed to capture') >= 0 && shotF.mode === 'viewport',
    'ok=' + String(bodyF.ok) + '；viewport 文件 ' + (noShotFile ? '没有' : '居然有') + '；error=' + JSON.stringify(shotF.error) +
      '；screenshot.mode=' + String(shotF.mode))

  try { a.server.close() } catch (e) {}
  try { b.server.close() } catch (e) {}
  return { ports: { a: aPort, b: bPort }, registry: registry.port }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (isMain) {
  const results = []
  const assert = function (name, ok, detail) { results.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail) }) }
  runHubChecks(assert).then(function (info) {
    console.log('== hub 断言（假登记台 127.0.0.1:' + info.registry + ' + 两个假实例 ' + info.ports.a + '/' + info.ports.b + '）==')
    let failed = 0
    for (const row of results) {
      if (!row.ok) failed += 1
      console.log((row.ok ? '  PASS  ' : '  FAIL  ') + row.name + (row.detail ? '   — ' + row.detail : ''))
    }
    console.log('')
    console.log(failed === 0 ? '[hub-check] 全部通过（' + results.length + '/' + results.length + '）' : '[hub-check] 失败 ' + failed + ' 条')
    process.exitCode = failed === 0 ? 0 : 1
  }, function (e) {
    console.error('[hub-check] 崩了：' + (e && e.stack || e))
    process.exitCode = 1
  })
}
