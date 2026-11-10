// assemble.mjs — 把多份"页面零件"装配成一个可播放的多文件块（目录树 + .uiblock）
// 规则：共用 CSS / 素材各成一份文件；每页只留自己的 DOM 与页内差异样式。
// 用法：node assemble.mjs --parts out/parts --names home,plugins,market --out out/site
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const partsRoot = path.resolve(arg('parts', 'out/parts'));
const names = arg('names', 'home,plugins,market').split(',').map((s) => s.trim()).filter(Boolean);
const outDir = path.resolve(arg('out', 'out/site'));
const timelineFile = arg('timeline', null);
const blockFile = path.resolve(arg('block', 'out/data.uiblock'));

// 与插件默认值对齐（dsh-ui-block/index.js 的 LIMIT_DEFAULTS，可由配置 limits.* 覆盖）：
// 单文件 2 MB、整块 64 MB；16 MB 起插件只给软提示，不拦。
const PER_FILE = 2097152;     // 单文件硬顶
const BLOCK = 67108864;       // 块总量硬顶
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
const bytes = (s) => Buffer.byteLength(s, 'utf8');

// ---- 读零件 ---------------------------------------------------------------
const pages = [];
for (const n of names) {
  const p = path.join(partsRoot, n, 'parts.json');
  const j = JSON.parse(await readFile(p, 'utf8'));
  pages.push({ ...j, name: n });
}

// ---- 素材：按内容哈希去重，一份文件一次 -----------------------------------
const assetFiles = new Map(); // hash -> {file, bytes}
for (const pg of pages) {
  for (const a of pg.assets || []) {
    if (!assetFiles.has(a.hash)) assetFiles.set(a.hash, { file: a.hash + '.' + a.ext, bytes: a.bytes, meta: a });
  }
}
const resolveAssets = (text, relPrefix) =>
  text.replace(/@@asset:([0-9a-f]+)@@/g, (m, h) => {
    const a = assetFiles.get(h);
    return a ? relPrefix + a.file : m;
  });

// ---- CSS：跨页共用的成 shared/app.css，页内独有的成 pages/<n>/page.css -----
const counts = new Map();
for (const pg of pages) for (const r of new Set(pg.rules)) counts.set(r, (counts.get(r) || 0) + 1);
const sharedRules = [...counts].filter(([, c]) => c >= 2).map(([r]) => r);
const sharedSet = new Set(sharedRules);

// :root 变量的"顺序"会随页面加载漂移，按声明集合比较才算真的同一套主题
const declMap = (css) => new Map(css.replace(/^:root\{/, '').replace(/\}$/, '').split(';').filter(Boolean).map((s) => [s.slice(0, s.indexOf(':')), s.slice(s.indexOf(':') + 1)]));
const tokensSame = (a, b) => {
  const x = declMap(a), y = declMap(b);
  if (x.size !== y.size) return false;
  for (const [k, v] of x) if (y.get(k) !== v) return false;
  return true;
};
const sameTokens = pages.every((p) => tokensSame(p.rootVars, pages[0].rootVars));

// ---- 写站点 ---------------------------------------------------------------
for (const sub of ['shared', 'assets', 'pages']) await mkdir(path.join(outDir, sub), { recursive: true });

const tokensCss = resolveAssets(pages[0].rootVars, '../assets/');
const appCss = resolveAssets(sharedRules.join('\n'), '../assets/');
if (sameTokens) await writeFile(path.join(outDir, 'shared/tokens.css'), tokensCss, 'utf8');
await writeFile(path.join(outDir, 'shared/app.css'), appCss, 'utf8');

