// self-check.mjs — 离线自检：不依赖 DSH 端点，也不依赖 chrome.* API。
// 做法：无头 Chrome 打开 about:blank → 注入一段带 --dsw-* 变量的测试 DOM →
// 把 extractor.js 原文 Runtime.evaluate 进去 → 跑抽取 → 对产出做断言 → 落盘。
// 跑法：node self-check.mjs      （产出写在 out-selfcheck/，已 gitignore）
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
//   反例3  噪声 PNG > 200KB（降采样后仍超限 → 落 assets/，证明 ../../ 前缀）
//          + 220KB 假 woff2（字体不能降采样 → 落 assets/，证明 ../ 前缀）
function buildFixture() {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="2400" height="1200">' +
    '<rect width="2400" height="1200" fill="#4a7bd0"/><circle cx="1200" cy="600" r="420" fill="#d9a441"/></svg>';

  // 噪声 PNG：几乎不可压缩，保证 > 200KB 且降采样后仍超限
  const cv = document.createElement('canvas');
  cv.width = 600; cv.height = 600;
  const cx = cv.getContext('2d');
  const img = cx.createImageData(600, 600);
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

  // 假 woff2：225000 字节（> 200KB），内容无所谓，这条只验证"超限就落文件"
  let b64 = '';
  const CH = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let x = 987654321;
  while (b64.length < 300000) {
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
    '.thumb{width:240px;height:120px;object-fit:cover;border-radius:8px;}'
  ].join('') + '</style>';
  document.body.innerHTML = '<main class="wrap">' +
    '<section><h1 id="headline">抓取自检</h1><p id="tagline">目标元素在这里</p></section>' +
    '<div class="card" id="target">\u4f60\u597d\uff0cdsh</div>' +
    '<div class="hero"></div>' +
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
  return { rules: document.styleSheets[0] ? document.styleSheets[0].cssRules.length : 0, noiseBytes: Math.round(noise.length * 0.75) };
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

async function runExtract(s, opts) {
  const r = await s.send('Runtime.evaluate', {
    expression: 'globalThis.dshPageCapture.extract(document, ' + JSON.stringify(opts) + ')',
    awaitPromise: true,
    returnByValue: true
  });
  if (r.exceptionDetails) {
    throw new Error('extract 抛异常：' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
  }
  return r.result.value;
}

async function main() {
  const cdpPath = pickCdp();
  const cdp = await import(pathToFileURL(cdpPath).href);
  console.log('[cdp] ' + cdpPath);

  const browser = await cdp.launch({ width: 1280, height: 800 });
  const s = browser.session;
  let failed = 0;
  try {
    const fx = await cdp.evaluate(s, buildFixture);
    console.log('[fixture] about:blank 注入完成：style 规则 ' + fx.rules + ' 条，噪声 PNG ≈ ' + Math.round(fx.noiseBytes / 1024) + 'KB，假 woff2 225KB');

    const src = readFileSync(path.join(HERE, 'extractor.js'), 'utf8');
    const inj = await s.send('Runtime.evaluate', { expression: src, returnByValue: false });
    if (inj.exceptionDetails) throw new Error('注入 extractor.js 失败：' + JSON.stringify(inj.exceptionDetails));

    const out = await runExtract(s, { origin: 'about:blank' });
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
    // 带 selector 再跑一次（只抽 dom，便宜），确认没有把整个 document 塞进去，
    // 且"目标 → body 直系子元素"这一整段都在。
    const sub = await runExtract(s, { origin: 'about:blank', selector: '#target', includes: 'dom' });
    const subEntry = (sub.files.find((f) => f.path === 'entry.html') || {}).content || '';
    // entry.html 自己的 <html>/<body> 是文档壳，不算数；只看 <body> 里面有没有被塞进整份 document
    const bodyInner = (subEntry.split('<body>')[1] || '').split('</body>')[0];
    const chainOk = bodyInner.indexOf('id="headline"') >= 0 && bodyInner.indexOf('id="target"') >= 0 &&
      bodyInner.indexOf('<body') < 0 && bodyInner.indexOf('<html') < 0 && bodyInner.indexOf('<head') < 0 &&
      sub.report.ancestors.length >= 2 && sub.report.ancestors[0].id === 'target';
    assert('祖先链停在 body 直系子元素（不含 <html>/<body>）', chainOk,
      'selector=#target → ' + sub.report.ancestors.map((a) => a.tag + (a.id ? '#' + a.id : '')).join(' < ') + '，entry ' + subEntry.length + ' 字符');

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
    await browser.close();
  }
}

main().catch((e) => {
  console.error('[self-check] 崩了：' + (e && e.stack || e));
  process.exitCode = 1;
});
