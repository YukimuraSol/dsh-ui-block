/**
 * dsh-ui-block — page block (client half).
 *
 * The ONE trigger (2026-10-24) is a message LINE OF ITS OWN that references a
 * file in the user-level ui-blocks directory:
 *
 *   ::dsh-ui login-modal::
 *   ::dsh-ui login-modal res=820x510::
 *
 * That line is the whole trigger. The line itself is hidden and a canvas is
 * rendered in its place, right after it. The HTML comes from the FILE, fetched
 * from the host route /ui-blocks/<name>.uiblock, and rendered in the canvas
 * built for it (resolution menu, picker, zoom toward the cursor, free pan,
 * draggable height all unchanged).
 *
 * The chrome IS a code block (2026-10-24, user call: "就像之前的写法效果一样"):
 * the seat mounts the REAL CodeBlock component the chat renders for fences
 * (require('@deepseek-ai/dsh-client-ui-primitives')), so the frame, the banner,
 * the language label, the copy button and its tooltip are the same component,
 * not a copy of its look. The fence body is the block's PATH — the built-in
 * copy button therefore copies ui-blocks/<name>.uiblock — and the <pre> is
 * display:none, so the canvas sits in the code block's body slot. Our own bar
 * is gone; the resolution button and the picker icon join the banner's actions.
 *
 * The line must be ALONE: any other text on it, a backtick, or a fence makes it
 * a non-trigger, and it stays plain text. Nothing inside a code block is read at
 * all, so the retired spelling (a fence whose BODY FIRST LINE was
 * 'dsh-ui ref: ui-blocks/<name>.uiblock') can only ever be a plain code block —
 * there is no code path left for it.
 *
 * v2 — the block is a MAP VIEWPORT (a window onto the canvas), three
 * independent states:
 *   - canvas resolution (the iframe logical size): the bar's control, changing
 *     it reflows the draft — untouched from v1;
 *   - zoom: a plain wheel over the canvas zooms TOWARD THE CURSOR, transform
 *     only, never reflows, clamped 20%-400%; double-click resets (fit width
 *     once). No zoom control and no percentage anywhere in the bar;
 *   - viewport height: the outer frame is a WINDOW with an explicit height
 *     (default min(canvas height x initial fit, 480px)), draggable from the
 *     bottom-edge handle (double-click resets). The bar never shows the height.
 *   Native scrollbars are gone — panning is a free drag; the canvas rests
 *   wherever it is left.
 *
 * The canvas resolution is the line's res= when it declares one, else
 * DEFAULT_RES (1440x900) — the same default the host's read_ui_block screenshots
 * at, so the model sees the picture the user sees.
 *
 * Sandbox: allow-same-origin ONLY, never allow-scripts (both together disable the
 * sandbox). The draft stays script-inert and its CSP still blocks external loads,
 * but the parent can read the frame's DOM — which is what the canvas picker needs.
 */