const pageMeta = [];
for (const pg of pages) {
  const dir = path.join(outDir, 'pages', pg.name);
  await mkdir(path.join(dir, 'assets'), { recursive: true });
  // 素材：统一放站点根 assets/，页面目录不重复存
  for (const a of pg.assets || []) {
    const src = path.join(partsRoot, pg.name, 'assets', a.hash + '.' + a.ext);
    const dst = path.join(outDir, 'assets', a.hash + '.' + a.ext);
    if (!existsSync(dst)) await writeFile(dst, await readFile(src));
  }
  const own = pg.rules.filter((r) => !sharedSet.has(r));
  const pageCss = resolveAssets((sameTokens ? '' : pg.rootVars + '\n') + own.join('\n'), '../../assets/');
  await writeFile(path.join(dir, 'page.css'), pageCss, 'utf8');
  const head = ['<link rel="stylesheet" href="../../shared/tokens.css">'];
  const html =
    '<!doctype html>\n<html ' + pg.htmlAttrs.map(([k, v]) => k + '="' + esc(v) + '"').join(' ') + '>\n<head>\n' +
    '<meta charset="utf-8">\n<meta name="viewport" content="width=device-width,initial-scale=1">\n' +
    '<title>' + esc(pg.title) + '</title>\n' +
    '<!-- ui-snapshot 多文件快照：共用样式在 ../../shared，素材在 ../../assets -->\n' +
    head.join('\n') + '\n<link rel="stylesheet" href="../../shared/app.css">\n<link rel="stylesheet" href="./page.css">\n</head>\n' +
    '<body ' + pg.bodyAttrs.map(([k, v]) => k + '="' + esc(v) + '"').join(' ') + '>' +
    resolveAssets(pg.bodyHtml, '../../assets/') + '</body>\n</html>\n';
  await writeFile(path.join(dir, 'index.html'), html, 'utf8');
  pageMeta.push({ name: pg.name, title: pg.title, url: pg.url, sharedRules: sharedRules.length, ownRules: own.length, ownRuleBytes: bytes(own.join('\n')) });
}

// ---- 时间轴 / 块入口（index.html = harness，直接能演） --------------------
const harness = await readFile(path.resolve('harness.html'), 'utf8');
await writeFile(path.join(outDir, 'index.html'), harness.replace("./player.mjs", "./player.mjs"), 'utf8');
await writeFile(path.join(outDir, 'player.mjs'), await readFile(path.resolve('player.mjs'), 'utf8'), 'utf8');
const tl = timelineFile ? JSON.parse(await readFile(path.resolve(timelineFile), 'utf8')) : { name: 'multi', timeline: { steps: [] } };
const demo = {
  name: tl.name || '多文件块演示',
  snapshots: Object.fromEntries(pages.map((p) => [p.name, 'url:pages/' + p.name + '/index.html'])),
  timeline: tl.timeline,
};
await writeFile(path.join(outDir, 'demo.json'), JSON.stringify(demo, null, 1), 'utf8');

// ---- 纯数据演示块：只有文档 / 样式 / 素材 / demo.json，不带播放器 -------------
// 边界：播放器属于宿主，块是纯数据。所以块里没有 player.mjs、也没有 harness；
// 入口 index.html 是"首页那份文档"（格式仍要求一个 html 入口，只能给它），别的页在 pages/<名>/index.html。
const BINARY = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.woff', '.woff2', '.ttf', '.otf']);
async function walk(dir, base = '') {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const rel = base ? base + '/' + e.name : e.name;
    if (e.isDirectory()) out.push(...(await walk(path.join(dir, e.name), rel)));
    else out.push(rel);
  }
  return out;
}
// 宿主的东西（harness 入口、播放器）不进块；首页那份已在入口里，不重复放
const SKIP = new Set(['index.html', 'player.mjs', 'pages/home/index.html']);
const all = (await walk(outDir)).sort((a, b) => a.localeCompare(b));

