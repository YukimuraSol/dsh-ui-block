// dsh-page-capture / options.js
// 四件事：读/写 chrome.storage.local、把 ?baseURL= 查询参数写进 storage（launch.mjs
// 用这条精确指定实例）、按当前设置试一次 poll、点「自动发现」问后台要实例表。
const DEFAULTS = { baseUrl: '', instance: 'chrome', token: '', enabled: true }
const $ = function (id) { return document.getElementById(id) }

function say(text) { $('out').textContent = text }

function cleanBase(value) {
  const base = String(value || '').trim().replace(/\/+$/, '')
  if (base === '') return ''
  return /^https?:\/\/[^\s]+$/i.test(base) ? base : null
}

/**
 * options.html?baseURL=http://127.0.0.1:4000 —— agent 自建的浏览器用这条打开本页，
 * 写进 storage 之后后台下一次 poll 就打这个实例。参数名 baseURL / baseUrl 都认。
 * @returns the address written, or '' when the query carried none / was invalid.
 */
async function applyQueryBaseUrl() {
  const params = new URLSearchParams(String((globalThis.location && globalThis.location.search) || ''))
  const raw = params.get('baseURL') || params.get('baseUrl') || ''
  const base = cleanBase(raw)
  if (!base) return ''
  await chrome.storage.local.set({ baseUrl: base })
  return base
}

async function load() {
  const got = await chrome.storage.local.get(DEFAULTS)
  const cfg = Object.assign({}, DEFAULTS, got)
  $('baseUrl').value = cfg.baseUrl
  $('instance').value = cfg.instance
  $('token').value = cfg.token
  $('enabled').checked = !!cfg.enabled
  let line = '当前：' + (cfg.enabled ? '上报中' : '已关闭（不发请求）') + ' → ' + (cfg.baseUrl || '自动发现（打登记表里每个实例）') + ' / ' + cfg.instance
  try {
    const status = await chrome.runtime.sendMessage({ type: 'dsh-capture-status' })
    const reg = status && status.registry
    if (reg && !cfg.baseUrl) {
      const rows = reg.instances || []
      line += String.fromCharCode(10) + '实例表：' + reg.source + (rows.length ? ' → ' + rows.map(function (r) { return '127.0.0.1:' + r.port }).join('、') : '（空）')
    }
  } catch (e) {}
  say(line)
}

async function save() {
  const base = cleanBase($('baseUrl').value)
  if (base === null) { say('base URL 只能是 http(s) 地址，或留空 = 自动发现'); return }
  const cfg = {
    baseUrl: base,
    instance: String($('instance').value || '').trim() || DEFAULTS.instance,
    token: String($('token').value || '').trim(),
    enabled: !!$('enabled').checked
  }
  await chrome.storage.local.set(cfg)
  say('已保存：' + (cfg.enabled ? '上报中' : '已关闭') + ' → ' + (cfg.baseUrl || '自动发现') + ' / ' + cfg.instance)
}

async function discover() {
  say('发现中…（登记台 → 缓存 → 本机探测 3000-4100）')
  try {
    const answer = await chrome.runtime.sendMessage({ type: 'dsh-capture-discover' })
    if (!answer) { say('后台没有应答（扩展刚重载？关掉本页再开一次）'); return }
    if (answer.ok === false) { say('发现失败：' + (answer.error || '未知原因')); return }
    if (answer.source === 'config') { say('已显式配置，跳过发现：' + answer.pinned + String.fromCharCode(10) + '清空 base URL 保存后才会自动发现。'); return }
    const rows = answer.instances || []
    say('来源 ' + answer.source + '：' + (rows.length ? rows.map(function (r) { return '127.0.0.1:' + r.port }).join('、') : '一个实例也没应答'))
  } catch (e) {
    say('发现失败：' + String(e && e.message || e))
  }
}

async function test() {
  const target = cleanBase($('baseUrl').value)
  const instance = String($('instance').value || '').trim() || DEFAULTS.instance
  const token = String($('token').value || '').trim()
  if (!target) { say('没有填 base URL：后台按实例表多播上报，不需要在这里测单个端口。'); return }
  let url = target + '/ui-blocks/agent/poll'
  if (token) url += '?token=' + encodeURIComponent(token)
  say('POST ' + url + ' …')
  const t0 = Date.now()
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ instance: instance, tabs: [] }),
      cache: 'no-store'
    })
    const text = await res.text()
    let pretty = text
    try { pretty = JSON.stringify(JSON.parse(text), null, 2) } catch (e) {}
    say('HTTP ' + res.status + ' · ' + (Date.now() - t0) + 'ms' + (res.status === 404 ? '（插件侧 agent.enabled 可能是关的）' : '') + String.fromCharCode(10) + pretty.slice(0, 1200))
  } catch (e) {
    say('连不上：' + String(e && e.message || e) + String.fromCharCode(10) + '检查 DSH 是否在跑、端口是否与 base URL 一致。')
  }
}

$('save').addEventListener('click', function () { save().catch(function (e) { say('保存失败：' + e.message) }) })
$('discover').addEventListener('click', function () { discover() })
$('test').addEventListener('click', function () { test() })
$('enabled').addEventListener('change', function () { save().catch(function () {}) })

// 启动：先吃 ?baseURL=（有就写进 storage），再按 storage 渲染
applyQueryBaseUrl().then(function (written) {
  return load().then(function () {
    if (!written) return
    return chrome.storage.local.get('baseUrl').then(function (got) {
      say('已从链接写入 base URL：' + written + String.fromCharCode(10) + '读回 storage.baseUrl = ' + String(got && got.baseUrl || '') + String.fromCharCode(10) + '（后台下一轮 poll 就打它）')
    })
  })
}).catch(function (e) { say('读取配置失败：' + String(e && e.message || e)) })
