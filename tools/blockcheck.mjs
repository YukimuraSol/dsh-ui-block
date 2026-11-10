// blockcheck.mjs — 用 .uiblock 的**正式解析规则**检查块文件
// 规则来自 dsh-ui-block/index.js：SECTION_RE、sectionType()、SECTION_TYPES、
// bytes=binary?base64解码后:utf8、段标记伪造检查、块总量按落盘文本。
// 两条上限与 index.js 的 LIMIT_DEFAULTS **同值**（sectionBytes 8 MB / blockBytes 64 MB）：
// 那边改了（可用 limits 配置覆盖），这里跟着改，不在本工具另立一套默认值。
// 再加两条**生成侧**规则（插件侧不动，数据侧自己保证）：
//   ① 段内资源路径必须段相对：src="/…"、href="/…"、url(/…) 一律报错
//      （块挂在 /ui-blocks/<name>/ 下，根绝对路径必然 404）；
//   ② demo.json 指向入口的快照必须写 "url:./"（/ui-blocks/<name>/index.html 恒 404）。
// 说明：这是"同规则复刻"，不是调用插件内部函数（assembleBlock 未导出）。
import { readFile } from 'node:fs/promises';

const SECTION_RE = /^<!--\s*@@file\s+(\S+?)(\s+base64)?\s*-->\s*$/;
// 与 index.js LIMIT_DEFAULTS.sectionBytes / .blockBytes 同值，见文件头注释。
const SECTION_MAX_BYTES = 8 * 1024 * 1024;
const BLOCK_MAX_BYTES = 64 * 1024 * 1024;
// html/htm 是正式段类型（index.js SECTION_TYPES 已收）：一个块可以带整页。
const SECTION_TYPES = { html: 1, htm: 1, css: 1, svg: 1, json: 1, woff2: 1, woff: 1, ttf: 1, otf: 1, png: 1, jpg: 1, jpeg: 1, webp: 1, gif: 1 };
// --allow-html 是旧调用的兼容开关，现在什么也不做（html 恒为合法段类型），也绝不报错。
void process.argv.includes('--allow-html');
const BINARY = new Set(['woff2', 'woff', 'ttf', 'otf', 'png', 'jpg', 'jpeg', 'webp', 'gif']);
const TEXTY = new Set(['html', 'htm', 'css', 'svg']);
const ext = (p) => p.slice(p.lastIndexOf('.') + 1).toLowerCase();