// 入口在块根：引用一律写 ./xxx。块挂在 /ui-blocks/<name>/ 下，根绝对路径（/assets/x）必 404。
const entryDoc = (await readFile(path.join(outDir, 'pages/home/index.html'), 'utf8'))
  // 全局替换，不加引号锚点：<link href>、<img src>、以及行内 style 里的 url(../../assets/…) 都要换
  .replace(/\.\.\/\.\.\/shared\//g, './shared/')
  .replace(/\.\.\/\.\.\/assets\//g, './assets/')
  .replace('"./page.css"', '"./pages/home/page.css"');
let block = entryDoc.endsWith('\n') ? entryDoc : entryDoc + '\n';
const fileSizes = [{ path: 'index.html', bytes: bytes(entryDoc), kind: 'text' }];
for (const rel of all) {
  if (SKIP.has(rel)) continue;
  const ext = path.extname(rel).toLowerCase();
  const bin = BINARY.has(ext);
  let raw = await readFile(path.join(outDir, rel));
  // 入口快照必须写 "./"：路由只在目录 URL /ui-blocks/<name>/ 上服务入口，/ui-blocks/<name>/index.html 恒 404
  if (rel === 'demo.json') raw = Buffer.from(raw.toString('utf8').replace('"url:pages/home/index.html"', '"url:./"'), 'utf8');
  block += '\n<!-- @@file ' + rel + (bin ? ' base64' : '') + ' -->\n';
  block += bin ? raw.toString('base64') + '\n' : raw.toString('utf8');
  fileSizes.push({ path: rel, bytes: bin ? raw.length : bytes(raw.toString('utf8')), kind: bin ? 'base64' : 'text' });
}
await writeFile(blockFile, block, 'utf8');

// ---- 合法块：.uiblock 只允许一个 html（入口）+ css/svg/json/woff*/png/jpg/webp 段 ----
// 依据 dsh-ui-block/index.js：SECTION_TYPES 里没有 html/htm/mjs，非入口的 .html 段会 415；
// CSP 是 script-src 'none'。所以多页演示本轮只能以站点形态给播放器，块形态只打单页。
const entryPage = arg('block-page', 'plugins');
const pageDir = path.join(outDir, 'pages', entryPage);
if (existsSync(pageDir)) {
  const entryText = (await readFile(path.join(pageDir, 'index.html'), 'utf8'))
    .replace(/"\.\.\/\.\.\/shared\//g, '"')
    .replace(/"\.\.\/\.\.\/assets\//g, '"assets/');
  const bs = [{ path: 'app.css', file: path.join(outDir, 'shared/app.css') }];
  if (sameTokens) bs.push({ path: 'tokens.css', file: path.join(outDir, 'shared/tokens.css') });
  bs.push({ path: 'page.css', file: path.join(pageDir, 'page.css') });
  for (const [hash, a] of assetFiles) {
    if (!existsSync(path.join(outDir, 'assets', a.file))) continue;
    // 只带这一页真正引用到的素材
    const used = entryText.includes('assets/' + a.file) || (await readFile(path.join(pageDir, 'page.css'), 'utf8')).includes('assets/' + a.file) || (sameTokens && (await readFile(path.join(outDir, 'shared/app.css'), 'utf8')).includes('assets/' + a.file));
    if (used) bs.push({ path: 'assets/' + a.file, file: path.join(outDir, 'assets', a.file) });
  }
  let blk = entryText.endsWith('\n') ? entryText : entryText + '\n';
  const sizes = [{ path: 'index.html', bytes: bytes(entryText) }];
  for (const b of bs) {
    const raw = await readFile(b.file);
    const isBin = BINARY.has(path.extname(b.path).toLowerCase());
    blk += '\n<!-- @@file ' + b.path + (isBin ? ' base64' : '') + ' -->\n' + (isBin ? raw.toString('base64') : raw.toString('utf8'));
    sizes.push({ path: b.path, bytes: raw.length });
  }
  const bfs = path.resolve(arg('block-file', 'out/page.uiblock'));
  await writeFile(bfs, blk, 'utf8');
  console.log('BLOCK ' + JSON.stringify({ file: bfs, page: entryPage, bytes: bytes(blk), files: sizes.sort((a, b) => b.bytes - a.bytes) }));
}

// ---- 记账 ----------------------------------------------------------------
const payload = fileSizes.reduce((a, f) => a + f.bytes, 0);
// 对照：每页各自自包含时的总量（DOM + 该页全部规则 + 该页全部素材，不去重不共用）
const naive = pages.reduce((a, pg) => a + bytes(pg.bodyHtml) + bytes(pg.rules.join('\n')) + (pg.assets || []).reduce((x, y) => x + y.bytes, 0), 0);
const summary = {
  pages: pageMeta,
  shared: { tokens: sameTokens, rules: sharedRules.length, ruleBytes: bytes(appCss) },
  files: fileSizes.sort((a, b) => b.bytes - a.bytes),
  payloadBytes: payload,
  uiblockFile: blockFile,
  uiblockBytes: bytes(block),
  perFileLimit: PER_FILE,
  blockLimit: BLOCK,
  overPerFile: fileSizes.filter((f) => f.bytes > PER_FILE).map((f) => f.path),
  blockOver: Math.max(0, payload - BLOCK),
  naiveBytes: naive,
  savingsVsNaive: naive - payload,
};
console.log(JSON.stringify(summary, null, 1));