window.__ModuleLoader__.load({
  id: 'dsh-ui-block',
  factory(require) {
    var DEFAULT_RES = { w: 1440, h: 900 };
    var PRESETS = [
      { label: '桌面 1440×900', w: 1440, h: 900 },
      { label: '桌面 1280×720', w: 1280, h: 720 },
      { label: '平板 834×1112', w: 834, h: 1112 },
      { label: '手机 390×844', w: 390, h: 844 }
    ];
    var MIN_RES = 200;
    var MAX_RES = 6000;
    var ZOOM_MIN = 0.2;
    var ZOOM_MAX = 4;
    var WHEEL_STEP = 1.1;
    var MIN_VIEW_H = 120;
    var FALLBACK_VIEW_H = 480;
    var MAX_META_VIEW_H = 4000;
    /** Banner language label: the directive spelling itself (user call). */
    var LANG_LABEL = 'dsh-ui';
    /** The copy button copies the block's PATH, so say that, not "copy code". */
    var COPY_LABEL = '复制路径';
    var COPIED_LABEL = '已复制';
    /** Stable header node of a code block (documented consumer point). */
    var BANNER_SELECTOR = '[data-code-block-banner]';
    // The shell IS the chat's own code block (user call 2026-10-24: "就像之前的
    // 写法效果一样"), so it is the real component — the same module the message's
    // fences render through — not a lookalike. Resolved once, never re-required.
    var react = null;
    var reactDomClient = null;
    var primitives = null;
    try { react = require('react'); } catch (e) { react = null; }
    try { reactDomClient = require('react-dom/client'); } catch (e) { reactDomClient = null; }
    try { primitives = require('@deepseek-ai/dsh-client-ui-primitives'); } catch (e) { primitives = null; }
    var HAS_CODE_BLOCK = !!(react && reactDomClient && primitives && primitives.CodeBlock);

    // [directive-parsers] — pure string/number helpers only; this region is
    // lifted verbatim into a sandbox by self-check-uiblock-directive.mjs, so it
    // must not touch the DOM or any install()-scoped state.
    /**
     * The ONE trigger (2026-10-24): a whole line, on its own, naming a file in
     * the ui-blocks directory. Both spellings below are the SAME directive:
     *
     *   ::dsh-ui login-modal::
     *   ::dsh-ui login-modal res=820x510::
     *
     * Nothing else may sit on the line (leading/trailing whitespace aside), and a
     * backtick or a fence is not in the pattern, so such a line stays plain text.
     */
    var DIRECTIVE_RE = /^[ \t]*::dsh-ui[ \t]+([A-Za-z0-9._-]+)(?:[ \t]+res=(\d{2,5})x(\d{2,5}))?[ \t]*::[ \t]*$/;
    /** Longest a reference line can be; the sweep rejects anything longer first. */
    var DIRECTIVE_MAX = 110;
    /**
     * Parse ONE whole line. Returns { name, res } where res is {w,h} or null (the
     * line declared no size), or null when the line is not a reference at all.
     *
     * An ILL-FORMED size (res=axb, res=0x0) fails the pattern, so the WHOLE line
     * is rejected and keeps its text: a half-understood line never silently
     * renders at a geometry its author did not write. A well-formed but silly one
     * (res=10x10) is clamped by clampRes, exactly like the canvas control does.
     */
    function parseDirectiveLine(line) {
      var match = DIRECTIVE_RE.exec(String(line == null ? '' : line));
      if (!match) return null;
      var name = match[1];
      if (name.length > 64 || name.indexOf('..') >= 0) return null;
      return {
        name: name,
        res: match[2] === undefined ? null : clampRes(parseInt(match[2], 10), parseInt(match[3], 10))
      };
    }
    /** The block file a reference names, relative to the app root. */
    function directivePath(name) {
      return 'ui-blocks/' + name + '.uiblock';
    }
    /** Canvas geometry for a reference: its res= when declared, else the default. */
    function directiveRes(directive) {
      return directive.res || { w: DEFAULT_RES.w, h: DEFAULT_RES.h };
    }
    function clampRes(w, h) {
      var cw = Math.min(MAX_RES, Math.max(MIN_RES, Math.round(w)));
      var ch = Math.min(MAX_RES, Math.max(MIN_RES, Math.round(h)));
      return { w: isFinite(cw) ? cw : DEFAULT_RES.w, h: isFinite(ch) ? ch : DEFAULT_RES.h };
    }
    /**
     * Viewport height (the outer frame, NOT the canvas). A reference line has no
     * h= clause any more — the drag handle owns the height — so this always
     * answers "not declared" and the caller derives
     * min(canvas height x initial fit zoom, FALLBACK_VIEW_H).
     */
    function readViewH(meta) {
      if (!meta || meta.h === undefined) return { h: null, declared: false };
      var m = /^(\d{1,5})(px)?$/i.exec(String(meta.h).trim());
      if (!m) return { h: null, declared: false };
      var n = parseInt(m[1], 10);
      if (!(n > 0)) return { h: null, declared: false };
      return { h: Math.min(MAX_META_VIEW_H, Math.max(MIN_VIEW_H, n)), declared: true };
    }
    function formatRes(res) { return res.w + '×' + res.h; }
    // [/directive-parsers]

    function readScheme() {
      var scheme = '';
      try { scheme = (getComputedStyle(document.body).colorScheme || '').toLowerCase(); } catch (e) { scheme = ''; }
      if (scheme.indexOf('dark') >= 0) return 'dark';
      if (scheme.indexOf('light') >= 0) return 'light';
      try { return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'; } catch (e) { return 'light'; }
    }
    function readTokens() {
      var pairs = [];
      var seen = {};
      // body FIRST: custom properties are inherited, so the nearest scoped
      // declaration is the value descendants actually use. The :root (skin)
      // values must not shadow a body-level theme override, or the block would
      // paint a different colour than the app around it.
      var scopes = [document.body, document.documentElement];
      for (var s = 0; s < scopes.length; s += 1) {
        var cs = null;
        try { cs = getComputedStyle(scopes[s]); } catch (e) { continue; }
        if (!cs) continue;
        for (var i = 0; i < cs.length; i += 1) {
          var name = cs[i];
          if (name.indexOf('--dsw-') !== 0 && name.indexOf('--dsh-') !== 0) continue;
          if (seen[name]) continue;
          var value = cs.getPropertyValue(name).trim();
          if (!value) continue;
          seen[name] = 1;
          pairs.push(name + ':' + value + ';');
        }
      }
      pairs.sort();
      return { css: pairs.join(''), count: pairs.length, scheme: readScheme() };
    }
    /** Cheap stable hash of the token sheet; length alone cannot tell light from dark. */
    function hashString(text) {
      var hash = 5381;
      for (var i = 0; i < text.length; i += 1) hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
      return (hash >>> 0).toString(36);
    }
    function tokensKeyNow(cache) {
      return cache.count + ':' + cache.scheme + ':' + hashString(cache.css);
    }

    var BASE_CSS = [
      '*{box-sizing:border-box}',
      'html,body{margin:0;padding:0;width:100%;min-height:100%}',
      'body{background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);',
      'font-family:var(--dsw-font-family);font-size:14px;line-height:1.5;-webkit-font-smoothing:antialiased}',
      'a[href^="http"],a[href^="//"]{pointer-events:none}',
      'img{max-width:100%}',
      'input,select,textarea,button{font:inherit;color:inherit}',
      '.pb{display:flex;gap:14px;width:100%;min-height:100%;padding:18px}',
      '.pb-center{align-items:center;justify-content:center}',
      '.pb-card{background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l1);',
      'border-radius:12px;box-shadow:var(--dsw-shadow-lv2);padding:20px;min-width:280px;max-width:420px}',
      '.pb-title{margin:0 0 4px;font-size:16px;font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.pb-sub{margin:0 0 16px;font-size:13px;color:var(--dsw-alias-label-secondary)}',
      '.pb-row{display:flex;gap:8px;align-items:center}',
      '.pb-row-end{justify-content:flex-end}',
      '.pb-btn{appearance:none;border:.5px solid var(--dsw-alias-border-l1);border-radius:8px;padding:7px 14px;',
      'background:var(--dsw-alias-button-elevated-fill);color:var(--dsw-alias-label-primary);cursor:pointer}',
      '.pb-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.pb-btn-primary{background:var(--dsw-alias-button-primary-fill);border-color:transparent;',
      'color:var(--dsw-alias-label-primary-foreground)}',
      '.pb-btn-primary:hover{background:var(--dsw-alias-button-primary-hover)}',
      '.pb-field{display:flex;flex-direction:column;gap:6px;margin-bottom:12px}',
      '.pb-label{font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.pb-input{border:.5px solid var(--dsw-alias-border-l1);border-radius:8px;padding:8px 10px;',
      'background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);outline:none;width:100%}',
      '.pb-input:focus{border-color:var(--dsw-alias-brand-primary)}',
      '.pb-mask{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:var(--dsw-alias-bg-mask-1)}'
    ].join('');

    var CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data:; form-action 'none'; base-uri 'none'";

    function buildSrcdoc(state, tokens) {
      var head = '<!doctype html><html><head><meta charset="utf-8">' +
        '<meta http-equiv="Content-Security-Policy" content="' + CSP + '">' +
        '<style>:root{' + tokens.css + '}html{color-scheme:' + tokens.scheme + '}' + BASE_CSS + '</style>' +
        '</head><body>';
      return head + state.body + '</body></html>';
    }

    var CLIENT_CSS = [
      // The seat is a MOVER, not a frame (2026-10-24): the canvas frame, banner,
      // radius and background all come from the real CodeBlock component mounted
      // inside it, so this wrapper must paint nothing of its own or the block
      // would double every edge. Zero margin: the code block brings its own 16px.
      '.dshpb-seat{margin:0}',
      // The code block's body is the block's PATH (what the copy button copies);
      // the canvas takes that slot, so the <pre> stays in the DOM but paints
      // nothing. Scoped to our own marker class: plain fences are untouched.
      '.md-code-block.dshpb-active>[data-code-block-content]>pre{display:none!important}',
      // Body insets are the card arm's own pre insets (6px 22px 20px), and the
      // background/bottom radii come from the code-block variables, so the canvas
      // sits in the body exactly as text would.
      '.dshpb-host{display:block;overflow:hidden;padding:6px 22px 20px;',
      'background:var(--dsl-code-block-background,transparent);',
      'border-bottom-left-radius:var(--dsl-code-block-border-radius,12px);',
      'border-bottom-right-radius:var(--dsl-code-block-border-radius,12px)}',
      '.dshpb-shell{position:relative;overflow:hidden;border-radius:6px;background:var(--dsw-alias-bg-base);',
      'cursor:grab;touch-action:none;user-select:none;-webkit-user-select:none}',
      '.dshpb-shell.dshpb-grabbing{cursor:grabbing}',
      '.dshpb-frame{display:block;border:0;transform-origin:top left;background:var(--dsw-alias-bg-base);',
      'pointer-events:none;box-shadow:0 0 0 .5px var(--dsw-alias-border-l1)}',
      '.dshpb-handle{position:absolute;left:0;right:0;bottom:0;height:7px;cursor:ns-resize;z-index:3;touch-action:none}',
      '.dshpb-handle::after{content:"";position:absolute;left:50%;top:2px;width:36px;height:3px;margin-left:-18px;',
      'border-radius:2px;background:var(--dsw-alias-border-l1);opacity:0;transition:opacity .15s}',
      '.dshpb-shell:hover .dshpb-handle::after{opacity:.85}',
      '.dshpb-ctl{display:inline-flex;align-items:center;gap:6px;margin-left:8px;flex:none}',
      '.dshpb-btn{font:inherit;font-size:11px;line-height:18px;color:var(--dsw-alias-label-secondary);background:transparent;',
      'border:.5px solid var(--dsw-alias-border-l1);border-radius:6px;padding:1px 7px;cursor:pointer;white-space:nowrap}',
      '.dshpb-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.dshpb-note{font-size:11px;line-height:18px;color:var(--dsw-alias-label-caption);white-space:nowrap}',
      '.dshpb-menu{position:fixed;z-index:9999;min-width:190px;padding:6px;border-radius:10px;',
      'background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l1);box-shadow:var(--dsw-shadow-lv3);',
      'color:var(--dsw-alias-label-primary);font:var(--dsw-font-xxs-12)}',
      '.dshpb-menu-title{padding:4px 8px;color:var(--dsw-alias-label-caption)}',
      '.dshpb-item{display:flex;justify-content:space-between;gap:12px;width:100%;text-align:left;background:transparent;border:0;',
      'border-radius:6px;padding:5px 8px;color:inherit;font:inherit;cursor:pointer}',
      '.dshpb-item:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dshpb-item-on{color:var(--dsw-alias-brand-primary)}',
      '.dshpb-custom{display:flex;gap:6px;align-items:center;padding:6px 8px}',
      '.dshpb-custom input{width:66px;font:inherit;background:var(--dsw-alias-bg-layer-2);color:inherit;',
      'border:.5px solid var(--dsw-alias-border-l1);border-radius:6px;padding:3px 6px}',
      '.dshpb-toast{position:fixed;z-index:10000;bottom:28px;left:50%;transform:translateX(-50%);padding:8px 14px;border-radius:10px;',
      'background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l1);box-shadow:var(--dsw-shadow-lv3);',
      'color:var(--dsw-alias-label-primary);font:var(--dsw-font-xxs-12)}',
      // Canvas picker (2026-10-10). The lit state paints the ROUNDED BORDER and the
      // ICON STROKE in #22d3ee and nothing else — no fill. #22d3ee is written as a
      // literal on purpose: --dsw-alias-brand-primary resolves to a neutral-bluish
      // token that reads near-white on the dark theme.
      '.dshpb-pick{padding:1px 5px;line-height:0;border-color:var(--dsw-alias-border-l2)}',
      '.dshpb-pick svg{display:block;width:13px;height:13px;overflow:visible}',
      '.dshpb-pick path{fill:none;stroke:var(--dsw-alias-label-secondary);stroke-width:1.3;',
      'stroke-linecap:round;stroke-linejoin:round}',
      '.dshpb-pick-on{border-color:#22d3ee;background:transparent}',
      '.dshpb-pick-on path{stroke:#22d3ee;stroke-width:1.5}',
      '.dshpb-pickbox{position:fixed;z-index:2147483000;pointer-events:none;display:none;',
      'border:2px solid #4d6bfe;background:rgba(77,107,254,.12)}',
      // Delayed hover hint (2026-10-10). The native title tooltip has no
      // controllable delay, so the pick icon carries its own one-line tip.
      '.dshpb-pick-tip{position:fixed;z-index:2147483001;display:none;pointer-events:none;',
      'max-width:280px;padding:5px 9px;border-radius:8px;background:var(--dsw-alias-bg-layer-1);',
      'border:.5px solid var(--dsw-alias-border-l1);box-shadow:var(--dsw-shadow-lv3);',
      'color:var(--dsw-alias-label-primary);font:var(--dsw-font-xxs-12);white-space:nowrap}'
    ].join('');

    // ── canvas picker (2026-10-10) ─────────────────────────────────────────────
    // Picking belongs to ONE block at a time: arming a second block disarms the
    // first, so two page blocks on one screen can never fight over the pointer.
    // Everything here runs in the PARENT page; the frame only lends its document
    // (same-origin, see the sandbox value) and its geometry.
    var PICK_MAX_ATTRS = 8;
    var PICK_MAX_TEXT = 80;
    var PICK_TOKEN_OPEN = 'element\u00ab';
    var PICK_TOKEN_CLOSE = '\u00bb';
    /** Reuses dsh-element-chip's registered source so its chip rendering/serialization apply. */
    var PICK_SOURCE = 'element';
    var armedPick = null; // the state whose picker currently owns the pointer

    /** `#id` when there is one, else up to 4 levels of tag.class:nth-of-type. */
    function pickSelector(element) {
      if (element.id) return '#' + CSS.escape(element.id);
      var parts = [];
      var current = element;
      while (current && parts.length < 4) {
        var part = current.tagName.toLowerCase();
        var classes = [];
        for (var i = 0; i < current.classList.length && classes.length < 2; i += 1) classes.push(CSS.escape(current.classList[i]));
        if (classes.length) part += '.' + classes.join('.');
        var sameTag = [];
        if (current.parentElement) {
          var kids = current.parentElement.children;
          for (var j = 0; j < kids.length; j += 1) if (kids[j].tagName === current.tagName) sameTag.push(kids[j]);
        }
        if (sameTag.length > 1) part += ':nth-of-type(' + (sameTag.indexOf(current) + 1) + ')';
        parts.unshift(part);
        current = current.parentElement;
      }
      return parts.join(' > ');
    }
    /** «/»/backslash escaped, so the first bare closing guillemet always ends the token. */
    function pickEscape(text) {
      return String(text).replace(/\\/g, '\\\\').replace(/«/g, '\\u00ab').replace(/»/g, '\\u00bb');
    }
    /** Own attributes only (<=8, then "+N more"), own text only (<=80 chars). */
    function pickHtmlElement(element) {
      var attrs = element.attributes;
      var parts = [];
      for (var i = 0; i < attrs.length && i < PICK_MAX_ATTRS; i += 1) {
        parts.push(attrs[i].name + '="' + String(attrs[i].value).replace(/"/g, '\\"') + '"');
      }
      if (attrs.length > PICK_MAX_ATTRS) parts.push('...+' + (attrs.length - PICK_MAX_ATTRS) + ' more');
      var tag = element.tagName.toLowerCase();
      var text = String(element.textContent || '').trim().replace(/\s+/g, ' ');
      return '<' + tag + (parts.length ? ' ' + parts.join(' ') : '') + '>' +
        (text.length > PICK_MAX_TEXT ? text.slice(0, PICK_MAX_TEXT) + '…' : text) + '</' + tag + '>';
    }
    /**
     * The composer token: exactly three lines, same shape as the browser picker's
     * (attribute/text caps included). Position is in the canvas' OWN coordinate
     * system — the frame's logical viewport — which is the space res= declares.
     */
    function pickToken(element) {
      var rect = element.getBoundingClientRect();
      var lines = [
        'DOM Path: ' + pickSelector(element),
        'Position: top=' + Math.round(rect.top) + 'px, left=' + Math.round(rect.left) +
          'px, width=' + Math.round(rect.width) + 'px, height=' + Math.round(rect.height) + 'px',
        'HTML Element: ' + pickHtmlElement(element)
      ];
      return PICK_TOKEN_OPEN + pickEscape(lines.join('\n')) + PICK_TOKEN_CLOSE;
    }
    /**
     * Every element under a point, topmost first. Chrome omits pointer-events:none
     * subtrees from elementsFromPoint, so ancestors are appended as a safety net
     * (same net the browser picker casts).
     */
    function pickStackAt(doc, x, y) {
      var list = [];
      try { list = doc.elementsFromPoint(x, y); } catch (e) { list = []; }
      var kept = [];
      for (var i = 0; i < list.length; i += 1) if (list[i] && list[i].nodeType === 1) kept.push(list[i]);
      var current = kept.length ? kept[kept.length - 1] : null;
      while (current && current.parentElement) {
        current = current.parentElement;
        if (kept.indexOf(current) < 0) kept.push(current);
      }
      return kept;
    }

    var stats = { blocks: 0, converted: 0, tokenCount: 0, refWait: 0, lastRefError: null };
    /** How often a mounted block re-reads its file, so an edit shows up live. */
    var REF_TTL = 1500;

    function install(ctx) {
      var states = new WeakMap();
      var live = [];
      var tokenCache = { css: '', count: 0, scheme: '' };
      var styleTag = null;
      var menu = null;
      var toast = null;
      var sweepScheduled = false;
      // ui-blocks files, keyed by the ref path in the message. text === null means
      // "asked for, not back yet"; fetchedAt drives the TTL re-read that makes an
      // edit to the file show up without a reload.
      var refCache = {};

      styleTag = document.createElement('style');
      styleTag.setAttribute('data-plugin-css', 'dsh-ui-block');
      styleTag.textContent = CLIENT_CSS;
      document.head.appendChild(styleTag);

      // Headless seat (renders null) that hands the picker its sessionId and the
      // revision-guarded insertion span. A DIFFERENT id from dsh-element-chip's seat:
      // conversation.input.overlay is an additive list, so both coexist.
      // The seat is registered lazily from sweep(): ctx.get (not ctx.slots) so a
      // missing service can never park the block, and a retry so a late-arriving
      // slots service still gets the seat instead of silently losing picking.
      function ensurePickSeat() {
        if (seatTried && !seatDispose) return; // one warning is enough
        if (seatDispose) return;
        var pickSlots = ctx && typeof ctx.get === 'function' ? ctx.get('slots') : undefined;
        if (!pickSlots || typeof pickSlots.inject !== 'function') { seatTried = true; return; }
        try {
          seatDispose = pickSlots.inject('conversation.input.overlay', function () {
            return pickSlots.register({
              name: 'conversation.input.overlay',
              id: 'dsh-ui-block-picker',
              order: 6
            }, PageBlockPickSeat);
          });
        } catch (e) {
          seatTried = true;
          try { console.warn('[dsh-ui-block] picker seat unavailable; canvas picking will report 插入失败:', e); } catch (e2) { /* diagnostics never break the block */ }
        }
      }

      function showToast(text) {
        if (!toast) {
          toast = document.createElement('div');
          toast.className = 'dshpb-toast';
          toast.setAttribute('role', 'status');
          document.body.appendChild(toast);
        }
        toast.textContent = text;
        toast.style.display = 'block';
        window.clearTimeout(showToast.timer);
        showToast.timer = window.setTimeout(function () { if (toast) toast.style.display = 'none'; }, 2200);
      }
      function closeMenu() {
        if (menu && menu.parentNode) menu.parentNode.removeChild(menu);
        menu = null;
      }
      function openMenu(anchor, build) {
        closeMenu();
        menu = document.createElement('div');
        menu.className = 'dshpb-menu';
        build(menu);
        document.body.appendChild(menu);
        var rect = anchor.getBoundingClientRect();
        var left = Math.min(window.innerWidth - menu.offsetWidth - 8, Math.max(8, rect.right - menu.offsetWidth));
        var top = rect.bottom + 6;
        if (top + menu.offsetHeight > window.innerHeight - 8) top = Math.max(8, rect.top - menu.offsetHeight - 6);
        menu.style.left = left + 'px';
        menu.style.top = top + 'px';
      }
      function menuItem(parent, label, hint, on, onClick) {
        var button = document.createElement('button');
        button.type = 'button';
        button.className = 'dshpb-item' + (on ? ' dshpb-item-on' : '');
        var name = document.createElement('span');
        name.textContent = label;
        button.appendChild(name);
        if (hint) {
          var tail = document.createElement('span');
          tail.className = 'dshpb-note';
          tail.textContent = hint;
          button.appendChild(tail);
        }
        button.addEventListener('click', function (event) {
          event.preventDefault();
          event.stopPropagation();
          onClick();
        });
        parent.appendChild(button);
        return button;
      }
      function usableWidth(state) {
        var host = state.host;
        var width = host ? host.clientWidth : 0;
        if (host) {
          var cs = getComputedStyle(host);
          width -= (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
        }
        if (!width || width < 40) {
          var rootWidth = state.root && state.root.getBoundingClientRect ? state.root.getBoundingClientRect().width : 0;
          width = rootWidth ? rootWidth - 44 : 700;
        }
        return width;
      }
      function fitZoom(state) {
        var zoom = usableWidth(state) / state.res.w;
        if (!isFinite(zoom) || zoom <= 0) zoom = 1;
        return Math.min(1, Math.max(0.05, Math.round(zoom * 1000) / 1000));
      }
      /** Undeclared/invalid h=: min(canvas height x initial fit zoom, 480px). */
      function defaultViewH(state) {
        return Math.min(FALLBACK_VIEW_H, Math.max(MIN_VIEW_H, Math.round(state.res.h * fitZoom(state))));
      }
      /** Back to the model's default height (meta h= or the fallback). */
      function resetViewH(state) {
        var vh = readViewH(state.meta);
        state.hDeclared = vh.declared;
        state.userViewH = false;
        state.viewH = vh.declared ? vh.h : null;
      }
      function applySize(state) {
        // autoFit is the "reset view" state: fit width once, recentered. Any
        // user gesture (wheel/drag) turns it off; double-click turns it back on.
        if (state.autoFit) {
          state.zoom = fitZoom(state);
          state.offset = null;
        }
        // No user gesture, no cached height: the frame follows whatever res= the
        // ref line currently declares (a streamed res= outranks the 1440x900
        // default the first frame created). meta h= still wins when declared.
        if (!state.userViewH) {
          var vh = readViewH(state.meta);
          state.viewH = vh.declared ? vh.h : defaultViewH(state);
        }
        var zoom = state.zoom;
        var canvasW = state.res.w * zoom;
        var canvasH = state.res.h * zoom;
        var winW = state.shell.clientWidth || usableWidth(state);
        var winH = state.viewH;
        var offset = state.offset;
        var x = offset ? offset.x : (winW - canvasW) / 2;
        var y = offset ? offset.y : (canvasH > winH ? 0 : (winH - canvasH) / 2);
        // Free placement (user call): the canvas rests wherever it was
        // dragged, in both axes, even fully off the window. Initial position
        // and the double-click reset are the only things that recentre it.
        state.offset = { x: x, y: y };
        state.shell.style.height = winH + 'px';
        // The canvas resolution is the iframe's real CSS viewport, so media
        // queries re-evaluate against it. Zoom/pan/height never touch these
        // two properties — that is what keeps zooming reflow-free.
        state.frame.style.width = state.res.w + 'px';
        state.frame.style.height = state.res.h + 'px';
        state.frame.style.transform = 'translate(' + x + 'px,' + y + 'px) scale(' + zoom + ')';
        updateControls(state);
      }
      function paint(state) {
        var key = state.res.w + 'x' + state.res.h + '|' + state.tokensKey + '|' + state.body;
        if (state.paintedKey === key) return;
        state.paintedKey = key;
        state.frame.setAttribute('width', String(state.res.w));
        state.frame.setAttribute('height', String(state.res.h));
        state.frame.setAttribute('srcdoc', buildSrcdoc(state, tokenCache));
      }
      function relayout(state) {
        applySize(state);
        paint(state);
      }
      function updateControls(state) {
        if (!state.controls) return;
        state.resButton.textContent = formatRes(state.res);
        if (state.note) state.note.style.display = state.declared ? 'none' : '';
      }
      function openResMenu(state) {
        openMenu(state.resButton, function (parent) {
          var title = document.createElement('div');
          title.className = 'dshpb-menu-title';
          title.textContent = '画布分辨率（重排内容）';
          parent.appendChild(title);
          PRESETS.forEach(function (preset) {
            menuItem(parent, preset.label, null, preset.w === state.res.w && preset.h === state.res.h, function () {
              state.res = { w: preset.w, h: preset.h };
              state.declared = true;
              closeMenu();
              relayout(state);
              showToast('画布分辨率 ' + formatRes(state.res));
            });
          });
          var custom = document.createElement('div');
          custom.className = 'dshpb-custom';
          var wInput = document.createElement('input');
          wInput.type = 'number';
          wInput.value = String(state.res.w);
          wInput.setAttribute('aria-label', '宽');
          var times = document.createElement('span');
          times.textContent = '×';
          var hInput = document.createElement('input');
          hInput.type = 'number';
          hInput.value = String(state.res.h);
          hInput.setAttribute('aria-label', '高');
          var go = document.createElement('button');
          go.type = 'button';
          go.className = 'dshpb-btn';
          go.textContent = '应用';
          go.addEventListener('click', function (event) {
            event.preventDefault();
            event.stopPropagation();
            var w = parseInt(wInput.value, 10);
            var h = parseInt(hInput.value, 10);
            if (!(w > 0 && h > 0)) { showToast('宽高要填正整数'); return; }
            state.res = clampRes(w, h);
            state.declared = true;
            closeMenu();
            relayout(state);
            showToast('画布分辨率 ' + formatRes(state.res));
          });
          custom.appendChild(wInput);
          custom.appendChild(times);
          custom.appendChild(hInput);
          custom.appendChild(go);
          parent.appendChild(custom);
        });
      }
      function buildControls(state) {
        if (state.controls && state.controls.isConnected) return;
        var header = state.header;
        // The banner arrives one commit after the seat (the code block is React);
        // adoptCodeBlock calls back in here the moment it exists.
        if (!header) return;
        var slot = header.lastElementChild && header.querySelector('button') ? header.lastElementChild : header;
        // The shell's wrap toggle is a no-op here (content is a scriptless
        // iframe) — drop it from page-block banners (user call, v0.2.3).
        // aria-pressed is unique to the wrap button; copy has none.
        var stale = header.querySelectorAll('button[aria-pressed]');
        for (var i = 0; i < stale.length; i++) stale[i].remove();
        var controls = document.createElement('span');
        controls.className = 'dshpb-ctl';
        var resButton = document.createElement('button');
        resButton.type = 'button';
        resButton.className = 'dshpb-btn';
        resButton.title = '画布分辨率（点开可改，含自定义 W×H）';
        resButton.addEventListener('click', function (event) { event.preventDefault(); event.stopPropagation(); openResMenu(state); });
        // Canvas picker toggle. Icon only (13x13), sitting to the RIGHT of the
        // resolution button; the lit state is the border + stroke in #22d3ee.
        var pickButton = document.createElement('button');
        pickButton.type = 'button';
        pickButton.className = 'dshpb-btn dshpb-pick';
        // No title attribute on purpose: the native tooltip's delay is not
        // controllable and would double up with the delayed hint below.
        pickButton.setAttribute('aria-pressed', 'false');
        pickButton.setAttribute('aria-label', '在画布内选取元素');
        pickButton.innerHTML = '<svg viewBox="0 0 13 13" aria-hidden="true"><path d="M2.5 2.5l5 11 1.8-4.2 4.2-1.8z"/></svg>';
        pickButton.addEventListener('mouseenter', function () { schedulePickTip(pickButton); });
        pickButton.addEventListener('mouseleave', cancelPickTip);
        pickButton.addEventListener('blur', cancelPickTip);
        pickButton.addEventListener('click', function (event) {
          event.preventDefault();
          event.stopPropagation();
          cancelPickTip();
          armPick(state);
        });
        var note = document.createElement('span');
        note.className = 'dshpb-note';
        note.textContent = '未声明，使用默认';
        controls.appendChild(resButton);
        controls.appendChild(pickButton);
        if (!state.declared || !state.hDeclared) controls.appendChild(note);
        if (slot === header) slot.appendChild(controls);
        else slot.insertBefore(controls, slot.firstChild);
        state.controls = controls;
        state.resButton = resButton;
        state.pickButton = pickButton;
        state.note = note;
        // A rebuilt banner must not silently un-light an armed picker.
        if (state.pick) {
          pickButton.classList.add('dshpb-pick-on');
          pickButton.setAttribute('aria-pressed', 'true');
        }
        updateControls(state);
      }

      // Map-viewport gestures. The iframe itself is pointer-events:none, so
      // the plugin-owned shell takes every pointer event aimed at the canvas.
      // ponytail: the drafts are static (sandbox has no scripts), so swallowing
      // clicks is safe; when a real interactive canvas lands (phase L) this
      // layer must forward clicks through instead.
      function attachInteractions(state) {
        var shell = state.shell;
        shell.addEventListener('wheel', function (event) {
          if (!event.deltaY || !state.offset) return;
          event.preventDefault();
          var rect = shell.getBoundingClientRect();
          var cx = event.clientX - rect.left;
          var cy = event.clientY - rect.top;
          var zoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, state.zoom * (event.deltaY < 0 ? WHEEL_STEP : 1 / WHEEL_STEP)));
          if (!(zoom > 0) || zoom === state.zoom) return;
          // Zoom toward the cursor: keep the canvas point under the cursor
          // fixed — newOffset = cursor - (cursor - offset) * (newZ / oldZ).
          state.offset = {
            x: cx - (cx - state.offset.x) * (zoom / state.zoom),
            y: cy - (cy - state.offset.y) * (zoom / state.zoom)
          };
          state.autoFit = false;
          state.zoom = zoom;
          applySize(state);
        }, { passive: false });
        // move/up live on window: the gesture survives the cursor leaving the
        // shell AND a failed setPointerCapture (chat-shell floating widgets can
        // sit above the canvas edge). Handlers no-op unless a drag is active.
        shell.addEventListener('pointerdown', function (event) {
          if (event.button !== 0 || state.resizing) return;
          state.drag = { id: event.pointerId, x: event.clientX, y: event.clientY, ox: state.offset.x, oy: state.offset.y, moved: false };
          shell.classList.add('dshpb-grabbing');
        });
        state.onPanMove = function (event) {
          if (!state.drag || event.pointerId !== state.drag.id) return;
          var dx = event.clientX - state.drag.x;
          var dy = event.clientY - state.drag.y;
          if (!state.drag.moved && Math.abs(dx) + Math.abs(dy) > 2) { state.drag.moved = true; state.autoFit = false; }
          if (state.drag.moved) {
            state.offset = { x: state.drag.ox + dx, y: state.drag.oy + dy };
            applySize(state);
          }
        };
        state.onPanEnd = function (event) {
          if (!state.drag || event.pointerId !== state.drag.id) return;
          state.drag = null;
          shell.classList.remove('dshpb-grabbing');
        };
        window.addEventListener('pointermove', state.onPanMove);
        window.addEventListener('pointerup', state.onPanEnd);
        window.addEventListener('pointercancel', state.onPanEnd);
        shell.addEventListener('dblclick', function () {
          // Reset the view: fit-width once, recentered.
          state.autoFit = true;
          applySize(state);
        });
        var handle = state.handle;
        handle.addEventListener('pointerdown', function (event) {
          if (event.button !== 0) return;
          event.preventDefault();
          event.stopPropagation();
          state.resizing = { id: event.pointerId, y: event.clientY, h: state.viewH };
        });
        state.onResizeMove = function (event) {
          if (!state.resizing || event.pointerId !== state.resizing.id) return;
          var next = state.resizing.h + (event.clientY - state.resizing.y);
          // A pulled handle locks the height: applySize stops re-deriving it from
          // the canvas until the handle is double-clicked back to auto.
          state.userViewH = true;
          state.viewH = Math.max(MIN_VIEW_H, Math.min(window.innerHeight, next));
          state.hDeclared = true;
          applySize(state);
        };
        state.onResizeEnd = function (event) {
          if (!state.resizing || event.pointerId !== state.resizing.id) return;
          state.resizing = null;
        };
        window.addEventListener('pointermove', state.onResizeMove);
        window.addEventListener('pointerup', state.onResizeEnd);
        window.addEventListener('pointercancel', state.onResizeEnd);
        handle.addEventListener('dblclick', function (event) {
          event.stopPropagation(); // handle reset is height, not the canvas view
          resetViewH(state);
          applySize(state);
        });
      }

      // ── canvas picker runtime (2026-10-10) ───────────────────────────────
      // One block owns the pointer at a time (armedPick). The highlight box is a
      // fixed-position node in the PARENT page: the frame's own rect gives the
      // viewport origin, and state.zoom scales the element's canvas rect onto it.
      // The picker only ever ends by clicking the icon again — Enter and Escape are
      // deliberately NOT bound, so the mode never eats a key the page may want.
      var pickBox = null;
      var pickTip = null;
      var pickTipTimer = 0;
      var seatRef = { sessionId: null, actions: null };
      var seatDispose = null;
      var seatTried = false;

      function pickBoxNode() {
        if (!pickBox || !pickBox.parentNode) {
          pickBox = document.createElement('div');
          pickBox.className = 'dshpb-pickbox';
          pickBox.setAttribute('data-dshpb-pickbox', 'true');
          document.body.appendChild(pickBox);
        }
        return pickBox;
      }
      function hidePickBox() { if (pickBox) pickBox.style.display = 'none'; }

      // The pick icon's own hint: 3s of dwell, one line, no toast, no popup.
      var PICK_TIP_TEXT = '点元素插入到输入框 · 滚轮切层 · 方向键导航 · 再点退出';
      function cancelPickTip() {
        window.clearTimeout(pickTipTimer);
        pickTipTimer = 0;
        if (pickTip) pickTip.style.display = 'none';
      }
      function showPickTip(button) {
        if (!pickTip || !pickTip.parentNode) {
          pickTip = document.createElement('div');
          pickTip.className = 'dshpb-pick-tip';
          pickTip.setAttribute('role', 'tooltip');
          document.body.appendChild(pickTip);
        }
        pickTip.textContent = PICK_TIP_TEXT;
        var rect = button.getBoundingClientRect();
        pickTip.style.display = 'block';
        var below = rect.bottom + 6;
        var top = below + pickTip.offsetHeight > window.innerHeight - 8
          ? Math.max(8, rect.top - pickTip.offsetHeight - 6) : below;
        pickTip.style.left = Math.max(8, Math.round(rect.right - pickTip.offsetWidth)) + 'px';
        pickTip.style.top = Math.round(top) + 'px';
      }
      function schedulePickTip(button) {
        cancelPickTip();
        pickTipTimer = window.setTimeout(function () { pickTipTimer = 0; showPickTip(button); }, 3000);
      }

      /** Apply one scoped input event to one session, exactly as dsh-element-chip does. */
      function pickEmit(sessionId, event, payload) {
        var sessions = ctx.get('sessions');
        var actx = sessions === undefined ? undefined : sessions.scope(sessionId);
        if (actx === undefined) return false;
        return actx.bail(actx, event, payload) === true;
      }
      /**
       * Headless session seat: renders nothing, only holds the two facts a pick
       * needs — the session it belongs to and the revision-guarded insertion span.
       */
      function PageBlockPickSeat(props) {
        seatRef.sessionId = props.sessionId;
        seatRef.actions = props.inputActions;
        return null;
      }

      function pickSet(state, element) {
        if (!element || element.nodeType !== 1) return;
        state.pickHovered = element;
        var rect = element.getBoundingClientRect();
        var frameRect = state.frame.getBoundingClientRect();
        var zoom = state.zoom || 1;
        var box = pickBoxNode();
        box.style.display = 'block';
        box.style.left = (frameRect.left + rect.left * zoom) + 'px';
        box.style.top = (frameRect.top + rect.top * zoom) + 'px';
        box.style.width = (rect.width * zoom) + 'px';
        box.style.height = (rect.height * zoom) + 'px';
      }

      function pickMove(state, event) {
        if (!state.pick) return;
        var list = pickStackAt(state.pick.doc, event.clientX, event.clientY);
        if (!list.length) { hidePickBox(); return; }
        state.pickStack = list;
        pickSet(state, list[0]);
      }

      /** Wheel walks the paint stack so an occluded element becomes selectable. */
      function pickWheel(state, event) {
        event.preventDefault();
        event.stopPropagation();
        var hovered = state.pickHovered;
        if (!hovered) return;
        var stack = state.pickStack || [];
        var at = stack.indexOf(hovered);
        if (at >= 0) {
          var next = event.deltaY < 0 ? Math.min(at + 1, stack.length - 1) : Math.max(at - 1, 0);
          pickSet(state, stack[next]);
        } else {
          pickSet(state, event.deltaY < 0 ? hovered.parentElement : hovered.firstElementChild);
        }
      }

      function pickKey(state, event) {
        var hovered = state.pickHovered;
        if (!hovered) return;
        var target = null;
        if (event.key === 'ArrowUp') target = hovered.parentElement;
        else if (event.key === 'ArrowDown') target = hovered.firstElementChild;
        else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          var parent = hovered.parentElement;
          if (parent) {
            var sibs = [];
            for (var i = 0; i < parent.children.length; i += 1) sibs.push(parent.children[i]);
            target = sibs[sibs.indexOf(hovered) + (event.key === 'ArrowRight' ? 1 : -1)] || null;
          }
        } else return; // Enter, Escape and everything else stay unbound on purpose
        if (!target) return;
        event.preventDefault();
        event.stopPropagation();
        pickSet(state, target);
      }

      /**
       * Click = confirm: the token goes straight into the composer as a real chip.
       * The picker deliberately STAYS armed so several elements can be picked in a
       * row (user call, 2026-10-10); only a second click on the icon exits. Both
       * outcomes are silent: a successful pick shows up as a chip, a failed one
       * simply does not, so there is nothing to toast about.
       */
      function pickSelect(state) {
        var element = state.pickHovered;
        if (!element) return;
        var token = pickToken(element);
        var tag = '<' + element.tagName.toLowerCase() + '>';
        var span = seatRef.actions ? seatRef.actions.captureInsertion() : null;
        if (seatRef.sessionId && span) {
          try {
            pickEmit(seatRef.sessionId, 'slash/input-insert-reference', {
              reference: { source: PICK_SOURCE, ref: token, label: tag, clipboardText: token },
              span: span
            });
          } catch (e) { /* silent: the chip just never appears */ }
        }
      }

      function disarmPick(state, quiet) {
        var pick = state.pick;
        if (!pick) return;
        state.pick = null;
        if (armedPick === state) armedPick = null;
        var doc = pick.doc, win = pick.win;
        if (doc) {
          doc.removeEventListener('mousemove', pick.onMove, true);
          doc.removeEventListener('click', pick.onClick, true);
          doc.removeEventListener('pointerdown', pick.onDown, true);
          doc.removeEventListener('wheel', pick.onWheel, true);
          doc.removeEventListener('keydown', pick.onKey, true);
          doc.removeEventListener('mouseleave', pick.onLeave, true);
        }
        if (win) win.removeEventListener('blur', pick.onLeave, true);
        state.pickStack = [];
        state.pickHovered = null;
        hidePickBox();
        state.frame.style.pointerEvents = '';
        state.shell.style.cursor = '';
        if (state.pickButton) {
          state.pickButton.classList.remove('dshpb-pick-on');
          state.pickButton.setAttribute('aria-pressed', 'false');
        }
        // Exit is silent by design (user call, 2026-10-10): the icon going dark
        // and the highlight box disappearing are the whole feedback.
      }

      function armPick(state) {
        if (armedPick && armedPick !== state) disarmPick(armedPick, true);
        if (state.pick) { disarmPick(state); return; }
        var doc = null, win = null;
        try { doc = state.frame.contentDocument; win = state.frame.contentWindow; } catch (e) { doc = null; win = null; }
        if (!doc || !win) return; // canvas not ready: stay out of pick mode, silently
        var pick = { doc: doc, win: win };
        pick.onMove = function (event) { pickMove(state, event); };
        pick.onDown = function (event) {
          event.preventDefault();
          event.stopPropagation();
          // preventDefault above also suppresses the compatibility mousedown that
          // would have moved focus into the frame, so do it explicitly.
          try { win.focus(); } catch (e) { /* best-effort */ }
        };
        pick.onClick = function (event) { event.preventDefault(); event.stopPropagation(); pickSelect(state); };
        pick.onWheel = function (event) { pickWheel(state, event); };
        pick.onKey = function (event) { pickKey(state, event); };
        pick.onLeave = function () { hidePickBox(); };
        doc.addEventListener('mousemove', pick.onMove, true);
        doc.addEventListener('pointerdown', pick.onDown, true);
        doc.addEventListener('click', pick.onClick, true);
        doc.addEventListener('wheel', pick.onWheel, { capture: true, passive: false });
        doc.addEventListener('keydown', pick.onKey, true);
        doc.addEventListener('mouseleave', pick.onLeave, true);
        win.addEventListener('blur', pick.onLeave, true);
        state.pick = pick;
        state.pickStack = [];
        state.pickHovered = null;
        armedPick = state;
        // The frame is pointer-events:none for the pan/zoom shell; arming flips it so
        // the picker sees the events, and the shell's own drag never starts.
        state.frame.style.pointerEvents = 'auto';
        state.shell.style.cursor = 'crosshair';
        // The arrow keys are handled on the frame's document, so the frame has to
        // hold focus: without this they land on the host page and the layer
        // navigation silently never runs. preventScroll keeps the view still.
        try { state.frame.focus({ preventScroll: true }); } catch (e) { /* focus is best-effort */ }
        pickBoxNode();
        if (state.pickButton) {
          state.pickButton.classList.add('dshpb-pick-on');
          state.pickButton.setAttribute('aria-pressed', 'true');
        }
      }

      /** Text of one candidate node, trimmed: a reference line is the whole node. */
      function seatText(node) {
        return String(node.textContent == null ? '' : node.textContent).trim();
      }
      /** True for text the page must never read: a code block or a text editor. */
      function isPageChrome(node) {
        return node.closest('[contenteditable="true"], [data-lexical-editor], pre, code') !== null;
      }
      /** Drop a state's window-level gesture listeners (safe to call twice). */
      function unbindPan(state) {
        if (typeof state.onPanMove === 'function') window.removeEventListener('pointermove', state.onPanMove);
        if (typeof state.onPanEnd === 'function') {
          window.removeEventListener('pointerup', state.onPanEnd);
          window.removeEventListener('pointercancel', state.onPanEnd);
        }
        if (typeof state.onResizeMove === 'function') window.removeEventListener('pointermove', state.onResizeMove);
        if (typeof state.onResizeEnd === 'function') {
          window.removeEventListener('pointerup', state.onResizeEnd);
          window.removeEventListener('pointercancel', state.onResizeEnd);
        }
        state.onPanMove = null;
        state.onPanEnd = null;
        state.onResizeMove = null;
        state.onResizeEnd = null;
      }
      /**
       * Build (or rebuild) one canvas seat: the chat's real code block, with the
       * map viewport in its body slot. The trigger line itself is hidden, and the
       * seat is inserted right after it, so the message reads as a page instead
       * of a file path.
       */
      function mountSeat(state, lineNode) {
        unbindPan(state);
        unmountCodeBlockShell(state);
        var seat = document.createElement('div');
        seat.className = 'dshpb-seat';
        var host = document.createElement('div');
        host.className = 'dshpb-host';
        var shell = document.createElement('div');
        shell.className = 'dshpb-shell';
        var frame = document.createElement('iframe');
        frame.className = 'dshpb-frame';
        frame.setAttribute('sandbox', 'allow-same-origin');
        frame.setAttribute('referrerpolicy', 'no-referrer');
        var handle = document.createElement('div');
        handle.className = 'dshpb-handle';
        handle.setAttribute('role', 'separator');
        handle.setAttribute('aria-label', '外框高度：拖拽调整，双击复位');
        shell.appendChild(frame);
        shell.appendChild(handle);
        host.appendChild(shell);
        if (lineNode.parentNode) lineNode.parentNode.insertBefore(seat, lineNode.nextSibling);
        lineNode.style.display = 'none';
        state.seat = seat;
        state.host = host;
        state.shell = shell;
        state.frame = frame;
        state.handle = handle;
        state.block = null;
        // The banner and the body slot only exist once the code block commits;
        // adoptCodeBlock() fills these in and then runs buildControls/relayout.
        state.header = null;
        state.controls = null;
        state.resButton = null;
        state.pickButton = null;
        state.note = null;
        state.paintedKey = null;
        attachInteractions(state);
        mountCodeBlockShell(state);
      }

      /**
       * Mount the chat's OWN code block into the seat. The fence body is the
       * block's path, so the shell's built-in copy button copies the path (with
       * the shell's own tooltip + check-icon feedback); the <pre> is hidden by
       * CSS and the canvas takes the body slot.
       */
      function mountCodeBlockShell(state) {
        if (!HAS_CODE_BLOCK) {
          // This build exposes no code block: render the canvas bare rather than
          // not at all. The banner degrades to the seat itself (controls only).
          state.seat.appendChild(state.host);
          state.header = state.seat;
          buildControls(state);
          relayout(state);
          return;
        }
        var contentRef = react.createRef();
        function CodeBlockShell() {
          react.useLayoutEffect(function () {
            adoptCodeBlock(state, contentRef.current);
          }, []);
          return react.createElement(primitives.CodeBlock, {
            // The body is the PATH: one small consequence is that the shell's
            // copy button copies ui-blocks/<name>.uiblock, which is what a reader
            // can act on — the draft's HTML is already in the file.
            code: state.refPath,
            lang: LANG_LABEL,
            // No wrap toggle: an iframe canvas has no wrapping to toggle. Passing
            // wrap keeps that dead control out of the banner entirely.
            wrap: true,
            contentRef: contentRef,
            copyLabel: COPY_LABEL,
            copiedLabel: COPIED_LABEL,
            toolbarLabels: { codeLabel: LANG_LABEL, wrapLabel: '自动换行', unwrapLabel: '不换行' }
          });
        }
        var root = reactDomClient.createRoot(state.seat);
        state.reactRoot = root;
        state.contentRef = contentRef;
        state.renderShell = function () { root.render(react.createElement(CodeBlockShell)); };
        state.renderShell();
      }

      /** Hand the committed code block's two stable nodes to the canvas. */
      function adoptCodeBlock(state, content) {
        if (!state.seat || !state.seat.isConnected) return;
        var block = content && content.closest ? content.closest('.md-code-block') : null;
        if (!block) return;
        block.classList.add('dshpb-active');
        state.block = block;
        if (content !== state.host.parentNode) content.appendChild(state.host);
        state.header = block.querySelector(BANNER_SELECTOR);
        buildControls(state);
        relayout(state);
      }

      /** Drop the React shell (its DOM goes with the seat). */
      function unmountCodeBlockShell(state) {
        state.renderShell = null;
        state.contentRef = null;
        if (!state.reactRoot) return;
        var root = state.reactRoot;
        state.reactRoot = null;
        try { root.unmount(); } catch (e) { /* the seat may already be detached */ }
      }
      /**
       * One reference line -> one canvas. Fast path: nothing changed since the
       * last sweep, so only the theme sheet is re-adopted and repainted.
       */
      function ensureSeat(lineNode, directive) {
        var refPath = directivePath(directive.name);
        // The version this reference shows is frozen to its message: the pin is
        // resolved from the chat node, and the host keeps the moment.
        var pin = pinOf(lineNode);
        var refKey = refKeyOf(refPath, pin);
        var cached = refCache[refKey];
        var body = cached !== undefined && cached.text !== null ? cached.text : null;
        if (body === null) { scheduleRefFetch(refKey, refPath, pin); return; }
        var line = seatText(lineNode);
        var state = states.get(lineNode);
        if (state && state.refKey === refKey && state.body === body && state.firstLine === line &&
            state.seat && state.seat.isConnected && state.controls && state.controls.isConnected) {
          // The file itself is unchanged, but the host theme may not be: adopt
          // the current token sheet and repaint (paint() no-ops when the key is
          // identical, so this stays cheap on every sweep).
          state.tokensKey = tokensKeyNow(tokenCache);
          paint(state);
          return;
        }
        if (!state) {
          state = {
            root: lineNode,
            res: directiveRes(directive),
            declared: directive.res !== null,
            zoom: 1,
            autoFit: true,
            offset: null,
            viewH: null,
            userViewH: false,
            hDeclared: true,
            drag: null,
            resizing: null,
            pick: null,
            pickStack: [],
            pickHovered: null,
            meta: null,
            firstLine: line,
            refPath: refPath,
            refKey: refKey,
            pinned: pin !== null,
            pin: pin,
            body: body,
            paintedKey: null,
            tokensKey: ''
          };
          states.set(lineNode, state);
          live.push(state);
          stats.converted += 1;
        }
        // A renamed line re-renders the shell too: the code block's body IS the
        // path, and the copy button must copy the path the line names now.
        var renamed = state.refPath !== refPath;
        state.refPath = refPath;
        state.refKey = refKey;
        state.pinned = pin !== null;
        state.pin = pin;
        if (!state.seat || !state.seat.isConnected) mountSeat(state, lineNode);
        else lineNode.style.display = 'none';
        if (renamed && state.renderShell) state.renderShell();
        // Same block, new file contents (the user or the agent edited it), or a
        // changed res= clause: adopt both, then repaint (paint() keys on the body
        // and the canvas size, so either change re-renders).
        state.firstLine = line;
        state.body = body;
        if (directive.res && (directive.res.w !== state.res.w || directive.res.h !== state.res.h)) {
          state.res = directive.res;
          state.declared = true;
        }
        state.frame.setAttribute('title', directive.name);
        buildControls(state);
        state.tokensKey = tokensKeyNow(tokenCache);
        relayout(state);
        if (state.resObserver) state.resObserver.disconnect();
        else if (typeof ResizeObserver === 'function') {
          state.resObserver = new ResizeObserver(function () {
            window.requestAnimationFrame(function () { applySize(state); });
          });
        }
        if (state.resObserver && state.host) {
          try { state.resObserver.observe(state.host); } catch (e) { /* noop */ }
        }
      }
      /** Tear one canvas down: gestures, observer, the seat node, the hidden line. */
      function disposeState(state) {
        try { if (state.resObserver) state.resObserver.disconnect(); } catch (e) { /* keep tearing down */ }
        try {
          unbindPan(state);
          unmountCodeBlockShell(state);
          if (state.block) state.block.classList.remove('dshpb-active');
          if (state.seat && state.seat.parentNode) state.seat.parentNode.removeChild(state.seat);
          if (state.root) state.root.style.display = '';
        } catch (e) { /* keep tearing down */ }
        state.seat = null;
        state.block = null;
        state.controls = null;
      }
      function sweep() {
        sweepScheduled = false;
        ensurePickSeat();
        tokenCache = readTokens();
        stats.tokenCount = tokenCache.count;
        var nodes = document.querySelectorAll('p, li');
        var found = 0;
        for (var i = 0; i < nodes.length; i += 1) {
          var node = nodes[i];
          var text = seatText(node);
          // Cheap rejects first: a reference line is short and carries the
          // marker, so an ordinary paragraph costs one indexOf.
          if (text.length > DIRECTIVE_MAX || text.indexOf('::dsh-ui') < 0) continue;
          // A list item that wraps a paragraph is that paragraph's parent; the
          // paragraph itself is the trigger, or one line would render twice.
          if (node.tagName === 'LI' && node.querySelector('p') !== null) continue;
          if (isPageChrome(node)) continue;
          var directive = parseDirectiveLine(text);
          if (directive === null) continue;
          found += 1;
          ensureSeat(node, directive);
        }
        stats.blocks = found;
        for (var j = live.length - 1; j >= 0; j -= 1) {
          var state = live[j];
          if (!state.root.isConnected) { disarmPick(state, true); disposeState(state); live.splice(j, 1); continue; }
          if (!state.seat || !state.seat.isConnected || !state.host.isConnected || !state.frame.isConnected) {
            state.paintedKey = null;
            var again = parseDirectiveLine(seatText(state.root));
            if (again !== null) ensureSeat(state.root, again);
            continue;
          }
          if (state.frame.getAttribute('srcdoc') === null) { state.paintedKey = null; paint(state); }
          if (!state.controls || !state.controls.isConnected) { buildControls(state); applySize(state); }
          else if (!state.drag) applySize(state); // never fight an active rubber-band drag
          // TTL re-read: an edited file repaints without a page reload. A pinned
          // reference is skipped here — its content is already final.
          if (state.refKey !== null && refStale(state)) scheduleRefFetch(state.refKey, state.refPath, state.pin);
        }
      }
      /** The chat node a reference sits in, keyed by the engine-owned stable key. */
      function chatNodeOf(lineNode) {
        return lineNode && typeof lineNode.closest === 'function' ? lineNode.closest('[data-chat-node-key]') : null;
      }
      /** Which reference this is inside its node (document order, 0-based). */
      function refIndexIn(host, lineNode) {
        var nodes = host.querySelectorAll('p, li');
        var count = 0;
        for (var i = 0; i < nodes.length; i += 1) {
          var node = nodes[i];
          if (node.tagName === 'LI' && node.querySelector('p') !== null) continue;
          if (isPageChrome(node)) continue;
          var text = seatText(node);
          if (text.length > DIRECTIVE_MAX || text.indexOf('::dsh-ui') < 0) continue;
          if (parseDirectiveLine(text) === null) continue;
          if (node === lineNode) return count;
          count += 1;
        }
        return count;
      }
      /**
       * The pin one reference asks for: { key, index } when it sits inside a chat
       * message, null when it does not (draft preview, standalone page, a host
       * that stopped tagging rows) — null keeps the old "show the newest" path.
       */
      function pinOf(lineNode) {
        var host = chatNodeOf(lineNode);
        if (host === null) return null;
        var key = host.getAttribute('data-chat-node-key');
        if (key === null || key === '') return null;
        return { key: key, index: refIndexIn(host, lineNode) };
      }
      /** Cache identity: one frozen version per pinned reference, plain path otherwise. */
      function refKeyOf(refPath, pin) {
        return pin === null ? refPath : refPath + '\u0000' + pin.key + '\u0000' + String(pin.index);
      }
      /**
       * Read one ui-blocks file. The host route is the primary path (it is the
       * only one that cannot leak a local path into the page); the plain fetch is
       * the fallback for a deployment whose host half is not mounted.
       * A pinned reference asks the host for the version at the moment that
       * message was first seen; without a pin the newest body is read, exactly
       * as before. Failures are cached as null and retried on the next TTL, so a
       * typo in a ref line costs a 404 every 1.5s, never a broken canvas.
       */
      function fetchRef(refKey, refPath, pin) {
        var entry = refCache[refKey];
        if (entry !== undefined && entry.pending) return;
        if (entry !== undefined && entry.text === null && Date.now() - entry.fetchedAt < REF_TTL) return;
        refCache[refKey] = { text: entry === undefined ? null : entry.text, fetchedAt: Date.now(), pending: true, pinned: pin !== null };
        var base = String(window.__DSH_BOOT__ && window.__DSH_BOOT__.basePath ? window.__DSH_BOOT__.basePath : '').replace(/\/$/, '');
        var url = base + '/' + refPath;
        if (pin !== null) url += '?pin=' + encodeURIComponent(pin.key) + '&i=' + String(pin.index);
        window.fetch(url, { credentials: 'same-origin', cache: 'no-store' })
          .then(function (response) {
            if (!response.ok) throw new Error('HTTP ' + response.status);
            return response.text();
          })
          .then(function (body) {
            refCache[refKey] = { text: body, fetchedAt: Date.now(), pending: false, pinned: pin !== null };
            schedule();
          }, function (error) {
            refCache[refKey] = { text: null, fetchedAt: Date.now(), pending: false, pinned: pin !== null, error: String(error && error.message || error) };
            stats.refWait += 1;
            stats.lastRefError = { path: refPath, error: String(error && error.message || error) };
          });
      }
      /**
       * Is this reference due for a re-read? A pinned one is NOT: its content
       * cannot change any more, so re-reading would only spend requests. A
       * failed read is still retried, because a 404 may become a 200 later.
       */
      function refStale(state) {
        var entry = refCache[state.refKey] || {};
        if (Date.now() - (entry.fetchedAt || 0) <= REF_TTL) return false;
        return state.pinned ? entry.text === null : true;
      }
      /** Ask for a missing file once per TTL, then let the sweep pick it up. */
      function scheduleRefFetch(refKey, refPath, pin) {
        var entry = refCache[refKey];
        if (entry === undefined) { fetchRef(refKey, refPath, pin); return; }
        if (entry.pending) return;
        if (entry.text === null && Date.now() - entry.fetchedAt < REF_TTL) return;
        fetchRef(refKey, refPath, pin);
      }
      function schedule() {
        if (sweepScheduled) return;
        sweepScheduled = true;
        window.requestAnimationFrame(function () { try { sweep(); } catch (e) { stats.lastError = String(e); } });
      }

      var observer = new MutationObserver(schedule);
      observer.observe(document.body, { childList: true, subtree: true });
      // Head mutations carry theme stylesheet swaps; the interval is also a
      // safety net that self-heals any node the host's React tree drops.
      var headObserver = new MutationObserver(schedule);
      headObserver.observe(document.head, { childList: true, subtree: true });
      var timer = window.setInterval(schedule, 1500);
      var onResize = function () { schedule(); };
      window.addEventListener('resize', onResize);
      var onDown = function (event) { if (menu && !menu.contains(event.target)) closeMenu(); };
      var onKey = function (event) { if (event.key === 'Escape') closeMenu(); };
      document.addEventListener('pointerdown', onDown, true);
      document.addEventListener('keydown', onKey, true);
      schedule();

      var api = {
        version: '0.6.0',
        stats: stats,
        /**
         * Read-only render seam for the host's read_ui_block screenshot: the SAME
         * token sheet and the SAME document builder the canvas uses, so the model
         * gets the picture the user is looking at instead of a second CSS copy
         * that would drift. Called from headless CDP against the live app page.
         */
        render: {
          tokens: function () { return readTokens(); },
          srcdoc: function (body) { return buildSrcdoc({ body: String(body == null ? '' : body) }, readTokens()); },
          defaultRes: function () { return { w: DEFAULT_RES.w, h: DEFAULT_RES.h }; }
        },
        /** Test seam: what the ref cache holds for one path (or a pinned variant). */
        ref: function (refPath) {
          var entry = refCache[refPath];
          if (entry === undefined) {
            var prefix = refPath + '\u0000';
            var keys = Object.keys(refCache);
            for (var i = 0; i < keys.length; i += 1) {
              if (keys[i].indexOf(prefix) === 0) { entry = refCache[keys[i]]; break; }
            }
          }
          if (entry === undefined) return null;
          return { text: entry.text, fetchedAt: entry.fetchedAt, pending: !!entry.pending, error: entry.error };
        },
        /** Test seam: arm/disarm a block's picker and read its live state. */
        picker: {
          arm: function (index) { var s = live[index || 0]; if (!s) return null; armPick(s); return api.picker.state(index); },
          disarm: function (index) { var s = live[index || 0]; if (!s) return null; disarmPick(s); return api.picker.state(index); },
          select: function (index) { var s = live[index || 0]; if (!s) return null; pickSelect(s); return api.picker.state(index); },
          state: function (index) {
            var s = live[index || 0];
            if (!s) return null;
            return {
              armed: !!s.pick,
              hovered: s.pickHovered ? (s.pickHovered.tagName.toLowerCase() + (s.pickHovered.id ? '#' + s.pickHovered.id : '')) : null,
              stack: (s.pickStack || []).map(function (el) { return el.tagName.toLowerCase() + (el.id ? '#' + el.id : ''); }),
              buttonLit: !!(s.pickButton && s.pickButton.classList.contains('dshpb-pick-on')),
              boxVisible: !!(pickBox && pickBox.style.display === 'block'),
              sandbox: s.frame.getAttribute('sandbox')
            };
          }
        },
        sweep: function () {
          sweep();
          return {
            stats: stats,
            tokenCount: tokenCache.count,
            scheme: tokenCache.scheme,
            live: live.map(function (s) {
              return {
                ref: s.refPath,
                pinned: !!s.pinned,
                pin: s.pin === null || s.pin === undefined ? null : { key: s.pin.key, index: s.pin.index },
                res: formatRes(s.res),
                zoom: s.zoom,
                autoFit: s.autoFit,
                declared: s.declared,
                hDeclared: s.hDeclared,
                viewH: Math.round(s.viewH || 0),
                hostWidth: Math.round(s.host.getBoundingClientRect().width),
                shellHeight: Math.round(s.shell.getBoundingClientRect().height)
              };
            })
          };
        }
      };
      window.__dshPageBlock = api;

      return function dispose() {
        for (var p = 0; p < live.length; p += 1) disarmPick(live[p], true);
        if (pickBox && pickBox.parentNode) pickBox.parentNode.removeChild(pickBox);
        pickBox = null;
        cancelPickTip();
        if (pickTip && pickTip.parentNode) pickTip.parentNode.removeChild(pickTip);
        pickTip = null;
        if (typeof seatDispose === 'function') seatDispose();
        seatDispose = null;
        observer.disconnect();
        headObserver.disconnect();
        window.clearInterval(timer);
        window.removeEventListener('resize', onResize);
        document.removeEventListener('pointerdown', onDown, true);
        document.removeEventListener('keydown', onKey, true);
        closeMenu();
        if (toast && toast.parentNode) toast.parentNode.removeChild(toast);
        if (styleTag && styleTag.parentNode) styleTag.parentNode.removeChild(styleTag);
        for (var i = 0; i < live.length; i += 1) disposeState(live[i]);
        live.length = 0;
        if (window.__dshPageBlock === api) delete window.__dshPageBlock;
      };
    }

    return {
      apply: function (ctx) {
        if (ctx && typeof ctx.effect === 'function') {
          var dispose = install(ctx);
          ctx.effect(function () { return dispose; });
          return;
        }
        install(ctx);
      }
    };
  }
});
