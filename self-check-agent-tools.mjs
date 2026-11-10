/**
 * Self-check for the two capture tools: list_pages and capture_page.
 *
 *   node self-check-agent-tools.mjs
 *
 * Mounts the plugin against a stub Cordis context with a throwaway DSH_HOME, so
 * the tools and the endpoints they lean on run in one process with no browser:
 *
 *   1. list_pages with nothing connected answers [] and a checklist, not a blank
 *   2. a reported tab list comes back row for row, capturable:false + reason kept
 *   3. the instance filter narrows the list and never invents rows
 *   4. a report older than 10 minutes marks its rows stale
 *   5. capture_page: queue -> poll takes it -> result lands -> dir + files[].from,
 *      and every from is a real file with the bytes the report claims
 *   6. a timeout says which of the three silences happened
 *   7. a target tab that disappears fails fast, naming the tab
 *   8. an extension-reported failure repeats the extension's own words
 */
import assert from 'node:assert/strict'
import { readFileSync, statSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

const tempHome = await mkdtemp(join(tmpdir(), 'dsh-agent-tools-home-'))
process.env.DSH_HOME = tempHome

const { apply, extensionHub, instanceRegistry } = await import('./index.js')
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

const checks = []
const checkAsync = async (name, fn) => { await fn(); checks.push(name); console.log('  ok - ' + name) }

const tools = new Map()
const routes = []
const stubCtx = {
  tools: { register: (definition) => { tools.set(definition.name, definition); return () => {} } },
  inject: (services, fn) => { fn({ webServer: { port: 4000, register: (route) => { routes.push(route); return () => {} } } }) },
  logger: { warn: () => {}, info: () => {} }
}
// registry.enabled:false — a test run must never fight a real instance over
// 127.0.0.1:38520. The registry itself is exercised on ephemeral ports below.
apply(stubCtx, { agent: { enabled: true }, registry: { enabled: false } })

const agentRoute = () => routes.filter((route) => route.path === '/ui-blocks/agent').pop()
const tool = (name) => {
  const found = tools.get(name)
  if (found === undefined) throw new Error('tool not registered: ' + name + ' (have: ' + [...tools.keys()].join(', ') + ')')
  return found
}
/** The rendered text of one tool value — what the model actually reads. */
const render = (name, args, value) => tool(name).output.render(args, value).map((part) => part.text).join('\n')

/** The slice of http.IncomingMessage the handler touches, plus a JSON body. */
function request({ method = 'POST', path = '/', body } = {}) {
  const text = body === undefined ? '' : JSON.stringify(body)
  return {
    method,
    url: path,
    headers: {},
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() { if (text !== '') yield Buffer.from(text, 'utf8') }
  }
}
/** The slice of http.ServerResponse the handler touches. */
function response() {
  const out = { status: 0, headers: {}, text: '' }
  return {
    out,
    writeHead(status, headers) { out.status = status; out.headers = headers },
    end(chunk) { if (chunk !== undefined) out.text += String(chunk) },
    json() { return JSON.parse(out.text) }
  }
}
async function call(options) {
  const res = response()
  await agentRoute().handler(request(options), res)
  return res
}
const poll = (body) => call({ path: '/ui-blocks/agent/poll', body })
const result = (body) => call({ path: '/ui-blocks/agent/result', body })

/** Two tabs, one of them a page that can never be captured. */
const TABS = [
  { tabId: 7, url: 'https://example.com/a', title: 'Example A', focused: true, capturable: true },
  { tabId: 9, url: 'chrome://settings', title: 'Settings', focused: false, capturable: false, reason: 'chrome:// page' }
]

console.log('--- 1. nothing connected: [] and a checklist, never a blank ---')
await checkAsync('list_pages answers an empty array', async () => {
  const value = await tool('list_pages').execute({})
  assert.deepEqual(value, [])
})
await checkAsync('the rendered text names all five things to check', async () => {
  const value = await tool('list_pages').execute({})
  const text = render('list_pages', {}, value)
  assert.match(text, /no extension has reported/i)
  for (const needle of ['chrome:\/\/extensions must list dsh-page-capture', 'baseURL', 'http://127.0.0.1:4000', 'reporting switch', 'agent.enabled', 'capturable=false']) {
    assert.match(text, new RegExp(needle), 'missing: ' + needle)
  }
  assert.doesNotMatch(text, /^\s*$/)
})
await checkAsync('the port is this instance\'s, learned from the web server', async () => {
  const text = render('list_pages', {}, [])
  assert.match(text, /http:\/\/127\.0\.0\.1:4000/)
})

console.log('--- 2. a reported tab list comes back row for row ---')
await checkAsync('two tabs -> two rows, capturable:false keeps its reason', async () => {
  const res = await poll({ instance: 'probe-ext', tabs: TABS })
  assert.equal(res.out.status, 200)
  const value = await tool('list_pages').execute({})
  assert.equal(value.length, 2)
  const [first, second] = value
  assert.deepEqual(
    { instance: first.instance, tabId: first.tabId, url: first.url, title: first.title, focused: first.focused, capturable: first.capturable, stale: first.stale },
    { instance: 'probe-ext', tabId: 7, url: 'https://example.com/a', title: 'Example A', focused: true, capturable: true, stale: false }
  )
  assert.equal(second.tabId, 9)
  assert.equal(second.capturable, false)
  assert.equal(second.reason, 'chrome:// page')
  assert.equal(typeof first.seenAt, 'string')
  assert.equal(new Date(first.seenAt).getTime() > Date.now() - 5000, true)
})
await checkAsync('the rendered table marks the uncapturable row and explains why', async () => {
  const value = await tool('list_pages').execute({})
  const text = render('list_pages', {}, value)
  assert.match(text, /^\[cannot capture\] instance=probe-ext tabId=9 \| Settings \| chrome:\/\/settings/m)
  assert.match(text, /tabId=7 \| Example A \| https:\/\/example.com\/a \| focused/)
})

console.log('--- 3. the instance filter ---')
await checkAsync('a second instance is listed, and the filter separates them', async () => {
  await poll({ instance: 'other-ext', tabs: [{ tabId: 1, url: 'https://example.org/', title: 'Org', focused: true, capturable: true }] })
  assert.equal((await tool('list_pages').execute({})).length, 3)
  const only = await tool('list_pages').execute({ instance: 'other-ext' })
  assert.deepEqual(only.map((row) => row.tabId), [1])
})
await checkAsync('an unknown instance lists nothing and says which ones are reporting', async () => {
  const text = render('list_pages', { instance: 'ghost' }, await tool('list_pages').execute({ instance: 'ghost' }))
  assert.match(text, /No browser tab is on the list for instance "ghost"/)
  assert.match(text, /Instances reporting right now: probe-ext, other-ext/)
})

console.log('--- 4. an old report is marked stale ---')
await checkAsync('a report 11 minutes old marks every row stale:true', async () => {
  const seen = extensionHub.hub.instances.get('probe-ext')
  seen.at = Date.now() - 11 * 60 * 1000
  const rows = await tool('list_pages').execute({ instance: 'probe-ext' })
  assert.deepEqual(rows.map((row) => row.stale), [true, true])
  const text = render('list_pages', { instance: 'probe-ext' }, rows)
  assert.match(text, /STALE: last reported/)
  seen.at = Date.now()
})

console.log('--- 5. capture_page: queue, take, result, material on disk ---')
await checkAsync('the whole loop returns dir + files[].from with real bytes', async () => {
  const pending = tool('capture_page').execute({ instance: 'probe-ext', tabId: 7, name: 'agent-tools-check' })
  const taken = (await poll({ instance: 'probe-ext', tabs: TABS })).json()
  assert.equal(taken.task.tabId, 7)
  assert.equal(taken.task.name, 'agent-tools-check')
  const posted = await result({
    instance: 'probe-ext',
    taskId: taken.task.id,
    ok: true,
    files: [
      { path: 'entry.html', content: '<p>captured</p>' },
      { path: 'shared/card.css', content: 'body{color:#123456}' }
    ],
    report: { origin: 'https://example.com/a', title: 'Example A', sections: 2, dropped: ['big.png', 'tracker.gif'] }
  })
  assert.equal(posted.out.status, 200)
  const value = await pending
  assert.equal(value.dir, join(tempHome, 'ui-captures', 'agent-tools-check'))
  assert.deepEqual(value.files.map((file) => file.path), ['entry.html', 'shared/card.css'])
  for (const file of value.files) {
    assert.equal(file.from, join(value.dir, file.path))
    assert.equal(statSync(file.from).size, file.bytes, 'bytes on disk match the returned count: ' + file.path)
  }
  assert.equal(readFileSync(value.files[0].from, 'utf8'), '<p>captured</p>')
  assert.match(value.summary, /2 file\(s\), 34 bytes total, 2 resource\(s\) dropped/)
})
await checkAsync('the report is report.json verbatim, and the text points at files[].from', async () => {
  // Same shape as the call above, run again to get a value to inspect.
  const pending = tool('capture_page').execute({ instance: 'probe-ext', tabId: 7, name: 'agent-tools-check-report' })
  const taken = (await poll({ instance: 'probe-ext', tabs: TABS })).json()
  await result({ instance: 'probe-ext', taskId: taken.task.id, ok: true, files: [{ path: 'entry.html', content: '<p>x</p>' }], report: { origin: 'https://example.com/a', title: 'A', dropped: 1, rulesTotal: 812 } })
  const value = await pending
  const onDisk = JSON.parse(readFileSync(join(value.dir, 'report.json'), 'utf8'))
  assert.deepEqual(value.report, onDisk)
  assert.equal(value.report.origin, 'https://example.com/a')
  assert.equal(value.report.rulesTotal, 812)
  assert.equal(value.report.capture.taskId, taken.task.id)
  const text = render('capture_page', {}, value)
  assert.equal(text.includes('from=' + value.files[0].from), true, 'the rendered text spells the absolute from path')
  assert.match(text, /create_ui_block/)
  assert.match(text, /none of this material enters the conversation/)
})

console.log('--- 6. a timeout names the silence ---')
await checkAsync('nobody polls at all -> "never reported in"', async () => {
  await assert.rejects(
    () => tool('capture_page').execute({ instance: 'ghost-ext', tabId: 3, timeout_ms: 1200 }),
    (error) => {
      assert.match(error.message, /no material came back within 1s/)
      assert.match(error.message, /never reported in/)
      assert.match(error.message, /baseURL/)
      return true
    }
  )
  assert.equal(extensionHub.hub.tasks.length, 0, 'the abandoned task is dropped, so it cannot hijack a later poll')
})
await checkAsync('the instance polls but never takes the task -> "never took the task"', async () => {
  // A task for a DIFFERENT instance is invisible to this poller, which is how a
  // queue that never gets drained looks from the tool's side.
  await poll({ instance: 'probe-ext', tabs: TABS })
  const queued = extensionHub.hub.enqueue({ instance: 'nobody-ext', tabId: 42 })
  await assert.rejects(
    () => tool('capture_page').execute({ instance: 'probe-ext', tabId: 7, timeout_ms: 1200 }),
    /never took the task off the queue/
  )
  extensionHub.hub.tasks = extensionHub.hub.tasks.filter((task) => task.id !== queued.id)
})
await checkAsync('taken but silent -> "took the task and never answered"', async () => {
  const pending = tool('capture_page').execute({ instance: 'probe-ext', tabId: 7, timeout_ms: 1200 })
  await poll({ instance: 'probe-ext', tabs: TABS })
  await assert.rejects(() => pending, /took the task and never answered/)
})

console.log('--- 7. a target tab that disappears fails fast ---')
await checkAsync('tab gone -> names the tabId, does NOT substitute another tab', async () => {
  await poll({ instance: 'probe-ext', tabs: TABS })
  const pending = tool('capture_page').execute({ instance: 'probe-ext', tabId: 7, timeout_ms: 20000 })
  await poll({ instance: 'probe-ext', tabs: TABS }).catch(() => {})
  await poll({ instance: 'probe-ext', tabs: [{ ...TABS[1] }] })
  const started = Date.now()
  await assert.rejects(() => pending, (error) => {
    assert.match(error.message, /the target tab is gone — tabId 7/)
    assert.match(error.message, /call list_pages again/)
    return true
  })
  assert.equal(Date.now() - started < 15000, true, 'it failed early instead of waiting out the 20s budget')
})
await checkAsync('the tab comes back and the list is usable again', async () => {
  await poll({ instance: 'probe-ext', tabs: TABS })
  assert.equal((await tool('list_pages').execute({ instance: 'probe-ext' })).length, 2)
})

console.log('--- 8. an extension-reported failure keeps its own words ---')
await checkAsync('ok:false -> the message repeats the extension error verbatim', async () => {
  const pending = tool('capture_page').execute({ instance: 'probe-ext', tabId: 7, timeout_ms: 5000 })
  const taken = (await poll({ instance: 'probe-ext', tabs: TABS })).json()
  await result({
    instance: 'probe-ext',
    taskId: taken.task.id,
    ok: false,
    files: [],
    report: { origin: 'https://example.com/a' },
    error: 'tabs.update failed: the page is in the background and refused to activate'
  })
  await assert.rejects(() => pending, (error) => {
    assert.match(error.message, /the extension itself reported a failure/)
    assert.match(error.message, /tabs.update failed: the page is in the background and refused to activate/)
    return true
  })
})
await checkAsync('an empty material set is refused, not handed on as a block', async () => {
  const pending = tool('capture_page').execute({ instance: 'probe-ext', tabId: 7, timeout_ms: 5000 })
  const taken = (await poll({ instance: 'probe-ext', tabs: TABS })).json()
  await result({ instance: 'probe-ext', taskId: taken.task.id, ok: true, files: [], report: { origin: 'https://example.com/a' } })
  await assert.rejects(() => pending, /answered but sent no files/)
})

console.log('--- 9. bad arguments are refused before a task is queued ---')
await checkAsync('a name create_ui_block would reject never reaches the queue', async () => {
  await assert.rejects(() => tool('capture_page').execute({ instance: 'probe-ext', tabId: 7, name: 'bad/name' }), /name must be 1-64 chars/)
  assert.equal(extensionHub.hub.tasks.length, 0)
})
await checkAsync('a non-numeric tabId never reaches the queue', async () => {
  // The registry rejects it from the schema before the body runs; the body's own
  // guard is the second line for a programmatic caller.
  await assert.rejects(() => tool('capture_page').execute({ instance: 'probe-ext', tabId: 'seven' }), /tabId.*must be a number/)
  assert.equal(extensionHub.hub.tasks.length, 0)
})

console.log('--- 10. a poll that omits tabs keeps the last list; tabs:[] clears it ---')
await checkAsync('a poll without the tabs field keeps the previous list', async () => {
  await poll({ instance: 'keep-ext', tabs: TABS })
  assert.equal((await tool('list_pages').execute({ instance: 'keep-ext' })).length, 2)
  // The extension's fingerprint-only round: instance + tabsTag, no tabs.
  const fingerprintOnly = await poll({ instance: 'keep-ext', tabsTag: 'same-ish-tag' })
  assert.equal(fingerprintOnly.out.status, 200)
  assert.deepEqual((await tool('list_pages').execute({ instance: 'keep-ext' })).map((row) => row.tabId), [7, 9])
})
await checkAsync('tabs: [] is the one way to say "this browser has no tabs now"', async () => {
  await poll({ instance: 'keep-ext', tabs: [] })
  assert.equal((await tool('list_pages').execute({ instance: 'keep-ext' })).length, 0)
  assert.match(render('list_pages', { instance: 'keep-ext' }, []), /No browser tab is on the list for instance "keep-ext"/)
  // The hub itself now holds zero tabs for it — the cleared list, not a stale copy.
  assert.equal(extensionHub.hub.instances.get('keep-ext').tabs.length, 0)
})

console.log('--- 11. /ui-block-extension/info names who is connected right now ---')
const infoRoute = () => routes.filter((route) => route.path === '/ui-block-extension').pop()
async function infoCall() {
  const res = response()
  await infoRoute().handler(request({ method: 'GET', path: '/ui-block-extension/info' }), res)
  return res
}
await checkAsync('agents carries instance, lastSeenAt and the tab count', async () => {
  await poll({ instance: 'probe-ext', tabs: TABS })
  const body = (await infoCall()).json()
  assert.equal(Array.isArray(body.agents), true)
  const probe = body.agents.find((agent) => agent.instance === 'probe-ext')
  assert.ok(probe, 'probe-ext appears in agents')
  assert.deepEqual(Object.keys(probe).sort(), ['instance', 'lastSeenAt', 'tabs'])
  assert.equal(probe.tabs, 2)
  assert.equal(new Date(probe.lastSeenAt).getTime() > Date.now() - 5000, true)
  const keep = body.agents.find((agent) => agent.instance === 'keep-ext')
  assert.equal(keep.tabs, 0, 'an instance that reported zero tabs says zero, not "missing"')
})
await checkAsync('the info answer keeps the install fields and carries no token', async () => {
  const body = (await infoCall()).json()
  assert.equal(typeof body.dir, 'string')
  assert.equal(typeof body.captureDir, 'string')
  assert.equal(typeof body.captureExists, 'boolean')
  assert.equal(JSON.stringify(body).toLowerCase().includes('token'), false)
})

console.log('--- 12. the instance registry: reuse, auth, expiry, idle shutdown ---')
const { createRegistry, createRegistryClient, REGISTRY_EXPIRE_MS } = instanceRegistry
const TOKEN = 'self-check-token-0123456789'
const reg = createRegistry({ port: 0, token: TOKEN })
await reg.start()
const regPort = reg.port()
const instancesOf = async (port) => (await (await fetch('http://127.0.0.1:' + String(port) + '/instances')).json()).instances
const postRegister = (port, body, headers) => fetch('http://127.0.0.1:' + String(port) + '/register', {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers === undefined ? {} : headers },
  body: JSON.stringify(body)
})

