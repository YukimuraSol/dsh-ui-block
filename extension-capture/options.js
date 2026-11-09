// dsh-page-capture / options.js
// 只做三件事：读/写 chrome.storage.local、随手把开关状态打到徽标上、按当前设置试一次 poll。
const DEFAULTS = { baseUrl: 'http://127.0.0.1:4000', instance: 'chrome', token: '', enabled: true }
const $ = function (id) { return document.getElementById(id) }

function say(text) { $('out').textContent = text }

async function load() {
  const got = await chrome.storage.local.get(DEFAULTS)
  const cfg = Object.assign({}, DEFAULTS, got)
  $('baseUrl').value = cfg.baseUrl
  $('instance').value = cfg.instance
  $('token').value = cfg.token
  $('enabled').checked = !!cfg.enabled
  say('当前：' + (cfg.enabled ? '上报中' : '已关闭（不发请求）') + ' → ' + cfg.baseUrl + ' / ' + cfg.instance)
}

async function save() {
  const cfg = {
    baseUrl: String($('baseUrl').value || '').trim().replace(/\/+$/, '') || DEFAULTS.baseUrl,
    instance: String($('instance').value || '').trim() || DEFAULTS.instance,
    token: String($('token').value || '').trim(),
    enabled: !!$('enabled').checked
  }
  await chrome.storage.local.set(cfg)
  say('已保存：' + (cfg.enabled ? '上报中' : '已关闭') + ' → ' + cfg.baseUrl + ' / ' + cfg.instance)
}

async function test() {
  const base = String($('baseUrl').value || '').trim().replace(/\/+$/, '') || DEFAULTS.baseUrl
  const instance = String($('instance').value || '').trim() || DEFAULTS.instance
  const token = String($('token').value || '').trim()
  let url = base + '/ui-blocks/agent/poll'
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
$('test').addEventListener('click', function () { test() })
$('enabled').addEventListener('change', function () { save().catch(function () {}) })
load().catch(function (e) { say('读取配置失败：' + e.message) })
