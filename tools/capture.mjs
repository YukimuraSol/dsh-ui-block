// capture.mjs — url → 自包含快照（单 HTML 文件）
// 用法见 技术文档.md。核心：祖先链完整的 body 快照 + 按“真能命中”过滤后的 CSS + 内联资源。
import { launch, navigate, evaluate, screenshot } from './cdp.mjs';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf('--' + k);
  return i >= 0 ? argv[i + 1] : d;
};
const flag = (k) => argv.includes('--' + k);

const url = arg('url', 'http://127.0.0.1:3080/');
const outPath = path.resolve(arg('out', 'out/snap.html'));
const width = Number(arg('width', 1440));
const height = Number(arg('height', 900));
const settle = Number(arg('settle', 1500));
const maxBytes = Number(arg('max-bytes', 256 * 1024));
const afterFile = arg('after', null);
const noFonts = flag('no-fonts');
const shrinkMin = Number(arg('shrink-min', 20000)); // 单个 data URI 超过这个就重编码
const maxDim = Number(arg('max-dim', 1280));        // 重编码后的最长边
const quality = Number(arg('quality', 0.72));
// 多文件模式：--split <目录> 时把 CSS/图片抽成独立文件，每页只留 DOM 与页内差异样式
const splitDir = arg('split', null);
const assetCap = Number(arg('asset-cap', 256 * 1024)); // 单文件上限（每个抽出来的资产文件都受它约束）
// 对照用：把"抓取那一刻的实机画面"也存一张，像素对照才不会掺进应用状态漂移
const shotPath = arg('shot', null);
// 截实机帧 / 抓 DOM 之前先等这个表达式成立（页面自身的加载完成条件，例：插件卡渲染完）
const readyExpr = arg('wait-ready', null);

let prepareJs = null;
if (afterFile) {
  const { readFile } = await import('node:fs/promises');
  prepareJs = await readFile(path.resolve(afterFile), 'utf8');
}

