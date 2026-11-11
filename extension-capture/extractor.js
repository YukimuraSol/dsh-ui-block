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
  // 「抓取前就被摘掉的节点」（观察器见 removed-watch.js）：最多列 20 条，每条带
  // 序列化后前 300 字。20 条之外只报个数——清单是给模型判断「要不要在块里复刻」用的，
  // 不是全量审计；一条 outerHTML 长起来可以是几十 KB。
  var REMOVED_MAX = 20;
  var REMOVED_HEAD = 300;

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

  // ---- 自定义属性：站内变量原样保留，只固化宿主皮肤 -----------------------
  // 真实事故（pintia 考试页）：.pc-button 的 background 本该是 var(--color)=#3E7EEA，
  // 产物里被冻成 hsl(0,0%,25%)——因为 cleanDecls 拿**文档级全局变量表**去替换
  // var(--color)，而 --color 是逐元素/逐组件的，全局表里存的是**别的**作用域的值
  // （report.varsFromElements 里那条「--color = hsl(0, 0%, 25%)」就是它）。
  // 现在：站内自定义属性与含站内 var() 的声明**原样写出去**，谁覆盖谁交给浏览器的
  // 层叠按元素算；必须固化的只有宿主皮肤（--dsw-*/--columbina-），那属于 3080 的皮肤。
  var HOST_VAR_RE = /^--(?:dsw-|columbina)/;

  /** 只把 var(--dsw-*) 换成字面值；站内变量原样留着（连同它的 fallback）。 */
  function substHostVars(text, vars, st) {
    var s = String(text), out = '', i = 0, guard = 0;
    while (i < s.length && guard++ < 200) {
      var rest = s.slice(i);
      var hit = findVar(rest);
      if (!hit) { out += rest; break; }
      out += rest.slice(0, hit.start);
      var tok = rest.slice(hit.start, hit.end);
      var name = String(splitTopLevel(hit.inside, ',')[0] || '').trim();
      if (HOST_VAR_RE.test(name)) {
        var r = resolveText(tok, vars, 0);
        out += (r.ok && !/var\(/.test(r.text)) ? r.text : tok;
      } else {
        if (name && st && st.varRefs) st.varRefs[name] = 1;
        out += tok;
      }
      i += hit.end;
    }
    return out;
  }

  /**
   * 一条声明块过一遍。
   * - 宿主皮肤变量（--dsw-*）的声明丢掉、用法换成字面值；
   * - 站内自定义属性的声明照原样写出去——只声明自定义属性的规则因此不再被判「空规则」
   *   丢弃（.pc-active-primary{--color:…} 这类正是「这个按钮是 primary」的唯一信息）；
   * - 含站内 var() 的普通声明原样保留，不拿全局表替换（交互态跟着一起活）。
   */
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
      if (prop.slice(0, 2) === '--') {
        if (HOST_VAR_RE.test(prop)) { st.customPropsDropped++; continue; }
        var cv = substHostVars(val, vars, st);
        if (!cv) { st.customPropsDropped++; continue; }
        out.push(prop + ':' + cv);
        st.customPropsKept++;
        continue;
      }
      var sv = substHostVars(val, vars, st);
      if (/var\(\s*--/.test(sv)) { st.varDeclsKept++; out.push(prop + ':' + sv); continue; }
      out.push(prop + ':' + sv);
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

  // ---- 活值固化：表单控件的值住在 DOM 属性里，序列化时不带 -----------------
  // 实测（智云课堂 E 页）：右上角周选择器是
  //   <input type="text" placeholder="筛选往周课程" class="el-input__inner">
  // 真站显示「当前周」，抓下来是个空框——value 是 DOM 属性（property），
  // innerHTML / outerHTML 序列化都不带它，只有写回 value 属性才会被序列化出来。
  // 做法：抓的那一刻把活值写回**属性**——input 写 value、checkbox/radio 写 checked、
  // textarea 写文本内容、select 把选中项写成 selected。只写非空（空串就是默认，写了白胖）。
  // 敏感字段一律不写（见 sensitiveReason）：type=password / hidden / file，以及
  // autocomplete 里点名了密码、信用卡、一次性验证码的字段——密码不许进块。
  // 注意：autocomplete="off" 本身**不是**跳过条件。周选择器就是 autocomplete="off"，
  // 值是「当前周」；按 off 跳过等于把这条要修的 bug 原样留下。真正敏感的是上面那三类。
  var SENSITIVE_AC = /(^|\s)(current-password|new-password|cc-name|cc-number|cc-exp|cc-exp-month|cc-exp-year|cc-csc|cc-type|one-time-code|webauthn)(\s|$)/i;

  function sensitiveReason(el) {
    var type = '';
    try { type = String((el.getAttribute && el.getAttribute('type')) || el.type || '').toLowerCase(); } catch (e) { type = ''; }
    if (type === 'password') return 'type=password';
    if (type === 'hidden') return 'type=hidden';
    if (type === 'file') return 'type=file';
    var ac = '';
    try { ac = String((el.getAttribute && el.getAttribute('autocomplete')) || ''); } catch (e) { ac = ''; }
    if (SENSITIVE_AC.test(ac)) return 'autocomplete=' + ac;
    return '';
  }

  /** 把此刻的活值写成属性。写的是活页面上的元素（克隆时属性自然带上），只写非空值。 */
  function fixLiveValues(elements, st) {
    for (var i = 0; i < elements.length && i < 8000; i++) {
      var el = elements[i];
      if (!el || el.nodeType !== 1) continue;
      var tag = String(el.tagName || '').toLowerCase();
      if (tag !== 'input' && tag !== 'textarea' && tag !== 'select') continue;
      var why = (tag === 'input' || tag === 'textarea') ? sensitiveReason(el) : '';
      if (why) {
        st.liveValuesSkipped++;
        if (st.sensitiveSample.length < 8) {
          var nm = '';
          try { nm = String(el.getAttribute('name') || ''); } catch (e) { nm = ''; }
          st.sensitiveSample.push(tag + '(' + why + ')' + (el.id ? '#' + el.id : '') + (nm ? '[' + nm + ']' : ''));
        }
        continue;
      }
      try {
        if (tag === 'input') {
          var type = String((el.getAttribute('type') || el.type || 'text')).toLowerCase();
          if (type === 'checkbox' || type === 'radio') {
            // 布尔状态没有「空串」：勾了就写 checked，没勾就把过时的 checked 摘掉。
            if (el.checked) { if (!el.hasAttribute('checked')) st.liveValuesWritten++; el.setAttribute('checked', ''); }
            else if (el.hasAttribute('checked')) { el.removeAttribute('checked'); st.liveValuesWritten++; }
            continue;
          }
          var v = String(el.value == null ? '' : el.value);
          if (v === '') continue;
          if (el.getAttribute('value') !== v) { el.setAttribute('value', v); st.liveValuesWritten++; }
        } else if (tag === 'textarea') {
          var tv = String(el.value == null ? '' : el.value);
          if (tv === '') continue;
          el.textContent = tv;
          st.liveValuesWritten++;
        } else {
          var opts = el.options || [];
          var wrote = 0;
          for (var k = 0; k < opts.length; k++) {
            if (opts[k].selected) { if (!opts[k].hasAttribute('selected')) { opts[k].setAttribute('selected', ''); wrote++; } }
            else if (opts[k].hasAttribute('selected')) { opts[k].removeAttribute('selected'); wrote++; }
          }
          if (wrote) st.liveValuesWritten++;
        }
      } catch (e) { /* 个别控件的 value 会抛（只读/跨根），跳过它一个就是 */ }
    }
  }

  // ---- shadow DOM 盲区 ----------------------------------------------------
  // open shadow root 里的东西不在 querySelectorAll 结果里：它不在主文档这棵树上。
  // 实测五页都缺右下角那个客服悬浮按钮，它就是被 attachShadow 进去的。
  // 做法（closed 的读不到，shadowRoot 直接是 null，不硬来）：
  //   ① 元素清单里紧跟 host 收进 shadow root 的后代 → 它们也能固化计算样式与活值；
  //   ② shadow root 里的 <style>/<link rel=stylesheet>/adoptedStyleSheets 走同一条 CSS
  //     管道，选择器加 [data-dsh-shadow="sN"] 前缀，死选择器探针改成在那个 root 里查；
  //   ③ 序列化时把 shadow 内容拷进一个真实容器 <div data-dsh-shadow="sN">，
  //     挂在 host 的克隆里；<slot> 投影的 light DOM 原地保留，不重复拷。
  // 代价说明：展平后不再是 shadow 作用域，宿主选择器的权重/继承关系有细微差别；
  // :host 映射到 wrapper 自己，::slotted() 与 :host-context() 无法还原，直接丢并记账。
  var SHADOW_ELEMENTS_MAX = 6000;
  var SHADOW_NEST_MAX = 8;

  // ---- 模板占位名 ---------------------------------------------------------
  /**
   * 是不是「没插值的模板名」——不是资源，浏览器同样拿不到。
   *
   * 真实事故（93.6 s 返工）：Angular 模板渲染前残留的地址形如 /user/avatarSmallUrl、
   * /course/99569/instructor.avatar_small_url，服务器一律回 200 + SPA 兜底 HTML。
   * 浏览器拿到的是那张 HTML，画面从来不缺东西——模型却逐个 web_fetch 复核了 10 条。
   *
   * 判据宁窄勿宽，只认两种形状：
   *   ① 地址里带 {{ 或 }}；
   *   ② 末段是「无扩展名、无查询串」的驼峰/下划线标识符，并以 Url / _url 结尾。
   * 带已知扩展名或带查询串的一律不算：classroom 的 iconfont.woff?t=1595385243010 是真资源
   * （那份材料里它是 HTTP 404，但仍然不是占位）。
   * ponytail: 「路径 + 标识符」那条更宽的形状没有单独实现——它在取到字节之前和真资源分不开，
   * 而这里必须在取字节之前就下结论（省下的正是那些无谓的 fetch）。漏判的代价只是一次取字节。
   */
  var PLACEHOLDER_ASSET_EXT = {
    png: 1, jpg: 1, jpeg: 1, webp: 1, svg: 1, gif: 1, ico: 1, avif: 1, bmp: 1,
    woff: 1, woff2: 1, ttf: 1, otf: 1, eot: 1, css: 1, js: 1, mjs: 1, json: 1, map: 1, html: 1, htm: 1
  };
  /** 末段：标识符 + 点分标识符（instructor.avatar_small_url 也算一段）。 */
  var PLACEHOLDER_TAIL_RE = /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*$/;
  function isTemplatePlaceholder(url) {
    var s = String(url || '');
    if (s === '') return false;
    if (s.indexOf('{{') >= 0 || s.indexOf('}}') >= 0) return true;
    if (!/^https?:\/\//i.test(s)) return false;
    var cut = s.length;
    var q = s.indexOf('?');
    if (q >= 0 && q < cut) cut = q;
    var h = s.indexOf('#');
    if (h >= 0 && h < cut) cut = h;
    if (cut < s.length) return false;
    var tail = s.slice(s.lastIndexOf('/') + 1);
    if (!PLACEHOLDER_TAIL_RE.test(tail)) return false;
    var dot = tail.lastIndexOf('.');
    if (dot >= 0 && PLACEHOLDER_ASSET_EXT[tail.slice(dot + 1).toLowerCase()]) return false;
    return /(?:Url|_url)$/.test(tail);
  }

  // ---- @keyframes / animation 的账 ----------------------------------------
  /**
   * 一份 CSS 原文里有几条 @keyframes、几条 animation 声明、其中几条带 infinite。
   *
   * 真实事故（57.5 s）：模型在 pages/current/page.css 里找 @keyframes 找不到——第 7 步把
   * @font-face 与 @keyframes 统一提到 shared/app.css，page.css 里一条都没有。它 grep/read
   * 三轮，最后靠 web_fetch 原站 HTML 才对上。数的是落盘后的原文，所以和块里的字节同一口径。
   */
  // animation 关键字表：这些词出现在 shorthand 里都不是动画名。
  var ANIM_KEYWORDS = {
    normal: 1, reverse: 1, alternate: 1, 'alternate-reverse': 1, forwards: 1, backwards: 1, both: 1,
    none: 1, running: 1, paused: 1, infinite: 1, linear: 1, ease: 1, 'ease-in': 1, 'ease-out': 1,
    'ease-in-out': 1, 'step-start': 1, 'step-end': 1, initial: 1, inherit: 1, unset: 1, revert: 1,
    // auto 是 duration/delay 在新语法里的值，不是动画名。实测 s6 的
    // `@media (prefers-reduced-motion){*{animation:auto ease 0s 1 normal none running none}}`
    // 被当成 dangling 报了一个 "auto"——那条 reset 的动画名其实是 none。
    auto: 1, 'revert-layer': 1
  };
  /**
   * 一层 animation（逗号分隔的一层）里的动画名。取第一个不是数字/时间/关键字/函数的词。
   * 口径只在 animation 与 animation-name 上调用——其余长属性（duration/timing/delay…）没有名字。
   */
  function animationNameOf(layer) {
    var toks = String(layer || '').trim().split(/\s+/);
    for (var i = 0; i < toks.length; i++) {
      var t = toks[i].replace(/^[,(]+/, '').replace(/[),]+$/, '');
      if (!t) continue;
      if (/^[-+]?[0-9]*\.?[0-9]+(?:e[-+]?[0-9]+)?$/.test(t)) continue; // iteration-count
      if (/^[0-9.]+m?s$/i.test(t)) continue;                             // 时间
      if (ANIM_KEYWORDS[t.toLowerCase()]) continue;                      // 方向/填充/播放态/缓动
      if (/^[a-z-]+\(/i.test(t)) continue;                               // steps(4, / cubic-bezier(
      if (!/^-?[_a-zA-Z][_a-zA-Z0-9-]*$/.test(t)) continue;
      return t;
    }
    return '';
  }
  /** @keyframes 的名单（countAnimations 只给条数，算 dangling 要名字）。 */
  function keyframeNames(text) {
    var out = [], re = /@keyframes\s+([^\s{]+)/g, m;
    while ((m = re.exec(String(text || ''))) !== null) out.push(m[1]);
    return out;
  }
  /**
   * 一份 CSS 原文里有几条 @keyframes、几条 animation 声明、其中几条带 infinite。
   *
   * 真实事故（57.5 s）：模型在 pages/current/page.css 里找 @keyframes 找不到——第 7 步把
   * @font-face 与 @keyframes 统一提到 shared/app.css，page.css 里一条都没有。它 grep/read
   * 三轮，最后靠 web_fetch 原站 HTML 才对上。数的是落盘后的原文，所以和块里的字节同一口径。
   *
   * 迭代次数（oneShot / infinite）按**声明条数**算，不按层算：一条 shorthand 写成
   * `animation: a 2s, b 3s` 是 1 条声明 2 层，口径与 animationCount 一致。
   * 没有写 iteration-count 的声明默认 1 次 = 有限（oneShot）；写了 infinite 的才算无限。
   *
   * 真实事故（动画「静态」）：模型照抄了 loop 用的 @keyframes，却把迭代次数漏成一次，
   * 每条只播 7 s、可见运动 238–420 ms——所以这两个数必须能被模型看见。
   */
  function countAnimations(text) {
    var s = String(text || '');
    var keyframes = (s.match(/@keyframes[\s{]/g) || []).length;
    var declarations = 0, infinite = 0;
    var names = [];
    // 每条声明单记一笔，dangling 的分类要在两份文件合起来之后做（@keyframes 全在 app.css）。
    var decls = [];
    var re = /(?:^|[;{])\s*(animation(?:-[a-z]+)*)\s*:([^;}]*)/g, m;
    while ((m = re.exec(s)) !== null) {
      declarations++;
      var prop = m[1], body = m[2];
      var declNames = [];
      // 只有 shorthand 与 animation-name 带名字；其余长属性当名字扫会扫出 duration 之类。
      if (prop === 'animation' || prop === 'animation-name') {
        body.split(',').forEach(function (layer) {
          var n = animationNameOf(layer);
          if (n) { names.push(n); declNames.push(n); }
        });
      }
      if (/\binfinite\b/.test(body)) infinite++;
      decls.push({ infinite: /\binfinite\b/.test(body), names: declNames });
    }
    return { keyframes: keyframes, animations: declarations, infinite: infinite, oneShot: declarations - infinite, names: names, decls: decls };
  }

  // ---- @font-face / @keyframes 去重 ---------------------------------------
  // shadow root 展开后，同一批字体与动画会被再 push 进 pageRules 一遍（客服组件 AirChatbot
  // 的 8 张 shadow 样式表），而第 7 步又把这两类 at-rule 无条件全部提到 shared/app.css。
  // 真实事故：@font-face 69→89、@keyframes 87→266，块涨 873,584 B，其中 96.6% 是同一批
  // KaTeX 字形的又一/第三份拷贝。
  // 键（保守优先，宁可不合也别合错）：
  //   @font-face = (font-family, font-style, font-weight, src 里每个字体文件的字节)
  //                字节相同才算同一份字；family/style/weight 相同但字节不同（子集不同）的是
  //                两条不同的字，必须都留。键相同时优先留带 font-display 的那条。
  //   @keyframes = name + body 文本（首尾去空白、空白折叠）——同名不同 body 全留。
  // 只作用于这两类 at-rule：元素规则与死选择器逻辑一律不碰。
  var SRC_URL_RE = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g;
  /** 取 @font-face 里的属性值。值里不会有 ';'（src 里的 data: 只有 ";base64,"），按 ; 与 } 截。 */
  var ffProp = function (rule, name) {
    var m = new RegExp('(?:^|[;{])\\s*' + name + '\\s*:\\s*([^;}]+)', 'i').exec(rule);
    return m ? m[1].trim() : '';
  };
  /**
   * byteIdOfUrl(url) => 该字体的字节身份（同字节必得同串，不同字节必不同串）。
   * 抓取时由 assetMap 给：data: 取 base64 正文，落文件的取落盘 base64 —— 两条路都是
   * toBase64(原始字节)，所以内联与落文件两种形态的同一份字认得出是同一份。
   */
  function dedupeAtRules(fontFaceRules, keyframeRules, byteIdOfUrl) {
    var outFaces = [], faceDisplay = [], faceAt = new Map(), outKf = [], kfSeen = new Set();
    var lostFaces = 0, lostKf = 0, i, j, m;
    for (i = 0; i < fontFaceRules.length; i++) {
      var rule = fontFaceRules[i];
      var ids = [];
      SRC_URL_RE.lastIndex = 0;
      while ((m = SRC_URL_RE.exec(rule))) ids.push(byteIdOfUrl(m[2]));
      var key = ffProp(rule, 'font-family') + '|' + (ffProp(rule, 'font-style') || 'normal') + '|' +
        (ffProp(rule, 'font-weight') || '400') + '|' + ids.join(',');
      var hasDisplay = /(?:^|[;{])\s*font-display\s*:/i.test(rule);
      var at = faceAt.get(key);
      if (at === undefined) {
        faceAt.set(key, outFaces.length); outFaces.push(rule); faceDisplay.push(hasDisplay);
        continue;
      }
      lostFaces++;
      if (hasDisplay && !faceDisplay[at]) { outFaces[at] = rule; faceDisplay[at] = true; }
    }
    for (j = 0; j < keyframeRules.length; j++) {
      var t = keyframeRules[j];
      var b = t.indexOf('{');
      // ponytail: 空白折叠对引号里的内容也生效；两条 body 必须先逐字相同才可能撞键，
      // 失真场景只有 content:"a  b" 这类串内空格，撞上也只是少留一条等价动画。
      var kk = b < 0 ? t : t.slice(0, b) + '{' + t.slice(b + 1).replace(/\s+/g, ' ').trim();
      if (kfSeen.has(kk)) { lostKf++; continue; }
      kfSeen.add(kk); outKf.push(t);
    }
    return { fontFaces: outFaces, keyframes: outKf, fontFacesDeduped: lostFaces, keyframesDeduped: lostKf };
  }

  // ---- 主流程 -------------------------------------------------------------
  async function extract(doc, opts) {
    opts = opts || {};
    var st = {
      rulesTotal: 0, rulesKept: 0, rulesDead: 0, rulesEmpty: 0,
      declarationsDropped: 0, customPropsDropped: 0,
      fontFaces: 0, keyframes: 0, sheets: 0, sheetsFailed: 0, rulesUnsupported: 0,
      // 去重掉的重复 at-rule 条数（见 dedupeAtRules；只算这两类，别的一律不碰）
      fontFacesDeduped: 0, keyframesDeduped: 0,
      elements: 0, computedRules: 0, assetsInlined: 0, assetsSpilled: 0,
      // 令牌固化：宿主皮肤（--dsw-*）换成字面值；站内变量原样保留并记账
      declarationsInvalid: 0, invalidAtComputedValue: [],
      customPropsKept: 0, varDeclsKept: 0, varRefs: {},
      skinSelectorRewrites: 0, skinSelectorKept: 0, skinAttrsStripped: 0,
      // 活值固化（input/textarea/select）与敏感字段跳过
      liveValuesWritten: 0, liveValuesSkipped: 0, sensitiveSample: [],
      // shadow DOM：找到的 open shadow root、真正展开进产物的、收进来的规则条数
      shadowRules: 0, shadowSelectorsDropped: 0, shadowSlots: 0
    };
    // 三本账，口径分开（缺陷 B：dropped 里混进「改存 assets」，summary 与数组打架）：
    //   dropped  只放真丢：取不到字节 / 超单文件上限 / 读不到样式表。一条 = 一个真的没了的东西。
    //   spilled  只放「字节保住了、只是落成文件」：{url, bytes, path, reason}。改存不是丢。
    //   notices  既没丢也没落文件的信息行（重编码、摘属性、@import 成环），读块的人看情况。
    var dropped = [];
    // 与 dropped 同序、同文：每一项的 kind。字符串数组是给「直接读 dropped」的老读者留的，
    // kind 是给要分类的人（模板占位 / HTTP 码 / 超限 / 跨域表）留的——两条账必须一一对应。
    var droppedItems = [];
    var droppedTruncated = 0;
    var drop = function (s, kind) {
      if (dropped.length < 40) {
        var text = String(s).slice(0, 220);
        dropped.push(text);
        droppedItems.push({ kind: kind || 'other', text: text });
      } else droppedTruncated++;
    };
    var notices = [];
    var note = function (s) { if (notices.length < 60) notices.push(String(s).slice(0, 220)); };
    var spilled = [];                       // report.spilled：每一条落成 assets/ 的资源
    var spillInfo = new Map();              // absu -> 为什么落文件（写进 spilled[].reason）
    var sheetFails = [];                    // report.sheetsFailedItems：每张读不到的表
    var unsupportedKinds = {};              // 不认识的 at-rule 类型（不是「样式表失败」）

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
    // 只在子树里声明的令牌（根与 body 上抄不到）：解析时按名字现问一遍元素。
    // 这些值**只**进报告、**不**变成 :root 兜底：它们取自「某个元素」，属于那个元素/组件
    // 的作用域，把它抬成全局单值正是蓝色变灰的病根（见 cleanDecls 上的注释）。
    var varsSource = {};
    Object.keys(vars).forEach(function (name) { varsSource[name] = 'root'; });
    if (doc.body && win.getComputedStyle) {
      var bodyVarNames = readVars(win.getComputedStyle(doc.body));
      Object.keys(bodyVarNames).forEach(function (name) { varsSource[name] = 'body'; });
    }
    var probeCache = {};
    var varsFromElements = [];
    var lookupVar = function (name) {
      if (Object.prototype.hasOwnProperty.call(vars, name)) return String(vars[name]).trim();
      if (Object.prototype.hasOwnProperty.call(probeCache, name)) return probeCache[name];
      var found = '', at = '';
      try {
        var all = doc.querySelectorAll('body, body *');
        for (var i = 0; i < all.length && i < 4000; i++) {
          var v = win.getComputedStyle(all[i]).getPropertyValue(name);
          if (v && String(v).trim() !== '') {
            found = String(v).trim();
            at = String(all[i].tagName || '').toLowerCase() + (all[i].id ? '#' + all[i].id : '') +
              (all[i].className && typeof all[i].className === 'string' ? '.' + all[i].className.split(/\s+/).slice(0, 2).join('.') : '');
            break;
          }
        }
      } catch (e) { found = ''; }
      probeCache[name] = found;
      if (found) {
        vars[name] = found;
        varsSource[name] = 'element-probe';
        varsFromElements.push({ name: name, value: found.slice(0, 120), from: 'element-probe', at: at.slice(0, 120) });
      }
      return found;
    };
    Object.defineProperty(vars, 'lookup', { value: lookupVar, enumerable: false });
    var varCount = Object.keys(vars).length;
    /** :root 兜底层：只收真的挂在根/body 上的令牌（元素的私有值不许升级成全局单值）。 */
    var rootVarDecls = [];
    Object.keys(vars).forEach(function (name) {
      if (HOST_VAR_RE.test(name)) return;
      var src = varsSource[name];
      if (src !== 'root' && src !== 'body') return;
      var v = String(vars[name] || '').trim();
      // 值里带 url() 的不进兜底层：这些 URL 在资源那一趟之后才出现，来不及本地化，
      // 留在 :root 里就是一条悬空/越界引用。ponytail: 代价是这类变量退回「没有值」，
      // 升级路径是把它并进第 5 步的 URL 清单再本地化。
      if (!v || /url\(/i.test(v)) return;
      rootVarDecls.push(name + ':' + v);
    });

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

    // 1.9) 取字节的两个通道先就位：跨域样式表要在第 2 步之前取回来（规则管道本身是同步的）。
    // 内容脚本跑在页面里，取跨域图片/字体受页面 CORS 限制（logo、app-fold.svg、
    // no-application.png 就是这么 Failed to fetch 的）；service worker 带 all_urls 主机权限，
    // 同样的 URL 在那里 fetch 是 200，所以字节一律走这条路取。
    /**
     * 取字节：交给扩展后台的 service worker（background.js 的 'dsh-capture-fetch'），它带
     * all_urls 主机权限，跨域资源不受页面 CORS 限制——页面里 fetch 拿不到的 logo/svg/png
     * 就是死在这一步。没有后台可用时（离线自检的宿主页面）退回页面自身的 fetch。
     * maxBytes：走后台时的单条上限；缺省沿用 MAX_FETCH_BYTES，样式表那条按 16MB 传。
     */
    var bgFetch = function (absu, maxBytes) {
      var capture = globalThis.dshPageCapture;
      if (capture && typeof capture.fetchBytes === 'function') return Promise.resolve(capture.fetchBytes(absu, { maxBytes: maxBytes || 0 }));
      if (typeof chrome !== 'undefined' && chrome.runtime && typeof chrome.runtime.sendMessage === 'function') {
        return new Promise(function (res, rej) {
          try {
            chrome.runtime.sendMessage({ type: 'dsh-capture-fetch', url: absu, maxBytes: maxBytes || 0 }, function (r) {
              var err = chrome.runtime.lastError;
              if (err) { rej(new Error('后台没有应答：' + err.message)); return; }
              if (!r) { rej(new Error('后台没有应答')); return; }
              if (r.ok === false) {
                // HTTP 码要跟着走：只留一句人话，报告里就查不出是 404 还是 403（缺陷 A）
                var bad = new Error(String(r.error || '后台取字节失败'));
                if (r.httpStatus !== undefined) bad.httpStatus = Number(r.httpStatus);
                rej(bad);
                return;
              }
              res(r);
            });
          } catch (e) { rej(new Error('调后台失败：' + String(e && e.message || e))); }
        });
      }
      return null;
    };

    var fetchOne = async function (absu, maxBytes) {
      var cap = Number(maxBytes) > 0 ? Number(maxBytes) : MAX_FETCH_BYTES;
      if (absu.slice(0, 5).toLowerCase() === 'data:') {
        var meta = splitDataUri(absu);
        if (!meta) throw new Error('坏 data: URI');
        var bytes;
        if (meta.base64 !== null) bytes = fromBase64(meta.base64);
        else bytes = new TextEncoder().encode(decodeURIComponent(absu.slice(absu.indexOf(',') + 1)));
        return { bytes: bytes, mime: meta.mime, rawLen: meta.bytes, via: 'data' };
      }
      var fromBg = bgFetch(absu, cap);
      if (fromBg) {
        var r = await fromBg;
        var u8 = (r && r.bytes instanceof Uint8Array) ? r.bytes : fromBase64(String((r && r.base64) || ''));
        if (!u8 || !u8.length) throw new Error('后台回的是空字节');
        if (u8.length > cap) throw new Error('超过单条上限 ' + Math.round(cap / 1048576) + 'MB');
        return { bytes: u8, mime: String((r && r.mime) || '').split(';')[0].trim() || guessMime(absu), rawLen: u8.length, via: 'background' };
      }
      var f = (win.fetch ? win.fetch.bind(win) : fetch);
      var res = await f(absu, { credentials: 'include' });
      if (!res || !res.ok) {
        var bad = new Error('HTTP ' + (res ? res.status : '?') + (res && res.statusText ? ' ' + res.statusText : ''));
        if (res) bad.httpStatus = Number(res.status);
        throw bad;
      }
      var buf = new Uint8Array(await res.arrayBuffer());
      var ct = String((res.headers && res.headers.get('content-type')) || '').split(';')[0].trim();
      return { bytes: buf, mime: ct || guessMime(absu), rawLen: buf.length, via: 'page' };
    };

    // 2) 命中样式表：规则原文，死选择器丢掉（整条列表一个都不匹配就丢这条规则）
    var STATE = /:(hover|focus-visible|focus-within|focus|active|visited|target|checked|indeterminate|disabled|enabled|read-only|read-write|placeholder-shown|default|required|optional|valid|invalid|in-range|out-of-range|user-invalid|user-valid|autofill|open|popover-open|modal|fullscreen|picture-in-picture|playing|paused|muted|seeking|buffering|stalled|defined|link|any-link|local-link|scope)\b/gi;
    var PSEUDO_EL = /::?(before|after|marker|placeholder|selection|first-line|first-letter|backdrop|file-selector-button|cue|highlight)\b/gi;
    // 死选择器探针的作用域：主文档恒为 doc；收 shadow root 里的样式表时临时切到那个 root
    // （doc.querySelector 看不见 shadow 里的节点，不切就等于把整套 shadow 规则判成死选择器）。
    var probeRoot = null;
    // 非空 = 正在收 shadow root 的规则：选择器要加 scope 前缀，展平后才找得回这些节点。
    var shadowPrefix = '';
    var probe = function (sel) {
      var p = String(sel).replace(PSEUDO_EL, '').replace(STATE, '')
        .replace(/:host-context\([^()]*\)/gi, '')
        .replace(/:host(?:\([^()]*\))?/gi, '')
        .replace(/:not\(\s*\)/g, '').replace(/\s+/g, ' ').trim();
      if (!p) return true;
      try { return (probeRoot || doc).querySelector(p) !== null; } catch (e) { return false; }
    };
    // shadow 的选择器展平后要挂到 wrapper 上：:host 指 wrapper 自己，其余前挂 wrapper；
    // ::slotted()（投影走 light DOM 原位置）与 :host-context()（依赖祖先，展平后没有意义）丢弃。
    var shadowSel = function (sel, prefix) {
      var s = String(sel).trim();
      if (s.indexOf('::slotted') >= 0 || /:host-context\(/i.test(s)) { st.shadowSelectorsDropped++; return null; }
      s = s.replace(/:host-context\([^()]*\)/gi, '').replace(/:host(?:\([^()]*\))?/gi, '').replace(/\s+/g, ' ').trim();
      if (!s) return prefix;
      return prefix + ' ' + s;
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
      if (shadowPrefix) {
        var scoped = [];
        for (var mi = 0; mi < kept.length; mi++) {
          var one = shadowSel(kept[mi], shadowPrefix);
          if (one) scoped.push(one);
        }
        if (!scoped.length) { st.rulesDead++; return null; }
        return scoped.join(', ');
      }
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
          // 认不出的 at-rule（@layer 语句、@page、@namespace…）**不是**「样式表失败」。
          // 缺陷 A 的真实事故：这里曾经 st.sheetsFailed++，于是报告喊「1 张样式表没取到」，
          // 而它连一张表都不是、也没有 href——模型只能去猜、去手补 CSS。分开记。
          var kk2 = kind || 'unknown';
          st.rulesUnsupported++;
          if (!unsupportedKinds[kk2]) unsupportedKinds[kk2] = { type: kk2, count: 0, sample: String(rule.cssText || '').slice(0, 120) };
          unsupportedKinds[kk2].count++;
        }
      }
    };
    // ---- 跨域样式表：字节从后台取回来，自己解析 ------------------------------
    // 同源策略挡的是页面脚本（读 sheet.cssRules 抛 SecurityError），不挡扩展后台：它带
    // all_urls 主机权限，fetch(href) 就是 200。拿回正文后用 CSSStyleSheet.replaceSync 解析成
    // 一张真表，选择器重写、层叠顺序、死选择器探针全走原管道——只记一条 dropped 等于放弃
    // 这张表里的版式（真实事故：pure-drawer.css 里的 position/transform 没固化，抽屉停在
    // x=-334，它的 .drawer-header 正好盖住左上角图标位）。
    var MAX_IMPORT_DEPTH = 3;
    var bgSheets = new Map();   // 原 sheet → { sheets: [CSSStyleSheet…] }（按层叠顺序排好）
    var bgSheetLog = [];        // report.sheetsFetchedViaBackground.items

    /**
     * 记一张「读不到」的样式表：结构化一条（report.sheetsFailedItems）+ 一条能直接读的
     * dropped 行。缺陷 A 真实事故：报告只说「1 stylesheet could NOT be captured」，没有 href，
     * 模型翻了五步、grep 了 fail|could not，最后靠采样截图颜色手补 <style>。
     * href 是这张表唯一的身份，一定要进文本。
     */
    var failSheet = function (href, reason, via, extra) {
      var h = String(href || '');
      for (var i = 0; i < sheetFails.length; i++) {
        if (sheetFails[i].href === h) return sheetFails[i];   // 同一张表只记一条
      }
      var row = { href: h, reason: String(reason || ''), via: via === 'background' ? 'background' : 'cssom' };
      if (extra && extra.httpStatus !== undefined && Number.isFinite(Number(extra.httpStatus))) row.httpStatus = Number(extra.httpStatus);
      if (extra && extra.bytes !== undefined) row.bytes = Number(extra.bytes);
      sheetFails.push(row);
      // href 后面**必须留空格**：index.js 的 droppedItemOf 用 /https?:\/\/[^\s]+/ 抠 URL，
      // 紧贴着写括号会把「（后台取字节失败：HTTP」一起吞进 URL，文本那行就断成两截。
      drop('读不到样式表（跨域）：' + h + ' —— ' + row.reason +
        '；这张表里的样式整份缺失：要么接受并在差异里说明，要么让用户在该表所在的域上再抓一次。', 'crossOriginSheet');
      return row;
    };

    /**
     * 摘掉 CSS 注释再做 @import / url() 扫描。实测（真·跨域夹具）：注释里写着「@import url(...)」
     * 的一句说明，会被当成真的 @import 去取——多一次无谓的 fetch、多一条 404、多一行 dropped。
     * 引号里的注释起始符不算注释（content:"/*" 这种），所以按字符走，认得字符串与反斜杠转义。
     */
    var stripCssComments = function (css) {
      var s = String(css), out = '', i = 0, quote = '';
      while (i < s.length) {
        var ch = s.charAt(i), nx = s.charAt(i + 1);
        if (quote) {
          out += ch;
          if (ch === '\\' && i + 1 < s.length) { out += nx; i += 2; continue; }
          if (ch === quote) quote = '';
          i++;
          continue;
        }
        if (ch === '"' || ch === "'") { quote = ch; out += ch; i++; continue; }
        if (ch === '/' && nx === '*') {
          var end = s.indexOf('*/', i + 2);
          i = end < 0 ? s.length : end + 2;
          continue;
        }
        out += ch; i++;
      }
      return out;
    };

    /** 跨域表里的相对 url() / @import 按它自己的地址解析，别拿页面的 base 当基准。 */
    var rebaseCss = function (text, sheetUrl) {
      var rebase = function (u) {
        var t = String(u).trim();
        if (!t || t.charAt(0) === '#' || /^(data:|https?:|\/\/|blob:|about:)/i.test(t)) return t;
        return absUrl(t, sheetUrl) || t;
      };
      return String(text)
        .replace(/(@import\s+(?:url\(\s*)?)(['"])([^'"]+)\2/gi, function (m, head, q, u) { return head + q + rebase(u) + q; })
        .replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, function (m, q, u) { return 'url(' + q + rebase(u) + q + ')'; });
    };

    /** 解析一张表：@import 已经摘掉（replaceSync 不允许正文里带 @import）。 */
    var parseCssText = function (text) {
      if (typeof CSSStyleSheet === 'undefined') return null;
      try { var sh = new CSSStyleSheet(); sh.replaceSync(String(text)); return sh; } catch (e) { return null; }
    };

    /** 取一张跨域表的正文：失败重试一次即止（网络抖一下不该整张表作废）。 */
    var fetchSheetText = async function (href) {
      var last = null;
      for (var attempt = 0; attempt < 2; attempt++) {
        try {
          var got = await fetchOne(href, MAX_ASSET_BYTES);
          if (got.rawLen > MAX_ASSET_BYTES) throw new Error('超单条上限 ' + MAX_ASSET_MB);
          var text = new TextDecoder('utf-8').decode(got.bytes);
          return { text: text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text, bytes: got.rawLen };
        } catch (e) { last = e; }
      }
      throw last;
    };

    /**
     * 取回一张跨域表：@import 先递归展开（最多 MAX_IMPORT_DEPTH 层，成环即止），再解析本文。
     * 返回按层叠顺序排好的 CSSStyleSheet 数组；一张都没取到就返回空（调用方退回 dropped）。
     */
    var loadRemoteSheet = async function (href, depth, chain) {
      chain = chain || [];
      if (chain.indexOf(href) >= 0) { note('@import 成环，不再取：' + href); return []; }
      if (depth > MAX_IMPORT_DEPTH) { note('@import 超过 ' + MAX_IMPORT_DEPTH + ' 层，不再取：' + href); return []; }
      var got;
      try { got = await fetchSheetText(href); } catch (e) {
        failSheet(href, '后台取字节失败：' + String((e && e.message) || e).slice(0, 120), 'background',
          { httpStatus: e && e.httpStatus });
        return [];
      }
      bgSheetLog.push({ href: href, bytes: got.bytes });
      var text = rebaseCss(stripCssComments(got.text), href);
      var imports = [];
      text = text.replace(/@import\s+(?:url\(\s*)?(?:\"([^\"]*)\"|'([^']*)'|([^'\")\s;]+))\s*\)?([^;]*);/gi, function (m, a, b, c) {
        var u = a || b || c || '';
        if (u) imports.push(u);
        return '';
      });
      var out = [];
      // @import 带来的表在层叠上排在本文之前（CSS 规定 @import 必须在最前面）
      for (var i = 0; i < imports.length; i++) {
        var absu = absUrl(imports[i], href) || imports[i];
        var sub = /^https?:/i.test(absu) ? await loadRemoteSheet(absu, depth + 1, chain.concat([href])) : [];
        for (var j = 0; j < sub.length; j++) out.push(sub[j]);
      }
      var own = parseCssText(text);
      if (own) out.push(own);
      else failSheet(href, '取回后解析不了（CSSStyleSheet 不可用）', 'background', { bytes: got.bytes });
      return out;
    };

    /** 页面上读不到 cssRules 的那些样式表逐张取回来（只对 http/https 取）。 */
    var prefetchCrossOrigin = async function (list) {
      for (var i = 0; i < list.length; i++) {
        var sh = list[i];
        if (!sh || bgSheets.has(sh) || seen.indexOf(sh) >= 0) continue;
        var href = String(sh.href || '');
        if (!href || !/^https?:/i.test(href)) continue;
        var readable = true;
        try { readable = !!sh.cssRules; } catch (e) { readable = false; }
        if (readable) continue;
        var got = await loadRemoteSheet(absUrl(href, base) || href, 0, []);
        if (got.length) bgSheets.set(sh, { sheets: got });
      }
    };

    var walkSheet = function (sheet) {
      if (!sheet || seen.indexOf(sheet) >= 0) return;
      seen.push(sheet);
      var rules;
      try { rules = sheet.cssRules; } catch (e) {
        // 跨域：后台取回的那份已经解析好放在 bgSheets 里，按这条样式表原来的位置接进管道。
        var bg = bgSheets.get(sheet);
        if (!bg) {
          // 取字节时已经记过一条（同一条 href，failSheet 里按 href 去重），这里只补
          // 「压根没走到取字节」的那种：href 不是 http(s)（inline / blob: / extension:）。
          failSheet(sheet.href || 'inline', '读不到 cssRules（跨域），字节也没取回', 'cssom');
          return;
        }
        for (var b = 0; b < bg.sheets.length; b++) { st.sheets++; walkRules(bg.sheets[b].cssRules); }
        return;
      }
      if (!rules) return;
      st.sheets++;
      walkRules(rules);
    };
    var sheets = Array.prototype.slice.call(doc.styleSheets || []);
    if (doc.adoptedStyleSheets) sheets = sheets.concat(Array.prototype.slice.call(doc.adoptedStyleSheets));
    await prefetchCrossOrigin(sheets);
    for (var si = 0; si < sheets.length; si++) walkSheet(sheets[si]);

    // 3) 元素计算样式：给子树每个元素挂 data-dsh-el，把关键属性固化成规则
    //    继承属性与父元素相同就跳过（不然 color/font-* 会把字节数翻几倍）。
    var computedRules = [];
    var computedUsed = 0;
    var elements = [];
    // shadow：host 的后代紧跟在自己后面入列。它们不在 querySelectorAll 里（那是主文档
    // 这一棵树），排在队尾就等于永远挤不进 600 个元素的固化预算——而客服按钮这种
    // 恰恰是被 attachShadow 进去的，排在队尾等于白收。
    var shadowHosts = [];
    var shadowScope = new Map();
    var scopeSeq = 0;
    var collectElements = function (rootEl, depth) {
      if (!rootEl || !rootEl.querySelectorAll || depth > SHADOW_NEST_MAX) return;
      var list = Array.prototype.slice.call(rootEl.querySelectorAll('*'));
      for (var ci = 0; ci < list.length; ci++) {
        if (elements.length >= SHADOW_ELEMENTS_MAX) return;
        var ce = list[ci];
        elements.push(ce);
        var csr = null;
        try { csr = ce.shadowRoot; } catch (e) { csr = null; }  // closed / 跨域文档里会抛
        if (csr) {
          var sid = 's' + (++scopeSeq);
          shadowHosts.push({ host: ce, root: csr, scope: sid });
          shadowScope.set(ce, sid);
          collectElements(csr, depth + 1);
        }
      }
    };
    var topShadow = null;
    try { topShadow = topEl.shadowRoot; } catch (e) { topShadow = null; }
    if (topShadow) {
      var sidTop = 's' + (++scopeSeq);
      shadowHosts.push({ host: topEl, root: topShadow, scope: sidTop });
      shadowScope.set(topEl, sidTop);
      collectElements(topShadow, 1);
    }
    collectElements(topEl, 0);
    elements = [topEl].concat(elements);
    // 3.1) 活值固化（定义见 fixLiveValues）：走同一份清单，shadow 里的控件也覆盖。
    fixLiveValues(elements, st);
    // 3.2) shadow root 里的样式：<style> / <link rel=stylesheet> / adoptedStyleSheets
    //      照同一条管道收，选择器加 scope 前缀；探针切到那个 root 里去查。
    for (var hs = 0; hs < shadowHosts.length; hs++) {
      var sroot = shadowHosts[hs].root;
      var sheetList = [];
      try {
        var stEls = Array.prototype.slice.call(sroot.querySelectorAll('style'));
        for (var sx = 0; sx < stEls.length; sx++) { if (stEls[sx].sheet) sheetList.push(stEls[sx].sheet); }
        var lkEls = Array.prototype.slice.call(sroot.querySelectorAll('link[rel~="stylesheet"]'));
        for (var lx = 0; lx < lkEls.length; lx++) { if (lkEls[lx].sheet) sheetList.push(lkEls[lx].sheet); }
        if (sroot.adoptedStyleSheets) sheetList = sheetList.concat(Array.prototype.slice.call(sroot.adoptedStyleSheets));
      } catch (e) { drop('读不到 shadow root 的样式表：' + String((e && e.message) || e)); }
      await prefetchCrossOrigin(sheetList);
      var keptBefore = st.rulesKept;
      probeRoot = sroot;
      shadowPrefix = '[data-dsh-shadow="' + shadowHosts[hs].scope + '"]';
      for (var ssi = 0; ssi < sheetList.length; ssi++) walkSheet(sheetList[ssi]);
      probeRoot = null;
      shadowPrefix = '';
      st.shadowRules += st.rulesKept - keptBefore;
    }
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

    // 4.1) shadow root 展开：cloneNode 不带 shadow 树。把每个 open shadow root 的内容
    // 拷进一个真实容器 <div class="dsh-shadow-root" data-dsh-shadow="sN">，挂在 host 的
    // 克隆里（host 自己的 light DOM 子节点原地保留）。<slot> 投影的内容仍在原来那棵树上，
    // 不重复拷——代价是投影位置还原不了，记进 report.shadowRoots.slots 与 README 的边界。
    // 这一步发生在 index 对齐之后、结构改写之前：liveTree 与 cloneTree 此刻逐项同构。
    var shadowInlined = 0;
    if (shadowHosts.length) {
      var liveTree = [topEl].concat(Array.prototype.slice.call(topEl.querySelectorAll('*')));
      var cloneTree = [clone].concat(Array.prototype.slice.call(clone.querySelectorAll('*')));
      var expandShadow = function (liveNodes, cloneNodes) {
        for (var xi = 0; xi < liveNodes.length; xi++) {
          var lx1 = liveNodes[xi], cx1 = cloneNodes[xi];
          if (!lx1 || !cx1) continue;
          var xroot = null;
          try { xroot = lx1.shadowRoot; } catch (e) { xroot = null; }
          if (!xroot) continue;
          var wrap = doc.createElement('div');
          wrap.className = 'dsh-shadow-root';
          wrap.setAttribute('data-dsh-shadow', shadowScope.get(lx1) || '');
          wrap.setAttribute('data-dsh-shadow-host', String(lx1.tagName || '').toLowerCase());
          // ShadowRoot 本身不能 cloneNode（NotSupportedError），只能逐个孩子克隆进一个片段
          var frag = doc.createDocumentFragment();
          for (var bi = 0; bi < xroot.childNodes.length; bi++) {
            frag.appendChild(xroot.childNodes[bi].cloneNode(true));
          }
          try {
            var slotN = xroot.querySelectorAll('slot').length;
            if (slotN) st.shadowSlots += slotN;
          } catch (e) { /* 数不出来就算了，不影响产物 */ }
          try {
            // 嵌套 shadow（shadow 里的 host）：同一个函数往下走一层
            expandShadow(Array.prototype.slice.call(xroot.querySelectorAll('*')),
                         Array.prototype.slice.call(frag.querySelectorAll('*')));
          } catch (e) { /* 内层展开失败就只留外层，不连累整棵 */ }
          wrap.appendChild(frag);
          cx1.appendChild(wrap);
          shadowInlined++;
        }
      };
      expandShadow(liveTree, cloneTree);
    }

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
    // 抽取时从**副本**里摘掉的死标签条数。它和下面 report.removedNodes（页面自己的 JS
    // 在抓取前摘掉的节点）是两件事，名字以前混用过：旧 report 的 removedNodes 就是这个数，
    // 于是「加载层消失」被读成了「2 个节点没了」。现在各归各名。
    var deadTagsStripped = 0;
    Array.prototype.slice.call(clone.querySelectorAll(deadTags.join(','))).forEach(function (n) {
      if (n.parentNode) { n.parentNode.removeChild(n); deadTagsStripped++; }
    });
    // 「抓取前就已经不在 DOM 里的节点」：页面自己（框架）在加载完成后把加载层 / 骨架层 /
    // 提示条摘掉，抓取这一刻它们早就没了——抽取函数只能在当下的 DOM 上工作，看不见过去。
    // 真实事故：panel.solyukimura.top 的 .lwrap / .lbox 就这么消失的，旧 report 里那句
    // removedNodes: 2 还是「抽取时摘掉的 <script>/<style>」，模型没有任何依据判断要不要
    // 在块里把它放回去，于是复刻出来是静态的。
    // 观察器（removed-watch.js，manifest 里 document_start 注入）把被摘掉的元素压进一个有界环，
    // 这里只取最近的那几条并序列化。**只报，不放回去**：要不要复刻是模型在块里该做的决定。
    var removedItems = [];
    var removedTruncated = 0;
    var removedObserved = false;
    try {
      var removedWatch = (typeof globalThis !== 'undefined' ? globalThis : win).__dshRemovedWatch;
      if (removedWatch && removedWatch.rows) {
        removedObserved = true;
        var removedTotal = typeof removedWatch.total === 'function' ? Number(removedWatch.total()) : removedWatch.rows.length;
        // 新的在前：最贴近抓取那一刻被摘掉的那个，通常正是加载/骨架层。
        for (var ri = removedWatch.rows.length - 1; ri >= 0 && removedItems.length < REMOVED_MAX; ri--) {
          var row = removedWatch.rows[ri];
          var gone = row && row.el;
          if (!gone) continue;
          var goneHtml = '';
          try { goneHtml = String(gone.outerHTML || ''); } catch (e) { goneHtml = ''; }
          removedItems.push({
            tag: String(row.tag || ''),
            id: String(row.id || ''),
            cls: String(row.cls || ''),
            bytes: utf8Len(goneHtml),
            outerHTMLHead: goneHtml.slice(0, REMOVED_HEAD)
          });
        }
        removedTruncated = Math.max(0, removedTotal - removedItems.length);
      }
    } catch (e) {
      removedObserved = false;
      removedItems = [];
      removedTruncated = 0;
    }
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
          else { n.removeAttribute(a.name); note('根绝对引用无法绝对化，已去掉 ' + nm + '=' + v); }
          return;
        }
        if (BIND_ABS_ATTR[nm]) {
          // Vue 的值是表达式：:href="'/z'" 只把引号里那段路径绝对化，引号原样留着。
          var lit = /^\s*(['"])([^'"]*)\1\s*$/.exec(v);
          var inner = lit ? lit[2] : v;
          if (/^\/(?!\/)/.test(inner)) {
            var absBind = absUrl(inner, base);
            if (absBind && /^https?:|^file:/i.test(absBind)) n.setAttribute(a.name, lit ? lit[1] + absBind + lit[1] : absBind);
            else { n.removeAttribute(a.name); note('根绝对引用无法绝对化，已去掉 ' + nm + '=' + v); }
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
            note('属性里的变量解析不了，已去掉 ' + nm + '=' + v.slice(0, 60));
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
    var assetRowByUrl = new Map();   // absu -> assetLog 行（预算改判时要就地改这一行）
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

    // （bgFetch / fetchOne 已提到第 1.9 步：跨域样式表要在规则管道跑起来之前取回来。）

    var kbOf = function (n) { return Math.round(n / 1024) + 'KB'; };

    /** 落 assets/：原字节进块，不改尺寸。返回段内相对路径。reason 只进 report.spilled。 */
    var spool = function (kind, absu, mime, base64, bytes, reason) {
      assetSeq[kind] = (assetSeq[kind] || 0) + 1;
      var name = kind === 'font' ? 'font' : (kind === 'img' ? 'img' : 'asset');
      var path = 'assets/' + name + '-' + assetSeq[kind] + '.' + extOf(absu, mime);
      assetFiles.push({ path: path, content: base64, base64: true, bytes: bytes });
      spillInfo.set(absu, String(reason || ''));
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
      // 原始 URL 只在内存里留着（不枚举 → 不进 report）：spilled[].reason、字体去重用得上，
      // 而 report 里的 url 还是截断后的可读标识。
      Object.defineProperty(row, 'key', { value: absu, enumerable: false });
      assetLog.push(row);
      assetRowByUrl.set(absu, row);
      return row;
    };

    var resolveAsset = async function (absu) {
      if (assetMap.has(absu)) return assetMap.get(absu);
      var out = { kind: 'drop' };
      var got = null;
      // 模板占位名不是资源：一次都不去取。取也是 200 + SPA 兜底 HTML，再落到「非图片/字体」
      // 那条 drop——真实事故里这一串白跑就是 93.6 s。落点照旧 none，画面与现在一字不差。
      if (isTemplatePlaceholder(absu)) {
        out = { kind: 'drop', reason: '未插值的模板占位名（不是资源）' };
        drop('未插值的模板占位（浏览器也拿不到）：' + absu, 'templatePlaceholder');
        assetMap.set(absu, out);
        logAsset(absu, out, null);
        return out;
      }
      try {
        got = await fetchOne(absu);
        var mime = got.mime || guessMime(absu);
        var isImg = /^image\//i.test(mime);
        var isFont = /^font\//i.test(mime) || /font-(woff2?|ttf|otf|eot)|vnd\.ms-fontobject/i.test(mime) || /\.(woff2?|ttf|otf|eot)([?#]|$)/i.test(absu);
        if (!isImg && !isFont) { out = { kind: 'drop', reason: '非图片/字体' }; drop('非图片/字体，丢弃：' + absu); }
        else if (isFont) {
          if (got.rawLen <= MAX_INLINE_BYTES) {
            out = { kind: 'data', uri: 'data:' + mime + ';base64,' + toBase64(got.bytes), bytes: got.rawLen, mime: mime };
          } else if (got.rawLen <= MAX_ASSET_BYTES) {
            var fpath = spool('font', absu, mime, toBase64(got.bytes), got.rawLen, '字体 ' + kbOf(got.rawLen) + ' 超内嵌上限 1.4MB');
            out = { kind: 'file', path: fpath, bytes: got.rawLen, mime: mime };
          } else {
            out = { kind: 'drop', reason: '超单文件上限 ' + MAX_ASSET_MB };
            drop('字体 ' + kbOf(got.rawLen) + ' 超单文件上限 ' + MAX_ASSET_MB + '，丢弃：' + absu, 'overLimit');
          }
        } else {
          var info = await imageSize(doc, got.bytes, mime);
          var iw = info ? info.w : 0, ih = info ? info.h : 0;
          var dimTooBig = iw > MAX_IMAGE_DIM || ih > MAX_IMAGE_DIM;
          if (info && spriteLike(iw, ih)) {
            // 雪碧图 / 长条图：降采样会把 358x20870 压成 34x2000，等于毁掉——原尺寸落文件。
            if (got.rawLen <= MAX_ASSET_BYTES) {
              var spath = spool('img', absu, mime, toBase64(got.bytes), got.rawLen, '雪碧图 ' + iw + 'x' + ih + ' 原尺寸落文件（不降采样会毁图）');
              out = { kind: 'file', path: spath, bytes: got.rawLen, mime: mime, w: iw, h: ih, downsampled: false };
            } else {
              out = { kind: 'drop', reason: '雪碧图原图超单文件上限 ' + MAX_ASSET_MB };
              drop('雪碧图 ' + iw + 'x' + ih + ' 原图 ' + kbOf(got.rawLen) + ' 超单文件上限 ' + MAX_ASSET_MB + '，丢弃：' + absu, 'overLimit');
            }
          } else if (got.rawLen <= MAX_INLINE_BYTES && !dimTooBig) {
            out = { kind: 'data', uri: 'data:' + mime + ';base64,' + toBase64(got.bytes), bytes: got.rawLen, mime: mime, w: iw, h: ih, downsampled: false };
          } else {
            var shrink = dimTooBig ? await reencode(doc, got.bytes, mime, MAX_IMAGE_DIM) : null;
            if (shrink && shrink.bytes <= MAX_INLINE_BYTES) {
              out = { kind: 'data', uri: shrink.uri, bytes: shrink.bytes, mime: shrink.mime, w: shrink.w, h: shrink.h, downsampled: true };
              note('图片重编码 ' + (iw ? iw + 'x' + ih : '?') + ' → ' + shrink.w + 'x' + shrink.h + ' webp ' + kbOf(shrink.bytes) + '：' + absu);
            } else if (shrink) {
              var ipath = spool('img', absu, shrink.mime, splitDataUri(shrink.uri).base64, shrink.bytes, '降采样后仍 ' + kbOf(shrink.bytes) + ' 超内嵌上限');
              out = { kind: 'file', path: ipath, bytes: shrink.bytes, mime: shrink.mime, w: shrink.w, h: shrink.h, downsampled: true };
            } else if (got.rawLen <= MAX_ASSET_BYTES) {
              // 解不开、或长宽比正常只是文件大：原字节落文件，不在体积上赌质量。
              var opath = spool('img', absu, mime, toBase64(got.bytes), got.rawLen, '图片 ' + kbOf(got.rawLen) + ' 超内嵌上限 1.4MB，原尺寸落文件');
              out = { kind: 'file', path: opath, bytes: got.rawLen, mime: mime, w: iw, h: ih, downsampled: false };
            } else {
              out = { kind: 'drop', reason: '超单文件上限 ' + MAX_ASSET_MB };
              drop('图片 ' + kbOf(got.rawLen) + ' 超单文件上限 ' + MAX_ASSET_MB + '，丢弃：' + absu, 'overLimit');
            }
          }
        }
      } catch (e) {
        out = { kind: 'drop', reason: String(e && e.message || e) };
        // 有 HTTP 码就是 httpStatus（404 / 403 / 500 是三种不同的麻烦），没有就是网络/别的。
        drop('取不到字节，丢弃：' + absu + ' （' + String(e && e.message || e).slice(0, 80) + '）', e && e.httpStatus ? 'httpStatus' : 'other');
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
        var p2 = spool('bin', item.k, meta2.mime, meta2.base64, item.v.bytes, '内嵌总量超预算，改存文件');
        assetMap.set(item.k, { kind: 'file', path: p2, bytes: item.v.bytes, mime: meta2.mime });
        // 就地改这一行：assets 总账与 spilled / assetsInlined / assetsSpilled 必须同一口径。
        // 旧代码按 shortUrl 后的字符串比对，data: 那条永远对不上（url 里是截断后的说明文字），
        // 于是账上是 data、磁盘上是文件——三个数互相打架的一半原因在这。
        var brow = assetRowByUrl.get(item.k);
        if (brow) { brow.kind = 'file'; brow.path = p2; }
        inlineBytes -= item.v.bytes;
      }
    }

    // 资源四本账，一次性按**最终落点**数出来（不靠过程中的加加减减，那样同一份资源
    // 先内联再改判落文件会被算两次）：
    //   assetsInlined + assetsSpilled + assetsDropped = assets.length（资源总数）
    //   spilled.length === assetsSpilled
    //   dropped 里的资源条目 = assetsDropped；dropped 还会多出「读不到样式表」那几条，
    //   它们不是 assets 里的资源，单独由 sheetsFailedItems / sheetsFailed 记账。
    spilled.length = 0;
    var assetsInlinedN = 0, assetsSpilledN = 0, assetsDroppedN = 0;
    for (var li = 0; li < assetLog.length; li++) {
      var lrow = assetLog[li];
      if (lrow.kind === 'data') assetsInlinedN++;
      else if (lrow.kind === 'file') {
        assetsSpilledN++;
        spilled.push({ url: lrow.url, bytes: Number(lrow.bytes) || 0, path: String(lrow.path || ''), reason: spillInfo.get(String(lrow.key || '')) || '' });
      } else assetsDroppedN++;
    }
    st.assetsInlined = assetsInlinedN;
    st.assetsSpilled = assetsSpilledN;

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
            note('取不到 ' + attr + ' 的字节，只摘属性、保留子树：' + raw.slice(0, 120));
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
    // 字体字节的身份：assetMap 的落点已经定了（第 5 步跑完、内嵌预算也改判过了），
    // data: 取 base64 正文，落文件的取落盘的那份 base64。两条路都是 toBase64(原始字节)，
    // 所以同一份字不管被内联还是落成 assets/，认出来的是同一个串。
    var spoolBytes = new Map();
    assetFiles.forEach(function (f) { if (f.base64) spoolBytes.set(f.path, f.content); });
    var byteIds = new Map();
    var byteIdOfUrl = function (u) {
      var k = keyOf(u);
      if (byteIds.has(k)) return byteIds.get(k);
      var hit = assetMap.get(k), id = 'none';
      if (hit && hit.kind === 'data') {
        var bi = hit.uri.indexOf('base64,');
        id = bi >= 0 ? hit.uri.slice(bi + 7) : hit.uri;
      } else if (hit && hit.kind === 'file') {
        id = spoolBytes.get(hit.path) || ('file:' + hit.path);
      }
      byteIds.set(k, id);
      return id;
    };
    var deduped = dedupeAtRules(fontFaces, keyframes, byteIdOfUrl);
    st.fontFacesDeduped = deduped.fontFacesDeduped;
    st.keyframesDeduped = deduped.keyframesDeduped;
    appCss = [
      '/* dsh-page-capture: 基线（重置 + 字体 + 动画）——跨页可复用 */',
      '*,*::before,*::after{box-sizing:border-box}',
      'html,body{margin:0}',
      'img,svg,video,canvas{max-width:100%;height:auto}'
    ].concat(deduped.fontFaces).concat(deduped.keyframes);
    var pageCssBody = rest.length ? rest : ['/* 本页没有命中任何样式表规则 */'];
    // :root 兜底层放最前：只给「样式表里没有规则声明它」的令牌兜个值（主题常由 JS 塞到
    // html/body 上）。后面任何声明了同名令牌的规则都会按层叠覆盖它。
    var pageCss = ['/* dsh-page-capture: 本页样式表命中规则 + 元素计算样式固化 */']
      .concat(rootVarDecls.length ? [':root{' + rootVarDecls.join(';') + '}'] : [])
      .concat(pageCssBody).concat(computedRules);
    // 这些名字被 var() 引用了，但产物里没有任何规则/兜底层声明它们 → 浏览器会按
    // 「计算值阶段无效」退成 unset。报告里点名，别让它静默。
    var declaredVars = {};
    var scanVarDecls = function (txt) {
      var re = /(--[A-Za-z0-9_-]+)\s*:/g, m;
      while ((m = re.exec(txt))) declaredVars[m[1]] = 1;
    };
    scanVarDecls(pageRules.join(NL));
    scanVarDecls(computedRules.join(NL));
    scanVarDecls(rootVarDecls.join(';'));
    var unresolvedVars = Object.keys(st.varRefs).filter(function (n) { return !declaredVars[n]; });
    var appCssText = subCss(appCss.join(NL), '../') + NL;
    var pageCssText2 = subCss(pageCss.join(NL), '../../') + NL;
    if (utf8Len(appCssText) > SECTION_MAX_BYTES) { degrade.push('shared/app.css 超单段上限 ' + Math.round(SECTION_MAX_BYTES / 1024) + 'KB（' + utf8Len(appCssText) + '）'); }
    if (utf8Len(pageCssText2) > SECTION_MAX_BYTES) { degrade.push('pages/current/page.css 超单段上限 ' + Math.round(SECTION_MAX_BYTES / 1024) + 'KB（' + utf8Len(pageCssText2) + '）'); }
    // 动画的账：数落盘的那两份原文（不是 pageRules 的条数——去向在第 7 步已经定了）。
    var appAnim = countAnimations(appCssText);
    var pageAnim = countAnimations(pageCssText2);
    var keyframesByFile = {}, animationsByFile = {};
    keyframesByFile[APP_CSS] = appAnim.keyframes;
    keyframesByFile[PAGE_CSS] = pageAnim.keyframes;
    animationsByFile[APP_CSS] = appAnim.animations;
    animationsByFile[PAGE_CSS] = pageAnim.animations;
    // 引用不到已收集 keyframes 的动画名：产物里那些声明永远不会跑。名单要跨两份文件算
    // ——@keyframes 全被提到 shared/app.css，动画名却可能写在 page.css 的规则里。
    var knownKeyframes = {};
    keyframeNames(appCssText).concat(keyframeNames(pageCssText2)).forEach(function (n) { knownKeyframes[n] = 1; });
    // 按**声明**分类，三个桶互斥：一条声明里只要有一个动画名在产物里找不到，它就永远跑不起来，
    // 只记进 dangling（既不算循环也不算一次性）。这样 oneShot + infinite + dangling = animationCount，
    // 前提是没有一条声明既 infinite 又找不到名字（那种归 dangling，infiniteCount 仍算它——
    // infiniteCount 的口径是「文本里有 infinite 的声明数」，两者不冲突）。
    var oneShotN = 0, infiniteN = 0, danglingN = 0;
    var danglingNames = [];
    appAnim.decls.concat(pageAnim.decls).forEach(function (d) {
      var missing = (d.names || []).filter(function (n) { return !knownKeyframes[n]; });
      if (missing.length) {
        danglingN++;
        missing.forEach(function (n) { if (danglingNames.indexOf(n) < 0) danglingNames.push(n); });
        return;
      }
      if (d.infinite) infiniteN++; else oneShotN++;
    });

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
      // 只有真丢。口径（缺陷 B）：取不到字节 / 超单文件上限 / 读不到样式表。
      // 「改存 assets/」一条都不在这里——它是搬走了，不是丢了，见 spilled。
      dropped: dropped,
      // 与 dropped 同序同文，每条带 kind：templatePlaceholder（未插值的模板名，不是资源）/
      // httpStatus（取字节回了 404/403/500）/ overLimit（超单文件上限）/ crossOriginSheet
      // （跨域表读不到）/ other。字符串数组留给直接读 dropped 的人，分类看这里。
      droppedItems: droppedItems,
      // 落成 assets/ 的那些（字节保住了）：每条都带 url / bytes / path / reason。
      spilled: spilled,
      // 既没丢也没落文件的信息行（重编码、摘属性、@import 成环），读块时按需看。
      notices: notices,
      files: files.map(function (f) { return { path: f.path, bytes: f.bytes }; }),
      rulesTotal: st.rulesTotal,
      rulesKept: st.rulesKept,
      rulesDead: st.rulesDead,
      rulesEmpty: st.rulesEmpty,
      sheets: st.sheets,
      // 只数真正的样式表（读不到 cssRules 的那几张）。认不出的 at-rule 走 atRulesUnsupported。
      sheetsFailed: sheetFails.length,
      fontFaces: st.fontFaces,
      keyframes: st.keyframes,
      // 去重掉的重复条数：实测 zju-r2-a 那份材料 @font-face 89→32、@keyframes 266→169，
      // 重建块 17,774,100 → 15,491,282 B（同宽渲染逐像素相同）。别只看 fontFaces 那条——
      // 那是「碰到的条数」，写进 app.css 的是去重之后的那份。
      fontFacesDeduped: st.fontFacesDeduped,
      keyframesDeduped: st.keyframesDeduped,
      // 动画在哪份文件里：键就是产物里的相对路径。@keyframes 全在 shared/app.css
      // （第 7 步把 @font-face / @keyframes 统一提到基线），page.css 里一条都没有。
      keyframesByFile: keyframesByFile,
      animationsByFile: animationsByFile,
      animationCount: appAnim.animations + pageAnim.animations,
      infiniteCount: appAnim.infinite + pageAnim.infinite,
      // 动画能不能看出「在动」，取决于迭代次数：同一条 @keyframes，配 infinite 是转圈，
      // 配默认的 1 次就是「播一遍就停」。模型手写替代动画时漏掉 infinite 的代价是整块看起来静态
      // （实测每条只播 7 s、可见运动 238–420 ms），所以这两个数必须能被模型看见。
      // 口径：按**声明条数**，没写 iteration-count 的算有限（默认 1 次），与 animationCount 同口径。
      // 三个桶互斥：会跑一次、会一直循环、永远跑不起来（名字找不到）。和 animationCount 同口径，
      // 没有一条既 infinite 又找不到名字时 oneShot + infinite + dangling = animationCount。
      oneShotAnimations: oneShotN,
      infiniteAnimations: infiniteN,
      // 引用了产物里根本没有的 @keyframes 的声明条数（那条声明永远不会跑），名单另列。
      danglingAnimationNames: danglingN,
      danglingAnimationNameSample: danglingNames.slice(0, 10),
      // 站内自定义属性：原样写出去的条数 / 丢掉的（只有宿主皮肤 --dsw-* 与解析不了的空值）
      customPropsKept: st.customPropsKept,
      customPropsDropped: st.customPropsDropped,
      // 含站内 var() 的普通声明：原样保留、交给浏览器按元素算的条数
      varDeclsKept: st.varDeclsKept,
      declarationsDropped: st.declarationsDropped,
      declarationsInvalid: st.declarationsInvalid,
      // 被 var() 引用、却在产物里找不到声明的令牌名：浏览器会把这些声明退成 unset。
      // （宿主皮肤 --dsw-* 不在此列——它已经换成字面值了。）
      unresolvedVars: unresolvedVars.slice(0, 40),
      invalidAtComputedValue: st.invalidAtComputedValue,
      skinSelectorRewrites: st.skinSelectorRewrites,
      skinSelectorKept: st.skinSelectorKept,
      skinAttrsStripped: st.skinAttrsStripped,
      varsResolved: varCount,
      varsFromElements: varsFromElements,
      elements: st.elements,
      computedRules: st.computedRules,
      // 活值固化：写了几条属性、跳过几个敏感字段。sensitiveSample 只记「哪个控件被跳过」
      // （选择器级别的标识），密码本身的值一个字符都不进 report。
      liveValues: {
        written: st.liveValuesWritten,
        sensitiveSkipped: st.liveValuesSkipped,
        sensitiveSample: st.sensitiveSample
      },
      // shadow DOM：找到几个 open shadow root、真正展开进产物的几个、收进来的规则条数。
      // closed 的读不到（shadowRoot 直接是 null），不硬来——found 只算 open 的。
      shadowRoots: {
        found: shadowHosts.length,
        inlined: shadowInlined,
        rules: st.shadowRules,
        slots: st.shadowSlots,
        droppedSelectors: st.shadowSelectorsDropped
      },
      // 序列化后对不上的 [data-dsh-el] 规则条数（正常恒为 0；非 0 就是有节点在产物里丢了）
      computedOrphansDropped: computedOrphans,
      // 四本账（按最终落点数，见第 5 步末尾）：
      //   assetsInlined + assetsSpilled + assetsDropped = assetsTotal = assets.length
      //   spilled.length === assetsSpilled
      assetsInlined: st.assetsInlined,
      assetsSpilled: st.assetsSpilled,
      assetsDropped: assetsDroppedN,
      assetsTotal: assetLog.length,
      // 资源总账：每条 URL 的落点、字节、取字节通道（background=扩展后台 / page=页面兜底）、
      // 原尺寸与是否降采样。素材库索引与验收都读这一份，不用再猜。
      assets: assetLog,
      srcsetPicked: srcsetPickedUrls,
      // 抓取那一刻**已经不在 DOM 里**的节点（页面自己的 JS 摘掉的），新的在前，最多 20 条。
      // 每条 {tag, id, cls, bytes, outerHTMLHead}；outerHTMLHead 是序列化后前 300 字——
      // 复刻加载/骨架层时这就是那句「它原来长什么样」的唯一来源。
      // 旧版这里是个数字，数的是抽取时从副本里摘掉的死标签条数，现在叫 deadTagsStripped。
      removedNodes: removedItems,
      deadTagsStripped: deadTagsStripped,
      ancestors: ancestors,
      degrade: degrade,
      // frame 盲区：扩展只注入顶层文档，正文装在 iframe 里时抓到的就是空壳。
      // dominant = 盖住可视区 30% 以上的那个 frame（没有就是 null）。
      // 参考截图的环境事实：PNG 由 background.js 用 chrome.tabs.captureVisibleTab 拍下，存成
      // 材料目录里的 reference/viewport.png（不进块、不被 entry 引用）。
      // mode 恒为 viewport——captureVisibleTab 只能拍可见区域，没有整页拼接，别把它当整页。
      // width/height 是**抓取那一刻的视口**，只作对照参考，不是目标尺寸：块里固化的 px 绑在
      // 这个宽度上，明显换宽度渲染时 right/inset/宽度不会跟着变（已知上限）。
      screenshot: {
        mode: 'viewport',
        path: 'reference/viewport.png',
        width: Math.round(viewW),
        height: Math.round(viewH),
        dpr: Number(win.devicePixelRatio) || 1,
        scrollY: Math.round(Number(win.scrollY !== undefined ? win.scrollY : win.pageYOffset) || 0),
        scrollHeight: Math.round(Number((doc.documentElement && doc.documentElement.scrollHeight) || 0) || 0),
        captureViewport: { width: Math.round(viewW), height: Math.round(viewH), dpr: Number(win.devicePixelRatio) || 1 }
      },
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
    // 跨域样式表：页面读不到 cssRules 的那几张，字节是从扩展后台取回来的（每张一条账）。
    // 没有这个字段 = 这一页没有跨域样式表，或一张都没取回来（那就还是 dropped 里那条）。
    if (bgSheetLog.length) report.sheetsFetchedViaBackground = { count: bgSheetLog.length, items: bgSheetLog };
    // 读不到的那几张：一条失败一条（href + reason + via + HTTP 码）。没有这个字段 = 一张都没失败。
    if (sheetFails.length) report.sheetsFailedItems = sheetFails;
    // 认不出的 at-rule：单独记，绝不计入 sheetsFailed（它不是样式表，也没有 href）。
    if (st.rulesUnsupported > 0) {
      report.atRulesUnsupported = { count: st.rulesUnsupported, items: Object.keys(unsupportedKinds).map(function (k) { return unsupportedKinds[k]; }) };
    }
    if (droppedTruncated > 0) report.droppedTruncated = droppedTruncated;
    // 观察器记的比 20 条多：剩下的只报个数（口径与 droppedTruncated 一致）。
    if (removedTruncated > 0) report.removedNodesTruncated = removedTruncated;
    // 没有这个字段 = 观察器跑了；有 = 这一页加载时扩展还没装上/还没更新，抓不到「抓取前消失」的账。
    if (!removedObserved) report.removedNodesNotObserved = true;
    // includes 已废：传了就记一个布尔 true（口径与其它布尔字段一致——没有这个字段 = 没传），
    // 具体传了什么写在 degrade 那条说明里。产物恒定是 entry + 两份 CSS + 资源落点。
    if (includesIgnored.length) report.includesIgnored = true;
    return { files: files, report: report };
  }

  // dedupeAtRules 也挂出去：离线拿现成材料的 app.css 重跑同一份去重逻辑（验收脚本用），
  // 不给它就没有第二条路能在不重抓页面的前提下量出「改后」的计数与字节。
  // isTemplatePlaceholder / countAnimations 同样挂出去：离线拿现成材料的原文复核同一条判据
  // （验收脚本用）——不给就没有第二条路能在不重抓页面的前提下验「这条到底算不算占位」。
  globalThis.dshPageCapture = {
    extract: extract, dedupeAtRules: dedupeAtRules,
    isTemplatePlaceholder: isTemplatePlaceholder, countAnimations: countAnimations, keyframeNames: keyframeNames,
    version: '0.1.0'
  };
})();
