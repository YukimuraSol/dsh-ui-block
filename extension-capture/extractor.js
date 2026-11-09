// dsh-page-capture / extractor.js
// 纯函数抽取层：不 import、不碰 chrome.*，只用形参 doc（一个 document 接口）。
// ① MV3：chrome.scripting.executeScript({files:['extractor.js']}) 注入页面（ISOLATED world）
// ② self-check.mjs：CDP Runtime.evaluate 注入同一份源码，离线跑同一套断言
// 入口：globalThis.dshPageCapture.extract(doc, opts) => Promise<{ files, report }>
(function () {
  'use strict';

  var NL = String.fromCharCode(10);
  var COMPUTED_PROPS = ['color', 'background-color', 'font-size', 'font-family', 'line-height',
    'padding', 'margin', 'border-radius', 'box-shadow', 'display', 'grid-template-columns', 'gap'];
  var INHERITED = { color: 1, 'font-size': 1, 'font-family': 1, 'line-height': 1 };

  var MAX_ASSET_BYTES = 200 * 1024;   // 单文件 200KB
  var MAX_IMAGE_DIM = 2000;           // 单边 2000px
  var SECTION_MAX_BYTES = 256 * 1024; // 块格式单段上限

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

    var include = String(opts.includes || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    var want = function (n) { return !include.length || include.indexOf('all') >= 0 || include.indexOf(n) >= 0; };

    var maxBytes = Number(opts.maxBytes) > 0 ? Number(opts.maxBytes) : 0;
    // 预算：整块默认 256KB 一节上限，撞上就按顺序降级并在 report.degrade 里记名
    var inlineBudget = Math.min(180 * 1024, maxBytes ? Math.floor(maxBytes * 0.5) : 180 * 1024);
    var computedBudget = Math.min(60 * 1024, maxBytes ? Math.floor(maxBytes * 0.2) : 60 * 1024);
    var degrade = [];

    var win = doc.defaultView || {};
    var base = (doc.baseURI || (doc.location && doc.location.href) || '') + '';

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
    if (want('computed')) {
      elements = [topEl].concat(Array.prototype.slice.call(topEl.querySelectorAll('*')));
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
          if (INHERITED[prop] && pcs) {
            var pv = '';
            try { pv = String(pcs.getPropertyValue(prop) || '').trim(); } catch (e) { pv = ''; }
            if (pv === val) continue;
          }
          decls.push(prop + ':' + val);
        }
        if (!decls.length) continue;
        var key = 'e' + (ei + 1);
        var ruleText = '[data-dsh-el="' + key + '"]{' + decls.join(';') + '}';
        if (computedUsed + ruleText.length > computedBudget) { degrade.push('computed 段到预算上限，剩 ' + (capEls - ei) + ' 个元素没固化'); break; }
        computedUsed += ruleText.length;
        computedRules.push(ruleText);
        try { el.setAttribute('data-dsh-el', key); } catch (e) {}
        st.computedRules++;
      }
      st.elements = elements.length;
    }

    // 4) 拷一份 DOM 再清理（活页面只多挂几个 data-dsh-el 属性，不动结构）
    var clone = topEl.cloneNode(true);
    var isBody = (topEl === doc.body);
    var deadTags = ['script', 'noscript', 'template', 'iframe', 'object', 'embed', 'link', 'meta', 'style', 'canvas'];
    var removedNodes = 0;
    Array.prototype.slice.call(clone.querySelectorAll(deadTags.join(','))).forEach(function (n) {
      if (n.parentNode) { n.parentNode.removeChild(n); removedNodes++; }
    });
    var BAD_ATTR = { srcset: 1, imagesrcset: 1, integrity: 1, nonce: 1, crossorigin: 1, loading: 1, decoding: 1, referrerpolicy: 1 };
    var ROOT_ABS_ATTR = { href: 1, src: 1, action: 1, formaction: 1, poster: 1 };
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

    // 5) 资源：页面自身 fetch 取字节 → data:；超 200KB 或超 2000px 的图先重编码/降采样，
    //    还是超标就写进 assets/ 落文件；取不到就丢掉并在 dropped 里记名。
    var keyOf = function (u) { var a = absUrl(u, base); return a || String(u || ''); };
    var assetMap = new Map();
    var assetFiles = [];
    var assetSeq = { img: 0, font: 0, bin: 0 };
    var pageCssText = (want('css') ? pageRules.join(NL) : '');

    var urls = [];
    var addUrl = function (u) {
      var t = String(u || '').trim();
      if (!t || t.slice(0, 1) === '#' || /^(about|javascript|blob):/i.test(t)) return;
      var k = keyOf(t);
      if (urls.indexOf(k) < 0) urls.push(k);
    };
    pageCssText.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, function (m, q, u) { addUrl(u); return m; });
    Array.prototype.slice.call(clone.querySelectorAll('[src], [poster]')).forEach(function (n) {
      addUrl(n.getAttribute('src') || '');
      addUrl(n.getAttribute('poster') || '');
    });
    allNodes.forEach(function (n) {
      var stv = n.getAttribute && n.getAttribute('style');
      if (!stv) return;
      String(stv).replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, function (m, q, u) { addUrl(u); return m; });
    });

    var fetchOne = async function (absu) {
      if (absu.slice(0, 5).toLowerCase() === 'data:') {
        var meta = splitDataUri(absu);
        if (!meta) throw new Error('坏 data: URI');
        var bytes = null;
        if (meta.base64 !== null) {
          var bin = atob(meta.base64);
          bytes = new Uint8Array(bin.length);
          for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        } else {
          bytes = new TextEncoder().encode(decodeURIComponent(absu.slice(absu.indexOf(',') + 1)));
        }
        return { bytes: bytes, mime: meta.mime, rawLen: meta.bytes };
      }
      var f = (win.fetch ? win.fetch.bind(win) : fetch);
      var res = await f(absu, { credentials: 'include' });
      if (!res || !res.ok) throw new Error('HTTP ' + (res ? res.status : '?'));
      var buf = new Uint8Array(await res.arrayBuffer());
      var ct = String((res.headers && res.headers.get('content-type')) || '').split(';')[0].trim();
      return { bytes: buf, mime: ct || guessMime(absu), rawLen: buf.length };
    };

    var resolveAsset = async function (absu) {
      if (assetMap.has(absu)) return assetMap.get(absu);
      var out = { kind: 'drop' };
      try {
        var got = await fetchOne(absu);
        var mime = got.mime || guessMime(absu);
        var isImg = /^image\//i.test(mime);
        var isFont = /^font\//i.test(mime) || /font-(woff2?|ttf|otf|eot)|vnd\.ms-fontobject/i.test(mime) || /\.(woff2?|ttf|otf|eot)([?#]|$)/i.test(absu);
        if (!isImg && !isFont) { out = { kind: 'drop' }; drop('非图片/字体，丢弃：' + absu); }
        else if (isFont) {
          if (got.rawLen <= MAX_ASSET_BYTES) {
            out = { kind: 'data', uri: 'data:' + mime + ';base64,' + toBase64(got.bytes), bytes: got.rawLen };
            st.assetsInlined++;
          } else {
            assetSeq.font++;
            var fpath = 'assets/font-' + assetSeq.font + '.' + ((/\.(woff2?|ttf|otf|eot)/i.exec(absu) || [])[1] || 'woff2').toLowerCase();
            assetFiles.push({ path: fpath, content: toBase64(got.bytes), base64: true, bytes: got.rawLen });
            out = { kind: 'file', path: fpath, bytes: got.rawLen };
            st.assetsSpilled++;
            drop('字体 ' + Math.round(got.rawLen / 1024) + 'KB 超 200KB，改存 ' + fpath + '：' + absu);
          }
        } else {
          var info = await imageSize(doc, got.bytes, mime);
          var tooBig = got.rawLen > MAX_ASSET_BYTES || (info && Math.max(info.w, info.h) > MAX_IMAGE_DIM);
          if (!tooBig) {
            out = { kind: 'data', uri: 'data:' + mime + ';base64,' + toBase64(got.bytes), bytes: got.rawLen };
            st.assetsInlined++;
          } else {
            var shrink = await reencode(doc, got.bytes, mime, MAX_IMAGE_DIM);
            if (shrink && shrink.bytes <= MAX_ASSET_BYTES) {
              out = { kind: 'data', uri: shrink.uri, bytes: shrink.bytes };
              st.assetsInlined++;
              drop('图片重编码 ' + (info ? info.w + 'x' + info.h : '?') + ' → ' + shrink.w + 'x' + shrink.h + ' webp ' + Math.round(shrink.bytes / 1024) + 'KB：' + absu);
            } else if (shrink) {
              assetSeq.img++;
              var ipath = 'assets/img-' + assetSeq.img + '.' + (shrink.mime.indexOf('webp') > 0 ? 'webp' : 'png');
              assetFiles.push({ path: ipath, content: splitDataUri(shrink.uri).base64, base64: true, bytes: shrink.bytes });
              out = { kind: 'file', path: ipath, bytes: shrink.bytes };
              st.assetsSpilled++;
              drop('图片降采样后仍 ' + Math.round(shrink.bytes / 1024) + 'KB 超 200KB，改存 ' + ipath + '：' + absu);
            } else {
              out = { kind: 'drop' };
              drop('图片解码失败，丢弃：' + absu);
            }
          }
        }
      } catch (e) {
        out = { kind: 'drop' };
        drop('取不到字节，丢弃：' + absu + ' （' + String(e && e.message || e).slice(0, 60) + '）');
      }
      assetMap.set(absu, out);
      return out;
    };

    if (want('assets')) {
      for (var ui = 0; ui < urls.length; ui++) await resolveAsset(urls[ui]);
    } else {
      for (var uj = 0; uj < urls.length; uj++) assetMap.set(urls[uj], { kind: 'keep' });
    }

    // 内嵌总量超预算：把大的改判成落文件（data: 塞爆 CSS 会过 256KB 单段上限）
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
        assetSeq.img++;
        var p2 = 'assets/asset-' + assetSeq.img + '.' + ((/([a-z0-9]+)$/i.exec(meta2.mime) || [])[1] || 'bin');
        assetFiles.push({ path: p2, content: meta2.base64, base64: true, bytes: item.v.bytes });
        assetMap.set(item.k, { kind: 'file', path: p2, bytes: item.v.bytes });
        inlineBytes -= item.v.bytes;
        st.assetsSpilled++;
        drop('内嵌总量超预算，改存 ' + p2);
      }
    }

    var refFor = function (prefix, hit) {
      if (!hit) return null;
      if (hit.kind === 'keep') return null;
      if (hit.kind === 'drop') return 'none';
      if (hit.kind === 'data') return 'url(' + hit.uri + ')';
      return 'url(' + prefix + hit.path + ')';
    };
    var srcFor = function (prefix, hit) {
      if (!hit || hit.kind === 'keep') return undefined;
      if (hit.kind === 'drop') return 'none';
      if (hit.kind === 'data') return hit.uri;
      return prefix + hit.path;
    };

    // 6) 把资源落点写回副本（属性 + 行内 style）与两份 CSS
    var cloneNodes = [clone].concat(Array.prototype.slice.call(clone.querySelectorAll('*')));
    cloneNodes.forEach(function (n) {
      if (!n.getAttribute) return;
      ['src', 'poster'].forEach(function (attr) {
        if (!n.hasAttribute(attr)) return;
        var raw = n.getAttribute(attr) || '';
        var hit = assetMap.get(keyOf(raw));
        if (!hit) return;
        var rep = srcFor('./', hit);
        if (rep === 'none') { if (n.parentNode) n.parentNode.removeChild(n); return; }
        if (rep !== undefined) n.setAttribute(attr, rep);
      });
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
    var appCss = [];
    if (want('css')) {
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
    } else {
      var appCssText = '/* includes 未包含 css */' + NL;
      var pageCssText2 = '/* includes 未包含 css */' + NL;
    }
    if (utf8Len(appCssText) > SECTION_MAX_BYTES) { degrade.push('shared/app.css 超 256KB（' + utf8Len(appCssText) + '）'); }
    if (utf8Len(pageCssText2) > SECTION_MAX_BYTES) { degrade.push('pages/current/page.css 超 256KB（' + utf8Len(pageCssText2) + '）'); }

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
      assetsInlined: st.assetsInlined,
      assetsSpilled: st.assetsSpilled,
      removedNodes: removedNodes,
      ancestors: ancestors,
      degrade: degrade
    };
    return { files: files, report: report };
  }

  globalThis.dshPageCapture = { extract: extract, version: '0.1.0' };
})();
