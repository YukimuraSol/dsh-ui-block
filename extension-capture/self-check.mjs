// self-check.mjs — 离线自检：不依赖 DSH 端点。前半段（hub-check.mjs）用假 chrome
// 跑 background.js / options.js 的发现与上报，后半段用无头 Chrome 跑 extractor.js。
// 做法：无头 Chrome 打开 about:blank → 注入一段带 --dsw-* 变量的测试 DOM →
// 把 extractor.js 原文 Runtime.evaluate 进去 → 跑抽取 → 对产出做断言 → 落盘。
// 跑法：node self-check.mjs      （产出写在 out-selfcheck/，已 gitignore）
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
// 扩展侧「发现 / 多播 / 缓存 / ?baseURL=」这几条不依赖浏览器，由 hub-check.mjs 跑
// （假登记台 + 两个假实例，装的是 background.js / options.js 的真实源码）。
import { runHubChecks } from './hub-check.mjs';

const NL = String.fromCharCode(10);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'out-selfcheck');

// cdp.mjs 正在被另一个 worker 从 ui-snapshot\ 搬到 tools\，两处都找。
const CDP_CANDIDATES = [
  path.resolve(HERE, '..', 'tools', 'cdp.mjs'),
  path.resolve(HERE, '..', '..', 'ui-snapshot', 'cdp.mjs'),
  path.resolve(HERE, '..', '..', 'dsh-ui-block', 'tools', 'cdp.mjs'),
];

function pickCdp() {
  for (const p of CDP_CANDIDATES) if (existsSync(p)) return p;
  throw new Error('找不到 cdp.mjs，试过：' + NL + CDP_CANDIDATES.join(NL));
}

