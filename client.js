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
  *
 * Merged bundle (2026-10-28, v0.2.0): dsh-element-chip's client half lives HERE
 * now - the `element«…»` @ source, the draft watcher, the history chip and the
 * user-text rule. One bundle and one patch row, so the `element` source the
 * canvas picker relies on (PICK_SOURCE below) cannot be loaded after it any
 * more. The token spelling did not change: messages sent before this merge
 * still render.
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

    // ═══ element chip (merged from dsh-element-chip 0.1.0, 2026-10-28) ═══════
    // The page block's canvas picker writes `element«…»` tokens and routes them
    // through the source registered HERE (`PICK_SOURCE` below). Both halves now
    // load as one bundle, so that source can never be missing or late.

    // -- constants ---------------------------------------------------------
    /** Registered trigger-source name (the chip's serializer routing key). */
    var SOURCE_NAME = 'element';
    /** Trigger char; the @ roster is shared with @file, so a source name is mandatory. */
    var TRIGGER = '@';
    /** Token prefix: the semantic word plus the opening guillemet. */
    var TOKEN_PREFIX = 'element\u00ab';
    /** Token terminator: the first bare closing guillemet. */
    var TOKEN_CLOSE = '\u00bb';
    /**
     * One whole token, content included. Lazy and dot-all so the content may span
     * lines; the extension has already escaped any literal guillemet in the page
     * content, so the first bare closing guillemet really is the end.
     */
    var TOKEN_RE = /element\u00ab(.*?)\u00bb/gs;
    /** The first tag name on the token's `HTML Element:` line. */
    var TAG_RE = /HTML Element:\s*<([A-Za-z][A-Za-z0-9-]*)/;
    /** The token's `DOM Path:` line, for the @ menu description. */
    var PATH_RE = /element\u00abDOM Path:\s*([^\n]*)/;
    // -- history chip: shared shapes ---------------------------------------
    /**
     * Class names taken verbatim from the stylesheets already in the document
     * (ui-chat's MessageItem / MessageIconActions, ui-conversation's
     * ReferenceChip / composer-editor). Reusing them is what keeps the redrawn
     * bubble pixel-identical to the built-in one, and what makes a history chip
     * look exactly like the composer chip it came from. Read-only literals: the
     * plugin never edits the upstream packages.
     * ponytail: a ui-chat upgrade that rehashes these names degrades styling,
     * never correctness - re-read them from the shipped client.js and update.
     */
    var ELEMENT_CSS = {
      userRow: 'Sixlwa_userRow',
      userStack: 'Sixlwa_userStack',
      bubble: 'Sixlwa_bubble',
      referenceSummary: 'Sixlwa_referenceSummary',
      attachmentRow: 'Sixlwa_attachmentRow',
      fileCard: 'Sixlwa_fileCard',
      fileIcon: 'Sixlwa_fileIcon',
      fileContent: 'Sixlwa_fileContent',
      fileName: 'Sixlwa_fileName',
      fileMeta: 'Sixlwa_fileMeta',
      actions: 'xzv4MW_actions',
      timeStart: 'xzv4MW_timeStart',
      action: 'xzv4MW_action',
      chip: 'q44v1G_reference yAWgPa_chip',
      chipMarker: 'yAWgPa_marker',
      chipLabel: 'yAWgPa_label'
    };
    /** The chat locale namespace ui-chat registers; this entry reuses it. */
    var CHAT_NS = 'chat';
    /**
     * One token's payload without the \u00ab...\u00bb wrapper - the four lines the
     * chip's tooltip shows.
     * @param token - the whole token.
     * @returns the inner four lines.
     */
    function tokenBody(token) {
      var s = rawOf(token);
      return s.slice(TOKEN_PREFIX.length, s.length - TOKEN_CLOSE.length);
    }
    /**
     * Split one sent message into the runs the history bubble renders: one chip
     * per well-formed element token, and the untouched text between them.
     *
     * Safe failure, same rule as the draft watcher: a token whose tag cannot be
     * parsed is not chipped at all - it stays inside a text run and the scan
     * goes on, so a malformed token can never eat its neighbours.
     *
     * Pure (no DOM, no ctx), so the self-check drives it directly.
     * @param text - the logged message text.
     * @returns runs in source order; always at least one run.
     */
    function splitElementTokens(text) {
      var s = String(text == null ? '' : text);
      var parts = [];
      var cursor = 0;
      TOKEN_RE.lastIndex = 0;
      var m;
      while ((m = TOKEN_RE.exec(s)) !== null) {
        var tag = tokenTag(m[0]);
        if (tag === null) continue;
        if (m.index > cursor) parts.push({ kind: 'text', text: s.slice(cursor, m.index) });
        parts.push({ kind: 'chip', label: tag, token: m[0] });
        cursor = m.index + m[0].length;
      }
      if (cursor < s.length) parts.push({ kind: 'text', text: s.slice(cursor) });
      if (parts.length === 0) parts.push({ kind: 'text', text: s });
      return parts;
    }
    /**
     * Split one message's content blocks into text, attachments and the rest.
     *
     * Mirrors ui-chat's own contentParts (dsh-client-ui-chat/lib/client.js:1193),
     * which is not exported; the redrawn bubble needs the same three buckets so
     * images and file cards keep rendering.
     * @param content - the node's content blocks.
     * @returns { text, attachments, rest }.
     */
    function contentParts(content) {
      var texts = [];
      var attachments = [];
      var rest = [];
      var list = Array.isArray(content) ? content : [];
      for (var i = 0; i < list.length; i += 1) {
        var b = list[i];
        if (b === null || typeof b !== 'object') { rest.push(b); continue; }
        if (b.type === 'text' && typeof b.text === 'string') texts.push(b.text);
        else if (b.type === 'image' && b.attachment !== undefined) attachments.push({ type: 'image', image: { attachment: b.attachment } });
        else if (b.type === 'file' && b.attachment !== undefined) attachments.push({ type: 'file', file: b.attachment });
        else rest.push(b);
      }
      return { text: texts.join(''), attachments: attachments, rest: rest };
    }
    /** Zero-pad one clock field. */
    function pad2(n) { return n < 10 ? '0' + n : String(n); }
    /**
     * Compact local timestamp for the message action row, the shipped rule
     * (dsh-client-ui-chat/lib/client.js:1057): same calendar day -> HH:mm;
     * earlier this year -> the clock.md date template; other years -> clock.ymd.
     *
     * ponytail: the shipped version re-renders at local midnight (useCalendarDay);
     * this one reads the clock per render, so a row left mounted across midnight
     * keeps yesterday's date until its next render. Display-only.
     * @param time - Unix epoch ms from the source session event.
     * @param t - translate seat supplying the clock templates.
     * @param now - reference instant (defaults to wall clock).
     * @returns the clock string.
     */
    function formatClock(time, t, now) {
      var d = new Date(time);
      var n = new Date(now === undefined ? Date.now() : now);
      var clock = pad2(d.getHours()) + ':' + pad2(d.getMinutes());
      if (d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate()) return clock;
      var params = { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate() };
      return (d.getFullYear() === n.getFullYear() ? t('clock.md', params) : t('clock.ymd', params)) + ' ' + clock;
    }


    // -- pure helpers (lifted into the self-check; no DOM, no ctx) ---------
    /**
     * The chip label one token carries: its element's tag, e.g. `<button>`.
     *
     * The tag is read from the token's own `HTML Element:` line - the first tag
     * name after the `<`. Attributes are never parsed (an attribute value may
     * itself contain `>`), and a token that carries no such line, or an empty
     * one, is refused rather than guessed at.
     *
     * @param token - the whole token.
     * @returns `<tag>`, or null when the token is not a well-formed element token.
     */
    function tokenTag(token) {
      var s = String(token == null ? '' : token);
      if (s.slice(0, TOKEN_PREFIX.length) !== TOKEN_PREFIX) return null;
      if (s.slice(-TOKEN_CLOSE.length) !== TOKEN_CLOSE) return null;
      var m = TAG_RE.exec(s);
      if (m === null) return null;
      return '<' + m[1] + '>';
    }
    /**
     * The token's own DOM path line, used as the @ menu description.
     * @param token - the whole token.
     * @returns the path, or '' when the token carries none.
     */
    function tokenPath(token) {
      var m = PATH_RE.exec(String(token == null ? '' : token));
      return m === null ? '' : m[1];
    }
    /**
     * The next token one draft still needs decorated, in clipboard coordinates.
     *
     * One edit per call on purpose: every scoped event CASes on draftRev, so a
     * second edit of the same tick could not apply. The draft watcher re-runs on
     * every revision, so the draft converges one chip at a time and a failed edit
     * simply retries on the next interaction instead of wedging.
     *
     * A token that is already a chip (its offset is one of the draft's own
     * occurrences) is skipped, and so is a token whose tag cannot be parsed -
     * that one is left as plain text (safe failure) and the scan goes on.
     *
     * @param text - draft text (clipboard projection).
     * @param occurrences - the input state's chip occurrences.
     * @returns { token, tag, start, end }, or null when nothing is left to do.
     */
    function nextEdit(text, occurrences) {
      var s = String(text == null ? '' : text);
      var chipped = Object.create(null);
      var list = Array.isArray(occurrences) ? occurrences : [];
      for (var i = 0; i < list.length; i += 1) {
        var o = list[i];
        if (o !== null && typeof o === 'object' && o.source === SOURCE_NAME) chipped[o.offset] = true;
      }
      TOKEN_RE.lastIndex = 0;
      var m;
      while ((m = TOKEN_RE.exec(s)) !== null) {
        if (chipped[m.index] === true) continue;
        var tag = tokenTag(m[0]);
        if (tag === null) continue;
        return { token: m[0], tag: tag, start: m.index, end: m.index + m[0].length };
      }
      return null;
    }
    /**
     * Fold one clipboard-projection offset onto its detect-projection twin.
     * Every chip is one U+FFFC in detect coordinates but its clipboardText chars
     * in the clipboard projection, so each chip fully before the offset shifts it
     * back by length - 1.
     * @param offset - offset into the clipboard projection.
     * @param occurrences - the input state's chip occurrences.
     * @returns the detect offset, or null when the offset lands inside a chip.
     */
    function foldDetectOffset(offset, occurrences) {
      var list = Array.isArray(occurrences) ? occurrences : [];
      var shift = 0;
      for (var i = 0; i < list.length; i += 1) {
        var o = list[i];
        if (o === null || typeof o !== 'object') continue;
        var start = o.offset;
        var len = o.length;
        if (typeof start !== 'number' || typeof len !== 'number') continue;
        if (offset > start && offset < start + len) return null;
        if (start + len <= offset) shift += len - 1;
      }
      return offset - shift;
    }
    /**
     * The model / clipboard form of one reference.
     *
     * The ref IS the token, so both projections are the identity - that is what
     * makes the sent message byte-identical to the paste. Never throws: a
     * non-string ref (the unknown-ref probe, an empty ref) degrades to ''.
     * @param ref - the chip's reference.
     * @returns the token verbatim, or ''.
     */
    function rawOf(ref) {
      if (typeof ref === 'string') return ref;
      if (ref === null || ref === undefined) return '';
      try {
        return String(ref);
      } catch (error) {
        return '';
      }
    }
    /**
     * The plugin's read-only parse cache: every token it has seen, in first-seen
     * order, with the label it renders as. Pure display data for the @ menu - the
     * chips themselves carry their own ref and label, so nothing here is needed
     * to send or copy.
     */
    function createRegistry() {
      var tags = Object.create(null);
      var paths = Object.create(null);
      var tokens = [];
      return {
        /** Remember one token. A re-paste of the same token is a no-op. */
        remember: function (token) {
          var key = rawOf(token);
          if (key === '') return;
          if (tags[key] !== undefined) return;
          tags[key] = tokenTag(key) || '';
          paths[key] = tokenPath(key);
          tokens.push(key);
        },
        list: function () {
          return tokens.slice();
        },
        tagOf: function (token) {
          return tags[rawOf(token)];
        },
        pathOf: function (token) {
          return paths[rawOf(token)] || '';
        }
      };
    }
    /**
     * Build the @ trigger source over one registry.
     *
     * The source exists for two reasons: the pipeline routes serialize() through
     * the roster by source name, and a token in the draft can be chipped by hand
     * from the menu. No lexicon hook: the draft's tokens are decorated by the
     * paste watcher, never by @-token decoration.
     * @param registry - the plugin's parse cache.
     * @returns the InputTriggerSource.
     */
    function makeSource(registry) {
      return {
        trigger: TRIGGER,
        name: SOURCE_NAME,
        order: 5,
        showGroupTitle: true,
        async candidates(session, req) {
          var q = String((req && req.query) || '').toLowerCase();
          return registry.list().map(function (token, index) {
            return {
              name: String(index + 1),
              label: registry.tagOf(token) || token,
              description: registry.pathOf(token),
              value: token
            };
          }).filter(function (candidate) {
            return q === '' || candidate.label.toLowerCase().indexOf(q) >= 0;
          });
        },
        /** Hand back a chip that renders as <tag> and serializes to the token. */
        onPick: function (pick) {
          var candidate = (pick && pick.candidate) || {};
          var token = candidate.value === undefined ? candidate.name : candidate.value;
          var tag = tokenTag(token);
          if (tag === null) return undefined;
          return {
            insert: {
              source: SOURCE_NAME,
              ref: token,
              label: tag,
              clipboardText: token
            }
          };
        },
        codec: {
          /** Copy / persist projection: the token, verbatim. */
          clipboardText: function (ref) {
            return rawOf(ref);
          },
          /**
           * Model projection: the token, verbatim.
           *
           * NEVER rejects and never throws synchronously - a throw here blocks
           * the entire send (contract), and the identity function cannot fail.
           */
          serialize: function (ref) {
            return Promise.resolve().then(function () {
              try {
                return rawOf(ref);
              } catch (error) {
                console.error('[dsh-element-chip] serialize failed:', error);
                return '';
              }
            });
          }
        }
      };
    }

    // -- history chip: components ------------------------------------------
    /** The primitives package, resolved on first use (see needPrimitives); the
     * cache itself is the shared one declared at the top of this bundle. */
    /**
     * Resolve the primitives package on first use rather than at apply time: the
     * slot registration must not depend on client-bundle load order, and the
     * self-check's stub need not provide the id at all.
     * @returns the primitives module.
     */
    function needPrimitives() {
      if (primitives === null) primitives = require('@deepseek-ai/dsh-client-ui-primitives');
      return primitives;
    }
    /** One history chip: the composer chip's own markup and classes, plus the
     * token's four lines as the native tooltip. */
    function ElementChipRun(props) {
      return react.createElement('span', {
        className: ELEMENT_CSS.chip,
        'data-element-chip': 'history',
        title: tokenBody(props.token)
      },
        react.createElement('span', { className: ELEMENT_CSS.chipMarker, 'aria-hidden': true }, '@'),
        react.createElement('span', { className: ELEMENT_CSS.chipLabel }, props.label)
      );
    }
    /**
     * One element token rendered through the shared user-text pipeline
     * (`conversation.user.text.node`, key `element`).
     *
     * This is the SECOND projection of the same token, and the one that covers
     * every right-aligned bubble the app draws from user text: steering
     * messages (key `steering`), pending steering items, submission echoes and
     * command bubbles never pass through `conversation.chat.node`/`user` at
     * all - they all funnel through the session-scoped `conversation.user.text`
     * Factory, whose rules are the documented extension point. Shadowing only
     * the user node therefore left those bubbles showing the raw token.
     *
     * @param props - { node, raw, interactive } from the UserText renderer.
     * @returns the history chip.
     */
    function ElementTextNode(props) {
      var data = (props && props.node && props.node.data) || {};
      var token = typeof data.token === 'string' ? data.token : rawOf(props && props.raw);
      var label = typeof data.label === 'string' ? data.label : (tokenTag(token) || '');
      return ElementChipRun({ token: token, label: label });
    }
    /**
     * The copy button and clock of one user message's action row - the shipped
     * MessageIconActions reduced to the parts a user message actually uses
     * (dsh-client-ui-chat/lib/client.js:1117, called at :1458 with only
     * text/time/clock/className). Reproduced because shadowing the user
     * renderer also shadows this row.
     *
     * The rewind plugin's button is NOT reproduced: it is portaled into this
     * row at runtime (dsh-rewind-plugin/lib/client.js:1019-1025 takes the last
     * non-rewind button's parentElement), so it keeps working as long as a
     * button sits here - which is why the copy button must not be dropped.
     * @param props - message text, event time, translate seat.
     * @returns the action row.
     */
    function HistoryActions(props) {
      var P = needPrimitives();
      var t = props.t;
      var state = react.useState(false);
      var copied = state[0];
      var setCopied = state[1];
      var timer = react.useRef(null);
      react.useEffect(function () {
        return function () { if (timer.current !== null) clearTimeout(timer.current); };
      }, []);
      var label = copied ? t('copied') : t('copy');
      var onCopy = function () {
        if (copied) return;
        var p = P.writeClipboard(props.text);
        Promise.resolve(p).then(function (ok) {
          if (ok !== true) return;
          setCopied(true);
          timer.current = setTimeout(function () { timer.current = null; setCopied(false); }, 1000);
        }, function () {});
      };
      return react.createElement('div', { className: ELEMENT_CSS.actions, 'data-clock': 'start' },
        react.createElement('span', { className: ELEMENT_CSS.timeStart }, formatClock(props.time, t)),
        react.createElement(P.Tooltip, { label: label, side: 'bottom' },
          react.createElement('button', {
            type: 'button',
            className: ELEMENT_CSS.action,
            'aria-label': label,
            onClick: onCopy
          }, react.createElement(copied ? P.IconCheckOutlineRegular : P.IconCopyOutlineRegular, {}))
        )
      );
    }
    /** One attachment in the message's attachment row: image gallery or file card. */
    function AttachmentItem(props) {
      var P = needPrimitives();
      var attachment = props.attachment;
      if (attachment.type === 'image') {
        return props.renderMessageImages({
          images: [attachment.image],
          align: 'end',
          compact: props.compactImages
        });
      }
      var file = attachment.file;
      return react.createElement('span', { className: ELEMENT_CSS.fileCard, title: file.name },
        react.createElement(P.FileTypeIcon, { path: file.name, className: ELEMENT_CSS.fileIcon }),
        react.createElement('span', { className: ELEMENT_CSS.fileContent },
          react.createElement('span', { className: ELEMENT_CSS.fileName }, file.name),
          react.createElement('span', { className: ELEMENT_CSS.fileMeta },
            [String(P.fileExtension(file.name)).toUpperCase().slice(0, 8), P.fileSizeText(file.bytes)].filter(Boolean).join(' '))
        )
      );
    }
    /**
     * projectUserText and JsonBlock are read as dynamic properties of the
     * primitives module, so the shipped frontend build cannot see them and
     * tree-shakes whatever its own app does not use. Measured in
     * dsh-web-frontend @0.2.1-rc.2 dist/assets/index-CN7NIWNw.js:
     * projectUserText 0 hits (calling it threw and killed the whole bubble),
     * JsonBlock / writeClipboard / Tooltip / the icons 1 each. Probe before
     * calling; a plain text run only loses the @mention capsules, the element
     * chips come from splitElementTokens and keep working.
     * ponytail: text-only fallback, no mention capsules -- copy
     * projectUserText's ~40 lines here only if history mentions matter.
     */
    function userTextNodes(P, text, referenceLabels, skillNames, references) {
      if (typeof P.projectUserText === 'function') {
        return P.projectUserText(text, referenceLabels, skillNames, 'skill', references);
      }
      return react.createElement('span', null, text);
    }
    /** Same dynamic-access hazard as projectUserText: fall back to a plain
     * preformatted dump if a future build drops JsonBlock.
     * @param P - the primitives module.
     * @param payload - the extra content block.
     * @param t - the chat namespace translate seat.
     * @param key - react key.
     * @returns the extra block node.
     */
    function jsonBlockNode(P, payload, t, key) {
      if (typeof P.JsonBlock === 'function') {
        return react.createElement(P.JsonBlock, {
          key: key,
          label: t('message.extraBlock'),
          payload: payload,
          truncatedLabel: function (total) { return t('json.truncated', { total: total }); }
        });
      }
      var body;
      try {
        body = JSON.stringify(payload, null, 2);
      } catch (e) {
        body = String(payload);
      }
      return react.createElement('pre', { key: key }, body);
    }
    /**
     * The shadowing user/steering bubble.
     *
     * Structure, classes, and copy are the shipped UserStyleBubble +
     * UserMessageNodeView (dsh-client-ui-chat/lib/client.js:1332-1466) with one
     * substitution: a well-formed element token renders as a chip instead of a
     * text run. Everything else - the attachment row (images AND file cards),
     * the reference-summary line, extra content blocks, the action row with its
     * copy button and clock - is reproduced so a plain message keeps the exact
     * DOM it had before this plugin existed.
     *
     * A message with no token takes the identical path: splitElementTokens
     * returns one text run, projectUserText decorates it exactly as before.
     * @param props - the keyed chat node plus the owner seats.
     * @returns the user bubble.
     */
    function ElementChipUserBubble(props) {
      var P = needPrimitives();
      var data = props.node.data;
      var t = props.t;
      var parts = contentParts(data.content);
      var attachments = parts.attachments;
      var compactImages = attachments.length > 1;
      var runs = splitElementTokens(parts.text);
      var showBubble = parts.text !== '' || parts.rest.length > 0;
      var references = { openFile: props.openFile, openSkill: props.openSkill };
      var referenceLabels = data.referenceLabels === undefined ? [] : data.referenceLabels;
      var skillNames = data.skillNames === undefined ? [] : data.skillNames;
      var children = [];
      var i;
      for (i = 0; i < runs.length; i += 1) {
        var run = runs[i];
        if (run.kind === 'chip') children.push(react.createElement(ElementChipRun, { key: 'c' + i, label: run.label, token: run.token }));
        else children.push(react.createElement(react.Fragment, { key: 't' + i }, userTextNodes(P, run.text, referenceLabels, skillNames, references)));
      }
      for (i = 0; i < parts.rest.length; i += 1) {
        children.push(jsonBlockNode(P, parts.rest[i], t, 'r' + i));
      }
      var stackChildren = [];
      if (attachments.length > 0) {
        stackChildren.push(react.createElement('div', {
          key: 'attachments',
          className: ELEMENT_CSS.attachmentRow,
          'data-message-attachments': true
        }, attachments.map(function (attachment, index) {
          return react.createElement(AttachmentItem, {
            key: attachment.type + ':' + index,
            attachment: attachment,
            compactImages: compactImages,
            renderMessageImages: props.renderMessageImages
          });
        })));
      }
      if (showBubble) stackChildren.push(react.createElement('div', { key: 'bubble', className: ELEMENT_CSS.bubble }, children));
      if (referenceLabels.length > 0) {
        stackChildren.push(react.createElement('div', { key: 'refs', className: ELEMENT_CSS.referenceSummary },
          t('message.referenceSummary', { labels: referenceLabels.join(t('message.referenceSeparator')) })));
      }
      return react.createElement('div', { className: ELEMENT_CSS.userRow, 'data-element-chip-bubble': 'history' },
        react.createElement('div', { className: ELEMENT_CSS.userStack }, stackChildren),
        react.createElement(HistoryActions, { text: parts.text, time: data.time, t: t })
      );
    }
    /**
     * Wire the shadowing entry. Registered at priority -1: the slot ledger keeps
     * one winner per cell and the LOWEST priority renders
     * (dsh-client-ui-slots/lib/index.js:278-293, dsh-client-ui-renderer/lib/
     * client.js:1154), so this entry takes the cell from ui-chat's own priority-0
     * registration without touching any upstream file.
     * @param ctx - client root context.
     */
    function registerHistoryRenderer(ctx) {
      ctx.slots.inject('conversation.chat.node', function () {
        return ctx.slots.register({
          name: 'conversation.chat.node',
          key: 'user',
          priority: -1,
          locale: CHAT_NS
        }, ElementChipUserBubble);
      });
    }

    /** UserText rule id; also the renderer key on `conversation.user.text.node`. */
    var RULE_ID = 'element';
    /**
     * The UserText rule that turns every well-formed element token in a sent
     * message into one chip, wherever the app renders user text.
     *
     * Rules are polled: `match(text, from)` returns the nearest token at or
     * after `from`, or undefined. A token whose tag cannot be parsed is skipped
     * (safe failure, same rule as splitElementTokens) so it can never eat its
     * neighbours.
     * @returns the rule object.
     */
    function createElementRule() {
      return {
        id: RULE_ID,
        order: 20,
        match: function (text, from) {
          var s = String(text == null ? '' : text);
          TOKEN_RE.lastIndex = typeof from === 'number' && from > 0 ? from : 0;
          var m;
          while ((m = TOKEN_RE.exec(s)) !== null) {
            var tag = tokenTag(m[0]);
            if (tag === null) continue;
            return { id: RULE_ID, start: m.index, end: m.index + m[0].length, data: { label: tag, token: m[0] } };
          }
          return undefined;
        }
      };
    }
    /**
     * Register the user-text rule and its keyed renderer.
     *
     * Both are optional: without `uiConversation` the shadow renderer still
     * chips the user's own messages, and without the slot the text simply keeps
     * the raw token - never a half-rendered chip.
     * @param ctx - client root context.
     */
    function registerUserTextRule(ctx) {
      var uiConversation = ctx.get('uiConversation');
      if (uiConversation === undefined || uiConversation.userText === undefined) return;
      ctx.effect(function () {
        return uiConversation.userText.register(createElementRule());
      }, 'dsh-element-chip: user text rule');
      ctx.slots.inject('conversation.user.text.node', function () {
        return ctx.slots.register({
          name: 'conversation.user.text.node',
          key: RULE_ID
        }, ElementTextNode);
      });
    }

    // -- plugin body -------------------------------------------------------
    var registry = createRegistry();
    /** Required services: the trigger registry, the seat registry, the session scopes. */
    var inject = ['inputTriggers', 'slots', 'sessions', 'uiConversation'];

    /**
     * Client plugin body: register the @ source, then mount the draft watcher.
     * @param ctx - client root context.
     */
    function applyElementChip(ctx) {
      var inputTriggers = ctx.get('inputTriggers');
      if (inputTriggers !== undefined) {
        ctx.effect(function () {
          return inputTriggers.registerSource(makeSource(registry));
        }, 'dsh-element-chip: @ source');
      } else {
        console.error('[dsh-element-chip] inputTriggers service unavailable; chip source not registered');
      }

      /**
       * Apply one scoped input event to one session scope.
       * @param sessionId - owning session (the scope the event is addressed to).
       * @param event - scoped input event name.
       * @param payload - event payload.
       * @returns whether the editor applied the edit.
       */
      function emit(sessionId, event, payload) {
        var sessions = ctx.get('sessions');
        var actx = sessions === undefined ? undefined : sessions.scope(sessionId);
        if (actx === undefined) return false;
        return actx.bail(actx, event, payload) === true;
      }

      /**
       * Advance one pasted draft by a single chip edit through the public scoped
       * events. The token is remembered first so the @ menu can offer it back.
       * @param sessionId - owning session (the scope the event is addressed to).
       * @param state - current InputState.
       */
      function consumePaste(sessionId, state) {
        if (state === null || state === undefined) return;
        if (state.phase !== 'plain') return;
        var draft = state.draft;
        if (typeof draft !== 'string' || draft === '') return;
        var edit = nextEdit(draft, state.occurrences);
        if (edit === null) return;
        var start = foldDetectOffset(edit.start, state.occurrences);
        var end = foldDetectOffset(edit.end, state.occurrences);
        if (start === null || end === null || end <= start) return;
        registry.remember(edit.token);
        emit(sessionId, 'slash/input-insert-reference', {
          reference: {
            source: SOURCE_NAME,
            ref: edit.token,
            label: edit.tag,
            clipboardText: edit.token
          },
          span: { start: start, end: end, draftRev: state.draftRev }
        });
      }

      /**
       * Headless session-scope seat: renders nothing, watches the draft.
       * @param props - session standard props (sessionId + useInput).
       * @returns null.
       */
      function ElementChipWatcher(props) {
        var useInput = props.useInput;
        var input = typeof useInput === 'function' ? useInput(function (s) {
          return s;
        }) : undefined;
        var draft = input === undefined ? undefined : input.draft;
        var draftRev = input === undefined ? undefined : input.draftRev;
        react.useEffect(function () {
          try {
            consumePaste(props.sessionId, input);
          } catch (error) {
            console.error('[dsh-element-chip] draft watch failed:', error);
          }
        }, [draft, draftRev, props.sessionId]);
        return null;
      }

      ctx.slots.inject('conversation.input.overlay', function () {
        return ctx.slots.register({
          name: 'conversation.input.overlay',
          id: 'dsh-element-chip',
          order: 5
        }, ElementChipWatcher);
      });

      // History bubble: token -> chip (see registerHistoryRenderer).
      try {
        registerHistoryRenderer(ctx);
      } catch (error) {
        console.error('[dsh-element-chip] history renderer not registered; history keeps the raw token:', error);
      }

      // Every OTHER user-style bubble (steering, pending steering, submission
      // echo, command rows) is drawn from `conversation.user.text` and never
      // reaches the node slot above; the rule below chips those too.
      try {
        registerUserTextRule(ctx);
      } catch (error) {
        console.error('[dsh-element-chip] user text rule not registered; steering bubbles keep the raw token:', error);
      }
    }


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

    // -- browser-extension settings tab ------------------------------------
    // One card in Settings -> Plugins: where the packaged extension lives, a
    // button that opens that folder, the three steps to load it unpacked, and
    // the "moving the plugin means reloading the extension" note. The card only
    // READS the host's fixed path and never sends one, so nothing typed or
    // clicked here can widen the host's reveal route.
    var EXTENSION_ROUTE = '/ui-block-extension';
    var EXT_SETTINGS_CSS = [
      '.dshub-ext{display:flex;flex-direction:column;gap:12px;padding:12px;max-width:760px}',
      '.dshub-ext-title{font:var(--dsw-font-xs-strong-13);color:var(--dsw-alias-label-primary)}',
      '.dshub-ext-ver{font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-tertiary)}',
      '.dshub-ext-row{display:flex;align-items:center;gap:8px}',
      '.dshub-ext-path{flex:1 1 auto;min-width:0;height:28px;padding:0 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:var(--dsw-font-xxs-12)}',
      '.dshub-ext-btn{flex:none;height:28px;padding:0 14px;border-radius:6px;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-interactive-bg);color:var(--dsw-alias-label-primary);font:var(--dsw-font-xxs-12)}',
      '.dshub-ext-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dshub-ext-steps{margin:0;padding-left:18px;display:flex;flex-direction:column;gap:4px;font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-secondary);line-height:1.6}',
      '.dshub-ext-hint{font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-tertiary);line-height:1.6}',
      '.dshub-ext-note{font:var(--dsw-font-xxs-12);color:var(--dsw-alias-state-success-primary);word-break:break-all}',
      '.dshub-ext-bad{font:var(--dsw-font-xxs-12);color:var(--dsw-alias-state-error-primary);word-break:break-all}'
    ].join('');

    /** One line of human text for an unknown thrown value. */
    function errorText(error) {
      return String(error && error.message ? error.message : error);
    }

    /** Clipboard is best-effort: execCommand keeps insecure/denied contexts working. */
    function fallbackCopy(text) {
      try {
        var area = document.createElement('textarea');
        area.value = text;
        area.setAttribute('readonly', '');
        area.style.position = 'fixed';
        area.style.left = '-1000px';
        document.body.appendChild(area);
        area.select();
        document.execCommand('copy');
        if (area.parentNode !== null) area.parentNode.removeChild(area);
      } catch (e) { /* copying is a convenience, never a requirement */ }
    }

    /** Settings -> Plugins -> 浏览器扩展: locate, copy, reveal, and the 3 loading steps. */
    function ExtensionSettingsCard() {
      if (react === null || typeof react.useState !== 'function') return null;
      var h = react.createElement;
      var infoState = react.useState({ phase: 'loading', dir: '', version: '' });
      var info = infoState[0];
      var setInfo = infoState[1];
      var noteState = react.useState('');
      var note = noteState[0];
      var setNote = noteState[1];
      var copiedState = react.useState(false);
      var copied = copiedState[0];
      var setCopied = copiedState[1];

      react.useEffect(function () {
        var live = true;
        window.fetch(EXTENSION_ROUTE, { credentials: 'same-origin', cache: 'no-store' })
          .then(function (res) {
            if (!res.ok) throw new Error('HTTP ' + res.status);
            return res.json();
          })
          .then(function (body) {
            if (!live) return;
            setInfo({ phase: 'ready', dir: String(body.dir || ''), version: String(body.version || '') });
          })
          .catch(function (error) {
            if (!live) return;
            setInfo({ phase: 'error', dir: '', version: '' });
            setNote('读取扩展目录失败：' + errorText(error));
          });
        return function () { live = false; };
      }, []);

      function copyDir() {
        if (info.dir === '') return;
        var done = function () {
          setCopied(true);
          window.setTimeout(function () { setCopied(false); }, 1600);
        };
        try {
          if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            navigator.clipboard.writeText(info.dir).then(done, function () {
              fallbackCopy(info.dir);
              done();
            });
            return;
          }
        } catch (e) { /* fall through to the textarea path */ }
        fallbackCopy(info.dir);
        done();
      }

      function reveal() {
        setNote('正在打开文件夹…');
        window.fetch(EXTENSION_ROUTE + '/reveal', {
          method: 'POST',
          credentials: 'same-origin',
          cache: 'no-store',
          headers: { 'x-dsh-ui-block-reveal': '1' }
        })
          .then(function (res) {
            if (!res.ok) throw new Error('HTTP ' + res.status);
            return res.json();
          })
          .then(function (body) {
            setNote(body && body.ok === true ? '已打开：' + String(body.dir || '') : '打开失败');
          })
          .catch(function (error) { setNote('打开失败：' + errorText(error)); });
      }

      var pathValue = info.phase === 'ready' ? info.dir : (info.phase === 'error' ? '（读取失败）' : '读取中…');
      return h('div', { className: 'dshub-ext', 'data-dsh-ui-block-extension': 'card' },
        h('div', { className: 'dshub-ext-title' }, '浏览器扩展 dsh-element-picker'),
        h('div', { className: 'dshub-ext-ver' }, info.version === '' ? '扩展版本未知' : '扩展版本 ' + info.version + ' · 与插件 package.json 同版'),
        h('div', { className: 'dshub-ext-row' },
          h('input', {
            className: 'dshub-ext-path',
            value: pathValue,
            readOnly: true,
            'aria-label': '扩展目录',
            onFocus: function (event) { event.target.select(); }
          }),
          h('button', { type: 'button', className: 'dshub-ext-btn', onClick: copyDir }, copied ? '已复制' : '复制路径'),
          h('button', { type: 'button', className: 'dshub-ext-btn', onClick: reveal }, '打开文件夹')
        ),
        h('ol', { className: 'dshub-ext-steps' },
          h('li', null, '打开 chrome://extensions'),
          h('li', null, '打开右上角的「开发者模式」'),
          h('li', null, '点「加载已解压的扩展程序」，选上面这个目录')
        ),
        h('div', { className: 'dshub-ext-hint' }, '插件换目录（重装、换实例）后要回到 chrome://extensions 重新加载一次扩展，否则浏览器里跑的还是旧目录那份。'),
        note === '' ? null : h('div', { className: /失败/.test(note) ? 'dshub-ext-bad' : 'dshub-ext-note' }, note)
      );
    }

    /**
     * Register the Settings -> Plugins tab. The slots service can still be
     * inactive at first paint, so read it non-strictly and skip silently when it
     * is absent; the registration itself waits for the slot declaration.
     */
    function attachExtensionSettings(ctx) {
      var slots = ctx && typeof ctx.get === 'function' ? ctx.get('slots', false) : undefined;
      if (slots === undefined || slots === null || typeof slots.inject !== 'function') return;
      ctx.effect(function () {
        if (typeof document === 'undefined' || document.head === null) return function () {};
        var style = document.createElement('style');
        style.setAttribute('data-plugin-css', 'dsh-ui-block-extension');
        style.textContent = EXT_SETTINGS_CSS;
        document.head.appendChild(style);
        return function () {
          if (style.parentNode !== null) style.parentNode.removeChild(style);
        };
      }, 'dsh-ui-block: extension settings styles');
      ctx.effect(function () {
        return slots.inject('settings.plugins.tab', function () {
          return slots.register({
            name: 'settings.plugins.tab',
            id: 'ui-block-extension',
            order: 92,
            label: function () { return '浏览器扩展'; }
          }, ExtensionSettingsCard);
        });
      }, 'dsh-ui-block: extension settings tab');
    }

    return {
      apply: function (ctx) {
        // Element half FIRST: the `element` @ source this file registers is what
        // renders a picked element as a chip and what serializes it back, so the
        // canvas picker below can never run before it exists.
        applyElementChip(ctx);
        // Third half: the packaged browser extension's settings card. Independent
        // of both halves above — it only needs the slots service.
        attachExtensionSettings(ctx);
        if (ctx && typeof ctx.effect === 'function') {
          var dispose = install(ctx);
          ctx.effect(function () { return dispose; });
          return;
        }
        install(ctx);
      },
      inject: inject,
      // ponytail: pure halves exported only so self-check-element-chip.mjs can
      // assert them without a DOM or a live harness; the page never reads them.
      __pure: {
        tokenTag: tokenTag,
        tokenBody: tokenBody,
        splitElementTokens: splitElementTokens,
        contentParts: contentParts,
        formatClock: formatClock,
        tokenPath: tokenPath,
        nextEdit: nextEdit,
        foldDetectOffset: foldDetectOffset,
        rawOf: rawOf,
        createRegistry: createRegistry,
        makeSource: makeSource,
        createElementRule: createElementRule,
        TOKEN_PREFIX: TOKEN_PREFIX,
        TOKEN_CLOSE: TOKEN_CLOSE,
        SOURCE_NAME: SOURCE_NAME,
        TRIGGER: TRIGGER
      }
    };
  }
});
