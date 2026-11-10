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

const HERE = path.dirname(fileURLToPath(import.meta.url))
const realSetTimeout = setTimeout
const silent = { log() {}, info() {}, warn() {}, error() {} }

const TAB_A = { id: 11, url: 'http://example.test/a', title: 'A', windowId: 1, active: false }
const TAB_B = { id: 12, url: 'https://example.test/b', title: 'B', windowId: 1, active: false }

/** 假 chrome：行为对齐 MV3 里用到的那些 API，storage 用外部传入的 Map（跨"重启"复用）。 */
function makeChrome(store, env) {
  const listeners = { message: [], storageChanged: [] }
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
      getPlatformInfo(cb) { if (cb) cb({ os: 'win' }) },
      openOptionsPage() {},
      async sendMessage() { return { enabled: true, baseUrl: store.get('baseUrl') || '', instance: 'chrome', registry: { source: 'none', at: 0, instances: [] } } }
    },
    action: {
      onClicked: { addListener() {} },
      setBadgeText(o) { env.badge = String(o && o.text || '') },
      setBadgeBackgroundColor() {}
    },
    windows: { async getLastFocused() { return { id: 1 } }, async update() {} },
    tabs: {
      async query() { return [TAB_A, TAB_B] },
      async get(id) {
        const tab = [TAB_A, TAB_B].find((t) => t.id === id)
        if (!tab) throw new Error('No tab with id: ' + id)
        return tab
      },
      async update() {}
    },
    scripting: {
      async executeScript(options) {
        if (options && options.files) return []
        return [{ result: { files: [{ path: 'entry.html', content: '<html></html>', bytes: 13, base64: false }], report: { bytes: 13, files: [], dropped: [] } } }]
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
  const instanceA = { polls: [], results: [], queue: [{ id: 't-A1', tabId: 11 }] }
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