// 测试 DOM，四类样本一次全覆盖：
//   正例   --dsw-* 变量 + 真命中规则 + 2400px 宽 SVG（降采样后能内嵌）
//   反例1  死选择器 .dead-selector... 与半个死列表 .gone-1,.card
//   反例2  src="/abs/missing.png"（取不到 → dropped，且不许留根绝对路径）
//   反例3  噪声 PNG 超内嵌上限（落 assets/，证明 ../../ 前缀）
//          + 1.5MB 假 woff2（字体不能降采样 → 落 assets/，证明 ../ 前缀）
//   跨域    logo（另一台主机，必须走后台取字节）、358x20870 长条图、srcset 三档
function buildFixture(P) {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="2400" height="1200">' +
    '<rect width="2400" height="1200" fill="#4a7bd0"/><circle cx="1200" cy="600" r="420" fill="#d9a441"/></svg>';

  // 噪声 PNG：几乎不可压缩，800x800 约 1.8 MB——超 1.4 MB 内嵌上限、未超 2 MB 单文件上限，
  // 因此走「原尺寸落文件」这条路，正好证明 ../../ 前缀与落文件分支都还在。
  const cv = document.createElement('canvas');
  cv.width = 800; cv.height = 800;
  const cx = cv.getContext('2d');
  const img = cx.createImageData(800, 800);
  let seed = 1234567;
  for (let i = 0; i < img.data.length; i += 4) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    img.data[i] = seed & 255;
    img.data[i + 1] = (seed >> 8) & 255;
    img.data[i + 2] = (seed >> 16) & 255;
    img.data[i + 3] = 255;
  }
  cx.putImageData(img, 0, 0);
  const noise = cv.toDataURL('image/png');

  // 假 woff2：约 1.5 MB（超 1.4 MB 内嵌上限），内容无所谓，这条只验证「超限就落文件」
  let b64 = '';
  const CH = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let x = 987654321;
  while (b64.length < 2000000) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    b64 += CH[x & 63];
  }

  document.head.innerHTML = '<title>self-check fixture</title><style>' + [
    ':root{--dsw-accent:#4a7bd0;--dsw-fg:rgb(24,24,27);--dsw-radius:12px;--dsw-gap:16px;--dsw-shadow:0 2px 8px rgba(0,0,0,.2);}',
    'body{margin:0;font-family:system-ui;color:var(--dsw-fg);background:#fff;}',
    '.wrap{display:grid;grid-template-columns:1fr 240px;gap:var(--dsw-gap);padding:24px;}',
    '.card{background:var(--dsw-accent);color:#fff;border-radius:var(--dsw-radius);box-shadow:var(--dsw-shadow);padding:20px;font-size:18px;line-height:1.5;}',
    '.dead-selector-that-matches-nothing{color:red;}',
    '.gone-1,.card{letter-spacing:.02em;}',
    'h1{margin:0 0 12px 0;font-size:28px;}',
    'p{margin:0;color:#333;}',
    '.hero{background-image:url(' + noise + ');background-size:cover;height:120px;}',
    '@font-face{font-family:CapTest;src:url(data:font/woff2;base64,' + b64 + ') format("woff2");}',
    '@keyframes pulse{0%{opacity:.5}100%{opacity:1}}',
    '.thumb{width:240px;height:120px;object-fit:cover;border-radius:8px;}',
    // 根绝对引用（真实事故形态）：CSS 里写 url(/static/…)。它必须被改写成本地段，
    // 不能因为调用方传了 includes 就原样留在产物里。
    '.probe{background-image:url(/static/probe.svg);width:16px;height:16px;}'
  ].join('') + '</style>';
  document.body.innerHTML = '<main class="wrap">' +
    '<section><h1 id="headline">抓取自检</h1><p id="tagline">目标元素在这里</p></section>' +
    '<div class="card" id="target">\u4f60\u597d\uff0cdsh</div>' +
    '<div class="hero"></div>' +
    '<div class="probe" id="probe"></div>' +
    '<p><a id="rootlink" href="/abs/link">一个根绝对外链</a></p>' +
    '<div id="bigbox"></div>' +
    '</main>';
  const big = document.createElement('img');
  big.className = 'thumb';
  big.id = 'big';
  document.getElementById('bigbox').appendChild(big);
  big.src = 'data:image/svg+xml,' + encodeURIComponent(svg);
  const dead = document.createElement('img');
  dead.className = 'thumb';
  dead.id = 'dead';
  dead.setAttribute('src', '/abs/missing.png');
  document.querySelector('main').appendChild(dead);

  // 跨域三件套：logo 在另一台主机（localhost vs 127.0.0.1），长条图在 127.0.0.1，
  // srcset 故意乱序（100w / 900w / 300w），最大那档在中间——按「取最大」而不是「取第一」。
  const pics = document.createElement('div');
  pics.id = 'pics';
  pics.innerHTML = '<img id="xlogo" class="thumb" src="' + P.logo + '">' +
    '<img id="sprite" class="thumb" src="' + P.sprite + '">' +
    '<img id="srcsetimg" class="thumb" src="' + P.w100 + '" srcset="' +
    P.w100 + ' 100w, ' + P.w900 + ' 900w, ' + P.w300 + ' 300w">' +
    // 第二个带 srcset 的元素：让「修复前 2 条 / 修复后 3 条」这个计数对比有基线。
    '<img id="srcsetimg2" class="thumb" src="' + P.p400 + '" srcset="' + P.p400 + ' 400w, ' + P.p800 + ' 800w">' +
    // preload/imagesrcset：link 是死标签、元素会被整个删掉，但它预载的最大那张图既要
    // 下载、也要计入 report.srcsetPicked。修复前这条只下载不记账，报告少算 1 个来源。
    // 放在 body 里，因为抽取只克隆 root（默认 body）那一棵子树。
    '<link id="preloadx" rel="preload" as="image" imagesrcset="' + P.p400 + ' 1x, ' + P.p1200 + ' 2x">';
  document.querySelector('main').appendChild(pics);

  return { rules: document.styleSheets[0] ? document.styleSheets[0].cssRules.length : 0, noiseBytes: Math.round(noise.length * 0.75) };
}

// ---- 本地 http 服务：跨域素材的来源 -------------------------------------
// 故意不发任何 CORS 头：页面里 fetch 会被浏览器拦住，只有「后台取字节」这条路能拿到，
// 这正是 3080 上 logo / app-fold.svg / no-application.png 失败的那一类 URL。
const LOGO_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><rect width="24" height="24" fill="#1f6feb"/><circle cx="12" cy="12" r="7" fill="#f0f6ff"/></svg>';

// 真·长条图（358x20870）：在页面里用 canvas 造，交给本地服务发出去。
// 这张图如果被「单边超 2000px 就重编码」，会压成 34x2000，等于毁掉。
function makeSpritePng() {
  const cv = document.createElement('canvas');
  cv.width = 358; cv.height = 20870;
  const cx = cv.getContext('2d');
  cx.fillStyle = '#123456';
  cx.fillRect(0, 0, 358, 20870);
  cx.fillStyle = '#e0a000';
  for (let y = 0; y < 20870; y += 100) cx.fillRect(0, y, 358, 12);
  return cv.toDataURL('image/png');
}