// ---- 在页面里跑的一次性抓取 -------------------------------------------------
async function grab(opts) {
  const { shrinkMin, maxDim, quality } = opts;
  const dropKeyframes = !!opts.dropKeyframes;
  const split = !!opts.split;
  const assetCap = opts.assetCap || 262144;
  let splitBody = null, splitRules = null, splitAssets = null;
  const report = {
    splash: false, sheets: 0, rulesTotal: 0, rulesKept: 0, rulesDropped: 0,
    droppedSamples: [], mediaKept: 0, fontFaces: 0, keyframes: 0, imports: 0,
    shadowHosts: 0, resources: [], failed: [], scriptsRemoved: 0, styleTagsRemoved: 0,
    unresolved: 0,
    // 令牌固化的账：unresolvedVars 必须为空（空即证明产物不再问宿主要值）
    unresolvedVars: [], invalidAtComputedValue: [], varsUsed: 0, varsFromElements: [],
    varNamesUndeclared: [], skinSelectorRewrites: 0, skinSelectorKept: 0,
    skinAttrsDropped: 0, skinDeclsDropped: 0, bodyVarsFrozen: 0, emptyRulesDropped: 0,
  };

  // 0) 等 DOM 定型：会话列表、插件卡这类异步内容都是后到的。
  //    顺序很关键——CSS 过滤必须跑在 DOM 长完之后，否则"晚到元素"的选择器会被当成
  //    死选择器丢掉，快照里就是裸 HTML（实测：侧栏会话列表整条没样式、文字挤在左边被切）。
  if (!opts.noSettleDom) {
    const t0 = Date.now();
    let prev = '', stable = 0;
    for (let i = 0; i < 60; i++) {
      const n = document.querySelectorAll('*').length + ':' + document.body.innerText.length;
      if (n === prev) { if (++stable >= 3) break; } else stable = 0;
      prev = n;
      await new Promise((r) => setTimeout(r, 250));
    }
    report.domSettleMs = Date.now() - t0;
  }

  // 1) 关掉开屏视频层（它是全屏 z-max，会盖住整页）
  const splash = document.querySelector('.dshba');
  if (splash) {
    const v = splash.querySelector('video');
    if (v) { try { v.pause(); v.removeAttribute('src'); v.load(); } catch {} }
    splash.remove();
    report.splash = true;
  }
  window.scrollTo(0, 0);
  report.shadowHosts = [...document.querySelectorAll('*')].filter((e) => e.shadowRoot).length;

  // 1) :root 变量（当前主题的实测值）。--columbina-* 是皮肤自己的实现细节，不进素材：
  //    它带来的颜色已经在下面「令牌固化」里写成字面值了。
  const cs = getComputedStyle(document.documentElement);
  const vars = [];
  for (let i = 0; i < cs.length; i++) {
    const p = cs[i];
    if (p.startsWith('--columbina-')) continue;
    if (p.startsWith('--')) vars.push(p + ':' + cs.getPropertyValue(p).trim() + ';');
  }
  const rootVars = ':root{' + vars.join('') + '}';

  // ---- 令牌固化：把「用到的」变量写死，不只抄「声明过的」 ---------------------
  // 老做法只把 :root/body 上声明过的变量抄成令牌表，正文里的 var(--x) 原样留着。
  // 于是两种变量会在渲染时去问宿主的活令牌表（= 又跟着皮肤变）：
  //   ① 只在某个子树里声明的（根元素上抄不到）；
  //   ② 根本没声明的，靠 var(--x, fallback) 的兜底生效。
  // 这里改成按名字逐个解析：文档根 → body → 声明该名字的那个元素，拿到此刻的实际值。
  // 判据（写进 report）：unresolvedVars 为空，且产物里 var(--dsw-) / var(--dsh-) 残留为 0。
  const SKIN_ATTR = 'data-dsh-columbina';
  const SKIN_SEL_RE = new RegExp('\\[\\s*' + SKIN_ATTR + '(?:\\s*[~|^$*]?=\\s*(?:"[^"]*"|\'[^\']*\'|[^\\]]*))?\\s*\\]', 'gi');
  let varMap = new Map();

  const readCustomVars = (el) => {
    const m = new Map();
    if (!el) return m;
    let s;
    try { s = getComputedStyle(el); } catch { return m; }
    for (let i = 0; i < s.length; i++) {
      const p = s[i];
      if (!p || p.slice(0, 2) !== '--') continue;
      const v = s.getPropertyValue(p).trim();
      if (v) m.set(p, v);
    }
    return m;
  };

  // var( 里面可能还套 var(，所以要找配对括号，不能按 indexOf(')') 切。
  const findVar = (text, from) => {
    let i = text.indexOf('var(', from || 0);
    while (i >= 0) {
      if (i === 0 || !/[\w-]/.test(text[i - 1])) {
        let depth = 0, q = null;
        for (let j = i + 3; j < text.length; j++) {
          const ch = text[j];
          if (q) { if (ch === q) q = null; continue; }
          if (ch === '"' || ch === "'") { q = ch; continue; }
          if (ch === '(') depth++;
          else if (ch === ')') { depth--; if (depth === 0) return { start: i, end: j + 1, inside: text.slice(i + 4, j) }; }
        }
        return null;
      }
      i = text.indexOf('var(', i + 4);
    }
    return null;
  };
  const varNamesIn = (text) => {
    const set = new Set();
    const re = /var\(\s*(--[A-Za-z0-9_-]+)/g;
    let m;
    while ((m = re.exec(text))) set.add(m[1]);
    return set;
  };
  const missingNames = [];
  const resolveVars = (text, map, depth) => {
    if ((depth || 0) > 12) return { ok: false, text };
    let out = String(text);
    for (let guard = 0; guard < 500; guard++) {
      const hit = findVar(out, 0);
      if (!hit) return { ok: true, text: out };
      const args = splitSel(hit.inside);
      const name = (args[0] || '').trim();
      const fb = args.length > 1 ? args.slice(1).join(',').trim() : '';
      const raw = map.has(name) ? String(map.get(name)).trim() : '';
      const src = raw || fb;
      // 没有声明、也没有 fallback：整条声明在浏览器里是「计算值阶段无效」，
      // 属性退到 unset（继承属性照旧继承，其余取初始值）。交给下面的 healDecl 处理。
      if (!src) { if (missingNames.indexOf(name) < 0) missingNames.push(name); return { ok: false, text: out, name }; }
      const sub = resolveVars(src, map, (depth || 0) + 1);
      if (!sub.ok) return { ok: false, text: out, name: sub.name || name };
      out = out.slice(0, hit.start) + sub.text + out.slice(hit.end);
    }
    return { ok: true, text: out };
  };

  const buildVarMap = (names) => {
    const map = new Map();
    for (const src of [readCustomVars(document.documentElement), readCustomVars(document.body)]) {
      for (const [k, v] of src) map.set(k, v);
    }
    // 自定义属性不一定出现在 getComputedStyle 的 length 枚举里（实测 Chrome 只枚举长写属性），
    // 所以还得按名字问：body 先问（最近的声明就是后代实际用的值），根元素兜底。
    const rcs = getComputedStyle(document.documentElement);
    const bcs = getComputedStyle(document.body);
    for (const n of names) {
      if (map.has(n)) continue;
      const v = (bcs.getPropertyValue(n) || '').trim() || (rcs.getPropertyValue(n) || '').trim();
      if (v) map.set(n, v);
    }
    // 还是没有的名字，逐个元素问一遍（有些令牌只挂在某个子树或行内 style 上）
    let pending = [...names].filter((n) => !map.has(n));
    if (pending.length) {
      for (const el of document.querySelectorAll('body, body *')) {
        if (!pending.length) break;
        const left = [];
        for (const n of pending) {
          let v = '';
          try { v = getComputedStyle(el).getPropertyValue(n).trim(); } catch { v = ''; }
          if (v) {
            map.set(n, v);
            report.varsFromElements.push(n + ' @ ' + el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + ' = ' + v.slice(0, 60));
          } else left.push(n);
        }
        pending = left;
      }
    }
    report.varNamesUndeclared = pending.slice();
    report.varsUsed = names.size;
    return map;
  };

  // 把「解析不掉」的那条声明改写成浏览器当时真正生效的等价物：
  //   · 普通属性 → 值换成 unset（= 计算值阶段无效的结果）
  //   · 自定义属性 → 整条删掉（它只会被别处消费，而消费处已经写死成字面值）
  const healDecl = (text, pos) => {
    let a = pos;
    while (a > 0 && text[a - 1] !== '{' && text[a - 1] !== ';' && text[a - 1] !== '}') a--;
    let b = pos;
    while (b < text.length && text[b] !== ';' && text[b] !== '}') b++;
    const decl = text.slice(a, b);
    const colon = decl.indexOf(':');
    if (colon < 0) return null;
    const prop = decl.slice(0, colon).trim();
    if (!prop || /[\s(]/.test(prop)) return null; // 不是普通声明（@media 头之类）
    if (prop.slice(0, 2) === '--') return { text: text.slice(0, a) + text.slice(b + (text[b] === ';' ? 1 : 0)), op: 'drop' };
    return { text: text.slice(0, a) + prop + ':unset' + text.slice(b), op: 'unset' };
  };

  const noteUnresolved = (name) => {
    if (name && report.unresolvedVars.indexOf(name) < 0) report.unresolvedVars.push(name);
  };
  const noteInvalid = (name) => {
    if (name && report.invalidAtComputedValue.indexOf(name) < 0) report.invalidAtComputedValue.push(name);
  };

  // 一段 CSS 文本：删皮肤自定义属性声明 → 逐个 var() 写字面值 → 清理空规则
  const freezeCssText = (text) => {
    let out = text.replace(/(^|[{;])\s*--columbina-[A-Za-z0-9_-]*\s*:\s*[^;}]*/g, (m, lead) => {
      report.skinDeclsDropped++;
      return lead;
    });
    for (let guard = 0; guard < 20000; guard++) {
      const hit = findVar(out, 0);
      if (!hit) break;
      const args = splitSel(hit.inside);
      const name = (args[0] || '').trim();
      const fb = args.length > 1 ? args.slice(1).join(',').trim() : '';
      const raw = varMap.has(name) ? String(varMap.get(name)).trim() : '';
      const src = raw || fb;
      if (!src) {
        const h = healDecl(out, hit.start);
        if (!h) { noteUnresolved(name); break; }
        out = h.text;
        noteInvalid(name);
        continue;
      }
      const r = resolveVars(src, varMap, 0);
      if (!r.ok) {
        const h = healDecl(out, hit.start);
        if (!h) { noteUnresolved(r.name || name); break; }
        out = h.text;
        noteInvalid(r.name || name);
        continue;
      }
      out = out.slice(0, hit.start) + r.text + out.slice(hit.end);
    }
    // 皮肤属性从选择器里摘掉后，body[data-dsh-columbina]{--columbina-…} 会只剩空壳
    const before = out.length;
    out = out.replace(/[^{}]+\{\s*\}/g, '');
    if (out.length !== before) report.emptyRulesDropped++;
    return out;
  };

  // 选择器里的皮肤开关属性：把属性条件摘掉，规则本体照旧生效。
  // 视觉效果已经由字面值固定，块不该再靠「宿主是否开着皮肤」来命中。
  const stripSkinSelector = (sel) => {
    if (sel.indexOf(SKIN_ATTR) < 0) return sel;
    // :not([data-dsh-columbina]) 这类反向条件不能摘，摘了语义会反过来 → 留名不改
    if (/:not\([^)]*data-dsh-columbina/i.test(sel)) {
      report.skinSelectorKept++;
      (report.skinSelectorsKept = report.skinSelectorsKept || []).push(sel.slice(0, 120));
      return sel;
    }
    const out = sel.replace(SKIN_SEL_RE, '').replace(/\s+/g, ' ').trim();
    report.skinSelectorRewrites++;
    return out;
  };

  // 2) CSS：按“这份 DOM 里真能命中”过滤
  const STATE = /:(hover|focus-visible|focus-within|focus|active|visited|target|checked|indeterminate|disabled|enabled|read-only|read-write|placeholder-shown|default|required|optional|valid|invalid|in-range|out-of-range|user-invalid|user-valid|autofill|open|popover-open|modal|fullscreen|picture-in-picture|playing|paused|muted|seeking|buffering|stalled|defined|link|any-link|local-link|scope)\b/gi;
  const PSEUDO_EL = /::?(before|after|marker|placeholder|selection|first-line|first-letter|backdrop|file-selector-button|cue|highlight)\b/gi;
  const splitSel = (text) => {
    const out = []; let depth = 0, cur = '', q = null;
    for (const ch of text) {
      if (q) { cur += ch; if (ch === q) q = null; continue; }
      if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
      if (ch === '(' || ch === '[') depth++;
      else if (ch === ')' || ch === ']') depth--;
      if (ch === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
    }
    if (cur.trim()) out.push(cur);
    return out.map((s) => s.trim()).filter(Boolean);
  };
  const probe = (sel) => {
    // 探针 = 去掉伪元素/状态伪类后的选择器（规则原文不动，只用于判断“有没有元素能被它命中”）
    const p = sel.replace(PSEUDO_EL, '').replace(STATE, '').replace(/:not\(\s*\)/g, '').replace(/\s+/g, ' ').trim();
    if (!p) return true;
    try { return document.querySelector(p) !== null; } catch { return false; }
  };
  const keepSelectorText = (selText) => {
    const parts = splitSel(selText).map(stripSkinSelector);
    const kept = parts.filter(Boolean).filter(probe);
    if (!kept.length) {
      report.droppedSamples.push(selText.slice(0, 100));
      return null;
    }
    return kept.join(',');
  };

  const chunks = [];
  const walkRules = (rules, wrap) => {
    const inner = [];
    for (const rule of rules) {
      report.rulesTotal++;
      const kind = rule.constructor && rule.constructor.name;
      if (kind === 'CSSStyleRule' || (rule.selectorText && rule.style)) {
        const sel = keepSelectorText(rule.selectorText);
        if (!sel) { report.rulesDropped++; continue; }
        report.rulesKept++;
        // 保留原文里的子块（@nest 等），只替换选择器头
        const body = rule.cssText.slice(rule.cssText.indexOf('{'));
        inner.push(sel + ' ' + body);
      } else if (kind === 'CSSMediaRule' || kind === 'CSSSupportsRule' || kind === 'CSSContainerRule' || kind === 'CSSLayerBlockRule' || kind === 'CSSScopeRule') {
        const head = rule.cssText.slice(0, rule.cssText.indexOf('{') + 1);
        const sub = [];
        for (const r of rule.cssRules) {
          if (r.selectorText !== undefined) {
            const sel = keepSelectorText(r.selectorText);
            if (!sel) { report.rulesDropped++; continue; }
            sub.push(sel + ' ' + r.cssText.slice(r.cssText.indexOf('{')));
            report.rulesKept++;
          } else {
            sub.push(r.cssText);
            report.rulesKept++;
          }
        }
        if (sub.length) { inner.push(head + sub.join('') + '}'); report.mediaKept++; }
        else report.rulesDropped++;
      } else if (kind === 'CSSFontFaceRule') {
        report.fontFaces++; report.rulesKept++; inner.push(rule.cssText);
      } else if (kind === 'CSSKeyframesRule') {
        report.keyframes++;
        if (dropKeyframes) { report.keyframesDropped = (report.keyframesDropped || 0) + 1; continue; }
        report.rulesKept++; inner.push(rule.cssText);
      } else if (kind === 'CSSImportRule') {
        report.imports++;
        try {
          if (rule.styleSheet) walkSheet(rule.styleSheet);
        } catch {}
      } else if (kind === 'CSSLayerStatementRule') {
        report.rulesKept++; inner.push(rule.cssText);
      } else {
        report.rulesDropped++;
      }
    }
    if (inner.length) chunks.push(wrap ? wrap + '{' + inner.join('') + '}' : inner.join(''));
  };
  const seen = new Set();
  const walkSheet = (sheet) => {
    if (!sheet || seen.has(sheet)) return;
    seen.add(sheet);
    let rules;
    try { rules = sheet.cssRules; } catch { report.failed.push('cross-origin sheet: ' + (sheet.href || 'inline')); return; }
    if (!rules) return;
    report.sheets++;
    walkRules(rules, null);
  };
  // 收集可重跑：规则会因"晚到的元素"被判成死选择器（实测：侧栏会话列表整块没样式，
  // 文字挤在左边）。所以收集前后各数一次元素，DOM 又长了就等稳再收一遍，最多 3 遍。
  const countEls = () => document.querySelectorAll('*').length;
  const resetStats = () => {
    report.rulesTotal = 0; report.rulesKept = 0; report.rulesDropped = 0; report.mediaKept = 0;
    report.fontFaces = 0; report.keyframes = 0; report.imports = 0; report.sheets = 0;
    report.droppedSamples = [];
  };
  // 记下 sheet 引用：第 8 步会把 <style> 从 DOM 摘掉，之后 document.styleSheets 就空了，
  // 再过滤必须走这份引用（规则对象本身还活着）。
  const allSheets = [...document.styleSheets, ...(document.adoptedStyleSheets || [])];
  for (const sheet of allSheets) walkSheet(sheet);
  let cssElsAtCollect = countEls();
  // 收完就固化：先把这批规则里出现过的所有 var(--x) 名字解析成当下的字面值，再写回每个 chunk
  let cssText = '';
  const declaredCustomProps = (text) => {
    // 规则里「声明过」的自定义属性名也要进名字表：有的令牌值本身就是另一层令牌拼的，
    // 只问用到的名字会把中间那层漏掉。
    const set = new Set();
    const re = /(?:^|[{;])\s*(--[A-Za-z0-9_-]+)\s*:/g;
    let m;
    while ((m = re.exec(text))) set.add(m[1]);
    return set;
  };
  const collectCss = () => {
    const names = varNamesIn(chunks.join('\n'));
    for (const n of declaredCustomProps(chunks.join('\n'))) if (!names.has(n)) names.add(n);
    varMap = buildVarMap(names);
    for (let i = 0; i < chunks.length; i++) chunks[i] = freezeCssText(chunks[i]);
    cssText = chunks.join('\n');
  };
  collectCss();

  // 3) 内联资源：图片 / 背景图 / 字体
  const fetchCache = new Map();
  const abs = (u) => { try { return new URL(u, document.baseURI).href; } catch { return u; } };
  const isFont = (u, hint) => /\.(woff2?|ttf|otf|eot)(\?|#|$)/i.test(u) || /font/i.test(hint || '');
  async function toDataUri(rawUrl, hint) {
    const u = abs(rawUrl);
    if (!u || u.startsWith('data:')) return u;
    if (fetchCache.has(u)) return fetchCache.get(u);
    const p = (async () => {
      try {
        const res = await fetch(u, { credentials: 'include' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const buf = new Uint8Array(await res.arrayBuffer());
        const ct = (res.headers.get('content-type') || '').split(';')[0] || guessMime(u);
        if (!/^(image|font)\//.test(ct) && !/woff|ttf|otf/.test(ct)) {
          report.failed.push('not image/font (' + ct + '): ' + u);
          report.unresolved++;
          return u; // 拿不到就当外链留着
        }
        let bin = '';
        const CH = 0x8000;
        for (let i = 0; i < buf.length; i += CH) bin += String.fromCharCode.apply(null, buf.subarray(i, i + CH));
        const uri = 'data:' + ct + ';base64,' + btoa(bin);
        report.resources.push({ url: u, kind: isFont(u, ct) ? 'font' : 'image', bytes: buf.length, mime: ct });
        return uri;
      } catch (e) {
        report.failed.push((String(e.message || e) + ' ' + u).slice(0, 200));
        report.unresolved++;
        return u;
      }
    })();
    fetchCache.set(u, p);
    return p;
  }
  const guessMime = (u) => {
    const ext = (u.match(/\.([a-z0-9]+)(?:\?|#|$)/i) || [])[1] || '';
    return { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf' }[ext.toLowerCase()] || 'application/octet-stream';
  };

  // CSS 里的 url() —— 一次收集，并发内联
  const cssUrls = new Set();
  cssText.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (m, q, u) => { cssUrls.add(u); return m; });
  const cssMap = new Map();
  await Promise.all([...cssUrls].map(async (u) => { cssMap.set(u, await toDataUri(u, 'css')); }));

  // 元素属性里的图片（img/src、style 内联背景）
  const attrUrls = new Set();
  for (const el of document.querySelectorAll('img[src], source[src], image[href], [style*="url("]')) {
    const src = el.getAttribute('src') || el.getAttribute('href');
    if (src) attrUrls.add(src);
    const st = el.getAttribute('style') || '';
    st.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (m, q, u) => { attrUrls.add(u); return m; });
  }
  const bodyHtmlBefore = document.body.innerHTML;
  const unent = (v) => v.replace(/&quot;|&#39;|&amp;/g, (x) => (x === '&amp;' ? '&' : ''));
  for (const u of bodyHtmlBefore.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)) {
    const v = unent(u[2]);
    if (!v.includes('data:')) attrUrls.add(u[2]);
  }
  const attrMap = new Map();
  await Promise.all([...attrUrls].map(async (u) => {
    if (!u || u.startsWith('data:') || unent(u).includes('data:') || u.startsWith('#')) return;
    attrMap.set(u, await toDataUri(u, 'attr'));
  }));
  const subAttr = (html) =>
    html.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (m, q, u) => {
      const v = attrMap.get(u);
      return v && v !== u ? 'url(' + q + v + q + ')' : m;
    });

  // 3.5) 可选：丢掉 url 拿不到（404/跨域）的 @font-face —— 它们只剩装饰性文本
  const dropDeadFonts = (css) => {
    let n = 0;
    const out = css.replace(/@font-face\{[^}]*\}/g, (m) => {
      if (/url\(\s*['"]?https?:/i.test(m)) { n++; return ''; }
      return m;
    });
    if (n) report.fontFacesDropped = (report.fontFacesDropped || 0) + n;
    return out;
  };

  // 4) 生成两份 CSS：字体内联 / 字体留外链（超预算时降级）
  //    改成按"一段 CSS 文本"处理，多文件模式要按 chunk 分别产出（好做跨页共用去重）
  const subUrls = (text, inlineFonts) =>
    subAttr(text).replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (m, q, u) => {
      const v = cssMap.get(u);
      if (!v || v === u) return m;
      if (!inlineFonts && v.startsWith('data:font')) return 'url(' + abs(u) + ')';
      if (!inlineFonts && /^data:(font|application\/octet)/.test(v)) return 'url(' + abs(u) + ')';
      return 'url(' + q + v + q + ')';
    });
  const buildCss = (inlineFonts) => subUrls(cssText, inlineFonts);

  // 6) 元素索引（给时间轴挑目标用，旁挂文件，不算进快照体积）
  const pathOf = (el) => {
    const parts = [];
    let n = el;
    while (n && n.nodeType === 1 && n !== document.documentElement) {
      let s = n.tagName.toLowerCase();
      if (n.id && /^[A-Za-z][\w-]*$/.test(n.id)) { parts.unshift('#' + n.id); break; }
      const cls = [...n.classList].filter((c) => /^[A-Za-z_][\w-]*$/.test(c)).slice(0, 3);
      if (cls.length) s += '.' + cls.join('.');
      else { const p = n.parentElement; if (p) s += ':nth-child(' + ([...p.children].indexOf(n) + 1) + ')'; }
      parts.unshift(s);
      n = n.parentElement;
    }
    return parts.join(' > ');
  };
  const elements = [];
  for (const el of document.querySelectorAll('button, a, input, textarea, select, [role], [tabindex], [contenteditable="true"]')) {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    let sel = pathOf(el);
    if (document.querySelectorAll(sel).length !== 1) continue;
    elements.push({
      sel,
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role') || undefined,
      text: (el.innerText || el.value || '').replace(/\s+/g, ' ').trim().slice(0, 60) || el.getAttribute('aria-label') || el.getAttribute('title') || '',
      x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
    });
    if (elements.length >= 500) break;
  }

  // 5.4) 正文里的变量与皮肤标记
  //      行内 style、SVG 呈现属性（fill="var(--dsw-…)"）都不在样式表里，只固化规则会漏掉；
  //      逐个用「这个元素此刻的实际值」写死。皮肤开关属性（data-dsh-columbina）不进素材：
  //      它带来的外观已经由字面值固定，块不该再靠宿主是否开着皮肤来命中。
  {
    const els = [document.documentElement, ...document.querySelectorAll('body, body *')];
    for (const el of els) {
      for (const attr of [...el.attributes]) {
        if (attr.value.indexOf('var(') < 0) continue;
        const map = readCustomVars(el);
        for (const [k, v] of varMap) if (!map.has(k)) map.set(k, v);
        const r = resolveVars(attr.value, map, 0);
        if (r.ok && r.text.indexOf('var(') < 0) {
          if (r.text !== attr.value) { el.setAttribute(attr.name, r.text); report.bodyVarsFrozen++; }
        } else {
          noteInvalid(r.name || 'attr:' + attr.name);
          el.removeAttribute(attr.name);
          report.bodyVarsDropped = (report.bodyVarsDropped || 0) + 1;
        }
      }
    }
    for (const el of [document.body, ...document.querySelectorAll('[' + SKIN_ATTR + ']')]) {
      if (el && el.hasAttribute && el.hasAttribute(SKIN_ATTR)) { el.removeAttribute(SKIN_ATTR); report.skinAttrsDropped++; }
    }
  }

  // 5) 去掉会执行/会影响样式来源的节点，再取 body 结构
  const stripTags = (html) => html;
  for (const n of document.querySelectorAll('script')) n.remove();
  for (const n of document.querySelectorAll('link[rel="stylesheet"], link[rel="preload"]')) n.remove();
  const styleTags = [...document.querySelectorAll('style')];
  styleTags.forEach((n) => n.remove());
  report.styleTagsRemoved = styleTags.length;

  // 5.5) 大图重编码：base64 原样带着必超 256KB，降采样并降质量，逐张记账
  const shrunk = [];
  const b64Of = (u8) => { let bin = ''; const CH = 0x8000; for (let i = 0; i < u8.length; i += CH) bin += String.fromCharCode.apply(null, u8.subarray(i, i + CH)); return btoa(bin); };
  const seenData = new Map();
  async function shrinkOne(mime, b64) {
    if (b64.length <= shrinkMin) return null;
    const key = mime + ':' + b64.slice(0, 64) + ':' + b64.length;
    if (seenData.has(key)) return seenData.get(key);
    const p = (async () => {
      try {
        const bin = atob(b64);
        const u8 = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
        const bmp = await createImageBitmap(new Blob([u8], { type: mime }));
        const scale = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
        const w = Math.max(1, Math.round(bmp.width * scale));
        const h = Math.max(1, Math.round(bmp.height * scale));
        const cv = new OffscreenCanvas(w, h);
        cv.getContext('2d').drawImage(bmp, 0, 0, w, h);
        const outMime = mime === 'image/jpeg' ? 'image/jpeg' : 'image/webp';
        const blob = await cv.convertToBlob({ type: outMime, quality });
        const nb = new Uint8Array(await blob.arrayBuffer());
        const uri = 'data:' + outMime + ';base64,' + b64Of(nb);
        if (uri.length >= b64.length + mime.length + 8) return null;
        shrunk.push({ mime, fromPx: bmp.width + 'x' + bmp.height, toPx: w + 'x' + h, before: b64.length, after: nb.length });
        return 'data:' + outMime + ';base64,' + b64Of(nb);
      } catch (e) {
        report.failed.push('shrink failed ' + String(e.message || e).slice(0, 80));
        return null;
      }
    })();
    seenData.set(key, p);
    return p;
  }
  async function shrinkDataUris(html) {
    const re = /data:(image\/(?:png|jpeg|jpg|webp|gif));base64,([A-Za-z0-9+/=]+)/g;
    const jobs = [];
    let out = '';
    let last = 0;
    let m;
    while ((m = re.exec(html))) {
      jobs.push({ start: m.index, end: m.index + m[0].length, mime: m[1].replace('jpg', 'jpeg'), b64: m[2] });
    }
    if (!jobs.length) return html;
    const replaced = await Promise.all(jobs.map((j) => shrinkOne(j.mime, j.b64)));
    for (let i = 0; i < jobs.length; i++) {
      out += html.slice(last, jobs[i].start);
      out += replaced[i] || html.slice(jobs[i].start, jobs[i].end);
      last = jobs[i].end;
    }
    return out + html.slice(last);
  }

  // 5.6) 多文件模式：把 data: 大件抽成独立文件（每文件仍受 assetCap 约束）
  //   - 元素内联背景大图（壁纸）：按元素可视尺寸裁出"真正被看见的那块"，1:1 落盘，
  //     并把该元素的 background-size 改成 100% 100% —— 像素不再靠缩图换体积。
  //   - 其余 data: 图片：原样抽出；超单文件上限才降质量重编码（优先保原生像素）。
  // 最后一道闸：CSS 收完之后 DOM 又长了（晚到内容），等稳重收一遍再落盘；拆模式尤其要重收，
  // 否则 late 元素的规则永远进不了 page.css。
  {
    let pass = 0;
    while (pass < 3 && countEls() !== cssElsAtCollect) {
      pass++;
      let prev = '', stable = 0;
      for (let i = 0; i < 40; i++) {
        const n = countEls() + ':' + document.body.innerText.length;
        if (n === prev) { if (++stable >= 4) break; } else stable = 0;
        prev = n;
        await new Promise((r) => setTimeout(r, 250));
      }
      chunks.length = 0; seen.clear(); resetStats();
      for (const sheet of allSheets) walkSheet(sheet);
      cssElsAtCollect = countEls();
      collectCss();
      report.cssRecollect = pass;
    }
  }

  if (split) {
    const assets = new Map();
    const b64ToU8 = (b64) => { const bin = atob(b64); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i); return u8; };
    const u8ToB64 = (u8) => { let bin = ''; const CH = 0x8000; for (let i = 0; i < u8.length; i += CH) bin += String.fromCharCode.apply(null, u8.subarray(i, i + CH)); return btoa(bin); };
    const extOf = (mime) => ({ 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/svg+xml': 'svg' }[mime] || 'bin');
    const hexOf = async (u8) => {
      const d = await crypto.subtle.digest('SHA-256', u8);
      return [...new Uint8Array(d)].slice(0, 8).map((x) => x.toString(16).padStart(2, '0')).join('');
    };
    async function addAsset(u8, mime, meta) {
      const hash = await hexOf(u8);
      if (!assets.has(hash)) assets.set(hash, { hash, mime, ext: extOf(mime), b64: u8ToB64(u8), bytes: u8.length, ...meta });
      return '@@asset:' + hash + '@@';
    }
    const QS = [0.92, 0.88, 0.85, 0.8, 0.75, 0.7, 0.6, 0.5];
    async function encFit(cv, mime) {
      for (const q of QS) {
        const blob = await cv.convertToBlob({ type: mime, quality: q });
        if (blob.size <= assetCap) return { u8: new Uint8Array(await blob.arrayBuffer()), bytes: blob.size, q };
      }
      return null;
    }

    // 壁纸：按 background-size/position 算可见源区，再用元素自身像素尺寸画出来
    const cropApps = [];
    for (const el of document.querySelectorAll('[style*="data:image"]')) {
      const mm = /url\((["']?)(data:image\/[^)"']+)\1\)/.exec(el.getAttribute('style') || '');
      if (!mm) continue;
      const uri = mm[2];
      const b64 = uri.slice(uri.indexOf('base64,') + 7);
      const origBytes = Math.round(b64.length * 0.75);
      if (origBytes <= assetCap) continue;
      try {
        const r = el.getBoundingClientRect();
        const bmp = await createImageBitmap(await (await fetch(uri)).blob());
        const cs = getComputedStyle(el);
        const pos = (cs.backgroundPosition || '50% 0%').split(/\s+/).map((v) => parseFloat(v) / 100);
        const pxp = isNaN(pos[0]) ? 0.5 : pos[0];
        const pyp = isNaN(pos[1]) ? 0 : pos[1];
        const scale = Math.max(r.width / bmp.width, r.height / bmp.height);
        const dw = bmp.width * scale, dh = bmp.height * scale;
        const ox = (dw - r.width) * pxp, oy = (dh - r.height) * pyp;
        const sx = Math.max(0, ox / scale), sy = Math.max(0, oy / scale);
        const sw = Math.min(bmp.width - sx, r.width / scale), sh = Math.min(bmp.height - sy, r.height / scale);
        const w = Math.round(r.width), h = Math.round(r.height);
        const cv = new OffscreenCanvas(w, h);
        cv.getContext('2d').drawImage(bmp, sx, sy, sw, sh, 0, 0, w, h);
        const res = await encFit(cv, 'image/webp');
        if (!res) continue;
        const tok = await addAsset(res.u8, 'image/webp', {
          mode: 'crop-1:1', origBytes, bytes: res.bytes, q: res.q,
          fromPx: bmp.width + 'x' + bmp.height, cropPx: Math.round(sw) + 'x' + Math.round(sh), toPx: w + 'x' + h,
        });
        el.style.backgroundSize = '100% 100%';
        el.style.backgroundPosition = '0 0';
        el.style.backgroundImage = 'url("' + tok + '")';
        cropApps.push({ el: el.tagName.toLowerCase() + (el.id ? '#' + el.id : ''), origBytes, bytes: res.bytes, q: res.q, fromPx: bmp.width + 'x' + bmp.height, cropPx: Math.round(sw) + 'x' + Math.round(sh), toPx: w + 'x' + h });
      } catch (e) { report.failed.push('crop bg failed ' + String(e.message || e).slice(0, 80)); }
    }

    // 其余 data: 图片 → 独立文件（先原样，超限才重编码）
    async function swapAssets(text) {
      const re = /data:(image\/[a-z0-9+]+);base64,([A-Za-z0-9+/=]+)/g;
      const jobs = [];
      let m;
      while ((m = re.exec(text))) jobs.push({ start: m.index, end: m.index + m[0].length, mime: m[1], b64: m[2] });
      if (!jobs.length) return text;
      const toks = await Promise.all(jobs.map(async (j) => {
        let u8 = b64ToU8(j.b64);
        const origBytes = u8.length;
        let mime = j.mime;
        let meta = { mode: 'raw', origBytes, bytes: origBytes };
        if (origBytes > assetCap) {
          try {
            const bmp = await createImageBitmap(new Blob([u8], { type: mime }));
            const steps = [[bmp.width, bmp.height], [Math.round(bmp.width * 0.75), Math.round(bmp.height * 0.75)], [Math.round(bmp.width * 0.5), Math.round(bmp.height * 0.5)]];
            for (const [w, h] of steps) {
              const cv = new OffscreenCanvas(w, h);
              cv.getContext('2d').drawImage(bmp, 0, 0, w, h);
              const res = await encFit(cv, 'image/webp');
              if (res) { u8 = res.u8; mime = 'image/webp'; meta = { mode: 'reencode', origBytes, bytes: res.bytes, q: res.q, fromPx: bmp.width + 'x' + bmp.height, toPx: w + 'x' + h }; break; }
            }
          } catch (e) { report.failed.push('asset reencode failed ' + String(e.message || e).slice(0, 60)); }
        }
        return addAsset(u8, mime, meta);
      }));
      let out = '', last = 0;
      for (let i = 0; i < jobs.length; i++) { out += text.slice(last, jobs[i].start) + toks[i]; last = jobs[i].end; }
      return out + text.slice(last);
    }

    splitBody = await swapAssets(subAttr(document.body.innerHTML));
    splitRules = [];
    for (const c of chunks) splitRules.push(await swapAssets(subUrls(c, true)));
    splitAssets = [...assets.values()];
    report.croppedWallpapers = cropApps;
    report.assetCount = splitAssets.length;
    report.assetBytes = splitAssets.reduce((a, x) => a + x.bytes, 0);
  }

  const bodyHtml = split ? splitBody : await shrinkDataUris(subAttr(document.body.innerHTML));
  const attrList = (el) => [...el.attributes].map((a) => [a.name, a.value]);
  return {
    doc: {
      lang: document.documentElement.getAttribute('lang') || 'zh-CN',
      htmlAttrs: attrList(document.documentElement),
      // 皮肤开关属性不进素材（块里的外观已经全部是字面值）
      bodyAttrs: attrList(document.body).filter(([k]) => k !== SKIN_ATTR),
      title: document.title,
      bodyHtml,
      rootVars,
      cssInlineFonts: split ? '' : await shrinkDataUris(opts.dropDeadFontFace ? dropDeadFonts(buildCss(true)) : buildCss(true)),
      cssNoFonts: split ? '' : await shrinkDataUris(opts.dropDeadFontFace ? dropDeadFonts(buildCss(false)) : buildCss(false)),
      rules: splitRules,
      assets: splitAssets,
    },
    elements,
    report: { ...report, cssBytes: cssText.length, bodyBytes: bodyHtml.length, rootVarsBytes: rootVars.length,
      resourceBytes: report.resources.reduce((a, r) => a + r.bytes, 0),
      fontBytes: report.resources.filter((r) => r.kind === 'font').reduce((a, r) => a + r.bytes, 0),
      imageBytes: report.resources.filter((r) => r.kind === 'image').reduce((a, r) => a + r.bytes, 0),
      imagesShrunk: shrunk,
    },
  };
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

function buildHtml(doc, css, note) {
  const htmlAttrs = doc.htmlAttrs.filter(([k]) => k !== 'class' || true).map(([k, v]) => k + '="' + esc(v) + '"').join(' ');
  const bodyAttrs = doc.bodyAttrs.map(([k, v]) => k + '="' + esc(v) + '"').join(' ');
  return '<!doctype html>\n<html ' + htmlAttrs + '>\n<head>\n<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">\n' +
    '<title>' + esc(doc.title) + '</title>\n' +
    '<!-- ui-snapshot 自包含快照' + (note ? '：' + note : '') + ' -->\n' +
    '<style id="snap-vars">' + doc.rootVars + '</style>\n' +
    '<style id="snap-css">' + css + '</style>\n</head>\n<body ' + bodyAttrs + '>' + doc.bodyHtml + '</body>\n</html>\n';
}

// ---- 主流程：预算阶梯 -----------------------------------------------------
// 一次抓到底 → 量体积 → 超了就换更狠的一档重抓；每一档都记账，最后如实报告。
const ladder = [];
if (argv.includes('--max-dim') || argv.includes('--quality')) {
  ladder.push({ level: 'custom', maxDim, quality });
} else {
  ladder.push({ level: 'L0', maxDim: 1024, quality: 0.62 });
  ladder.push({ level: 'L1', maxDim: 900, quality: 0.55 });
  ladder.push({ level: 'L2', maxDim: 820, quality: 0.5, dropKeyframes: true, dropDeadFontFace: true });
  ladder.push({ level: 'L3', maxDim: 768, quality: 0.45, dropKeyframes: true, dropDeadFontFace: true });
}

async function runCapture(p) {
  const b = await launch({ width, height });
  try {
    await navigate(b.session, url, { settle });
    await evaluate(b.session, () => {
      const s = document.querySelector('.dshba');
      if (s) { const v = s.querySelector('video'); if (v) { try { v.pause(); v.muted = true; } catch {} } s.remove(); }
      window.scrollTo(0, 0);
      return true;
    });
    if (prepareJs) {
      await evaluate(b.session, prepareJs, { isExpression: true });
      await new Promise((r) => setTimeout(r, 400));
    }
    if (readyExpr) {
      for (let i = 0; i < 80; i++) {
        const ok = await evaluate(b.session, '!!(' + readyExpr + ')', { isExpression: true });
        if (ok) break;
        await new Promise((r) => setTimeout(r, 250));
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    if (shotPath) {
      const png = await screenshot(b.session);
      await writeFile(path.resolve(shotPath), png);
    }
    const opts = { noFonts: p.noFonts || noFonts, shrinkMin, maxDim: p.maxDim, quality: p.quality, dropKeyframes: p.dropKeyframes, dropDeadFontFace: p.dropDeadFontFace, split: !!splitDir, assetCap };
    return await evaluate(
      b.session,
      '(() => { const fn = ' + grab.toString() + '; return fn(' + JSON.stringify(opts) + '); })()',
      { isExpression: true }
    );
  } finally {
    await b.close();
  }
}

// ---- 多文件模式：一次抓全保真，把零件落盘给 assemble.mjs ----------------------
async function writeParts(r) {
  const dir = path.resolve(splitDir);
  await mkdir(path.join(dir, 'assets'), { recursive: true });
  const assets = r.doc.assets || [];
  for (const a of assets) await writeFile(path.join(dir, 'assets', a.hash + '.' + a.ext), Buffer.from(a.b64, 'base64'));
  const meta = assets.map(({ b64, ...m }) => m);
  const parts = {
    name: path.basename(dir), url, title: r.doc.title,
    htmlAttrs: r.doc.htmlAttrs, bodyAttrs: r.doc.bodyAttrs,
    bodyHtml: r.doc.bodyHtml, rootVars: r.doc.rootVars, rules: r.doc.rules || [], assets: meta,
  };
  await writeFile(path.join(dir, 'parts.json'), JSON.stringify(parts, null, 1), 'utf8');
  await writeFile(path.join(dir, 'elements.json'), JSON.stringify(r.elements, null, 0), 'utf8');
  const rulesText = (r.doc.rules || []).join('\n');
  const files = [{ file: 'parts.json', bytes: Buffer.byteLength(JSON.stringify(parts, null, 1), 'utf8') }].concat(
    meta.map((a) => ({ file: 'assets/' + a.hash + '.' + a.ext, bytes: a.bytes, origBytes: a.origBytes, mode: a.mode, q: a.q, fromPx: a.fromPx, toPx: a.toPx }))
  );
  console.log(JSON.stringify({
    mode: 'split', url, out: dir, width, height,
    bodyBytes: Buffer.byteLength(r.doc.bodyHtml, 'utf8'),
    rulesBytes: Buffer.byteLength(rulesText, 'utf8'), rules: (r.doc.rules || []).length,
    tokensBytes: Buffer.byteLength(r.doc.rootVars, 'utf8'),
    assetBytes: meta.reduce((x, a) => x + a.bytes, 0),
    files,
    report: { ...r.report, droppedSamples: r.report.droppedSamples.slice(0, 8), failed: r.report.failed.slice(0, 20) },
  }, null, 1));
}

if (splitDir) {
  await writeParts(await runCapture({ level: 'split', maxDim: 0, quality: 0 }));
  await new Promise((r) => process.stdout.write('', () => r())); // 先把 stdout 冲干净再退
  process.exit(0);
}

const attempts = [];
let final = null;
for (const p of ladder) {
  const r = await runCapture(p);
  for (const useNoFonts of [false, true]) {
    if (useNoFonts && r.doc.cssInlineFonts.length === r.doc.cssNoFonts.length) continue;
    const css = useNoFonts ? r.doc.cssNoFonts : r.doc.cssInlineFonts;
    const html = buildHtml(r.doc, css, useNoFonts ? '字体留外链' : '');
    const bytes = Buffer.byteLength(html, 'utf8');
    attempts.push({ level: p.level + (useNoFonts ? '/noFonts' : ''), maxDim: p.maxDim, quality: p.quality, bytes });
    if (!final || bytes < final.bytes) final = { ...r, html, css, bytes, params: p, useNoFonts };
    if (bytes <= maxBytes) break;
  }
  if (final && final.bytes <= maxBytes) break;
}

const { doc, elements, report, html, css, bytes } = final;
const trimmed = [{
  level: final.params.level,
  maxDim: final.params.maxDim,
  quality: final.params.quality,
  keyframesDropped: report.keyframesDropped || 0,
  fontFacesDropped: report.fontFacesDropped || 0,
  fontsExternal: !!final.useNoFonts,
  imagesShrunk: report.imagesShrunk || [],
}];

await writeFile(outPath, html, 'utf8');
const base2 = outPath.replace(/\.html$/, '');
await writeFile(base2 + '.elements.json', JSON.stringify(elements, null, 0), 'utf8');

const summary = {
  url, out: outPath, width, height,
  bytes, limit256: 256 * 1024, overLimit: bytes > 256 * 1024,
  elementsFile: base2 + '.elements.json',
  level: final.params.level,
  bytesOverLimit: Math.max(0, bytes - 256 * 1024),
  attempts,
  trimmed,
  report: { ...report, droppedSamples: report.droppedSamples.slice(0, 12), failed: report.failed.slice(0, 40) },
};
await writeFile(base2 + '.report.json', JSON.stringify(summary, null, 1), 'utf8');
console.log(JSON.stringify(summary, null, 1));