await checkAsync('/health identifies the registry and /instances lists ports only', async () => {
  const health = await (await fetch('http://127.0.0.1:' + String(regPort) + '/health')).json()
  assert.equal(health.service, instanceRegistry.REGISTRY_SERVICE)
  const accepted = await postRegister(regPort, { port: 41001, instance: 'A', bootAt: 111 }, { 'x-uiblock-token': TOKEN })
  assert.equal(accepted.status, 200)
  const rows = await instancesOf(regPort)
  assert.deepEqual(rows.map((row) => row.port), [41001])
  assert.deepEqual(Object.keys(rows[0]).sort(), ['bootAt', 'instance', 'lastSeenAt', 'port'])
  assert.equal(JSON.stringify(rows).includes(TOKEN), false, 'the table never carries the token')
})
await checkAsync('a registration without the token is refused and changes nothing', async () => {
  assert.equal((await postRegister(regPort, { port: 41002, instance: 'X' })).status, 401)
  assert.equal((await postRegister(regPort, { port: 41002, instance: 'X' }, { 'x-uiblock-token': 'wrong' })).status, 401)
  assert.deepEqual((await instancesOf(regPort)).map((row) => row.port), [41001])
})
await checkAsync('45s without a heartbeat drops the row', async () => {
  assert.deepEqual(reg.table(Date.now() + REGISTRY_EXPIRE_MS + 1000), [])
})
await checkAsync('a second instance reuses the listener instead of binding its own', async () => {
  const first = createRegistryClient({ instancePort: 41001, instance: 'A', registryPort: regPort, token: TOKEN, log: () => {} })
  await first.start()
  const second = createRegistryClient({ instancePort: 41002, instance: 'B', registryPort: regPort, token: TOKEN, log: () => {} })
  await second.start()
  assert.deepEqual((await instancesOf(regPort)).map((row) => row.instance), ['A', 'B'])
  assert.equal(first.status().hosting, false)
  assert.equal(second.status().hosting, false)
  first.stop()
  second.stop()
})
await checkAsync('after the idle window with no heartbeat it closes itself, and the next client binds a new one', async () => {
  const host = createRegistry({ port: 0, token: TOKEN, idleMs: 300 })
  await host.start()
  const hostedPort = host.port()
  host.register({ port: 41003, instance: 'C', bootAt: 1 })
  await sleep(1000)
  assert.equal(host.isClosed(), true, 'the listener closed itself')
  assert.equal(host.closedAt() > host.startedAt(), true)
  let again
  for (let attempt = 0; attempt < 10 && again === undefined; attempt += 1) {
    const candidate = createRegistry({ port: hostedPort, token: TOKEN, idleMs: 60000 })
    try {
      await candidate.start()
      again = candidate
    } catch {
      await sleep(100)
    }
  }
  assert.ok(again, 'the port is free again, so a later instance can host it')
  assert.equal(again.port(), hostedPort)
  assert.equal(again.startedAt() >= host.closedAt(), true)
  again.stop('test done')
})
await checkAsync('a non-registry listener on the port is reported once, never retried', async () => {
  const foreign = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('hello') })
  await new Promise((resolve) => foreign.listen(0, '127.0.0.1', resolve))
  const foreignPort = foreign.address().port
  const logged = []
  const client = createRegistryClient({ instancePort: 41004, instance: 'D', registryPort: foreignPort, token: TOKEN, heartbeatMs: 40, log: (line) => logged.push(line) })
  await client.start()
  assert.match(client.status().degraded, /not the instance registry/)
  assert.equal(logged.filter((line) => /disabled for this instance/.test(line)).length, 1)
  await sleep(250)
  assert.equal(logged.filter((line) => /disabled for this instance/.test(line)).length, 1, 'it logged once instead of looping')
  client.stop()
  await new Promise((resolve) => foreign.close(resolve))
})
reg.stop('test done')

await rm(tempHome, { recursive: true, force: true })
console.log('self-check-agent-tools: ' + checks.length + ' checks OK')