function squareSvg(n, color) {
  return '<svg xmlns="http://www.w3.org/2000/svg" width="' + n + '" height="' + n + '"><rect width="' + n + '" height="' + n + '" fill="' + color + '"/></svg>';
}

function startServer(routes) {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const key = decodeURIComponent(String(req.url || '').split('?')[0]);
      const hit = routes[key];
      if (!hit) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return; }
      res.writeHead(200, { 'content-type': hit.mime, 'content-length': hit.bytes.length, 'cache-control': 'no-store' });
      res.end(hit.bytes);
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

// background.js 的取字节就是一个带主机权限的 fetch；这里用 Node 的 fetch 演同一个动作。
async function bgFetchBytes(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return { ok: false, error: 'HTTP ' + res.status };
    const buf = Buffer.from(await res.arrayBuffer());
    return { ok: true, base64: buf.toString('base64'), mime: String(res.headers.get('content-type') || '').split(';')[0].trim(), bytes: buf.length };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// 把「内容脚本 → 后台 → 字节回传」这条消息链在离线环境里搭出来：
// 页面用 Runtime.addBinding 打请求，Node 取字节，再把答复写回页面里的 Promise。
async function installBgSeam(s, cdp) {
  await s.send('Runtime.addBinding', { name: '__dshBgFetch' });
  s.ws.addEventListener('message', (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch (e) { return; }
    if (!m || m.method !== 'Runtime.bindingCalled' || !m.params || m.params.name !== '__dshBgFetch') return;
    (async () => {
      let req;
      try { req = JSON.parse(m.params.payload); } catch (e) { return; }
      const out = await bgFetchBytes(String(req.url || ''));
      await s.send('Runtime.evaluate', {
        expression: 'globalThis.__dshBgDeliver(' + JSON.stringify(String(req.id)) + ', ' + JSON.stringify(JSON.stringify(out)) + ')'
      }).catch(() => {});
    })();
  });
  await cdp.evaluate(s, () => {
    const pending = new Map();
    let seq = 0;
    globalThis.__dshBgDeliver = (id, json) => {
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      let r;
      try { r = JSON.parse(json); } catch (e) { r = { ok: false, error: '坏答复' }; }
      p(r);
    };
    globalThis.dshPageCapture.fetchBytes = (url) => new Promise((resolve, reject) => {
      const id = 'r' + (++seq);
      pending.set(id, (r) => (r && r.ok ? resolve(r) : reject(new Error((r && r.error) || '后台取字节失败'))));
      globalThis.__dshBgFetch(JSON.stringify({ id, url }));
    });
  });
}

function pngSize(buf) {
  if (!buf || buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

function tagOf(html, id) {
  const m = new RegExp('<[^>]*id="' + id + '"[^>]*>').exec(String(html || ''));
  return m ? m[0] : '';
}

function scanAbsolutePaths(body) {
  const hits = [];
  for (const re of [
    /(?:src|href|action|poster)\s*=\s*["']\/(?!\/)/g,
    /url\(\s*["']?\/(?!\/)/g,
    /@import\s+(?:url\(\s*)?["']\/(?!\/)/g
  ]) {
    let m;
    while ((m = re.exec(body))) hits.push(body.slice(Math.max(0, m.index - 24), m.index + 36).replace(/\s+/g, ' '));
  }
  return hits;
}

// 和 blockcheck.mjs 同一套口径：把每个段的引用按"这段自己的块内地址"解析，
// 结果必须落在产出里真实存在的段上。
function resolveRefs(body, ownPath, present) {
  const text = String(body).replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  const base = 'http://block.invalid/' + ownPath;
  const refs = [];
  const push = (raw) => {
    const t = String(raw || '').trim();
    if (!t || t.startsWith('data:') || t.startsWith('#') || t.startsWith('http://') || t.startsWith('https://') || t.startsWith('//')) return;
    let url;
    try { url = new URL(t, base); } catch (e) { return; }
    const p = decodeURIComponent(url.pathname).replace(/^\//, '');
    refs.push({ ref: t, resolved: p, exists: present.has(p) });
  };
  for (const m of text.matchAll(/<link\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi)) push(m[1]);
  for (const m of text.matchAll(/<(?:img|source|video|audio|iframe)\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)) push(m[1]);
  for (const m of text.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) push(m[1]);
  return refs;
}

const bytesOf = (f) => (f.base64 ? Buffer.from(String(f.content), 'base64').length : Buffer.byteLength(String(f.content), 'utf8'));

const results = [];
function assert(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
}

// CDP 的 Runtime.evaluate 单次回传 payload 有上限（实测 3.7MB 能过、5MB 挂住）。
// 素材包一次能有几个 MB，所以分两步：先拿轻量清单（report + files 的 path/bytes），
// 再一条一条把内容取回来——单条最大 2.7MB（2MB 二进制转 base64），都在上限内。
async function runExtract(s, opts) {
  const r = await s.send('Runtime.evaluate', {
    expression: '(function () { globalThis.__dshOut = null; return globalThis.dshPageCapture.extract(document, ' + JSON.stringify(opts) + ')'
      + '.then(function (o) { globalThis.__dshOut = o; return { files: o.files.map(function (f) { return { path: f.path, bytes: f.bytes, base64: !!f.base64 }; }), report: o.report }; }); })()',
    awaitPromise: true,
    returnByValue: true
  });
  if (r.exceptionDetails) {
    throw new Error('extract 抛异常：' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
  }
  const light = r.result.value;
  if (!light || !Array.isArray(light.files)) throw new Error('extract 没有返回 files');
  const files = [];
  for (const meta of light.files) {
    const g = await s.send('Runtime.evaluate', {
      expression: '(function () { var o = globalThis.__dshOut; for (var i = 0; i < o.files.length; i++) { if (o.files[i].path === ' + JSON.stringify(meta.path) + ') return o.files[i].content; } return null; })()',
      returnByValue: true
    });
    if (g.exceptionDetails) throw new Error('取回 ' + meta.path + ' 的内容失败：' + JSON.stringify(g.exceptionDetails));
    files.push({ path: meta.path, bytes: meta.bytes, base64: meta.base64, content: g.result.value });
  }
  return { files: files, report: light.report };
}

async function main() {
  // 0) 扩展侧：发现 / 多播 / 缓存 / ?baseURL= —— 不需要浏览器，先跑
  await runHubChecks(assert)

  const cdpPath = pickCdp();
  const cdp = await import(pathToFileURL(cdpPath).href);
  console.log('[cdp] ' + cdpPath);

  const browser = await cdp.launch({ width: 1280, height: 800 });
  const s = browser.session;
  let failed = 0;
  let srv = null;
  try {
    // 0) 先造素材再起服务：长条图在页面里生成，字节交给本地 http 服务发出去。
    const spriteBytes = Buffer.from(String(await cdp.evaluate(s, makeSpritePng)).split(',')[1], 'base64');
    const logoBytes = Buffer.from(LOGO_SVG, 'utf8');
    const started = await startServer({
      '/logo.svg': { mime: 'image/svg+xml', bytes: logoBytes },
      '/sprite.png': { mime: 'image/png', bytes: spriteBytes },
      '/q100.svg': { mime: 'image/svg+xml', bytes: Buffer.from(squareSvg(100, '#a0c4ff'), 'utf8') },
      '/q300.svg': { mime: 'image/svg+xml', bytes: Buffer.from(squareSvg(300, '#9bf6ff'), 'utf8') },
      '/q900.svg': { mime: 'image/svg+xml', bytes: Buffer.from(squareSvg(900, '#caffbf'), 'utf8') },
      '/p400.svg': { mime: 'image/svg+xml', bytes: Buffer.from(squareSvg(400, '#ffd6a5'), 'utf8') },
      '/p800.svg': { mime: 'image/svg+xml', bytes: Buffer.from(squareSvg(800, '#fdffb6'), 'utf8') },
      '/p1200.svg': { mime: 'image/svg+xml', bytes: Buffer.from(squareSvg(1200, '#bdb2ff'), 'utf8') },
      // 夹具页从这台服务取（about:blank 没有 origin，根绝对 url(/static/…) 没法绝对化，
      // 也就复现不出真实事故）。/static/probe.svg 就是 CSS 里那条根绝对引用的落点。
      '/blank.html': { mime: 'text/html', bytes: Buffer.from('<!doctype html><html><head><title>probe</title></head><body><p>blank</p></body></html>', 'utf8') },
      '/static/probe.svg': { mime: 'image/svg+xml', bytes: Buffer.from(squareSvg(16, '#3355ff'), 'utf8') },
    });
    srv = started.server;
    const hostA = 'http://127.0.0.1:' + started.port;
    const hostB = 'http://localhost:' + started.port;   // 同服务、不同主机名 = 另一个源
    const P = { logo: hostB + '/logo.svg', sprite: hostA + '/sprite.png', w100: hostA + '/q100.svg', w300: hostA + '/q300.svg', w900: hostA + '/q900.svg',
      p400: hostA + '/p400.svg', p800: hostA + '/p800.svg', p1200: hostA + '/p1200.svg' };
    console.log('[server] ' + hostA + ' 已就绪：sprite.png ' + spriteBytes.length + ' B（358x20870），logo.svg ' + logoBytes.length + ' B，srcset 三档 100w/300w/900w');

    await cdp.navigate(s, hostA + '/blank.html');
    const pageUrl = hostA + '/blank.html';
    const fx = await cdp.evaluate(s, '(' + buildFixture.toString() + ')(' + JSON.stringify(P) + ')', { isExpression: true });
    console.log('[fixture] about:blank 注入完成：style 规则 ' + fx.rules + ' 条，噪声 PNG ≈ ' + Math.round(fx.noiseBytes / 1024) + 'KB，假 woff2 1.5MB');

    const srcText = readFileSync(path.join(HERE, 'extractor.js'), 'utf8');
    const inj = await s.send('Runtime.evaluate', { expression: srcText, returnByValue: false });
    if (inj.exceptionDetails) throw new Error('注入 extractor.js 失败：' + JSON.stringify(inj.exceptionDetails));

    // 后台取字节通道（对着 extractor 的 fetchBytes 钩子，等同 background.js 的答复形状）
    await installBgSeam(s, cdp);
    // 对照：页面自己 fetch 这张跨域图必然被拦（服务端不发 CORS），证明上面那条不是页面取到的。
    // 夹具页现在有自己的 origin（http 页，为了让根绝对 url(/static/…) 能绝对化），所以要拿
    // 另一个主机名（localhost）那张图当对照——同源的 sprite 页面自己当然能取到。
    const pageFetch = await cdp.evaluate(s,
      'fetch(' + JSON.stringify(P.logo) + ').then(function(){return "ok"},function(e){return String((e&&e.message)||e)})',
      { isExpression: true });
    console.log('[control] 页面直接 fetch 另一源的 logo.svg → ' + pageFetch);

    const out = await runExtract(s, { origin: pageUrl });
    if (!out || !out.files) throw new Error('extract 没有返回 files');
    const files = out.files;
    const report = out.report;
    const byPath = new Map(files.map((f) => [f.path, f]));
    const entry = byPath.get('entry.html');
    const allText = files.map((f) => String(f.content)).join(NL);

    // ---- 1. files 数量 > 0 ------------------------------------------------
    assert('files 数量 > 0', files.length > 0, files.length + ' 个：' + files.map((f) => f.path).join(', '));

    // ---- 2. entry.html 含目标元素 -----------------------------------------
    const hasTarget = !!entry && entry.content.indexOf('id="target"') >= 0 && entry.content.indexOf('\u4f60\u597d\uff0cdsh') >= 0;
    assert('entry.html 含目标元素 #target', hasTarget, entry ? 'entry.html ' + bytesOf(entry) + ' B' : '缺 entry.html');

    // ---- 3. --dsw- 残留 = 0（且真的落成了字面值）--------------------------
    // 残留口径：var(--dsw-…) 用法 + --dsw-*: 声明（这才是"皮肤被抓进块"的形态）；
    // 原始子串次数一并报出来——正文里提到 --dsw- 字样不算泄漏。
    const varUse = (allText.match(/var\(\s*--dsw-/g) || []).length;
    const declUse = (allText.match(/--dsw-[\w-]*\s*:/g) || []).length;
    const rawHit = (allText.match(/--dsw-/g) || []).length;
    const literal = allText.indexOf('#4a7bd0') >= 0 && allText.indexOf('rgb(24, 24, 27)') >= 0;
    assert('--dsw- 残留 = 0 且已固化成字面值', varUse === 0 && declUse === 0 && rawHit === 0 && literal,
      'var(--dsw-…) ' + varUse + ' 处 / 声明 ' + declUse + ' 处 / 原始子串 ' + rawHit + ' 处；字面值 ' + (literal ? '已落地' : '缺失'));

    // ---- 4. 无根绝对路径 + files[].path 合法 -------------------------------
    const absHits = [];
    for (const f of files) for (const h of scanAbsolutePaths(String(f.content))) absHits.push(f.path + ': ' + h);
    const badPath = files.filter((f) => f.path.startsWith('/') || f.path.split('/').indexOf('..') >= 0 || /[\\:]/.test(f.path));
    assert('无根绝对路径 / 路径合法', absHits.length === 0 && badPath.length === 0,
      absHits.length ? absHits.slice(0, 3).join(' | ') : 'files[].path 全是段内相对');

    // ---- 5. 体积账与 report 一致 ------------------------------------------
    const sum = files.reduce((a, f) => a + bytesOf(f), 0);
    const declared = report.files.reduce((a, f) => a + f.bytes, 0);
    const perFileOk = report.files.every((rf) => {
      const f = byPath.get(rf.path);
      return f && bytesOf(f) === rf.bytes;
    });
    assert('体积账与 report 一致', sum === report.bytes && declared === report.bytes && perFileOk,
      '实测 ' + sum + ' B / report.bytes ' + report.bytes + ' B / report.files 合计 ' + declared + ' B');

    // ---- 6. 相对引用（./ ../ ../../）都能解析到已有段 ----------------------
    const present = new Set(files.map((f) => f.path));
    const bad = [];
    for (const f of files) {
      if (f.base64) continue;
      for (const r of resolveRefs(f.content, f.path, present)) if (!r.exists) bad.push(f.path + ' -> ' + r.ref);
    }
    assert('相对引用全部解析到产出段（./ ../ ../../）', bad.length === 0,
      bad.length ? bad.slice(0, 3).join(' | ') : 'link/url() 引用 ' + files.filter((f) => !f.base64).reduce((a, f) => a + resolveRefs(f.content, f.path, present).length, 0) + ' 处，全部命中');

    // ---- 7. 坏资源进 dropped，且不进 entry.html ---------------------------
    const droppedOk = Array.isArray(report.dropped) && report.dropped.length > 0 && entry.content.indexOf('missing.png') < 0;
    assert('坏资源进 dropped 且不进 entry.html', droppedOk, report.dropped.length + ' 条 dropped');

    // ---- 8. 祖先链停在 body 的直系子元素 ---------------------------------
    // 带 selector 再跑一次，确认没有把整个 document 塞进去（includes 已废，不再传它），
    // 且"目标 → body 直系子元素"这一整段都在。
    const sub = await runExtract(s, { origin: pageUrl, selector: '#target' });
    const subEntry = (sub.files.find((f) => f.path === 'entry.html') || {}).content || '';
    // entry.html 自己的 <html>/<body> 是文档壳，不算数；只看 <body> 里面有没有被塞进整份 document
    const bodyInner = (subEntry.split('<body>')[1] || '').split('</body>')[0];
    const chainOk = bodyInner.indexOf('id="headline"') >= 0 && bodyInner.indexOf('id="target"') >= 0 &&
      bodyInner.indexOf('<body') < 0 && bodyInner.indexOf('<html') < 0 && bodyInner.indexOf('<head') < 0 &&
      sub.report.ancestors.length >= 2 && sub.report.ancestors[0].id === 'target';
    assert('祖先链停在 body 直系子元素（不含 <html>/<body>）', chainOk,
      'selector=#target → ' + sub.report.ancestors.map((a) => a.tag + (a.id ? '#' + a.id : '')).join(' < ') + '，entry ' + subEntry.length + ' 字符');

    // ---- 9. 跨域资源经后台取字节：拿到字节、dropped 里不再出现 -----------
    const logoRow = (report.assets || []).find((a) => String(a.url).indexOf('/logo.svg') >= 0);
    const logoDropped = report.dropped.some((d) => String(d).indexOf('logo.svg') >= 0);
    assert('跨域资源经后台取字节拿到字节，dropped 里不再出现',
      !!logoRow && logoRow.via === 'background' && logoRow.bytes === logoBytes.length && logoRow.kind === 'data' && !logoDropped && pageFetch !== 'ok',
      logoRow
        ? (logoRow.url + ' → ' + logoRow.bytes + ' B（服务端 ' + logoBytes.length + ' B），通道 ' + logoRow.via + '，落点 ' + logoRow.kind + '；页面直连：' + pageFetch)
        : '资源清单里没有 logo.svg（dropped ' + report.dropped.length + ' 条）');

    // ---- 10. 358x20870 长条图：原尺寸落文件，不降采样 ---------------------
    const sprRow = (report.assets || []).find((a) => String(a.url).indexOf('/sprite.png') >= 0);
    const sprFile = sprRow && sprRow.path ? byPath.get(sprRow.path) : null;
    const sprOut = sprFile ? Buffer.from(String(sprFile.content), 'base64') : null;
    const sprPng = sprOut ? pngSize(sprOut) : null;
    const sprDown = report.dropped.some((d) => String(d).indexOf('sprite.png') >= 0 && String(d).indexOf('重编码') >= 0);
    assert('358x20870 长条图原尺寸落文件、不参与 2000px 降采样',
      !!sprRow && sprRow.kind === 'file' && sprRow.downsampled === false && sprRow.w === 358 && sprRow.h === 20870 &&
        !!sprPng && sprPng.w === 358 && sprPng.h === 20870 && !!sprOut && sprOut.length === spriteBytes.length && !sprDown,
      sprRow
        ? (sprRow.path + '：report ' + sprRow.w + 'x' + sprRow.h + '，落盘 PNG ' + (sprPng ? sprPng.w + 'x' + sprPng.h : '解析失败') + '，' + (sprOut ? sprOut.length : 0) + ' B（原图 ' + spriteBytes.length + ' B）')
        : '资源清单里没有 sprite.png');

    // ---- 11. srcset 取最大候选（900w），小档不进清单 ----------------------
    const pickTag = tagOf(entry.content, 'srcsetimg');
    const picked = report.srcsetPicked || [];
    const got900 = picked.some((u) => String(u).indexOf('/q900.svg') >= 0);
    const gotSmall = (report.assets || []).some((a) => /\/q(100|300)\.svg/.test(String(a.url)));
    assert('带 srcset 的元素取最大候选（900w），100w/300w 不进资源清单',
      got900 && !gotSmall && /src="data:image\/svg\+xml/.test(pickTag) && pickTag.indexOf('srcset=') < 0,
      'srcsetPicked=' + JSON.stringify(picked) + '；img 标签：' + (pickTag || '没找到'));

    // ---- 12. preload/imagesrcset：最大候选下载了，就必须进 srcsetPicked ------
    // 修复前：link 先 addUrl() 进资源清单，随后作为死标签被删，属性循环再也看不到它，
    // 于是图片下载了、report.srcsetPicked 里却没有这一条（少算 1 个来源）。
    const preKept = entry.content.indexOf('preloadx') >= 0;
    assert('preload imagesrcset 的最大候选计入 srcsetPicked（link 被删也不漏账）',
      picked.length === 3 && picked.some((u) => String(u).indexOf('/p1200.svg') >= 0) && !preKept,
      'srcsetPicked 长度 ' + picked.length + '：' + JSON.stringify(picked) + '；entry 里还有 link=' + preKept);

    // ---- 13. includes 不再是开关：传/不传各抓一次，引用同样全部本地化、产物同构 ----
    // 真实事故：传 includes:'css,fonts,images' 时 assets 那一支被跳过，CSS 里 url(/static/…)
    // 一条都没改写，create_ui_block 连拒两次。现在 includes 只被记录，产物必须一模一样。
    const incRun = await runExtract(s, { origin: pageUrl, includes: 'css,fonts,images' });
    const cssAbs = (list) => list.filter((f) => /\.css$/.test(f.path))
      .reduce((a, f) => a + (String(f.content).match(/url\(\s*["']?\/(?!\/)/g) || []).length, 0);
    const incPaths = (rep) => (rep.assets || []).map((a) => a.url + '=' + a.kind).sort().join(' | ');
    const sumBytes = (list) => list.reduce((a, f) => a + bytesOf(f), 0);
    const baseAbs = cssAbs(files);
    const incAbs = cssAbs(incRun.files);
    // 同一套引用口径也要落在 includes 那份上：传了 includes 的产物一样不许有悬空引用。
    const incPresent = new Set(incRun.files.map((f) => f.path));
    const incBadRefs = [];
    for (const f of incRun.files) {
      if (f.base64) continue;
      for (const r of resolveRefs(f.content, f.path, incPresent)) if (!r.exists) incBadRefs.push(f.path + ' -> ' + r.ref);
    }
    assert('includes 传/不传产物同构：assets 与落点一致、CSS 根绝对 url() 与悬空引用都是 0',
      baseAbs === 0 && incAbs === 0 && incBadRefs.length === 0 &&
        (report.assets || []).length >= 1 &&
        (report.assets || []).length === (incRun.report.assets || []).length &&
        report.assetsInlined >= 1 && report.assetsInlined === incRun.report.assetsInlined &&
        incPaths(report) === incPaths(incRun.report) &&
        sumBytes(files) === sumBytes(incRun.files) &&
        report.includesIgnored === undefined && incRun.report.includesIgnored === true,
      '不传：assets ' + (report.assets || []).length + ' 条 / 内联 ' + report.assetsInlined + ' / CSS 根绝对 ' + baseAbs +
        ' / 悬空引用 ' + 0 + ' / ' + sumBytes(files) + ' B / includesIgnored=' + String(report.includesIgnored) +
        '；传 css,fonts,images：assets ' + (incRun.report.assets || []).length + ' 条 / 内联 ' + incRun.report.assetsInlined +
        ' / CSS 根绝对 ' + incAbs + ' / 悬空引用 ' + incBadRefs.length + ' / ' + sumBytes(incRun.files) + ' B / includesIgnored=' + String(incRun.report.includesIgnored) +
        (incBadRefs.length ? '；' + incBadRefs.slice(0, 3).join(' | ') : ''));

    // ---- 落盘 ------------------------------------------------------------
    if (existsSync(OUT)) rmSync(OUT, { recursive: true, force: true });
    mkdirSync(OUT, { recursive: true });
    for (const f of files) {
      const target = path.join(OUT, f.path);
      mkdirSync(path.dirname(target), { recursive: true });
      if (f.base64) writeFileSync(target, Buffer.from(String(f.content), 'base64'));
      else writeFileSync(target, String(f.content), 'utf8');
    }
    writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2), 'utf8');

    // ---- 报告 ------------------------------------------------------------
    console.log('');
    console.log('== 断言 ==');
    for (const r of results) {
      if (!r.ok) failed++;
      console.log((r.ok ? '  PASS  ' : '  FAIL  ') + r.name + (r.detail ? '   — ' + r.detail : ''));
    }
    console.log('');
    console.log('== 产出 files（已落盘 out-selfcheck/）==');
    let total = 0;
    for (const f of files) {
      const b = bytesOf(f);
      total += b;
      console.log('  ' + String(f.path).padEnd(28) + String(b).padStart(8) + ' B' + (f.base64 ? '  (base64)' : ''));
    }
    console.log('  ' + 'TOTAL'.padEnd(28) + String(total).padStart(8) + ' B   report.bytes=' + report.bytes);
    console.log('');
    console.log('== report 摘要 ==');
    console.log('  origin / title    ' + report.origin + ' / ' + report.title);
    console.log('  规则              总 ' + report.rulesTotal + ' · 命中 ' + report.rulesKept + ' · 死选择器丢 ' + report.rulesDead + ' · 空规则丢 ' + report.rulesEmpty);
    console.log('  样式表 / 动画       ' + report.sheets + ' 张 / @keyframes ' + report.keyframes + ' / @font-face ' + report.fontFaces);
    console.log('  变量              解析 ' + report.varsResolved + ' 个自定义属性；丢声明 ' + report.declarationsDropped + ' 条、自定义属性 ' + report.customPropsDropped + ' 条');
    console.log('  元素              子树 ' + report.elements + ' 个，固化 ' + report.computedRules + ' 条计算样式规则');
    console.log('  资源              内嵌 ' + report.assetsInlined + ' · 落 assets/ ' + report.assetsSpilled);
    console.log('  祖先链            ' + report.ancestors.map((a) => a.tag + (a.id ? '#' + a.id : '')).join(' < '));
    if (report.degrade.length) console.log('  降级              ' + report.degrade.join(' | '));
    console.log('  dropped ' + report.dropped.length + ' 条：');
    for (const d of report.dropped.slice(0, 8)) console.log('    - ' + d);
    console.log('');
    console.log(failed === 0 ? '[self-check] 全部通过（' + results.length + '/' + results.length + '）' : '[self-check] 失败 ' + failed + ' 条');
    process.exitCode = failed === 0 ? 0 : 1;
  } finally {
    if (srv) { try { srv.close() } catch (e) {} }
    await browser.close();
  }
}

main().catch((e) => {
  console.error('[self-check] 崩了：' + (e && e.stack || e));
  process.exitCode = 1;
});
