// dsh-page-capture / extractor.js
// 纯函数抽取层：不 import、不碰 chrome.*，只用形参 doc（一个 document 接口）。
// ① MV3：chrome.scripting.executeScript({files:['extractor.js']}) 注入页面（ISOLATED world）
// ② self-check.mjs：CDP Runtime.evaluate 注入同一份源码，离线跑同一套断言
// 入口：globalThis.dshPageCapture.extract(doc, opts) => Promise<{ files, report }>
(function () {
  'use strict';

  var NL = String.fromCharCode(10);
  var COMPUTED_PROPS = ['color', 'background-color', 'font-size', 'font-family', 'line-height',
    'padding', 'margin', 'border-radius', 'box-shadow', 'display', 'grid-template-columns', 'gap',
    // 布局位置也是"版式事实"，必须固化：实测 courses.zju.edu.cn 的抽屉样式表 pure-drawer.css
    // 跨域取不到（cssRules 抛 SecurityError），抽屉的 position/left/transform 全在里面，
    // 抓下来抽屉落回文档流、把整页往下压 450px，模型只能自己读 entry.html 反推版式。
    'position', 'inset', 'top', 'right', 'bottom', 'left', 'transform', 'z-index', 'overflow'];
  var INHERITED = { color: 1, 'font-size': 1, 'font-family': 1, 'line-height': 1 };
  // 这几个属性"等于默认"就是没设过，写进块只会白胖，默认值一律不输出。
  var PROP_DEFAULTS = {
    position: 'static', inset: 'auto', top: 'auto', right: 'auto', bottom: 'auto', left: 'auto',
    transform: 'none', 'z-index': 'auto', overflow: 'visible'
  };
  /** 单位矩阵 = 视觉上没动，和 transform:none 一样省掉。 */
  function identityTransform(v) {
    var s = String(v || '').replace(/\s+/g, '');
    return s === 'matrix(1,0,0,1,0,0)' || s === 'matrix3d(1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1)';
  }

  // 单文件上限 16 MB：这是**抓取时**的落盘上限，不是建块时的上限（index.js 的
  // limits.sectionBytes 是另一条，默认 8 MB）。实测教务页有 2.3 MB 的 woff 与
  // 4.2 MB 的 ttf，旧值 2 MB 在浏览器侧就把它们截断了——插件侧抬到 8 MB 也管不到这里。
  var MAX_ASSET_BYTES = 16 * 1024 * 1024;
  var MAX_ASSET_MB = Math.round(MAX_ASSET_BYTES / 1048576) + 'MB';
  // 内嵌那条不动：base64 会胀 4/3，1.4 MB 的字节内嵌后约 1.87 MB，仍在一段之内。
  var MAX_INLINE_BYTES = 1400 * 1024;
  // 单边 2000px 的降采样只对长宽比正常的图用；长宽比 ≥ 8 判为雪碧图/长条图，
  // 原尺寸落文件（358x20870 压成 34x2000 等于毁掉）。
  var MAX_IMAGE_DIM = 2000;
  var SPRITE_RATIO = 8;
  /** 单次取字节上限：后台同值，超了当场报原因，不把 40 MB 的图灌进消息通道。 */
  var MAX_FETCH_BYTES = 12 * 1024 * 1024;
  var SECTION_MAX_BYTES = 2 * 1024 * 1024; // 块格式单段上限（DSH 侧默认值）

  // ---- frame 盲区 ---------------------------------------------------------
  // 正文装在 iframe 里的页面（实测教务页就是），顶层文档抓下来是一片空：扩展只注入
  // 顶层文档，没有 all_frames，跨域 frame 连读都读不到。不点名的话，模型会当成
  // 「页面没内容」或「我抓错了」，自己猜三轮再去问用户三选一，白等两分钟。
  var FRAME_SEL = 'iframe, frame, object, embed';
  /** 一个 frame 盖住可视区 30% 以上，就算「正文在框里」。 */
  var FRAME_DOMINANT_RATIO = 0.3;
  /** 顶层文档的「空」判据：可见文字 < 50 字符，可见元素 < 5 个。 */
  var FRAME_SHELL_TEXT_MAX = 50;
  var FRAME_SHELL_ELEMENTS_MAX = 5;
  /** 固定一句话，可 grep：模型第一步就知道空的不是它的错。 */
  var FRAME_SHELL_LINE = 'THIS PAGE IS A FRAME SHELL — the visible content lives inside a frame; capturing the top document yields nothing usable.';
  var FRAME_NOTE = '页面正文在一个 iframe 里，顶层文档抓不到它；最省事的解法是在该框架上右键「在标签页中打开框架」，然后把那个新标签页的 DOM 抓下来。';
  var FRAME_ASK = '遇到 frame shell 不要问用户三选一：直接说「把那个框架在新标签打开，我抓那个标签」——截图只能当参考，按公开样式硬猜是下策。';

  var ENTRY = 'entry.html';
  var APP_CSS = 'shared/app.css';
  var PAGE_CSS = 'pages/current/page.css';

  // ---- 文本小工具 ---------------------------------------------------------
  function utf8Len(s) { return new TextEncoder().encode(String(s)).length; }

  function splitTopLevel(text, sep) {
    var out = [], depth = 0, cur = '', q = null;
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      if (q) { cur += ch; if (ch === q) q = null; continue; }
      if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
      if (ch === '(' || ch === '[') depth++;
      else if (ch === ')' || ch === ']') depth--;
      if (ch === sep && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
    }
    out.push(cur);
    return out;
  }

  function escAttr(s) {
    return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ---- var() 固化 ---------------------------------------------------------
  // 硬要求：抓下来的块里不许留 var(--dsw-*)——否则启用皮肤后块会跟着变样。
  // 做法：把 :root / body 上此刻的实测自定义属性抓成字面值表，再把每条声明里的
  // var(--x) 递归替换；解析不了就丢掉整条声明（宁可少一条样式，不留一个悬空引用）。
  function findVar(text) {
    var i = text.indexOf('var(');
    if (i < 0) return null;
    var depth = 0, q = null;
    for (var j = i + 3; j < text.length; j++) {
      var ch = text[j];
      if (q) { if (ch === q) q = null; continue; }
      if (ch === '"' || ch === "'") { q = ch; continue; }
      if (ch === '(') depth++;
      else if (ch === ')') { depth--; if (depth === 0) return { start: i, end: j + 1, inside: text.slice(i + 4, j) }; }
    }
    return null;
  }

  function resolveText(text, vars, depth) {
    depth = depth || 0;
    if (depth > 12) return { ok: false, text: text };
    var hit = findVar(text);
    if (!hit) return { ok: true, text: text };
    var args = splitTopLevel(hit.inside, ',');
    var name = String(args[0] || '').trim();
    var fb = args.length > 1 ? args.slice(1).join(',').trim() : '';
    var raw = Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]).trim()
      : (typeof vars.lookup === 'function' ? String(vars.lookup(name) || '').trim() : '');
    var sub;
    if (raw !== '') sub = resolveText(raw, vars, depth + 1);
    else if (fb !== '') sub = resolveText(fb, vars, depth + 1);
    else return { ok: false, text: text, name: name };
    if (!sub.ok) return { ok: false, text: text, name: sub.name || name };
    return resolveText(text.slice(0, hit.start) + sub.text + text.slice(hit.end), vars, depth + 1);
  }

  // 一条声明块（"a:b;c:d"）过一遍：自定义属性一律丢弃（消费方已固化），
  // var() 递归解析，解析不了整条丢。
  function cleanDecls(body, vars, st) {
    var parts = splitTopLevel(String(body || ''), ';');
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      var d = parts[i].trim();
      if (!d) continue;
      var c = d.indexOf(':');
      if (c < 0) continue;
      var prop = d.slice(0, c).trim();
      var val = d.slice(c + 1).trim();
      if (!prop || !val) continue;
      if (prop.slice(0, 2) === '--') { st.customPropsDropped++; continue; }
      var r = resolveText(val, vars, 0);
      if (!r.ok || /var\(\s*--/.test(r.text)) {
        // 没声明、也没 fallback：浏览器在「计算值阶段」判整条声明无效，属性退到 unset
        // （继承属性照旧继承，其余取初始值）。写成 unset 才等价，也不留悬空的 var()。
        st.declarationsInvalid++;
        st.invalidAtComputedValue.push((r.name || '?') + ' -> ' + prop);
        out.push(prop + ':unset');
        continue;
      }
      out.push(prop + ':' + r.text);
    }
    return out.join(';');
  }

  function readVars(cs) {
    var vars = {};
    if (!cs) return vars;
    for (var i = 0; i < cs.length; i++) {
      var p = cs[i];
      if (p && p.slice(0, 2) === '--') {
        var v = String(cs.getPropertyValue(p) || '').trim();
        if (v !== '') vars[p] = v;
      }
    }
    return vars;
  }

  // ---- 资源：取字节 / 转 data: / 降采样 / 溢出到 assets/ -------------------
  function absUrl(u, base) {
    try { return new URL(u, base).href; } catch (e) { return ''; }
  }

  function toBase64(u8) {
    var s = '', CH = 0x8000;
    for (var i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
    return btoa(s);
  }

  function guessMime(u) {
    var m = /\.([a-z0-9]+)(?:[?#]|$)/i.exec(u) || [];
    var ext = (m[1] || '').toLowerCase();
    var map = {
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
      webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif', bmp: 'image/bmp',
      ico: 'image/x-icon', woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf',
      otf: 'font/otf', eot: 'application/vnd.ms-fontobject'
    };
    return map[ext] || 'application/octet-stream';
  }

  function splitDataUri(uri) {
    var i = uri.indexOf(',');
    if (i < 0) return null;
    var head = uri.slice(0, i), body = uri.slice(i + 1);
    var m = /^data:([^;,]*)/i.exec(head) || [];
    var mime = m[1] || 'application/octet-stream';
    var isB64 = /;base64/i.test(head);
    var bytes;
    if (isB64) {
      // 减掉 padding：base64 长度不是 4 的倍数时 floor(len*3/4) 会比真实字节多 1~2
      var pad = (/=*$/.exec(body) || [''])[0].length;
      bytes = Math.floor(body.length * 3 / 4) - pad;
    }
    else { try { bytes = utf8Len(decodeURIComponent(body)); } catch (e) { bytes = body.length; } }
    return { mime: mime, bytes: bytes, base64: isB64 ? body : null };
  }

  function fromBase64(b64) {
    var bin = atob(b64);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  /** 长宽比极端的图（雪碧图、长条图）：降采样会把它压成一条线，只能原尺寸保留。 */
  function spriteLike(w, h) {
    if (!w || !h) return false;
    return Math.max(w, h) / Math.min(w, h) >= SPRITE_RATIO;
  }

  function extOf(url, mime) {
    var m = /\.([a-z0-9]{2,5})(?:[?#]|$)/i.exec(String(url || '')) || [];
    var ext = String(m[1] || '').toLowerCase();
    if (ext && ext !== 'php' && ext !== 'aspx' && ext !== 'cgi') return ext === 'jpeg' ? 'jpg' : ext;
    var mm = /^image\/([a-z0-9+.-]+)/i.exec(String(mime || '')) || [];
    var out = String(mm[1] || '').toLowerCase();
    if (out === 'svg+xml') return 'svg';
    if (out === 'jpeg') return 'jpg';
    if (out) return out;
    var fm = /^font\/([a-z0-9+.-]+)/i.exec(String(mime || '')) || [];
    return String(fm[1] || '').toLowerCase() || 'bin';
  }

  /**
   * srcset / imagesrcset 取最大候选。描述符里 w（固有宽度）优先于 x（像素密度）：
   * 混着写时按 w 挑，因为块的画布宽按 CSS 像素算，密度描述符换不出更大的源。
   * 返回候选 URL 原文（可能是相对地址），调用方负责绝对化。
   */
  function pickSrcsetMax(value) {
    var s = String(value || '');
    var bestUrl = '', bestW = 0, bestX = 0, sawW = false;
    var i = 0, guard = 0;
    while (i < s.length && guard++ < 400) {
      while (i < s.length && /[\s,]/.test(s[i])) i++;
      if (i >= s.length) break;
      var start = i;
      while (i < s.length && !/[\s,]/.test(s[i])) i++;
      var url = s.slice(start, i);
      // 描述符可能带括号（较新语法）：按顶层逗号收尾
      var dstart = i, depth = 0;
      while (i < s.length) {
        var ch = s[i];
        if (ch === '(') depth++;
        else if (ch === ')') depth = depth > 0 ? depth - 1 : 0;
        else if (ch === ',' && depth === 0) break;
        i++;
      }
      var desc = s.slice(dstart, i).trim();
      i++;
      if (!url || /^data:/i.test(url)) continue;
      var mw = /([\d.]+)\s*w(?![\w-])/.exec(desc);
      var mx = /([\d.]+)\s*x(?![\w-])/.exec(desc);
      if (mw) {
        var w = Number(mw[1]);
        if (w >= bestW) { bestW = w; bestUrl = url; sawW = true; }
      } else if (!sawW) {
        var x = mx ? Number(mx[1]) : 1;
        if (x >= bestX) { bestX = x; bestUrl = url; }
      }
    }
    return bestUrl;
  }

  async function imageSize(doc, bytes, mime) {
    var win = doc.defaultView || {};
    try {
      if (win.createImageBitmap) {
        var bmp = await win.createImageBitmap(new Blob([bytes], { type: mime }));
        var out = { w: bmp.width, h: bmp.height, src: bmp };
        return out;
      }
    } catch (e) { /* 落到 <img> 兜底 */ }
    try {
      var img = new win.Image();
      img.src = 'data:' + mime + ';base64,' + toBase64(bytes);
      if (img.decode) await img.decode();
      else await new Promise(function (r) { img.onload = r; img.onerror = r; });
      if (!img.naturalWidth) return null;
      return { w: img.naturalWidth, h: img.naturalHeight, src: img };
    } catch (e) { return null; }
  }

  async function reencode(doc, from, mime, maxDim) {
    var info = await imageSize(doc, from, mime);
    if (!info) return null;
    var scale = Math.min(1, maxDim / Math.max(info.w, info.h));
    var cw = Math.max(1, Math.round(info.w * scale));
    var ch = Math.max(1, Math.round(info.h * scale));
    var canvas = doc.createElement('canvas');
    canvas.width = cw; canvas.height = ch;
    var ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(info.src, 0, 0, cw, ch);
    var uri = canvas.toDataURL('image/webp', 0.8);
    if (!uri || uri.indexOf('data:image') !== 0) return null;
    var meta = splitDataUri(uri) || { bytes: 0, mime: 'image/webp' };
    return { uri: uri, bytes: meta.bytes, mime: meta.mime, w: cw, h: ch };
  }

  // ---- 主流程 -------------------------------------------------------------
  async function extract(doc, opts) {
    opts = opts || {};
    var st = {
      rulesTotal: 0, rulesKept: 0, rulesDead: 0, rulesEmpty: 0,
      declarationsDropped: 0, customPropsDropped: 0,
      fontFaces: 0, keyframes: 0, sheets: 0, sheetsFailed: 0,
      elements: 0, computedRules: 0, assetsInlined: 0, assetsSpilled: 0,
      // 令牌固化：解析不到的名字不再静默丢声明，而是按浏览器的实际行为写成 unset 并记名
      declarationsInvalid: 0, invalidAtComputedValue: [],
      skinSelectorRewrites: 0, skinSelectorKept: 0, skinAttrsStripped: 0
    };
    var dropped = [];
    var drop = function (s) { if (dropped.length < 40) dropped.push(String(s).slice(0, 220)); };

    // includes 已废：它原本是三处开关（computed / css / assets），三处都会改变产物形态——
    // 特别是 assets 那一处，一关就整段跳过资源解析，CSS 里的 url(/static/…) 原样留在块里，
    // create_ui_block 直接判引用越界。产物必须同构：同一个页面、任何入参，落点都一样。
    // 现在这个字段只被记录（report.includesIgnored），不再影响抽取。
    var includesIgnored = String(opts.includes || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);

    var maxBytes = Number(opts.maxBytes) > 0 ? Number(opts.maxBytes) : 0;
    // 预算：单段 2 MB。内嵌只花其中约七成（base64 会胀），剩下留给规则原文与元素固化；
    // 撞上就按顺序降级并在 report.degrade 里记名。
    var inlineBudget = Math.min(MAX_INLINE_BYTES, maxBytes ? Math.floor(maxBytes * 0.7) : MAX_INLINE_BYTES);
    var computedBudget = Math.min(384 * 1024, maxBytes ? Math.floor(maxBytes * 0.2) : 384 * 1024);
    var degrade = [];
    if (includesIgnored.length) {
      degrade.push('includes 已忽略（' + includesIgnored.join(',') + '）：抓取恒定输出 dom+css+computed+assets，资源引用一律本地化');
    }

    var win = doc.defaultView || {};
    var base = (doc.baseURI || (doc.location && doc.location.href) || '') + '';

    // 0.0) frame 盲区：正文装在 iframe 里的页面，顶层文档抓下来是空的
    // 统计 iframe/frame/object/embed：数量、每个的 src、可见尺寸、占可视区比例；
    // 同源/跨域按「摸不摸得到 contentDocument」判（跨域那份门是关的，读出来是 null）。
    var frameEls = [];
    try { frameEls = Array.prototype.slice.call(doc.querySelectorAll(FRAME_SEL)); } catch (e) { frameEls = []; }
    var viewW = Number(win.innerWidth) || (doc.documentElement && doc.documentElement.clientWidth) || 0;
    var viewH = Number(win.innerHeight) || (doc.documentElement && doc.documentElement.clientHeight) || 0;
    var viewArea = Math.max(1, viewW * viewH);
    var pageOrigin = '';
    try { pageOrigin = String((win.location && win.location.origin) || ''); } catch (e) { pageOrigin = ''; }
    var frameItems = [];
    var frameSame = 0, frameCross = 0;
    for (var fi = 0; fi < frameEls.length && fi < 16; fi++) {
      var fe = frameEls[fi];
      var fsrc = '';
      try { fsrc = String(fe.getAttribute('src') || fe.getAttribute('data') || ''); } catch (e) { fsrc = ''; }
      var fabs = fsrc ? absUrl(fsrc, base) : '';
      var fw = 0, fh = 0, fratio = 0;
      try {
        var frect = fe.getBoundingClientRect();
        fw = Math.round(frect.width);
        fh = Math.round(frect.height);
        // 只算落在视口里的那部分：整块在折叠线以下，就不算占住主区域
        var fvw = Math.max(0, Math.min(frect.right, viewW) - Math.max(frect.left, 0));
        var fvh = Math.max(0, Math.min(frect.bottom, viewH) - Math.max(frect.top, 0));
        fratio = Math.round((fvw * fvh) / viewArea * 1000) / 1000;
      } catch (e) { fw = 0; fh = 0; fratio = 0; }
      // 同源 = 摸得到 contentDocument，或 src 的源就是本页的源（覆盖还在加载的那一下）
      var freadable = false;
      try { freadable = !!fe.contentDocument; } catch (e) { freadable = false; }
      var fsameByUrl = false;
      if (fabs) { try { fsameByUrl = new URL(fabs).origin === pageOrigin; } catch (e) { fsameByUrl = false; } }
      var fSame = freadable || fsameByUrl;
      if (fSame) frameSame++; else frameCross++;
      var fshown = fabs || fsrc;
      if (fshown.length > 300) fshown = fshown.slice(0, 300) + '…';
      frameItems.push({ tag: String(fe.tagName || '').toLowerCase(), src: fshown, w: fw, h: fh, areaRatio: fratio, sameOrigin: fSame });
    }
    frameItems.sort(function (a, b) { return b.areaRatio - a.areaRatio; });
    var frameDominant = (frameItems.length > 0 && frameItems[0].areaRatio > FRAME_DOMINANT_RATIO) ? frameItems[0] : null;

    // 顶层文档是不是空壳：可见文字少、可见元素也少，同时有个 frame 占着主区域。
    // 三条同时成立才算，正常页（有正文、元素多）永远不会走到这里。
    var shellText = '';
    try { shellText = String((doc.body && (doc.body.innerText || doc.body.textContent)) || '').replace(/\s+/g, ''); } catch (e) { shellText = ''; }
    var shellVisible = 0;
    var shellScan = [];
    try { shellScan = doc.body ? Array.prototype.slice.call(doc.body.querySelectorAll('*')) : []; } catch (e) { shellScan = []; }
    for (var sv = 0; sv < shellScan.length && sv < 3000; sv++) {
      var svTag = String(shellScan[sv].tagName || '').toLowerCase();
      if (svTag === 'script' || svTag === 'style' || svTag === 'link' || svTag === 'meta' || svTag === 'title') continue;
      var svRect = null;
      try { svRect = shellScan[sv].getBoundingClientRect(); } catch (e) { continue; }
      if (svRect && svRect.width > 0 && svRect.height > 0) shellVisible++;
    }
    var frameShell = !!frameDominant && shellText.length < FRAME_SHELL_TEXT_MAX && shellVisible < FRAME_SHELL_ELEMENTS_MAX;
    var notes = [];
    if (frameDominant) notes.push(FRAME_NOTE);
    if (frameShell) {
      notes.push(FRAME_ASK);
      // 双保险：有的客户端只打印 dropped，那句必须在 dropped 里也有，且排在最前
      // （本块跑在一切资源解析之前，所以 drop() 进去就是第 0 条）。
      drop(FRAME_SHELL_LINE);
      drop(FRAME_NOTE);
    }

    // 0) 变量表：:root 打底，body 覆盖（页面常把主题变量挂在 body 上）
    var vars = readVars(win.getComputedStyle ? win.getComputedStyle(doc.documentElement) : null);
    if (doc.body && win.getComputedStyle) {
      var bodyVars = readVars(win.getComputedStyle(doc.body));
      for (var k in bodyVars) if (Object.prototype.hasOwnProperty.call(bodyVars, k)) vars[k] = bodyVars[k];
    }
    // 只在子树里声明的令牌（根与 body 上抄不到）：解析时按名字现问一遍元素，问到了就写进表。
    var probeCache = {};
    var varsFromElements = [];
    var lookupVar = function (name) {
      if (Object.prototype.hasOwnProperty.call(vars, name)) return String(vars[name]).trim();
      if (Object.prototype.hasOwnProperty.call(probeCache, name)) return probeCache[name];
      var found = '';
      try {
        var all = doc.querySelectorAll('body, body *');
        for (var i = 0; i < all.length && i < 4000; i++) {
          var v = win.getComputedStyle(all[i]).getPropertyValue(name);
          if (v && String(v).trim() !== '') { found = String(v).trim(); break; }
        }
      } catch (e) { found = ''; }
      probeCache[name] = found;
      if (found) { vars[name] = found; varsFromElements.push(name + ' = ' + found.slice(0, 60)); }
      return found;
    };
    Object.defineProperty(vars, 'lookup', { value: lookupVar, enumerable: false });
    var varCount = Object.keys(vars).length;

    // 1) 祖先链：从目标元素往上走到 body 的直系子元素为止（不要把整个 document 塞进去）
    var root = doc.body;
    if (opts.selector) { try { var hitSel = doc.querySelector(opts.selector); if (hitSel) root = hitSel; } catch (e) {} }
    var chain = [];
    var cur = root;
    while (cur && cur !== doc.body && cur.parentElement && cur.parentElement !== doc.body) {
      chain.push(cur);
      cur = cur.parentElement;
    }
    var topEl = (root === doc.body) ? doc.body : cur;
    var ancestors = [];
    var walkUp = root;
    while (walkUp && walkUp.nodeType === 1) {
      ancestors.push({
        tag: String(walkUp.tagName || '').toLowerCase(),
        id: walkUp.id || '',
        cls: String(walkUp.className && walkUp.className.baseVal !== undefined ? walkUp.className.baseVal : (walkUp.className || '')).slice(0, 120)
      });
      if (walkUp === topEl) break;
      walkUp = walkUp.parentElement;
    }

    // 2) 命中样式表：规则原文，死选择器丢掉（整条列表一个都不匹配就丢这条规则）
    var STATE = /:(hover|focus-visible|focus-within|focus|active|visited|target|checked|indeterminate|disabled|enabled|read-only|read-write|placeholder-shown|default|required|optional|valid|invalid|in-range|out-of-range|user-invalid|user-valid|autofill|open|popover-open|modal|fullscreen|picture-in-picture|playing|paused|muted|seeking|buffering|stalled|defined|link|any-link|local-link|scope)\b/gi;
    var PSEUDO_EL = /::?(before|after|marker|placeholder|selection|first-line|first-letter|backdrop|file-selector-button|cue|highlight)\b/gi;
    var probe = function (sel) {
      var p = String(sel).replace(PSEUDO_EL, '').replace(STATE, '').replace(/:not\(\s*\)/g, '').replace(/\s+/g, ' ').trim();
      if (!p) return true;
      try { return doc.querySelector(p) !== null; } catch (e) { return false; }
    };
    // 皮肤开关属性（body[data-dsh-columbina]）不进素材：视觉已经由字面值固定，块不该再靠
    // 「宿主有没有开着皮肤」来命中。做法是把属性条件从选择器里摘掉，规则本体照旧生效；
    // :not([data-dsh-columbina]) 这种反向条件不能摘（摘了语义反转），留名不改。
    var SKIN_ATTR = 'data-dsh-columbina';
    var SKIN_SEL_RE = /\[\s*data-dsh-columbina(?:\s*[~|^$*]?=\s*(?:"[^"]*"|'[^']*'|[^\]]*))?\s*\]/gi;
    var stripSkinSelector = function (sel) {
      if (String(sel).indexOf(SKIN_ATTR) < 0) return sel;
      if (/:not\([^)]*data-dsh-columbina/i.test(sel)) { st.skinSelectorKept++; return sel; }
      st.skinSelectorRewrites++;
      return String(sel).replace(SKIN_SEL_RE, '').replace(/\s+/g, ' ').trim();
    };
    var keepSelector = function (selText) {
      var parts = splitTopLevel(selText, ',').map(function (s) { return s.trim(); }).filter(Boolean)
        .map(stripSkinSelector).filter(Boolean);
      var kept = parts.filter(probe);
      if (!kept.length) { st.rulesDead++; return null; }
      return kept.join(', ');
    };

    var pageRules = [];
    var seen = [];
    var walkRules = function (rules) {
      for (var i = 0; i < rules.length; i++) {
        var rule = rules[i];
        st.rulesTotal++;
        var kind = (rule.constructor && rule.constructor.name) || '';
        if (kind === 'CSSStyleRule' || (rule.selectorText && rule.style)) {
          var sel = keepSelector(rule.selectorText);
          if (!sel) continue;
          var raw = (rule.style && rule.style.cssText) ? rule.style.cssText : rule.cssText.slice(rule.cssText.indexOf('{') + 1, rule.cssText.lastIndexOf('}'));
          var decls = cleanDecls(raw, vars, st);
          if (!decls) { st.rulesEmpty++; continue; }
          st.rulesKept++;
          pageRules.push(sel + '{' + decls + '}');
        } else if (kind === 'CSSMediaRule' || kind === 'CSSSupportsRule' || kind === 'CSSContainerRule' || kind === 'CSSLayerBlockRule' || kind === 'CSSScopeRule') {
          var head = rule.cssText.slice(0, rule.cssText.indexOf('{') + 1);
          var sub = [];
          for (var j = 0; j < rule.cssRules.length; j++) {
            var r = rule.cssRules[j];
            if (r.selectorText !== undefined) {
              var s2 = keepSelector(r.selectorText);
              if (!s2) continue;
              var d2 = cleanDecls((r.style && r.style.cssText) || '', vars, st);
              if (!d2) { st.rulesEmpty++; continue; }
              st.rulesKept++; sub.push(s2 + '{' + d2 + '}');
            }
          }
          if (sub.length) pageRules.push(head + sub.join('') + '}');
        } else if (kind === 'CSSFontFaceRule') {
          var fd = cleanDecls((rule.style && rule.style.cssText) || '', vars, st);
          if (fd) { st.fontFaces++; st.rulesKept++; pageRules.push('@font-face{' + fd + '}'); }
        } else if (kind === 'CSSKeyframesRule') {
          st.keyframes++;
          pageRules.push('@keyframes ' + rule.name + '{' + Array.prototype.map.call(rule.cssRules, function (x) { return x.keyText + '{' + cleanDecls((x.style && x.style.cssText) || '', vars, st) + '}'; }).join('') + '}');
        } else if (kind === 'CSSImportRule') {
          try { if (rule.styleSheet) walkSheet(rule.styleSheet); } catch (e) {}
        } else {
          st.sheetsFailed++;
        }
      }
    };
    var walkSheet = function (sheet) {
      if (!sheet || seen.indexOf(sheet) >= 0) return;
      seen.push(sheet);
      var rules;
      try { rules = sheet.cssRules; } catch (e) { st.sheetsFailed++; drop('读不到样式表（跨域）：' + (sheet.href || 'inline')); return; }
      if (!rules) return;
      st.sheets++;
      walkRules(rules);
    };
    var sheets = Array.prototype.slice.call(doc.styleSheets || []);
    if (doc.adoptedStyleSheets) sheets = sheets.concat(Array.prototype.slice.call(doc.adoptedStyleSheets));
    for (var si = 0; si < sheets.length; si++) walkSheet(sheets[si]);

    // 3) 元素计算样式：给子树每个元素挂 data-dsh-el，把关键属性固化成规则
    //    继承属性与父元素相同就跳过（不然 color/font-* 会把字节数翻几倍）。
    var computedRules = [];
    var computedUsed = 0;
    var elements = [];
    elements = [topEl].concat(Array.prototype.slice.call(topEl.querySelectorAll('*')));
    // 根元素就是 body 时，body 自己的 data-dsh-el 进不了 innerHTML（序列化的是它的
    // 子节点），那条规则就成了永不命中的孤儿——实测教务页里 16 条孤儿规则的第一条
    // 就是它。所以 body 那条直接写成 body{}，选择器与产物对得上。
    var isBody = (topEl === doc.body);
    var capEls = Math.min(elements.length, 600);
    for (var ei = 0; ei < capEls; ei++) {
      var el = elements[ei];
      var tag = String(el.tagName || '').toLowerCase();
      if (tag === 'script' || tag === 'style' || tag === 'link' || tag === 'meta') continue;
      var cs;
      try { cs = win.getComputedStyle(el); } catch (e) { continue; }
      if (!cs) continue;
      var pcs = null;
      try { pcs = (el.parentElement && el.parentElement !== doc.documentElement) ? win.getComputedStyle(el.parentElement) : null; } catch (e) { pcs = null; }
      var decls = [];
      for (var pi = 0; pi < COMPUTED_PROPS.length; pi++) {
        var prop = COMPUTED_PROPS[pi];
        var val = '';
        try { val = String(cs.getPropertyValue(prop) || '').trim(); } catch (e) { val = ''; }
        if (!val) continue;
        if (prop === 'box-shadow' && val === 'none') continue;
        if (prop === 'border-radius' && val === '0px') continue;
        if (PROP_DEFAULTS[prop] !== undefined && val === PROP_DEFAULTS[prop]) continue;
        if (prop === 'transform' && identityTransform(val)) continue;
        if (INHERITED[prop] && pcs) {
          var pv = '';
          try { pv = String(pcs.getPropertyValue(prop) || '').trim(); } catch (e) { pv = ''; }
          if (pv === val) continue;
        }
        decls.push(prop + ':' + val);
      }
      if (!decls.length) continue;
      var key = (isBody && ei === 0) ? '' : 'e' + (ei + 1);
      var ruleText = (key ? '[data-dsh-el="' + key + '"]' : 'body') + '{' + decls.join(';') + '}';
      if (computedUsed + ruleText.length > computedBudget) { degrade.push('computed 段到预算上限，剩 ' + (capEls - ei) + ' 个元素没固化'); break; }
      computedUsed += ruleText.length;
      computedRules.push(ruleText);
      if (key) { try { el.setAttribute('data-dsh-el', key); } catch (e) {} }
      st.computedRules++;
    }
    st.elements = elements.length;

    // 4) 拷一份 DOM 再清理（活页面只多挂几个 data-dsh-el 属性，不动结构）
    var clone = topEl.cloneNode(true);

    // 资源清单的收集器提前到这里：清属性时就要把 srcset 的最大候选记进去。
    var keyOf = function (u) { var a = absUrl(u, base); return a || String(u || ''); };
    var urls = [];
    var addUrl = function (u) {
      var t = String(u || '').trim();
      if (!t || t.slice(0, 1) === '#' || /^(about|javascript|blob):/i.test(t)) return;
      var k = keyOf(t);
      if (urls.indexOf(k) < 0) urls.push(k);
    };
    var srcsetPick = new Map();
    var srcsetPickedUrls = [];
    // link[rel=preload][imagesrcset]：link 是死标签、元素会被删，但它预载的最大那张图
    // 也是这份素材的一部分，先记进清单，别让「删死标签」顺手吃掉它。选中的档位同时要
    // 记进 srcsetPickedUrls：这个元素随后就被删掉，属性循环再也看不到它，漏记就等于
    // 报告少算一个来源。
    Array.prototype.slice.call(clone.querySelectorAll('link[imagesrcset], link[srcset]')).forEach(function (n) {
      var best = pickSrcsetMax(n.getAttribute('imagesrcset') || n.getAttribute('srcset') || '');
      if (!best) return;
      addUrl(best);
      srcsetPickedUrls.push(keyOf(best));
    });

    var deadTags = ['script', 'noscript', 'template', 'iframe', 'object', 'embed', 'link', 'meta', 'style', 'canvas'];
    // 「删掉它等于一张空图、不影响版式」的替换元素。src 取不到字节时只有这些可以整
    // 个摘掉；其余元素（含 <avatar src> 这类指令元素）必须留下——它们的内容是可见的。
    var REPLACED_TAG = { img: 1, source: 1, track: 1, input: 1, video: 1, audio: 1, embed: 1, object: 1, iframe: 1, frame: 1 };
    var removedNodes = 0;
    Array.prototype.slice.call(clone.querySelectorAll(deadTags.join(','))).forEach(function (n) {
      if (n.parentNode) { n.parentNode.removeChild(n); removedNodes++; }
    });
    // srcset / imagesrcset 不在这里删：它们是响应式图的档位表，删了等于主动丢掉最大一档，
    // 交给下面 pickSrcsetMax 取最大候选（见「nm === 'srcset'」分支与第 6 步回写）。
    var BAD_ATTR = { integrity: 1, nonce: 1, crossorigin: 1, loading: 1, decoding: 1, referrerpolicy: 1 };
    var ROOT_ABS_ATTR = { href: 1, src: 1, action: 1, formaction: 1, poster: 1 };
    // 同一个 URL 换个名字写：Angular 的 ng-href/ng-src、Vue 的 :href/:src 与 v-bind:href/v-bind:src、
    // SVG 的 xlink:href。它们不是资源引用（不取字节），但根绝对路径进块一样是非法路径——
    // 实测公开课页的 <a ng-href="/public-course#/all"> 就是这么漏过去的（href 绝对化了，ng-href 没有）。
    // 只处理「值就是 /开头的路径」或「值是引号包着的 /开头字符串字面量」；#icon、data:、javascript:、
    // {{表达式}} 一律不碰。
    var BIND_ABS_ATTR = { 'ng-href': 1, 'ng-src': 1, 'v-bind:href': 1, 'v-bind:src': 1, ':href': 1, ':src': 1, 'xlink:href': 1 };
    var resolveStyleAttr = function (raw) {
      return cleanDecls(raw, vars, st);
    };
    var allNodes = [clone].concat(Array.prototype.slice.call(clone.querySelectorAll('*')));
    allNodes.forEach(function (n) {
      if (!n.attributes) return;
      Array.prototype.slice.call(n.attributes).forEach(function (a) {
        var nm = String(a.name || '').toLowerCase();
        var v = String(a.value || '');
        if (nm === 'data-dsh-columbina') { n.removeAttribute(a.name); st.skinAttrsStripped++; return; }
        if (nm.slice(0, 2) === 'on') { n.removeAttribute(a.name); return; }
        if (nm === 'srcset' || nm === 'imagesrcset') {
          var picked = pickSrcsetMax(v);
          if (picked) { addUrl(picked); srcsetPick.set(n, { attr: nm, url: picked }); srcsetPickedUrls.push(keyOf(picked)); }
          else { n.removeAttribute(a.name); drop('srcset 解析不出候选，已去掉 ' + nm + '=' + v.slice(0, 60)); }
          return;
        }
        if (BAD_ATTR[nm]) { n.removeAttribute(a.name); return; }
        if (nm === 'href' && /^\s*(javascript|data):/i.test(v)) { n.removeAttribute(a.name); return; }
        // 根绝对引用（href="/x"、src="/x"）进块就是非法路径：先绝对化成原站地址，
        // 连绝对化都做不到（about:blank 之类没有 origin）就去掉属性——宁可少一条链接。
        if (ROOT_ABS_ATTR[nm] && /^\/(?!\/)/.test(v)) {
          var absolutized = absUrl(v, base);
          if (absolutized && /^https?:|^file:/i.test(absolutized)) n.setAttribute(a.name, absolutized);
          else { n.removeAttribute(a.name); drop('根绝对引用无法绝对化，已去掉 ' + nm + '=' + v); }
          return;
        }
        if (BIND_ABS_ATTR[nm]) {
          // Vue 的值是表达式：:href="'/z'" 只把引号里那段路径绝对化，引号原样留着。
          var lit = /^\s*(['"])([^'"]*)\1\s*$/.exec(v);
          var inner = lit ? lit[2] : v;
          if (/^\/(?!\/)/.test(inner)) {
            var absBind = absUrl(inner, base);
            if (absBind && /^https?:|^file:/i.test(absBind)) n.setAttribute(a.name, lit ? lit[1] + absBind + lit[1] : absBind);
            else { n.removeAttribute(a.name); drop('根绝对引用无法绝对化，已去掉 ' + nm + '=' + v); }
          }
          return;
        }
        if (nm === 'style') {
          var kept = resolveStyleAttr(v);
          if (kept) n.setAttribute('style', kept); else n.removeAttribute(a.name);
          return;
        }
        // SVG 的呈现属性也能带变量（实测 3080 的图标是 fill="var(--dsw-alias-label-…)"），
        // 不固化就等于把皮肤抓进块里。任何属性值里出现 var() 都要过一遍解析。
        if (v.indexOf('var(') >= 0) {
          var rv = resolveText(v, vars, 0);
          if (rv.ok && rv.text.indexOf('var(') < 0) n.setAttribute(a.name, rv.text);
          else {
            st.invalidAtComputedValue.push((rv.name || '?') + ' -> @' + nm);
            n.removeAttribute(a.name);
            drop('属性里的变量解析不了，已去掉 ' + nm + '=' + v.slice(0, 60));
          }
        }
      });
    });

    // 5) 资源：字节交给扩展后台的 service worker 取（它带 all_urls 主机权限，不受页面跨域限制）；
    //    长宽比正常的大图先重编码/降采样，还是超标就写进 assets/ 落文件；雪碧图原尺寸落文件；
    //    取不到就丢掉并在 dropped 里写清原因。
    var assetMap = new Map();
    var assetFiles = [];
    var assetSeq = { img: 0, font: 0, bin: 0 };
    var assetLog = [];
    // 引用一律从"要输出的那份 CSS 原文"里收：CSS 总是输出，所以 CSS 里的 url() 一条都不会漏。
    var pageCssText = pageRules.join(NL);
    pageCssText.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, function (m, q, u) { addUrl(u); return m; });
    Array.prototype.slice.call(clone.querySelectorAll('[src], [poster]')).forEach(function (n) {
      // 带 srcset 的元素只取最大候选（第 4 步已进清单），它的 src 是同一张图的小档，
      // 再取一遍只是白跑一次请求。
      if (!srcsetPick.has(n)) addUrl(n.getAttribute('src') || '');
      addUrl(n.getAttribute('poster') || '');
    });
    allNodes.forEach(function (n) {
      var stv = n.getAttribute && n.getAttribute('style');
      if (!stv) return;
      String(stv).replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, function (m, q, u) { addUrl(u); return m; });
    });

    /**
     * 取字节：交给扩展后台的 service worker（background.js 的 'dsh-capture-fetch'），它带
     * all_urls 主机权限，跨域资源不受页面 CORS 限制——页面里 fetch 拿不到的 logo/svg/png
     * 就是死在这一步。没有后台可用时（离线自检的宿主页面）退回页面自身的 fetch。
     */
    var bgFetch = function (absu) {
      var capture = globalThis.dshPageCapture;
      if (capture && typeof capture.fetchBytes === 'function') return Promise.resolve(capture.fetchBytes(absu));
      if (typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.sendMessage === 'function') {
        return new Promise(function (res, rej) {
          try {
            chrome.runtime.sendMessage({ type: 'dsh-capture-fetch', url: absu }, function (r) {
              var err = chrome.runtime.lastError;
              if (err) { rej(new Error('后台没有应答：' + err.message)); return; }
              if (!r) { rej(new Error('后台没有应答')); return; }
              if (r.ok === false) { rej(new Error(String(r.error || '后台取字节失败'))); return; }
              res(r);
            });
          } catch (e) { rej(new Error('调后台失败：' + String(e && e.message || e))); }
        });
      }
      return null;
    };

    var fetchOne = async function (absu) {
      if (absu.slice(0, 5).toLowerCase() === 'data:') {
        var meta = splitDataUri(absu);
        if (!meta) throw new Error('坏 data: URI');
        var bytes;
        if (meta.base64 !== null) bytes = fromBase64(meta.base64);
        else bytes = new TextEncoder().encode(decodeURIComponent(absu.slice(absu.indexOf(',') + 1)));
        return { bytes: bytes, mime: meta.mime, rawLen: meta.bytes, via: 'data' };
      }
      var fromBg = bgFetch(absu);
      if (fromBg) {
        var r = await fromBg;
        var u8 = (r && r.bytes instanceof Uint8Array) ? r.bytes : fromBase64(String((r && r.base64) || ''));
        if (!u8 || !u8.length) throw new Error('后台回的是空字节');
        if (u8.length > MAX_FETCH_BYTES) throw new Error('超过单次取字节上限 ' + Math.round(MAX_FETCH_BYTES / 1048576) + 'MB');
        return { bytes: u8, mime: String((r && r.mime) || '').split(';')[0].trim() || guessMime(absu), rawLen: u8.length, via: 'background' };
      }
      var f = (win.fetch ? win.fetch.bind(win) : fetch);
      var res = await f(absu, { credentials: 'include' });
      if (!res || !res.ok) throw new Error('HTTP ' + (res ? res.status : '?'));
      var buf = new Uint8Array(await res.arrayBuffer());
      var ct = String((res.headers && res.headers.get('content-type')) || '').split(';')[0].trim();
      return { bytes: buf, mime: ct || guessMime(absu), rawLen: buf.length, via: 'page' };
    };

    var kbOf = function (n) { return Math.round(n / 1024) + 'KB'; };

    /** 落 assets/：原字节进块，不改尺寸。返回段内相对路径。 */
    var spool = function (kind, absu, mime, base64, bytes) {
      assetSeq[kind] = (assetSeq[kind] || 0) + 1;
      var name = kind === 'font' ? 'font' : (kind === 'img' ? 'img' : 'asset');
      var path = 'assets/' + name + '-' + assetSeq[kind] + '.' + extOf(absu, mime);
      assetFiles.push({ path: path, content: base64, base64: true, bytes: bytes });
      st.assetsSpilled++;
      return path;
    };

    // report 里的 URL 只留可读标识：data: 内联资源的原串本身就有几 MB，整条塞进 report
    // 会让「回传结果」比素材还大。
    var shortUrl = function (u) {
      var s = String(u || '');
      if (s.slice(0, 5).toLowerCase() === 'data:') return s.slice(0, 48) + '…（内联 ' + s.length + ' 字符）';
      return s.length > 400 ? s.slice(0, 400) + '…' : s;
    };

    var logAsset = function (absu, out, got) {
      var row = { url: shortUrl(absu), kind: out.kind, via: (got && got.via) || '?', bytes: out.bytes || 0 };
      if (out.path) row.path = out.path;
      if (out.mime) row.mime = out.mime;
      if (out.w) { row.w = out.w; row.h = out.h; }
      if (out.downsampled !== undefined) row.downsampled = !!out.downsampled;
      if (out.reason) row.reason = out.reason;
      assetLog.push(row);
      return row;
    };

    var resolveAsset = async function (absu) {
      if (assetMap.has(absu)) return assetMap.get(absu);
      var out = { kind: 'drop' };
      var got = null;
      try {
        got = await fetchOne(absu);
        var mime = got.mime || guessMime(absu);
        var isImg = /^image\//i.test(mime);
        var isFont = /^font\//i.test(mime) || /font-(woff2?|ttf|otf|eot)|vnd\.ms-fontobject/i.test(mime) || /\.(woff2?|ttf|otf|eot)([?#]|$)/i.test(absu);
        if (!isImg && !isFont) { out = { kind: 'drop', reason: '非图片/字体' }; drop('非图片/字体，丢弃：' + absu); }
        else if (isFont) {
          if (got.rawLen <= MAX_INLINE_BYTES) {
            out = { kind: 'data', uri: 'data:' + mime + ';base64,' + toBase64(got.bytes), bytes: got.rawLen, mime: mime };
            st.assetsInlined++;
          } else if (got.rawLen <= MAX_ASSET_BYTES) {
            var fpath = spool('font', absu, mime, toBase64(got.bytes), got.rawLen);
            out = { kind: 'file', path: fpath, bytes: got.rawLen, mime: mime };
            drop('字体 ' + kbOf(got.rawLen) + ' 超内嵌上限 1.4MB，改存 ' + fpath + '：' + absu);
          } else {
            out = { kind: 'drop', reason: '超单文件上限 ' + MAX_ASSET_MB };
            drop('字体 ' + kbOf(got.rawLen) + ' 超单文件上限 ' + MAX_ASSET_MB + '，丢弃：' + absu);
          }
        } else {
          var info = await imageSize(doc, got.bytes, mime);
          var iw = info ? info.w : 0, ih = info ? info.h : 0;
          var dimTooBig = iw > MAX_IMAGE_DIM || ih > MAX_IMAGE_DIM;
          if (info && spriteLike(iw, ih)) {
            // 雪碧图 / 长条图：降采样会把 358x20870 压成 34x2000，等于毁掉——原尺寸落文件。
            if (got.rawLen <= MAX_ASSET_BYTES) {
              var spath = spool('img', absu, mime, toBase64(got.bytes), got.rawLen);
              out = { kind: 'file', path: spath, bytes: got.rawLen, mime: mime, w: iw, h: ih, downsampled: false };
              drop('雪碧图 ' + iw + 'x' + ih + ' 原尺寸落 ' + spath + '（不降采样）：' + absu);
            } else {
              out = { kind: 'drop', reason: '雪碧图原图超单文件上限 ' + MAX_ASSET_MB };
              drop('雪碧图 ' + iw + 'x' + ih + ' 原图 ' + kbOf(got.rawLen) + ' 超单文件上限 ' + MAX_ASSET_MB + '，丢弃：' + absu);
            }
          } else if (got.rawLen <= MAX_INLINE_BYTES && !dimTooBig) {
            out = { kind: 'data', uri: 'data:' + mime + ';base64,' + toBase64(got.bytes), bytes: got.rawLen, mime: mime, w: iw, h: ih, downsampled: false };
            st.assetsInlined++;
          } else {
            var shrink = dimTooBig ? await reencode(doc, got.bytes, mime, MAX_IMAGE_DIM) : null;
            if (shrink && shrink.bytes <= MAX_INLINE_BYTES) {
              out = { kind: 'data', uri: shrink.uri, bytes: shrink.bytes, mime: shrink.mime, w: shrink.w, h: shrink.h, downsampled: true };
              st.assetsInlined++;
              drop('图片重编码 ' + (iw ? iw + 'x' + ih : '?') + ' → ' + shrink.w + 'x' + shrink.h + ' webp ' + kbOf(shrink.bytes) + '：' + absu);
            } else if (shrink) {
              var ipath = spool('img', absu, shrink.mime, splitDataUri(shrink.uri).base64, shrink.bytes);
              out = { kind: 'file', path: ipath, bytes: shrink.bytes, mime: shrink.mime, w: shrink.w, h: shrink.h, downsampled: true };
              drop('图片降采样后仍 ' + kbOf(shrink.bytes) + '，改存 ' + ipath + '：' + absu);
            } else if (got.rawLen <= MAX_ASSET_BYTES) {
              // 解不开、或长宽比正常只是文件大：原字节落文件，不在体积上赌质量。
              var opath = spool('img', absu, mime, toBase64(got.bytes), got.rawLen);
              out = { kind: 'file', path: opath, bytes: got.rawLen, mime: mime, w: iw, h: ih, downsampled: false };
              drop('图片 ' + kbOf(got.rawLen) + ' 超内嵌上限 1.4MB，原尺寸改存 ' + opath + '：' + absu);
            } else {
              out = { kind: 'drop', reason: '超单文件上限 ' + MAX_ASSET_MB };
              drop('图片 ' + kbOf(got.rawLen) + ' 超单文件上限 ' + MAX_ASSET_MB + '，丢弃：' + absu);
            }
          }
        }
      } catch (e) {
        out = { kind: 'drop', reason: String(e && e.message || e) };
        drop('取不到字节，丢弃：' + absu + ' （' + String(e && e.message || e).slice(0, 80) + '）');
      }
      assetMap.set(absu, out);
      logAsset(absu, out, got);
      return out;
    };

    // 无条件解析：清单里的每一个引用都要拿到落点（data: / assets/… / none），
    // 否则它在产物里就还是原站绝对地址。includes 与此无关（改前这一步挂在 want('assets') 上，
    // 一传 includes 就整段跳过，url() 原样留存）。
    // 并发 3：一条一条取，一百多个资源的页面能等成几分钟。压在 3 是因为解码与重编码
    // 都在页面主线程里跑，贪多反而抖。
    var POOL = 3;
    var cursorIdx = 0;
    var sameWorkers = [];
    var workerCount = Math.min(POOL, urls.length);
    for (var wk = 0; wk < workerCount; wk++) {
      sameWorkers.push((async function () {
        while (cursorIdx < urls.length) {
          var idx = cursorIdx++;
          await resolveAsset(urls[idx]);
        }
      })());
    }
    await Promise.all(sameWorkers);

    // 内嵌总量超预算：把大的改判成落文件（data: 塞爆 CSS 会过单段上限）
    var inlineBytes = 0;
    assetMap.forEach(function (v, k) {
      if (v.kind === 'data') inlineBytes += v.bytes;
    });
    if (inlineBytes > inlineBudget) {
      var big = [];
      assetMap.forEach(function (v, k) { if (v.kind === 'data') big.push({ k: k, v: v }); });
      big.sort(function (a, b) { return b.v.bytes - a.v.bytes; });
      for (var bi = 0; bi < big.length && inlineBytes > inlineBudget; bi++) {
        var item = big[bi];
        var meta2 = splitDataUri(item.v.uri);
        if (!meta2 || !meta2.base64) continue;
        var p2 = spool('bin', item.k, meta2.mime, meta2.base64, item.v.bytes);
        assetMap.set(item.k, { kind: 'file', path: p2, bytes: item.v.bytes, mime: meta2.mime });
        for (var ai = 0; ai < assetLog.length; ai++) {
          if (assetLog[ai].url === item.k) { assetLog[ai].kind = 'file'; assetLog[ai].path = p2; break; }
        }
        inlineBytes -= item.v.bytes;
        st.assetsSpilled++;
        drop('内嵌总量超预算，改存 ' + p2);
      }
    }

    var refFor = function (prefix, hit) {
      if (!hit) return null;
      if (hit.kind === 'drop') return 'none';
      if (hit.kind === 'data') return 'url(' + hit.uri + ')';
      return 'url(' + prefix + hit.path + ')';
    };
    var srcFor = function (prefix, hit) {
      if (!hit) return undefined;
      if (hit.kind === 'drop') return 'none';
      if (hit.kind === 'data') return hit.uri;
      return prefix + hit.path;
    };

    // 6) 把资源落点写回副本（属性 + 行内 style）与两份 CSS
    var cloneNodes = [clone].concat(Array.prototype.slice.call(clone.querySelectorAll('*')));
    cloneNodes.forEach(function (n) {
      if (!n.getAttribute) return;
      var ntag = String(n.tagName || '').toLowerCase();
      ['src', 'poster'].forEach(function (attr) {
        if (!n.hasAttribute(attr)) return;
        var raw = n.getAttribute(attr) || '';
        var hit = assetMap.get(keyOf(raw));
        if (!hit) return;
        var rep = srcFor('./', hit);
        if (rep === 'none') {
          // 字节取不到（404 / 跨域 / 超限）不能连元素一起删。真实事故：教务页三处头像
          // 都是 <avatar src="/user/avatarSmallUrl">，网址 404 后 Angular 早已退回内联
          // SVG 兜底图标，而这里把整棵子树摘掉——块里头像全变空白，page.css 里还留下
          // 3×5 条永不命中的 [data-dsh-el] 规则。只有「替换元素且没有子元素」才删
          // （等于一张空图，不动版式）；其余只摘属性，把可见内容留下。
          if (REPLACED_TAG[ntag] && !n.firstElementChild) {
            if (n.parentNode) n.parentNode.removeChild(n);
          } else {
            n.removeAttribute(attr);
            drop('取不到 ' + attr + ' 的字节，只摘属性、保留子树：' + raw.slice(0, 120));
          }
          return;
        }
        if (rep !== undefined) n.setAttribute(attr, rep);
      });
      // srcset 的最大候选：img 用 src 承载，source 没有 src，把 srcset 收成一条。
      // 落点拿不到就整条删掉，绝不留原站绝对地址。
      var pick = srcsetPick.get(n);
      if (pick) {
        var prep = srcFor('./', assetMap.get(keyOf(pick.url)));
        var tg = String(n.tagName || '').toLowerCase();
        if (prep === 'none' || prep === undefined) {
          n.removeAttribute('srcset');
          n.removeAttribute('imagesrcset');
        } else if (tg === 'source') {
          n.setAttribute('srcset', prep);
          n.removeAttribute('imagesrcset');
        } else {
          n.setAttribute('src', prep);
          n.removeAttribute('srcset');
          n.removeAttribute('imagesrcset');
        }
      }
      var stv = n.getAttribute('style');
      if (!stv) return;
      var stv2 = stv.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, function (m, q, u) {
        var hit = assetMap.get(keyOf(u));
        var rep = refFor('./', hit);
        return rep || m;
      });
      if (stv2 !== stv) n.setAttribute('style', stv2);
    });
    var subCss = function (text, prefix) {
      return text.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, function (m, q, u) {
        var hit = assetMap.get(keyOf(u));
        var rep = refFor(prefix, hit);
        return rep || m;
      });
    };

    // 7) 三份文件：entry / shared / pages
    var bodyHtml = isBody ? clone.innerHTML : clone.outerHTML;

    // 7.5) 序列化后对账：计算样式规则必须挂在真实存在的元素上。序列化或清理弄丢了节点
    // （历史事故：404 的 src 把整棵子树删掉），page.css 里就会留下永不命中的
    // [data-dsh-el] 规则——读块的人分不清是「元素丢了」还是「样式没写」。挂不上的规则
    // 丢掉并记账（body{} 那条不是按 id 命中的，照旧保留）。
    var computedOrphans = 0;
    computedRules = computedRules.filter(function (r) {
      if (r.indexOf('body{') === 0) return true;
      var idm = /^\[data-dsh-el="(e\d+)"\]/.exec(r);
      if (!idm) return true;
      if (bodyHtml.indexOf('data-dsh-el="' + idm[1] + '"') >= 0) return true;
      computedOrphans++;
      return false;
    });
    st.computedRules = computedRules.length;
    var appCss = [];
    var fontFaces = pageRules.filter(function (r) { return r.indexOf('@font-face') === 0; });
    var keyframes = pageRules.filter(function (r) { return r.indexOf('@keyframes') === 0; });
    var rest = pageRules.filter(function (r) { return r.indexOf('@font-face') !== 0 && r.indexOf('@keyframes') !== 0; });
    appCss = [
      '/* dsh-page-capture: 基线（重置 + 字体 + 动画）——跨页可复用 */',
      '*,*::before,*::after{box-sizing:border-box}',
      'html,body{margin:0}',
      'img,svg,video,canvas{max-width:100%;height:auto}'
    ].concat(fontFaces).concat(keyframes);
    var pageCssBody = rest.length ? rest : ['/* 本页没有命中任何样式表规则 */'];
    var pageCss = ['/* dsh-page-capture: 本页样式表命中规则 + 元素计算样式固化 */'].concat(pageCssBody).concat(computedRules);
    var appCssText = subCss(appCss.join(NL), '../') + NL;
    var pageCssText2 = subCss(pageCss.join(NL), '../../') + NL;
    if (utf8Len(appCssText) > SECTION_MAX_BYTES) { degrade.push('shared/app.css 超单段上限 ' + Math.round(SECTION_MAX_BYTES / 1024) + 'KB（' + utf8Len(appCssText) + '）'); }
    if (utf8Len(pageCssText2) > SECTION_MAX_BYTES) { degrade.push('pages/current/page.css 超单段上限 ' + Math.round(SECTION_MAX_BYTES / 1024) + 'KB（' + utf8Len(pageCssText2) + '）'); }

    var title = doc.title || opts.title || '';
    var entryHtml = [
      '<!doctype html>',
      '<html lang="zh-CN">',
      '<head>',
      '<meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
      '<title>' + escAttr(title || 'captured page') + '</title>',
      '<link rel="stylesheet" href="./' + APP_CSS + '">',
      '<link rel="stylesheet" href="./' + PAGE_CSS + '">',
      '</head>',
      '<body>',
      bodyHtml,
      '</body>',
      '</html>',
      ''
    ].join(NL);

    var files = [
      { path: ENTRY, content: entryHtml },
      { path: APP_CSS, content: appCssText },
      { path: PAGE_CSS, content: pageCssText2 }
    ].concat(assetFiles);

    var total = 0;
    files.forEach(function (f) {
      f.bytes = f.base64 ? f.bytes : utf8Len(f.content);
      total += f.bytes;
    });

    var report = {
      origin: (doc.location && doc.location.href) || opts.origin || base,
      title: title,
      bytes: total,
      dropped: dropped,
      files: files.map(function (f) { return { path: f.path, bytes: f.bytes }; }),
      rulesTotal: st.rulesTotal,
      rulesKept: st.rulesKept,
      rulesDead: st.rulesDead,
      rulesEmpty: st.rulesEmpty,
      sheets: st.sheets,
      sheetsFailed: st.sheetsFailed,
      fontFaces: st.fontFaces,
      keyframes: st.keyframes,
      customPropsDropped: st.customPropsDropped,
      declarationsDropped: st.declarationsDropped,
      declarationsInvalid: st.declarationsInvalid,
      // 判据：unresolvedVars 为空（没有悬空的 var() 留给宿主令牌表），且产物里
      // data-dsh-columbina / --columbina- 计数为 0。
      unresolvedVars: [],
      invalidAtComputedValue: st.invalidAtComputedValue,
      skinSelectorRewrites: st.skinSelectorRewrites,
      skinSelectorKept: st.skinSelectorKept,
      skinAttrsStripped: st.skinAttrsStripped,
      varsResolved: varCount,
      varsFromElements: varsFromElements,
      elements: st.elements,
      computedRules: st.computedRules,
      // 序列化后对不上的 [data-dsh-el] 规则条数（正常恒为 0；非 0 就是有节点在产物里丢了）
      computedOrphansDropped: computedOrphans,
      assetsInlined: st.assetsInlined,
      assetsSpilled: st.assetsSpilled,
      // 资源总账：每条 URL 的落点、字节、取字节通道（background=扩展后台 / page=页面兜底）、
      // 原尺寸与是否降采样。素材库索引与验收都读这一份，不用再猜。
      assets: assetLog,
      srcsetPicked: srcsetPickedUrls,
      removedNodes: removedNodes,
      ancestors: ancestors,
      degrade: degrade,
      // frame 盲区：扩展只注入顶层文档，正文装在 iframe 里时抓到的就是空壳。
      // dominant = 盖住可视区 30% 以上的那个 frame（没有就是 null）。
      frames: {
        total: frameEls.length,
        sameOrigin: frameSame,
        crossOrigin: frameCross,
        dominant: frameDominant,
        items: frameItems
      },
      notes: notes
    };
    // 空壳标记：只在这一种情况下出现（与 hiddenTab / includesIgnored 同一口径——
    // 没有这个字段 = 没发生），调用方看到它就该把「正文在框里」直接说出来。
    if (frameShell) report.frameShell = true;
    // includes 已废：传了就记一个布尔 true（口径与其它布尔字段一致——没有这个字段 = 没传），
    // 具体传了什么写在 degrade 那条说明里。产物恒定是 entry + 两份 CSS + 资源落点。
    if (includesIgnored.length) report.includesIgnored = true;
    return { files: files, report: report };
  }

  globalThis.dshPageCapture = { extract: extract, version: '0.1.0' };
})();
