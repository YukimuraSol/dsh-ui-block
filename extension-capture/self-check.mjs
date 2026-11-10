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
  // 超 16 MB 单文件上限的图：走 data: 内联（绕开 fetch 的 12 MB 上限，直奔落盘上限那条分支）
  const hugeB64 = 'A'.repeat(23 * 1024 * 1024);    // 约 17 MB 字节

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
    '.probe{background-image:url(/static/probe.svg);width:16px;height:16px;}',
    // 抽屉形态：定位规则只写在样式表里（真实事故里那份表跨域取不到）。这些必须被固化成
    // 元素规则，否则抓下来抽屉落回文档流、整页往下压。
    '.drawerlike{position:fixed;top:0;left:0;transform:translateY(-100%);z-index:30;overflow:auto;width:200px;height:40px;}',
    // 3 MB woff 与 5 MB ttf：旧上限 2 MB 会在浏览器侧就把它们截掉（真实事故：教务页
    // 2.3 MB 的 woff 与 4.2 MB 的 ttf 根本没落盘）。上限抬到 16 MB 后两条都必须留下。
    '@font-face{font-family:BigWoff;src:url(/big-3mb.woff) format("woff");}',
    '@font-face{font-family:BigTtf;src:url(/big-5mb.ttf) format("truetype");}',
    // 头像形态：Angular 的 <avatar src> 指令，图片 404 之后退回内联 SVG 兜底图标。
    // 旧代码取不到 src 的字节就把整个 <avatar> 摘掉，这块 SVG 跟着没了。
    '.avatar{width:40px;height:40px;border-radius:50%;overflow:hidden;display:flex;color:#20bec8}',
    '.avatar-svg{display:flex;width:100%;height:100%;overflow:hidden}',
    '.avatar-svg svg{display:block;width:100%;height:100%;overflow:hidden}',
    // 单位矩阵 = 视觉上没动，和 transform:none 一样不许写进块。
    '.noopmove{position:relative;transform:translateX(0);top:auto;left:auto;}'
  ].join('') + '</style>';
  document.body.innerHTML = '<main class="wrap">' +
    '<section><h1 id="headline">抓取自检</h1><p id="tagline">目标元素在这里</p></section>' +
    '<div class="card" id="target">\u4f60\u597d\uff0cdsh</div>' +
    '<div class="hero"></div>' +
    '<div class="probe" id="probe"></div>' +
    '<div class="drawerlike" id="drawerprobe">抽屉容器</div>' +
    '<div class="noopmove" id="noopmove">没移动</div>' +
    '<p><a id="rootlink" href="/abs/link">一个根绝对外链</a></p>' +
    // 同一个 URL 换个名字写：Angular 的 ng-href、Vue 的 :href（值是字符串字面量）、SVG 的 xlink:href。
    // 前三个必须绝对化，SVG 那个的片段引用 #icon 必须原样留着。
    '<p><a id="anglink" ng-href="/x">angular 链接</a>' +
    '<a id="plainlink" href="/y">普通链接</a>' +
    '<a id="vuelink" :href="\'/z\'">vue 链接</a></p>' +
    '<svg width="20" height="20"><use id="svguse" xlink:href="#icon"></use></svg>' +
    // 头像：<avatar src> 指向一个 404 的地址，里面的内联 SVG 是唯一可见内容。
    '<div class="avatar" id="avatarbox"><avatar id="avatarels" src="/user/avatarSmallUrl">' +
    '<span class="avatar-svg svg-icon"><svg id="avatarsvg" viewBox="0 0 40 40" fill="currentColor" xmlns="http://www.w3.org/2000/svg">' +
    '<circle id="avatarcircle" cx="20" cy="20" r="19" fill="white" stroke="currentColor" stroke-width="2"></circle>' +
    '<path id="avatarpath" fill-rule="evenodd" d="M20 9C16.5 9 13.8 12 13.8 15.4V16.5Z" fill="currentColor"></path>' +
    '</svg></span></avatar></div>' +
    // 单文件超 16 MB：必须仍然丢掉，且理由写清阈值
    '<img id="hugeimg" src="data:image/png;base64,' + hugeB64 + '">' +
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
  // 分片取回：单个 5 MB 字体的 base64 有 6.7 MB，一次 returnByValue 装不下（实测 3.7MB 能过、
  // 5MB 挂住），所以按 1 MB 字符切片取。
  const CHUNK = 1024 * 1024;
  const sliceExpr = (p, off, len) => '(function () { var o = globalThis.__dshOut; for (var i = 0; i < o.files.length; i++) {'
    + ' if (o.files[i].path === ' + JSON.stringify(p) + ') return o.files[i].content.slice(' + off + ', ' + (off + len) + '); } return null; })()';
  for (const meta of light.files) {
    let content = '', off = 0;
    for (;;) {
      const g = await s.send('Runtime.evaluate', { expression: sliceExpr(meta.path, off, CHUNK), returnByValue: true });
      if (g.exceptionDetails) throw new Error('取回 ' + meta.path + ' 的内容失败：' + JSON.stringify(g.exceptionDetails));
      const part = g.result.value;
      if (part === null || part === undefined) throw new Error('取回 ' + meta.path + ' 的内容失败：null');
      content += part;
      if (part.length < CHUNK) break;
      off += CHUNK;
    }
    files.push({ path: meta.path, bytes: meta.bytes, base64: meta.base64, content: content });
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
      // frame 夹具：正文整个在 iframe 里，iframe 占 90% 可视高，顶层文档只有它一个元素。
      // 真实事故就是这个形态（教务页），扩展只注入顶层文档，抓回来是空的。
      '/shell.html': { mime: 'text/html', bytes: Buffer.from('<!doctype html><html><head><meta charset="utf-8"><title>frame shell</title><style>html,body{margin:0;height:100%}iframe{display:block;width:100vw;height:90vh;border:0}</style></head><body><iframe id="shell" src="/blank.html"></iframe></body></html>', 'utf8') },
      // 反例：普通页面，正文就在顶层文档里，没有任何 frame —— 不许喊 FRAME SHELL。
      '/normal.html': { mime: 'text/html', bytes: Buffer.from('<!doctype html><html><head><meta charset="utf-8"><title>normal page</title><style>body{margin:0;font-family:system-ui}main{padding:24px}h1{margin:0 0 12px}p{margin:0 0 8px}</style></head><body><main><h1>普通页面</h1><p>这一页的正文就在顶层文档里，没有任何 frame。</p><p>第二段用来凑够可见元素数。</p><ul><li>一</li><li>二</li><li>三</li></ul></main></body></html>', 'utf8') },
      '/static/probe.svg': { mime: 'image/svg+xml', bytes: Buffer.from(squareSvg(16, '#3355ff'), 'utf8') },
      // 两个「旧的 2 MB 上限会截掉」的字体：3 MB woff 与 5 MB ttf（真实事故的同类）。
      '/big-3mb.woff': { mime: 'font/woff', bytes: Buffer.alloc(3 * 1024 * 1024, 0x41) },
      '/big-5mb.ttf': { mime: 'font/ttf', bytes: Buffer.alloc(5 * 1024 * 1024, 0x42) },
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

    // ---- 14. 定位属性固化：抽屉落回文档流的根因 -----------------------------
    // 真实事故：抽屉样式表 pure-drawer.css 跨域取不到，position/left/transform 全在里面，
    // 抓下来抽屉落回文档流、把整页往下压 450px。定位必须固化成元素规则；
    // 默认值（static / auto / none / 单位矩阵）不许写，否则平白胖一圈。
    const cssText = ['shared/app.css', 'pages/current/page.css']
      .map((p) => (byPath.get(p) ? String(byPath.get(p).content) : '')).join('\n');
    const ruleOf = (id) => {
      const tag = (new RegExp('<[a-z]+[^>]*id="' + id + '"[^>]*>', 'i').exec(entry.content) || [''])[0];
      const key = (/data-dsh-el="(e\d+)"/.exec(tag) || [])[1] || '';
      return { key: key, rule: key ? ((new RegExp('\\[data-dsh-el="' + key + '"]\\{[^}]*\\}').exec(cssText) || [''])[0]) : '' };
    };
    const drawer = ruleOf('drawerprobe');
    const noop = ruleOf('noopmove');
    const computedRules = cssText.match(/\[data-dsh-el="e\d+"\]\{[^}]*\}/g) || [];
    const defaultHits = computedRules.filter((r) =>
      /(?:^|[;{])(?:position:static|top:auto|right:auto|bottom:auto|left:auto|transform:none|z-index:auto|overflow:visible|inset:auto)(?:[;}]|$)/.test(r));
    const drawerOk = drawer.rule !== '' &&
      /position:fixed/.test(drawer.rule) && /left:0px/.test(drawer.rule) && /top:0px/.test(drawer.rule) &&
      /transform:matrix\(1,\s*0,\s*0,\s*1,\s*0,\s*-?[\d.]+\)/.test(drawer.rule) &&
      /z-index:30/.test(drawer.rule) && /overflow:auto/.test(drawer.rule);
    const noopOk = noop.rule !== '' && /position:relative/.test(noop.rule) &&
      !/transform:matrix\(1,\s*0,\s*0,\s*1,\s*0,\s*0\)/.test(noop.rule) && !/[;{]left:auto/.test(noop.rule);
    assert('定位属性被固化，默认值不写（position/left/top/transform/z-index/overflow）',
      drawerOk && noopOk && defaultHits.length === 0,
      '抽屉规则=' + (drawer.rule || '（缺）') + '；单位矩阵那条=' + (noop.rule || '（缺）') +
        '；固化规则里写了默认值的条数=' + defaultHits.length +
        '；CSS 段共 ' + computedRules.length + ' 条元素规则');

    // ---- 15. 同一个 URL 换个名字写：ng-href / :href / xlink:href 也要绝对化 ------
    // 真实事故：公开课页的 <a ng-href="/public-course#/all"> 漏在 href 绝对化之外（那是 Angular
    // 的属性），blockcheck 对那份块报 root-absolute path + entry links missing 两条。
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const attrOf = (id, name) => {
      const tag = (new RegExp('<[a-z]+[^>]*id="' + esc(id) + '"[^>]*>', 'i').exec(entry.content) || [''])[0];
      const m = new RegExp('\\s' + esc(name) + '="([^"]*)"').exec(tag);
      return m ? m[1] : null;
    };
    const ngHref = attrOf('anglink', 'ng-href');
    const plainHref = attrOf('plainlink', 'href');
    const vueHref = attrOf('vuelink', ':href');
    const svgHref = attrOf('svguse', 'xlink:href');
    const vueWant = "'" + hostA + "/z'";
    assert('ng-href / :href 与 href 一样绝对化，xlink:href 的片段引用保持原样',
      ngHref === hostA + '/x' && plainHref === hostA + '/y' && vueHref === vueWant && svgHref === '#icon',
      'ng-href=' + JSON.stringify(ngHref) + '，href=' + JSON.stringify(plainHref) +
        '，:href=' + JSON.stringify(vueHref) + '，xlink:href=' + JSON.stringify(svgHref) +
        '（期望 ' + JSON.stringify(hostA + '/x') + '、' + JSON.stringify(hostA + '/y') + '、' + JSON.stringify(vueWant) + '、"#icon"）');

    // ---- 15b. 取不到字节的 src 不许连子树一起删（真实事故：头像的内联 SVG 被摘掉）----
    // 教务页三处头像都是 <avatar src="/user/avatarSmallUrl">，网址 404 后 Angular 已经退回
    // 内联 SVG 兜底图标；旧代码把整个 <avatar> 删掉，块里头像全空白、CSS 里留下 3×5 条孤儿规则。
    const circleTags = entry.content.match(/<circle[^>]*>/g) || [];
    const circleTag = circleTags[0] || '';
    const avatarTag = (/<avatar[^>]*>/.exec(entry.content) || [''])[0];
    const circleAttrs = ['cx="20"', 'cy="20"', 'r="19"', 'fill="white"', 'stroke="currentColor"', 'stroke-width="2"']
      .every((a) => circleTag.indexOf(a) >= 0);
    const svgKept = entry.content.indexOf('viewBox="0 0 40 40"') >= 0 && /<path[^>]*fill="currentColor"/.test(entry.content);
    const avatarKept = avatarTag !== '' && avatarTag.indexOf('avatarSmallUrl') < 0;
    const keptLine = report.dropped.some((d) => d.indexOf('只摘属性、保留子树') >= 0 && d.indexOf('avatarSmallUrl') >= 0);
    assert('404 的 src 只摘属性：<avatar> 里的内联 SVG 与 circle 属性完整留下',
      circleTags.length === 1 && circleAttrs && svgKept && avatarKept && keptLine,
      'entry 里 <circle> ' + circleTags.length + ' 处：' + (circleTag || '（缺）') + '；<avatar> ：' + (avatarTag || '（缺）') +
        '；svg viewBox=' + (entry.content.indexOf('viewBox="0 0 40 40"') >= 0) + '；dropped 记了「只摘属性」=' + keptLine);

    // ---- 15c. 计算样式规则必须挂得上元素：page.css 里的 [data-dsh-el] 在 entry.html 里 100% 命中 ----
    const idOf = (s) => ((/"(e\d+)"/.exec(s) || [])[1] || '');
    const ruleIds = [...new Set((cssText.match(/\[data-dsh-el="e\d+"\]/g) || []).map(idOf))];
    const entryIds = new Set((entry.content.match(/data-dsh-el="e\d+"/g) || []).map(idOf));
    const orphanIds = ruleIds.filter((id) => !entryIds.has(id));
    // computedOrphansDropped > 0 是**正常**的：被 404 删掉的 <img>（#dead、#hugeimg）本来就没有
    // 产物里的元素，它们那条计算样式规则会被摘掉。断言只要求产出这一侧 100% 对得上。
    assert('page.css 的每条 [data-dsh-el] 规则都能在 entry.html 里找到对应元素（孤儿规则 = 0）',
      orphanIds.length === 0 && ruleIds.length > 0 && typeof report.computedOrphansDropped === 'number',
      '规则 ' + ruleIds.length + ' 条 / entry 里 ' + entryIds.size + ' 个 id / 孤儿 ' + orphanIds.length +
        (orphanIds.length ? '：' + orphanIds.slice(0, 8).join(',') : '') + '；report.computedOrphansDropped=' + report.computedOrphansDropped);

    // ---- 15d. 单文件上限：常量在源码里必须是 16 MB，内联上限仍是 1.4 MB ----
    const srcText16 = readFileSync(path.join(HERE, 'extractor.js'), 'utf8');
    assert('阈值常量：MAX_ASSET_BYTES=16MB，MAX_INLINE_BYTES 仍是 1400KB',
      /var MAX_ASSET_BYTES = 16 \* 1024 \* 1024;/.test(srcText16) && /var MAX_INLINE_BYTES = 1400 \* 1024;/.test(srcText16),
      (/var MAX_ASSET_BYTES[^\n]*/.exec(srcText16) || [''])[0] + ' | ' + (/var MAX_INLINE_BYTES[^\n]*/.exec(srcText16) || [''])[0]);

    // ---- 15e. 3 MB woff 与 5 MB ttf 必须落 assets/（旧上限 2 MB 在浏览器侧就截掉了）----
    const rowOf = (u) => (report.assets || []).find((a) => String(a.url).indexOf(u) >= 0);
    const w3 = rowOf('/big-3mb.woff');
    const t5 = rowOf('/big-5mb.ttf');
    const w3File = w3 && w3.path ? byPath.get(w3.path) : null;
    const t5File = t5 && t5.path ? byPath.get(t5.path) : null;
    // 「超内嵌上限 1.4MB，改存 assets/…」是正常的信息行；只有「丢弃 / 超单文件上限」才算真丢。
    const fontMention = report.dropped.filter((d) => d.indexOf('big-3mb') >= 0 || d.indexOf('big-5mb') >= 0);
    const fontDropped = fontMention.filter((d) => d.indexOf('丢弃') >= 0 || d.indexOf('超单文件上限') >= 0);
    assert('3 MB woff 与 5 MB ttf 都落 assets/，dropped 里没有它们',
      !!w3 && w3.kind === 'file' && w3.bytes === 3145728 && /^assets\/font-\d+\.woff$/.test(String(w3.path)) && !!w3File && bytesOf(w3File) === 3145728 &&
        !!t5 && t5.kind === 'file' && t5.bytes === 5242880 && /^assets\/font-\d+\.ttf$/.test(String(t5.path)) && !!t5File && bytesOf(t5File) === 5242880 &&
        fontDropped.length === 0 && !report.dropped.some((d) => d.indexOf('超单文件上限') >= 0 && d.indexOf('字体') >= 0),
      'woff ' + (w3 ? w3.path + ' ' + bytesOf(w3File) + ' B' : '缺失') + '；ttf ' + (t5 ? t5.path + ' ' + bytesOf(t5File) + ' B' : '缺失') +
        '；dropped 里提到它们的 ' + fontMention.length + ' 条全是「改存」信息行、真丢 ' + fontDropped.length + ' 条' + (fontDropped.length ? '：' + fontDropped.join(' | ') : ''));

    // ---- 15f. 超 16 MB 的仍然丢掉，理由里写清阈值 ----
    const hugeDrop = report.dropped.find((d) => d.indexOf('超单文件上限 16MB') >= 0);
    assert('超 16 MB 的仍然丢弃，理由写明 16MB 阈值',
      !!hugeDrop && entry.content.indexOf('hugeimg') < 0,
      hugeDrop || 'dropped 里没有超限记录');

    // ---- 16. frame shell：正文在 iframe 里，顶层文档抓下来是空的 ---------------
    // 真实事故：教务页正文整个装在 iframe 里，扩展只注入顶层文档，抓到一片空；模型于是
    // 自己猜三轮、再问用户三选一，白等 1 分 54 秒。这里证明两件事：report.frames 点名了
    // 那个框，并且返回的第一条就是那句固定的话。
    const FRAME_SHELL_TEXT = 'THIS PAGE IS A FRAME SHELL — the visible content lives inside a frame; capturing the top document yields nothing usable.';
    await cdp.navigate(s, hostA + '/shell.html');
    const injShell = await s.send('Runtime.evaluate', { expression: srcText, returnByValue: false });
    if (injShell.exceptionDetails) throw new Error('shell 页注入 extractor 失败：' + JSON.stringify(injShell.exceptionDetails));
    const shellRun = await runExtract(s, { origin: hostA + '/shell.html' });
    const shellReport = shellRun.report;
    const shellEntry = (shellRun.files.find((f) => f.path === 'entry.html') || {}).content || '';
    const shellFrames = shellReport.frames || {};
    const shellFirst = String((shellReport.dropped || [])[0] || '');
    assert('frame 夹具：report.frames 点名那个 iframe（total 1、同源、占比 > 30%、有尺寸）',
      shellFrames.total === 1 && shellFrames.sameOrigin === 1 && shellFrames.crossOrigin === 0 &&
        !!shellFrames.dominant && shellFrames.dominant.areaRatio > 0.3 && shellFrames.dominant.w > 0 && shellFrames.dominant.h > 0 &&
        String(shellFrames.dominant.src).indexOf('/blank.html') >= 0,
      JSON.stringify(shellFrames) + '；entry ' + shellEntry.length + ' 字符（空壳）');
    assert('frame 夹具：frameShell 触发，dropped 首条就是那句固定话（可 grep）',
      shellReport.frameShell === true && shellFirst === FRAME_SHELL_TEXT &&
        (shellReport.notes || []).some((n) => String(n).indexOf('在标签页中打开框架') >= 0),
      'frameShell=' + String(shellReport.frameShell) + '；dropped[0]=' + JSON.stringify(shellFirst) +
        '；notes=' + JSON.stringify(shellReport.notes));

    // ---- 17. 正常页不许喊 FRAME SHELL（避免误报）-----------------------------
    await cdp.navigate(s, hostA + '/normal.html');
    const injNormal = await s.send('Runtime.evaluate', { expression: srcText, returnByValue: false });
    if (injNormal.exceptionDetails) throw new Error('normal 页注入 extractor 失败：' + JSON.stringify(injNormal.exceptionDetails));
    const normalRun = await runExtract(s, { origin: hostA + '/normal.html' });
    const normalReport = normalRun.report;
    const normalEntry = (normalRun.files.find((f) => f.path === 'entry.html') || {}).content || '';
    const normalDroppedText = (normalReport.dropped || []).join(' | ');
    assert('正常页不误报：frames.total=0、没有 frameShell、正文在 entry 里',
      !!normalReport.frames && normalReport.frames.total === 0 && normalReport.frames.dominant === null &&
        normalReport.frameShell === undefined && normalDroppedText.indexOf('FRAME SHELL') < 0 &&
        normalEntry.indexOf('普通页面') >= 0 && (normalReport.notes || []).length === 0,
      'frames=' + JSON.stringify(normalReport.frames) + '；frameShell=' + String(normalReport.frameShell) +
        '；entry ' + normalEntry.length + ' 字符；dropped 里有 FRAME SHELL=' + String(normalDroppedText.indexOf('FRAME SHELL') >= 0));

    // ---- 18. 参考截图：报告里的事实与口径 ---------------------------------
    // 拍图本身在 background.js（chrome.tabs.captureVisibleTab），这里只钉报告口径：
    // mode 只能是 viewport；宽高是**抓取那一刻的视口**，不是目标尺寸——所以字段名里
    // 不许出现 target / expected / size 这类会被读成「应该照做」的词。
    const shot = (report.screenshot !== null && typeof report.screenshot === 'object') ? report.screenshot : {};
    const shotForbidden = ['target', 'expected', 'size'].filter((k) => Object.prototype.hasOwnProperty.call(shot, k));
    const shotViewport = (shot.captureViewport !== null && typeof shot.captureViewport === 'object') ? shot.captureViewport : {};
    assert('report.screenshot：mode=viewport + path=reference/viewport.png + captureViewport，且不含 target/expected/size 键',
      shot.mode === 'viewport' && shot.path === 'reference/viewport.png' &&
        Number(shot.width) > 0 && Number(shot.height) > 0 && Number(shot.dpr) > 0 && Number.isFinite(Number(shot.scrollHeight)) &&
        Number(shotViewport.width) === Number(shot.width) && Number(shotViewport.height) === Number(shot.height) &&
        shotForbidden.length === 0,
      JSON.stringify(shot) + '；禁用键命中 ' + shotForbidden.length + ' 个' + (shotForbidden.length ? '：' + shotForbidden.join(',') : ''));

    // ---- 19. index.js 里那两行参考截图文案（抓完必须出现在返回文本里）----
    const indexSrc = readFileSync(path.join(HERE, '..', 'index.js'), 'utf8');
    const refLineOk = indexSrc.indexOf('REFERENCE VIEWPORT ') >= 0 &&
      indexSrc.indexOf('That viewport is the capture viewport, NOT a target size.') >= 0 &&
      indexSrc.indexOf('compare against this image only at the same width') >= 0 &&
      indexSrc.indexOf('frozen at the capture width, so do not rescale or copy those pixel values') >= 0 &&
      indexSrc.indexOf('REFERENCE VIEWPORT unavailable: ') >= 0 &&
      indexSrc.indexOf("shot.mode === 'viewport'") >= 0;
    assert('index.js 的 captureText 打印 REFERENCE VIEWPORT 两行（截图失败时打印 unavailable 行）',
      refLineOk, 'REFERENCE VIEWPORT ' + (indexSrc.indexOf('REFERENCE VIEWPORT ') >= 0) +
        ' / NOT a target size ' + (indexSrc.indexOf('NOT a target size') >= 0) +
        ' / unavailable ' + (indexSrc.indexOf('REFERENCE VIEWPORT unavailable: ') >= 0) +
        ' / 口径守卫 ' + (indexSrc.indexOf("shot.mode === 'viewport'") >= 0));

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
    console.log('  frames            ' + JSON.stringify(report.frames));
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