/** 根绝对路径扫描：只认真正的根绝对（//host 与 http:// 不算）。 */
function scanAbsolutePaths(body) {
  const hits = [];
  for (const re of [
    /(?:src|href|action|poster)\s*=\s*["']\/(?!\/)/g,
    /url\(\s*["']?\/(?!\/)/g,
    /@import\s+(?:url\(\s*)?["']\/(?!\/)/g,
  ]) {
    let m;
    while ((m = re.exec(body))) hits.push(body.slice(Math.max(0, m.index - 30), m.index + 40).replace(/\s+/g, ' '));
  }
  return hits;
}

/** 越界相对路径：'../' 比文件自己所在层还深，等于跑出块根（会解析成站点根，404）。 */
function scanDepthEscapes(body, depth) {
  const hits = [];
  const re = /(?:src|href|action|poster)\s*=\s*["']((?:\.\.\/)+)|url\(\s*["']?((?:\.\.\/)+)|@import\s+(?:url\(\s*)?["']((?:\.\.\/)+)/g;
  let m;
  while ((m = re.exec(body))) {
    const ups = (m[1] || m[2] || m[3] || '').split('../').length - 1;
    if (ups > depth) hits.push(body.slice(Math.max(0, m.index - 20), m.index + 50).replace(/\s+/g, ' '));
  }
  return hits;
}

const depthOf = (p) => p.split('/').length - 1;

/**
 * 解析式校验（比字符串匹配准）：把段内每个 <link href>、src、url() 按**该段自身的块内 URL**
 * 解析成绝对地址，要求解析结果仍落在块根 /<path> 之下、且该文件真的在块里。
 * 这条能同时抓住：以 / 开头的根绝对路径、../ 越界、以及写错名字的引用。
 */
function resolveRefs(rawBody, ownPath, present) {
  // 行内 style 里的 url() 引号会被序列化成 &quot;，不还原就会把 &quot; 当成路径的一部分
  const body = String(rawBody).replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  const base = 'http://block.invalid/' + ownPath;
  const refs = [];
  const push = (raw) => {
    const t = String(raw || '').trim();
    if (!t || t.startsWith('data:') || t.startsWith('#') || t.startsWith('http://') || t.startsWith('https://') || t.startsWith('//') || t.startsWith('mailto:')) return;
    let url;
    try { url = new URL(t, base); } catch { return; }
    const path = decodeURIComponent(url.pathname).replace(/^\//, '');
    refs.push({ ref: t, resolved: url.pathname, exists: present.has(path) });
  };
  for (const m of body.matchAll(/<link\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi)) push(m[1]);
  for (const m of body.matchAll(/<(?:img|script|source|video|audio|iframe)\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)) push(m[1]);
  for (const m of body.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) push(m[1]);
  return refs;
}

function parseBlock(text) {
  const lines = String(text).split(/\r?\n/);
  const entry = [];
  const sections = [];
  let cur = null;
  for (const line of lines) {
    const m = SECTION_RE.exec(line);
    if (!m) { (cur ? cur.lines : entry).push(line); continue; }
    cur = { path: m[1], declaredBase64: m[2] !== undefined, lines: [] };
    sections.push(cur);
  }
  return { entryText: entry.join('\n'), sections };
}

/** 全套检查：返回 { ok, errors, ...facts }，不抛异常，好一次看完所有问题。 */
function checkBlock(text) {
  const { entryText, sections } = parseBlock(text);
  const errs = [];
  const rows = [];
  const resolved = [];
  const presentAll = new Set(['index.html', ...sections.map((s) => s.path)]);
  if (entryText.trim() === '') errs.push('entry is empty');
  for (const s of sections) {
    if (s.path === '' || s.path.startsWith('/') || s.path.includes('..') || s.path.includes('\\') || s.path.includes('\0')) errs.push('bad path: ' + s.path);
    if (!SECTION_TYPES[ext(s.path)]) errs.push('unknown section type: ' + s.path);
    const body = s.lines.join('\n');
    const binary = BINARY.has(ext(s.path));
    const bytes = binary ? Buffer.from(body.trim(), 'base64').length : Buffer.byteLength(body, 'utf8');
    if (binary !== s.declaredBase64) errs.push('base64 flag mismatch: ' + s.path);
    if (bytes > SECTION_MAX_BYTES) errs.push('section over 2MB: ' + s.path + ' = ' + bytes);
    if (s.lines.some((l) => SECTION_RE.test(l))) errs.push('body contains a section marker: ' + s.path);
    if (TEXTY.has(ext(s.path))) {
      const abs = scanAbsolutePaths(body);
      if (abs.length) errs.push('root-absolute path in ' + s.path + ': ' + abs.slice(0, 3).join(' | '));
      const esc = scanDepthEscapes(body, depthOf(s.path));
      if (esc.length) errs.push('path escapes block root in ' + s.path + ' (depth ' + depthOf(s.path) + '): ' + esc.slice(0, 3).join(' | '));
      for (const r of resolveRefs(body, s.path, presentAll)) {
        if (!r.exists) errs.push('resolved outside block / missing file in ' + s.path + ': ' + r.ref + ' -> ' + r.resolved);
      }
      resolved.push(...resolveRefs(body, s.path, presentAll).map((r) => ({ where: s.path, ...r })));
    }
    if (s.path === 'demo.json') {
      try {
        const snaps = JSON.parse(body).snapshots || {};
        if (snaps.home !== undefined && snaps.home !== 'url:./') errs.push('demo.json entry snapshot must be "url:./", got ' + JSON.stringify(snaps.home));
      } catch (e) { errs.push('demo.json is not JSON: ' + String(e.message || e)); }
    }
    rows.push({ path: s.path, binary, bytes, marker: s.declaredBase64 });
  }
  const entryAbs = scanAbsolutePaths(entryText);
  if (entryAbs.length) errs.push('root-absolute path in entry: ' + entryAbs.slice(0, 3).join(' | '));
  const entryEsc = scanDepthEscapes(entryText, 0);
  if (entryEsc.length) errs.push('path escapes block root in entry (depth 0): ' + entryEsc.slice(0, 3).join(' | '));
  // 入口：每个 link/src/url() 按入口自己的 URL 解析，结果必须落在块根之下且文件真的在块里
  const entryRefs = resolveRefs(entryText, 'index.html', presentAll);
  for (const r of entryRefs) {
    if (!r.exists) errs.push('resolved outside block / missing file in entry: ' + r.ref + ' -> ' + r.resolved);
  }
  resolved.push(...entryRefs.map((r) => ({ where: 'index.html', ...r })));
  const total = Buffer.byteLength(text, 'utf8');
  if (total > BLOCK_MAX_BYTES) errs.push('block over 64MB: ' + total);
  const present = new Set(['index.html', ...sections.map((s) => s.path)]);
  const links = [...entryText.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1])
    .filter((u) => !u.startsWith('data:') && !u.startsWith('#') && !u.startsWith('http'));
  const missing = links.filter((u) => { const c = u.replace(/^\.\//, ''); return c !== '' && !present.has(c); });
  if (missing.length) errs.push('entry links missing: ' + missing.join(', '));
  return {
    entryStartsWithDoctype: /^<!doctype html/i.test(entryText.trim()),
    entryBytes: Buffer.byteLength(entryText, 'utf8'),
    sections: rows.length,
    totalTextBytes: total,
    blockLimit: BLOCK_MAX_BYTES,
    perFileLimit: SECTION_MAX_BYTES,
    biggest: rows.slice().sort((a, b) => b.bytes - a.bytes)[0],
    overPerFile: rows.filter((r) => r.bytes > SECTION_MAX_BYTES).map((r) => r.path),
    entryLinks: links,
    resolvedRefs: resolved,
    resolvedOutside: resolved.filter((r) => !r.exists).length,
    errors: errs,
    ok: errs.length === 0,
  };
}

// ---- 自检：证明"根绝对路径"这条校验真的会拦（AGENTS：非平凡逻辑留一个可跑的检查）----
if (process.argv.includes('--selftest')) {
  const bad = 'a src="/assets/a.webp" b href="/shared/app.css" c url(/assets/b.png)';
  const clean = 'src="./assets/a.webp" href="../../shared/app.css" url(./a.png) url(http://x/y.png) url(//cdn/z.png)';
  const hits = scanAbsolutePaths(bad);
  const falsePos = scanAbsolutePaths(clean);
  const planted = '<!doctype html><html><body><img src="/assets/planted.png"><div style="background-image:url(../../assets/escaped.webp)"></div></body></html>\n<!-- @@file demo.json -->\n{"snapshots":{"home":"url:index.html"}}';
  const res = checkBlock(planted);
  const linkEscape = '<!doctype html><html><head><link rel="stylesheet" href="../../shared/app.css"></head><body></body></html>\n<!-- @@file demo.json -->\n{"snapshots":{"home":"url:./"}}';
  const resLink = checkBlock(linkEscape);
  // 上限用例：植入一段刚好超过 SECTION_MAX_BYTES 的文本，证明"超单段"确实会拦。
  // 体积跟着常量走（SECTION_MAX_BYTES），所以上限再变也不会悄悄失效。
  const overSection = checkBlock('<!doctype html><html><body></body></html>\n<!-- @@file assets/big.css -->\n/*' + 'x'.repeat(SECTION_MAX_BYTES) + '*/');
  // html/htm 是正式段类型：同样的段不再报 unknown section type。
  const withPage = checkBlock('<!doctype html><p>a</p>\n<!-- @@file pages/one.html -->\n<!doctype html><p>b</p>\n<!-- @@file demo.json -->\n{"snapshots":{"home":"url:./"}}');
  const ok = hits.length === 3 && falsePos.length === 0 && !res.ok
    && res.errors.some((e) => e.includes('escapes block root'))
    && res.errors.some((e) => e.includes('resolved outside block'))
    && resLink.errors.some((e) => e.includes('resolved outside block') || e.includes('escapes block root'))
    && overSection.errors.some((e) => e.includes('section over 2MB'))
    && overSection.perFileLimit === SECTION_MAX_BYTES && overSection.blockLimit === BLOCK_MAX_BYTES
    && withPage.errors.every((e) => !e.includes('unknown section type'));
  console.log(JSON.stringify({ selftest: ok ? 'PASS' : 'FAIL', plantedHits: hits.length, falsePositivesOnClean: falsePos, plantedBlockErrors: res.errors, plantedLinkEscapeErrors: resLink.errors, limits: { perFileLimit: SECTION_MAX_BYTES, blockLimit: BLOCK_MAX_BYTES }, overSectionErrors: overSection.errors, withPageErrors: withPage.errors }, null, 1));
  process.exit(ok ? 0 : 1);
}

// 第一个非开关参数才是块文件：老调用常写 `--allow-html <file>`，开关不能被当成路径。
const file = process.argv.slice(2).find((arg) => !arg.startsWith('--')) || 'out/data.uiblock';
const out = checkBlock(await readFile(file, 'utf8'));
console.log(JSON.stringify({ file, ...out }, null, 1));
