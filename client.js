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
 * Demo blocks (2026-11-09, route 1: host-driven): a block file that carries a
 * demo.json section is a DEMO BLOCK. The one criterion is that section; nothing
 * is probed at runtime, and a block without it takes exactly the old path — no
 * player, no transport, no rAF, no extra node. A demo block keeps the same
 * security model (sandbox allow-same-origin only, frame pointer-events:none):
 * the plugin projects the timeline from outside, onto the same-origin snapshot
 * pages the vendored player mounts, and the banner says 演示 · 非交互.
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
     * The ONE trigger (2026-10-24, res-after-the-colon accepted 2026-11-11): a
     * whole line, on its own, naming a file in the ui-blocks directory. All three
     * spellings below are the SAME directive; the first two are the ones to write:
     *
     *   ::dsh-ui login-modal::
     *   ::dsh-ui login-modal res=820x510::
     *   ::dsh-ui login-modal:: res=820x510      (res after the closing ::, accepted)
     *
     * The third is tolerance, not a style: a model that means to size the canvas
     * sometimes appends res=WxH to the finished line instead of putting it inside,
     * and refusing that showed the line as plain text with no hint why.
     *
     * Nothing else may sit on the line (leading/trailing whitespace aside), and a
     * backtick or a fence is not in the pattern, so a line that merely MENTIONS the
     * syntax — in prose, in a code block — stays plain text.
     */
    var DIRECTIVE_RE = /^[ \t]*::dsh-ui[ \t]+([A-Za-z0-9._-]+)(?:[ \t]+res=(\d{2,5})x(\d{2,5}))?[ \t]*::(?:[ \t]+res=(\d{2,5})x(\d{2,5}))?[ \t]*$/;
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
      // A size may sit before the closing :: (groups 2/3) or after it (groups 4/5).
      // Two different sizes on one line contradict each other: keep the whole line
      // as text rather than silently pick one.
      if (match[2] !== undefined && match[4] !== undefined) return null;
      var w = match[2] === undefined ? match[4] : match[2];
      var h = match[3] === undefined ? match[5] : match[3];
      return {
        name: name,
        res: w === undefined ? null : clampRes(parseInt(w, 10), parseInt(h, 10))
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

    // A section marker as the CLIENT sees it: only its presence matters here (the
    // host does the parsing and the guard), and it decides srcdoc vs served URL.
    var SECTION_LINE_RE = /^[ \t]*<!--[ \t]*@@file[ \t]+\S/m;
    var TOKEN_STYLE_ID = 'dshpb-tokens';

    /** The one token sheet: live theme properties plus the shared base rules. */
    function tokenSheet(tokens) {
      return ':root{' + tokens.css + '}html{color-scheme:' + tokens.scheme + '}' + BASE_CSS;
    }

    /**
     * Write the token sheet into a document this page owns. The srcdoc frame gets
     * it inline at build time; a SERVED block document (same origin, see the
     * sandbox value) gets it here, once, right after its load event.
     * @returns whether the document accepted it.
     */
    function applyTokens(doc, tokens) {
      if (!doc || !doc.head) return false;
      var style = doc.getElementById(TOKEN_STYLE_ID);
      if (style === null) {
        style = doc.createElement('style');
        style.id = TOKEN_STYLE_ID;
        // FIRST in head: the block's own stylesheet must be able to win, and a
        // later copy of BASE_CSS would silently outrank it at equal specificity.
        doc.head.insertBefore(style, doc.head.firstChild);
      }
      style.textContent = tokenSheet(tokens);
      return true;
    }

    // Host body attributes a served block document needs to see. Real component CSS
    // keys on them (`body[data-ds-dark-theme] .card{...}`), and a served document has
    // its OWN body, so without this mirror every such rule silently misses and the
    // block paints the light variant no matter what the app around it shows.
    //
    // Prefix whitelist, not a blanket dataset copy: `data-dshpb-*` is this plugin's
    // own marker space, and the block has no business reading anything else.
    var MIRROR_PREFIXES = ['data-ds-', 'data-dsh-'];
    function mirrorName(name) {
      for (var i = 0; i < MIRROR_PREFIXES.length; i += 1) {
        if (name.indexOf(MIRROR_PREFIXES[i]) === 0) return name.indexOf('data-dshpb-') !== 0;
      }
      return false;
    }
    /** Live view of the host body's mirrored attributes, sorted by name. */
    function mirrorPairs() {
      var pairs = [];
      var attrs = document.body ? document.body.attributes : null;
      if (attrs === null) return pairs;
      for (var i = 0; i < attrs.length; i += 1) {
        var name = String(attrs[i].name === undefined ? '' : attrs[i].name).toLowerCase();
        if (!mirrorName(name)) continue;
        pairs.push([name, String(attrs[i].value)]);
      }
      pairs.sort(function (a, b) { return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0; });
      return pairs;
    }
    /** The mirrored set as one string, so a theme or skin switch has a cheap key. */
    function attrsKeyNow() {
      var pairs = mirrorPairs();
      var parts = [];
      for (var i = 0; i < pairs.length; i += 1) parts.push(pairs[i][0] + '=' + pairs[i][1]);
      return parts.join(';');
    }
    /**
     * Write the host's mirrored attributes onto a served document's body, and drop
     * the ones the host no longer has — a switch back to light must remove the dark
     * flag, or the block would never leave dark mode.
     * @returns the attribute key that was applied.
     */
    function mirrorAttrs(doc) {
      if (!doc || !doc.body) return '';
      var pairs = mirrorPairs();
      var want = {};
      var parts = [];
      for (var i = 0; i < pairs.length; i += 1) {
        want[pairs[i][0]] = pairs[i][1];
        parts.push(pairs[i][0] + '=' + pairs[i][1]);
      }
      var have = doc.body.attributes;
      for (var d = have.length - 1; d >= 0; d -= 1) {
        var old = String(have[d].name === undefined ? '' : have[d].name).toLowerCase();
        if (!mirrorName(old)) continue;
        if (want[old] === undefined) { try { doc.body.removeAttribute(old); } catch (e) { /* keep going */ } }
      }
      for (var n in want) {
        if (!Object.prototype.hasOwnProperty.call(want, n)) continue;
        try { doc.body.setAttribute(n, want[n]); } catch (e) { /* keep going */ }
      }
      return parts.join(';');
    }

    function buildSrcdoc(state, tokens) {
      var head = '<!doctype html><html><head><meta charset="utf-8">' +
        '<meta http-equiv="Content-Security-Policy" content="' + CSP + '">' +
        '<style>' + tokenSheet(tokens) + '</style>' +
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
      // A demo stage is the player's own canvas: an absolute overlay that copies
      // the frame's geometry, so it pans and zooms with the block instead of
      // floating over it. pointer-events stays none, exactly like the frame.
      '.dshpb-stage{position:absolute;left:0;top:0;transform-origin:top left;overflow:hidden;pointer-events:none;z-index:1}',
      '.dshpb-stage-mount{position:relative;width:100%;height:100%;overflow:hidden}',
      '.dshpb-handle{position:absolute;left:0;right:0;bottom:0;height:7px;cursor:ns-resize;z-index:3;touch-action:none}',
      '.dshpb-handle::after{content:"";position:absolute;left:50%;top:2px;width:36px;height:3px;margin-left:-18px;',
      'border-radius:2px;background:var(--dsw-alias-border-l1);opacity:0;transition:opacity .15s}',
      '.dshpb-shell:hover .dshpb-handle::after{opacity:.85}',
      '.dshpb-ctl{display:inline-flex;align-items:center;gap:2px;margin-left:8px;flex:none}',
      // Banner row, unified (user call, 2026-11-11): ONE header for every block —
      // 尺寸 ｜ ⟲ ｜ 选取 ｜ 复制 — measured against the shell's own copy-path button
      // that sits right of them: 24px high, no border at all, transparent until
      // hover, 6px radius, 2px apart. A demo block is no longer special-cased here:
      // it used to carry its own 播放/暂停/重新开始 pill row inside a second
      // .dshpb-ctl; that row is deleted. The timeline loops by
      // itself and ⟲ restarts it from step 1, so the header stays one header.
      '.dshpb-ctl>.dshpb-btn{display:inline-flex;align-items:center;justify-content:center;',
      'box-sizing:border-box;height:24px;min-width:24px;padding:0 5px;border:0;border-radius:6px;background:transparent;',
      'line-height:1;cursor:pointer;white-space:nowrap}',
      '.dshpb-ctl>.dshpb-btn:hover{background:var(--dsw-alias-interactive-bg-hover);',
      'color:var(--dsw-alias-label-primary)}',
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
      // Canvas picker (2026-10-10). The lit state paints the ICON STROKE in #22d3ee
      // and nothing else — no fill and, since the banner row went borderless, no
      // border either. #22d3ee is written as a literal on purpose:
      // --dsw-alias-brand-primary resolves to a neutral-bluish token that reads
      // near-white on the dark theme.
      '.dshpb-pick svg,.dshpb-replay svg{display:block;width:14px;height:14px;overflow:visible}',
      '.dshpb-pick path,.dshpb-replay path{fill:none;stroke:var(--dsw-alias-label-secondary);stroke-width:1.5;',
      'stroke-linecap:round;stroke-linejoin:round}',
      // The copy glyph (2026-11-11, 5th round: this button is ours now) is a <path>
      // plus two <rect> sheets — same 14px box and same stroke as its two neighbours,
      // so the row still reads as one icon set.
      '.dshpb-copy svg{display:block;width:14px;height:14px;overflow:visible}',
      '.dshpb-copy path,.dshpb-copy rect{fill:none;stroke:var(--dsw-alias-label-secondary);stroke-width:1.5;',
      'stroke-linecap:round;stroke-linejoin:round}',
      // The shell's own copy icon, stood down inside OUR card only. The class is
      // applied to that one node by identity; !important beats the inline
      // display:none the same code sets, so a re-render cannot quietly revive it.
      '.md-code-block.dshpb-active .dshpb-shellcopy{display:none!important}',
      // The replay glyph is a broken circle with an arrowhead and a play triangle
      // in the middle: "play this again", not "reload the page".
      '.dshpb-replay path.dshpb-tri{fill:var(--dsw-alias-label-secondary);stroke:none}',
      '.dshpb-pick-on{background:transparent}',
      '.dshpb-pick-on path{stroke:#22d3ee;stroke-width:1.5}',
      '.dshpb-pickbox{position:fixed;z-index:2147483000;pointer-events:none;display:none;',
      'border:2px solid #4d6bfe;background:rgba(77,107,254,.12)}',
      // One-line hover hint (2026-11-11, third pass). The row's four buttons must
      // answer the same gesture with the same bubble, and the only one that
      // answers at all on the user's machine is the shell's own tooltip on the
      // copy-path button. Its live values are reproduced here value for value
      // instead of borrowing the shell component, which is out of bounds.
      //
      // What drives it, measured not assumed (out/probe/tooltip-unify2/
      // report-mechanism.json): the shell bubble is a React component. It clones
      // its child and injects onMouseEnter/onMouseLeave, so a plugin-created
      // button can never get one — clean clones carrying aria-label, title, both,
      // or the copy button's exact attributes showed no node at all. `title` is
      // the browser's OS tooltip, which lives outside the render tree: that is
      // why headless could not tell it from no hint, and why the size button
      // showed nothing on real hardware.
      //
      // The only visible gap to the shell bubble was the entry: it fades in over
      // 150ms on var(--ds-ease-in-out); this one used to pop in. Same keyframes,
      // same duration, same curve. pointer-events:none: a hint must never eat the
      // click it is describing.
      '.dshpb-tip{position:fixed;z-index:1100;display:none;align-items:center;gap:8px;',
      'width:max-content;max-width:50vw;padding:3px 7px;border-radius:var(--dsw-radius-sm,8px);',
      'background:var(--dsw-alias-tooltip-bg,#43454a);color:var(--dsw-static-neutral-bluish-00,#fff);',
      'font-size:13px;line-height:20px;white-space:pre-line;overflow-wrap:break-word;',
      'box-shadow:none;pointer-events:none;transform:translate(-50%,-100%);',
      'animation:dshpb-tip-in .15s var(--ds-ease-in-out,cubic-bezier(.4,0,.2,1))}',
      '.dshpb-tip[data-side="bottom"]{transform:translate(-50%,0)}',
      '@keyframes dshpb-tip-in{0%{opacity:0}}',
      '@media(prefers-reduced-motion:reduce){.dshpb-tip{animation:none}}'
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
        // The demo stage copies the frame's geometry exactly, so pan / zoom /
        // height keep moving the canvas as one thing.
        if (state.stage) {
          state.stage.style.width = state.frame.style.width;
          state.stage.style.height = state.frame.style.height;
          state.stage.style.transform = state.frame.style.transform;
        }
      }
      // ── one content model, and the HOST plays whatever timeline it has ──────
      //     snapshots (one of them is the entry document) + an optional timeline
      // A block without a timeline is not a different kind of block: it is the
      // degenerate input, one snapshot and zero steps. So readSpec() ALWAYS
      // returns a spec, and every caller reads a parameter — "is there a
      // timeline?" — instead of asking which kind of block this is. The block
      // stays pure data (sandbox: allow-same-origin only, no allow-scripts,
      // pointer-events:none); this plugin is the projector: cursor, highlight,
      // synthetic click, page switch and per-character typing all run from here
      // on the snapshot documents the player mounts.
      var DEMO_FILE_RE = /(^|\/)demo\.json$/;

      /** One block body's sections in file order; index 0 is the entry (path ''). */
      function blockSections(body) {
        var text = String(body == null ? '' : body);
        var out = [];
        var re = /^[ \t]*<!--[ \t]*@@file[ \t]+([^\s>]+)[ \t]*(?:base64)?[ \t]*-->[ \t]*$/gm;
        var at = 0, current = '', m;
        while ((m = re.exec(text)) !== null) {
          out.push({ path: current, text: text.slice(at, m.index) });
          current = m[1];
          at = m.index + m[0].length;
        }
        out.push({ path: current, text: text.slice(at) });
        return out;
      }

      /**
       * The degenerate spec: one snapshot (the entry document), zero steps.
       *
       * '' is the entry document — blockUrl() resolves it against the block's own
       * served directory — so the entry needs no section name of its own.
       */
      function entrySpec() {
        return { snapshots: { '': '' }, timeline: { steps: [] } };
      }

      /**
       * Does this block carry a timeline? A PARAMETER read, never a kind check:
       * the same expression decides painting, reloading and the test seam.
       */
      function hasTimeline(spec) {
        return !!spec && !!spec.timeline && spec.timeline.steps.length > 0;
      }

      /**
       * The spec of any block — always an object, never null.
       *
       * Anything that is not a sectioned body, or whose demo.json cannot be read,
       * degrades to entrySpec(): a typo must never cost a block its canvas. An
       * empty timeline is not a degraded block either; it is zero steps, which is
       * the static case, read by the same rule as everything else.
       */
      function readSpec(body) {
        if (!hasSections(body)) return entrySpec();
        var sections = blockSections(body);
        for (var i = 0; i < sections.length; i += 1) {
          if (!DEMO_FILE_RE.test(sections[i].path)) continue;
          var spec = null;
          try { spec = JSON.parse(sections[i].text); } catch (e) {
            // An unreadable timeline must never blank the block: one warning, then
            // the entry document shows its own markup.
            console.warn('[dsh-ui-block] demo.json 解析失败，按入口文档显示：' + String((e && e.message) || e));
            return entrySpec();
          }
          if (!spec || !spec.snapshots || typeof spec.snapshots !== 'object') return entrySpec();
          var snapshots = {};
          var count = 0;
          for (var name in spec.snapshots) {
            if (!Object.prototype.hasOwnProperty.call(spec.snapshots, name)) continue;
            snapshots[name] = String(spec.snapshots[name]);
            count += 1;
          }
          if (count === 0) return entrySpec();
          var timeline = spec.timeline && typeof spec.timeline === 'object' ? spec.timeline : {};
          return {
            snapshots: snapshots,
            timeline: {
              steps: Array.isArray(timeline.steps) ? timeline.steps : [],
              loop: timeline.loop,
              duration: timeline.duration
            }
          };
        }
        return entrySpec();
      }

      /** A snapshot's address, resolved against the block's own served directory. */
      function blockUrl(state, rel) {
        var dir = entryUrl(state);
        var cut = dir.indexOf('?');
        if (cut >= 0) dir = dir.slice(0, cut);
        return new URL(String(rel).replace(/^url:/, ''), new URL(dir, window.location.href)).href;
      }

      function destroyPlayer(state) {
        if (state.io) { try { state.io.disconnect(); } catch (e) { /* already gone */ } state.io = null; }
        if (state.player) { try { state.player.destroy(); } catch (e) { /* already gone */ } state.player = null; }
        state.playerState = null;
        if (state.mount) { try { state.mount.innerHTML = ''; } catch (e) { /* already gone */ } }
      }

      /** The overlay layer the player mounts into (once per seat). */
      function ensureStage(state) {
        if (state.stage && state.stage.isConnected && state.mount) return;
        var stage = document.createElement('div');
        stage.className = 'dshpb-stage';
        stage.setAttribute('data-dshpb-stage', 'true');
        var mount = document.createElement('div');
        mount.className = 'dshpb-stage-mount';
        stage.appendChild(mount);
        if (state.shell) state.shell.insertBefore(stage, state.handle || null);
        state.stage = stage;
        state.mount = mount;
      }

      /** The snapshot addresses of one spec, resolved against the served block. */
      function snapshotUrls(state) {
        var spec = state.spec;
        var out = {};
        for (var name in spec.snapshots) {
          if (!Object.prototype.hasOwnProperty.call(spec.snapshots, name)) continue;
          out[name] = blockUrl(state, spec.snapshots[name]);
        }
        return out;
      }

      /**
       * One player for the block's spec. Every block with a timeline goes through
       * here — there is no second renderer for "the demo kind".
       *
       * `previous` is the player a reload is replacing: its layers stay on screen
       * until the new player's first frame has really been swapped in, so ⟲ never
       * blanks the canvas on the way back to step 1.
       */
      function startPlayer(state, previous) {
        var shown = false;
        var onFail = function (info) {
          // Nothing on screen yet and the snapshot step 1 asks for is gone: keep
          // the entry document visible instead of an empty stage.
          if (info && info.first && !info.onScreen) degradeToEntry(state, info.why);
        };
        var player = createPlayer({
          snapshots: snapshotUrls(state),
          timeline: state.spec.timeline,
          mount: state.mount,
          onState: function (next) {
            state.playerState = next;
            if (shown || !next || next.snapshot === null) return;
            shown = true;
            // The new first frame is up: only now does the old player go away.
            if (previous) { try { previous.destroy(); } catch (e) { /* already gone */ } }
          },
          onFail: onFail
        });
        state.player = player;
        armAutoplay(state);
        applySize(state);
        player.play();
        return player;
      }

      /** A block with a timeline paints the PLAYER; the raw block document never shows. */
      function paintDemo(state) {
        if (state.paintedBody === state.body && state.player) return;
        state.paintedBody = state.body;
        state.frame.style.visibility = 'hidden';
        state.frame.style.display = 'none';
        destroyPlayer(state);
        ensureStage(state);
        startPlayer(state, null);
      }

      /**
       * Degrade instead of painting nothing: the entry document stays on the
       * canvas, one warning names why. No 404 body is ever put on the canvas.
       */
      function degradeToEntry(state, why) {
        if (state.degraded) return;
        state.degraded = true;
        console.warn('[dsh-ui-block] 时间轴里没有能显示的快照（' + why + '），退回入口文档：' + String(state.refPath || ''));
        state.frame.style.visibility = '';
        state.frame.style.display = '';
        state.paintedKey = null;
        paint(state);
      }

      /**
       * Autoplay by visibility: scrolling the block into view starts the show,
       * scrolling it away pauses it. The timeline is meant to run by itself;
       * ⟲ re-parses the content, which is also how it gets back to step 1.
       */
      function armAutoplay(state) {
        if (typeof IntersectionObserver !== 'function' || !state.stage) return;
        if (state.io) { try { state.io.disconnect(); } catch (e) { /* already gone */ } }
        state.io = new IntersectionObserver(function (entries) {
          for (var i = 0; i < entries.length; i += 1) {
            if (!state.player) continue;
            if (entries[i].isIntersecting) state.player.play();
            else state.player.pause();
          }
        }, { threshold: 0.05 });
        state.io.observe(state.stage);
      }

      /**
       * One block's live player facts. Any block takes this route: a block with no
       * timeline simply has no player, and the answer says so (player: false)
       * instead of the caller asking which kind of block it is.
       */
      function playerInfoOf(index) {
        var s = live[index || 0];
        if (!s) return null;
        var st = s.player ? s.player.state() : null;
        return {
          player: !!s.player,
          timeline: hasTimeline(s.spec),
          playing: st ? st.playing : false,
          t: st ? st.t : null,
          snapshot: st ? st.snapshot : null,
          duration: st ? st.duration : null,
          stepsFired: st ? st.stepsFired : null,
          stage: !!(s.stage && s.stage.isConnected),
          headerButtons: s.controls ? s.controls.querySelectorAll('button').length : 0,
          layers: st ? st.layers : [],
          switched: st ? st.switched : [],
          switchMs: st ? st.switchMs : [],
          loads: st ? st.loads : [],
          delayed: st ? st.delayed : [],
          failures: st ? st.failures : [],
          lead: st ? st.lead : null,
          liveDocs: st ? st.liveDocs : 0,
          frame: s.player ? s.player.frameInfo() : null
        };
      }

    // ── vendored player (ui-snapshot/player.mjs) — host-driven timeline ──────
    // [vendored-player] copied 2026-11-09, re-vendored 2026-11-11 (double buffer)
// player.mjs — 宿主侧时间轴播放器（路线 1：块只当素材，外面演）
// 用法：createPlayer({ snapshots, timeline, mount, onState, onFail })
//         → { play, pause, seek, restart, destroy, state, frameInfo }
// 快照是纯数据 HTML，用 blob: 装进同源 iframe；播放器在 iframe 之上画光标/高亮/涟漪，
// 并直接改 iframe 里的 DOM（同源）来演示“填字 / 按下”。
//
// 内容模型（2026-11-12）：块 = 快照集合 + 可选时间轴。**零步骤是被接受的一种输入**，
// 不是“另一种块”：steps.length === 0 时这里不排任何定时器、不推进，停在第 1 帧。
// 于是调用方读的是参数（有没有时间轴），而不是块属于哪一类。
//
// 双缓冲（2026-11-11）。用户口径：浏览器里点链接就是硬切，不许我们“帮他画过渡”。
// 所以这里做的只有一件事——**下一份文档画好之前，不把旧内容撤掉**：
//   · 每份快照各自一个 iframe，切步骤只改「显示哪一层」，永不重新导航；
//   · 就绪判据 = load 之后 readyState complete + document.fonts.status loaded，超时 800ms 兜底；
//   · 就绪的那一刻在 requestAnimationFrame 里一次交换（opacity 直接 1/0，没有 transition/animation，
//     没有淡入淡出）——硬切，只是把这次硬切挪到内容完整的那一刻；
//   · 容器不写死底色：底色由每份快照自己的 body 背景色补上，取不到就保持透明。
//
// 按时间轴排程装快照（2026-11-12）。时间轴是写好的，所以“什么时候要哪一份”事先就知道：
//   · 第 1 步打开就装；第 i 步在 (at − lead) 起装，lead = clamp(2 × 上一份实际加载耗时, 250, 2000ms)；
//   · 到点还没就绪 → 继续显示上一帧、推迟切换，就绪后立刻切，并记一条告警（不留空画布）；
//   · 层池上限 3，同一份快照复用，超了淘汰最久未用（正在显示/正要显示的除外）；
//   · 装进后台层的动画一律 pause()，切过去 currentTime = 0 再 play()：只提前加载，不提前播。
//   · 一份快照没拿到（404 / 非 HTML）：这一层永不上画布，告警一条，画面上留着上一帧。

const STYLE_ID = 'snap-player-style';

// 底色曾经写死 #000：快照文档画出来之前露出的就是它，于是每次“旧文档已卸、新文档未画”都是黑帧。
// 现在容器显式透明，每层 iframe 也透明，底色只从快照自己的 body 上取（sampleBg）。
const CSS = [
  '.snap-stage{position:relative;overflow:hidden;background:transparent}',
  '.snap-frame{position:absolute;inset:0;width:100%;height:100%;border:0;display:block;background:transparent;opacity:0;visibility:hidden}',
  '.snap-overlay{position:absolute;inset:0;pointer-events:none;overflow:hidden;z-index:5}',
  '.snap-cursor{position:absolute;left:0;top:0;width:22px;height:22px;margin:-2px 0 0 -2px;filter:drop-shadow(0 2px 4px rgba(0,0,0,.45));transition:transform .55s cubic-bezier(.33,.02,.2,1);z-index:3}',
  '.snap-cursor.press{transform-origin:2px 2px}',
  '.snap-cursor.press::after{content:"";position:absolute;left:2px;top:2px;width:12px;height:12px;border:2px solid rgba(255,255,255,.9);border-radius:50%;animation:snap-press .28s ease-out forwards}',
  '.snap-ring{position:absolute;border:2px solid #4da3ff;border-radius:6px;opacity:0;box-shadow:0 0 0 3px rgba(77,163,255,.28),0 0 18px rgba(77,163,255,.5);transition:opacity .18s ease,transform .18s ease,width .18s ease,height .18s ease}',
  '.snap-ring.show{opacity:1}',
  '.snap-ripple{position:absolute;width:16px;height:16px;margin:-8px 0 0 -8px;border-radius:50%;border:2px solid rgba(255,255,255,.85);opacity:0;z-index:2}',
  '.snap-ripple.go{animation:snap-ripple .5s ease-out forwards}',
  '@keyframes snap-ripple{0%{opacity:.9;transform:scale(.4)}100%{opacity:0;transform:scale(4.2)}}',
  '@keyframes snap-press{0%{opacity:.9;transform:scale(.6)}100%{opacity:0;transform:scale(1.9)}}'
].join('');

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const st = document.createElement('style');
  st.id = STYLE_ID;
  st.textContent = CSS;
  document.head.appendChild(st);
}

const CURSOR_SVG =
  '<svg viewBox="0 0 24 24" width="22" height="22"><path d="M4 2 L4 20 L9.2 15.3 L12.4 21.6 L15.6 20 L12.3 13.8 L19 13.4 Z" fill="#fff" stroke="#1b1b1b" stroke-width="1.2" stroke-linejoin="round"/></svg>';

const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();

// 目标三种写法：直接给选择器字符串 / {sel:'...'} / {text:'按钮上的字'}
function resolveTarget(doc, to) {
  if (!to || !doc) return null;
  if (typeof to === 'string') { try { return doc.querySelector(to); } catch { return null; } }
  if (to.sel) { try { return doc.querySelector(to.sel); } catch { return null; } }
  if (to.text) {
    const want = norm(to.text);
    let best = null, bestArea = Infinity, bestExact = null;
    for (const el of doc.body.querySelectorAll('*')) {
      const txt = norm(el.innerText);
      if (!txt) continue;
      const exact = txt === want;
      if (!exact && !txt.includes(want)) continue;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      const area = r.width * r.height;
      if (exact && area < (bestExact ? bestExact.area : Infinity)) bestExact = { el, area };
      if (area < bestArea) { bestArea = area; best = el; }
    }
    return bestExact ? bestExact.el : best;
  }
  return null;
}

function createPlayer({ snapshots = {}, timeline = {}, mount, onState = null, onFail = null }) {
  if (!mount) throw new Error('createPlayer: mount 必填');
  ensureStyle();

  const steps = [...(timeline.steps || [])].sort((a, b) => a.at - b.at).map((s, i) => ({ ...s, _i: i }));
  // 零步骤 = 静态（退化情形）：同一台机器，不推进而已。
  const hasSteps = steps.length > 0;
  const loopEnabled = timeline.loop !== false;
  const duration = timeline.duration || (hasSteps ? Math.max(0, ...steps.map((s) => s.at)) + 1500 : 0);
  const READY_TIMEOUT_MS = 800;
  // 隐藏层上不许让动画偷跑：最多管这么多条，超了如实记下来（不假装全管住）。
  const MAX_ANIM = 300;
  // 预加载提前量：钳在 250–2000ms；层池上限 3（淘汰最久未用）。
  const LEAD_MIN = 250;
  const LEAD_MAX = 2000;
  const MAX_LAYERS = 3;

  // 快照两种形态，接口不变（仍是"换一份已抓快照"）：
  //   HTML 字符串  → 装进 blob:
  //   "url:<地址>" → 直接当站点里的多文件页面加载（共用 CSS/素材各是一份文件）
  const blobUrls = new Map();
  const srcFor = (key) => {
    if (!(key in snapshots)) throw new Error('未知快照: ' + key);
    const raw = snapshots[key];
    if (typeof raw === 'string' && !raw.trim().startsWith('<')) {
      return raw.trim().startsWith('url:') ? raw.trim().slice(4) : raw.trim();
    }
    if (!blobUrls.has(key)) blobUrls.set(key, URL.createObjectURL(new Blob([raw], { type: 'text/html' })));
    return blobUrls.get(key);
  };

  mount.classList.add('snap-stage');
  const overlay = document.createElement('div');
  overlay.className = 'snap-overlay';
  const ring = document.createElement('div');
  ring.className = 'snap-ring';
  const ripple = document.createElement('div');
  ripple.className = 'snap-ripple';
  const cursor = document.createElement('div');
  cursor.className = 'snap-cursor';
  cursor.innerHTML = CURSOR_SVG;
  overlay.append(ripple, ring, cursor);
  mount.append(overlay);

  const state = { t: 0, playing: false, snapshot: null, fired: 0 };
  const layers = new Map();
  const switches = [];
  const loads = [];         // 每次“开始装”：哪一步、什么时刻
  const delayed = [];       // 到点还没就绪的切换（推迟，不是空画布）
  const failures = [];      // 没拿到的快照
  const requested = new Set();  // 本轮已经排过程的快照
  const warnedSteps = new Set();
  let lastLoadMs = 0;           // 上一份快照的实际加载耗时（lead 的来源）
  const undo = [];
  const originals = new Map();
  const hiddenOriginals = new Map();
  const readyWaiters = new Map();
  let raf = 0, last = 0, fired = new Set(), updates = [], retries = [], timers = [], readyTimers = [];
  let cursorAt = { x: 120, y: 120 };
  let activeKey = null, wantKey = null, wantPlay = false;
  const t0 = performance.now();

  const later = (ms, fn) => { const id = setTimeout(() => { timers = timers.filter((x) => x !== id); fn(); }, ms); timers.push(id); return id; };
  const clearTimers = () => { timers.forEach(clearTimeout); timers = []; };
  const laterReady = (ms, fn) => { const id = setTimeout(() => { readyTimers = readyTimers.filter((x) => x !== id); fn(); }, ms); readyTimers.push(id); return id; };
  const doc = () => { try { const rec = activeKey === null ? null : layers.get(activeKey); return rec ? rec.el.contentDocument : null; } catch { return null; } };
  const recOf = (key) => layers.get(key) || null;

  // ── 双缓冲：一层一快照，每层导航一次 ─────────────────────────────────────────
  function makeLayer(key) {
    const el = document.createElement('iframe');
    el.className = 'snap-frame';
    el.setAttribute('scrolling', 'no');
    el.setAttribute('title', 'snapshot');
    el.setAttribute('data-snap', key);
    // 沙箱不变：可被同源读取，绝不执行脚本。
    el.setAttribute('sandbox', 'allow-same-origin');
    const rec = { key, el, ready: false, failed: false, bg: '', decideAt: 0, readyAt: 0, startedAt: performance.now(), usedAt: performance.now() };
    el.addEventListener('load', () => settle(rec, Date.now() + READY_TIMEOUT_MS));
    el.src = srcFor(key);
    mount.insertBefore(el, overlay);
    layers.set(key, rec);
    return rec;
  }

  // 第 1 步要的那份快照：时间轴里第一个 switch，否则快照集合里的第一份。
  function firstKey() {
    const first = steps.find((s) => s.do === 'switch');
    return first ? first.snapshot : (Object.keys(snapshots)[0] || null);
  }

  // lead = 2 × 上一份的实际加载耗时，钳在 250–2000ms。
  const leadMs = () => Math.min(LEAD_MAX, Math.max(LEAD_MIN, Math.round((lastLoadMs || 0) * 2)));

  /** 装一份快照进层。名字不在集合里、或层装不下，都只告警，不抛。 */
  function loadLayer(key) {
    const have = recOf(key);
    if (have) return have;
    if (!(key in snapshots)) {
      const why = '不在快照集合里（有：' + Object.keys(snapshots).join(', ') + '）';
      failures.push({ key, why, at: Math.round(performance.now() - t0) });
      console.warn('[player] 时间轴要的 "' + key + '" ' + why);
      onFail && onFail({ key, why, first: key === firstKey(), onScreen: activeKey !== null });
      return null;
    }
    if (!makeRoom(key)) return null;
    try { return makeLayer(key); } catch (e) {
      const why = String((e && e.message) || e);
      failures.push({ key, why, at: Math.round(performance.now() - t0) });
      console.warn('[player] 快照 "' + key + '" 装不进层：' + why);
      onFail && onFail({ key, why, first: key === firstKey(), onScreen: activeKey !== null });
      return null;
    }
  }

  /** 层池上限 MAX_LAYERS：超了淘汰最久未用的（正在显示、正要显示的都不淘汰）。 */
  function makeRoom(key) {
    if (layers.has(key)) return true;
    while (layers.size >= MAX_LAYERS) {
      let victim = null;
      for (const r of layers.values()) {
        if (r.key === activeKey || r.key === wantKey) continue;
        if (!victim || r.usedAt < victim.usedAt) victim = r;
      }
      if (!victim) return false;   // 全是活层：宁可不预装，也不拆正在用的
      victim.el.remove();
      layers.delete(victim.key);
    }
    return true;
  }

  /** 每一帧核对一次：哪一步快到点了，就把它的快照装起来（只提前加载，不提前播）。 */
  function scheduleLoads() {
    if (!hasSteps) return;
    const lead = leadMs();
    for (const s of steps) {
      if (s.do !== 'switch') continue;
      if (s.at - lead > state.t) continue;
      if (recOf(s.snapshot) || requested.has(s.snapshot)) continue;
      requested.add(s.snapshot);
      loads.push({ key: s.snapshot, stepAt: s.at, startedAt: Math.round(performance.now() - t0), lead });
      loadLayer(s.snapshot);
    }
  }

  /**
   * 一份快照没拿到（404 / 没装成）：这一层永远不上画布——错误文档不许顶到画上。
   * 画面上继续留上一帧；画布上还什么都没有时，交给 onFail 决定怎么降级。
   */
  function failLayer(rec, why) {
    if (rec.failed) return;
    rec.failed = true;
    rec.ready = false;
    rec.why = why;
    failures.push({ key: rec.key, why, at: Math.round(performance.now() - t0) });
    console.warn('[player] 快照 "' + rec.key + '" 没拿到（' + why + '）：保持上一帧，不把错误文档挂到画布上');
    readyWaiters.delete(rec.key);
    onFail && onFail({ key: rec.key, why, first: rec.key === firstKey(), onScreen: activeKey !== null });
  }

  function settle(rec, deadline) {
    if (rec.ready || rec.failed) return;
    let complete = false, fonts = true, type = '';
    try {
      const d = rec.el.contentDocument;
      type = d ? String(d.contentType || '') : '';
      complete = !!d && d.readyState === 'complete' && !!d.body;
      fonts = !d || !d.fonts || d.fonts.status === 'loaded';
    } catch { complete = false; }
    // 拿回来的不是 HTML，就不是这份快照：宿主的 404/415 是 text/plain 正文。
    if (complete && type && type !== 'text/html') { failLayer(rec, 'content-type ' + type); return; }
    if (complete && fonts) { finish(rec); return; }
    if (Date.now() >= deadline) { finish(rec); return; }   // 兜底：宁可慢一帧，也不许卡住时间轴
    laterReady(16, () => settle(rec, deadline));
  }

  // 隐藏不是「暂停看」，而是「别在你看不到的时候跑」：层一就绪就把动画停住，
  // 切过去的那一刻再从 0 开始。否则切过去看到的是已经播完的终态。
  function layerAnims(rec) {
    try { const d = rec.el.contentDocument; return d && typeof d.getAnimations === 'function' ? d.getAnimations() : []; } catch { return []; }
  }
  function freezeLayer(rec) {
    const all = layerAnims(rec);
    const list = all.slice(0, MAX_ANIM);
    rec.animCount = all.length;
    rec.animCapped = all.length > MAX_ANIM;
    for (const a of list) { try { a.pause(); } catch { /* 已经没了 */ } }
    return list.length;
  }
  function rewindLayer(rec) {
    const all = layerAnims(rec);
    const list = all.slice(0, MAX_ANIM);
    for (const a of list) { try { a.currentTime = 0; a.play(); } catch { /* 已经没了 */ } }
    return list.length;
  }

  function finish(rec) {
    if (rec.ready || rec.failed) return;
    rec.ready = true;
    rec.readyAt = performance.now();
    // 下一份的 lead 就取自这一次实际花了多久。
    if (rec.startedAt) lastLoadMs = Math.max(0, Math.round(rec.readyAt - rec.startedAt));
    sampleBg(rec);
    freezeLayer(rec);
    const waiters = readyWaiters.get(rec.key);
    if (waiters) { readyWaiters.delete(rec.key); waiters.forEach((fn) => fn()); }
    if (wantKey === rec.key) swapTo(rec);
  }

  // 底色不写死：从快照自己的 body 上取；取不到就保持透明（露出的就是外壳底色）
  function sampleBg(rec) {
    let bg = '';
    try { const d = rec.el.contentDocument; bg = d && d.body ? getComputedStyle(d.body).backgroundColor : ''; } catch { bg = ''; }
    if (!bg || bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent') return;
    rec.bg = bg;
    if (activeKey === null || rec.key === activeKey) mount.style.background = bg;
  }

  function waitReady(key) {
    const rec = recOf(key);
    if (rec && rec.ready) return Promise.resolve(true);
    return new Promise((res) => {
      const list = readyWaiters.get(key) || [];
      list.push(() => res(true));
      readyWaiters.set(key, list);
      laterReady(READY_TIMEOUT_MS + 200, () => res(false));
    });
  }

  // 起表只在「第一帧真的上屏」那一刻发生，所以循环与重来都不会先播一帧错的画面。
  // ponytail: 回到第 1 步时那一层可能已经在屏幕上（末步正好也是第 1 步的快照），
  // 没有交换可以等——那时候由 resetPlayback() 直接调这里，不然表会一直停在 0。
  function startClock() {
    if (!wantPlay) return;
    wantPlay = false;
    last = 0;
    raf = requestAnimationFrame(tick);
  }

  // 切换 = 换显示哪一层，一帧内 1/0，没有任何过渡。
  function swapTo(rec) {
    if (!rec || !rec.ready || rec.key === activeKey) return;
    const decideAt = rec.decideAt || performance.now();
    requestAnimationFrame(() => {
      if (wantKey !== rec.key) return;      // 目标又变了：这一层不用露面
      for (const r of layers.values()) {
        const on = r === rec;
        r.el.style.opacity = on ? '1' : '0';
        r.el.style.visibility = on ? 'visible' : 'hidden';
        // 隐藏层停住；显示层从 0 开始（首帧就是「刚进场」那一帧）
        if (on) rewindLayer(r);
        else freezeLayer(r);
      }
      activeKey = rec.key;
      state.snapshot = rec.key;
      rec.usedAt = performance.now();
      if (rec.bg) mount.style.background = rec.bg;
      ring.classList.remove('show');
      const appliedAt = performance.now();
      // 相位证据：交换这一刻新层动画的当前时间（≈0 才说明它没偷跑）
      let phaseMs = null;
      try { const first = layerAnims(rec)[0]; phaseMs = first ? Math.round(Number(first.currentTime) || 0) : null; } catch { phaseMs = null; }
      switches.push({
        key: rec.key,
        costMs: Math.round(appliedAt - decideAt),
        applyAt: Math.round(appliedAt - t0),
        phaseMs,
        anims: rec.animCount === undefined ? null : rec.animCount,
        animCapped: !!rec.animCapped,
        // 排程账：这一层什么时候开始装、装了多久、它的那一步在哪一刻（核对 lead ≥ loadMs 用）
        loadStartAt: rec.startedAt ? Math.round(rec.startedAt - t0) : null,
        loadMs: rec.startedAt && rec.readyAt ? Math.round(rec.readyAt - rec.startedAt) : null,
        stepAt: rec.stepAt === undefined ? null : rec.stepAt
      });
      if (switches.length > 24) switches.shift();
      startClock();
      onState && onState(publicState());
    });
  }

  // 要某一层出面。没有提前装到的，现在装：切过去自然晚一点，页面不会空。
  function want(key) {
    wantKey = key;
    let rec = recOf(key);
    if (!rec) rec = loadLayer(key);
    if (!rec) return false;
    requested.add(key);
    rec.stepAt = rec.stepAt === undefined ? Math.round(state.t) : rec.stepAt;
    rec.usedAt = performance.now();
    rec.decideAt = performance.now();
    if (rec.ready) swapTo(rec);
    return true;
  }

  function setCursor(x, y, instant) {
    cursorAt = { x, y };
    if (instant) cursor.style.transition = 'none';
    cursor.style.transform = 'translate(' + x + 'px,' + y + 'px)';
    if (instant) { void cursor.offsetWidth; cursor.style.transition = ''; }
  }

  function centerOf(el) {
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), r };
  }

  function showRing(el, ms) {
    const d = doc();
    if (!el || !d) return;
    const c = centerOf(el);
    const pad = 4;
    ring.style.left = (c.r.left - pad) + 'px';
    ring.style.top = (c.r.top - pad) + 'px';
    ring.style.width = (c.r.width + pad * 2) + 'px';
    ring.style.height = (c.r.height + pad * 2) + 'px';
    ring.classList.add('show');
    later(ms || 700, () => ring.classList.remove('show'));
  }

  function doClick(el) {
    const c = centerOf(el);
    ripple.style.left = c.x + 'px';
    ripple.style.top = c.y + 'px';
    ripple.classList.remove('go');
    void ripple.offsetWidth;
    ripple.classList.add('go');
    cursor.classList.add('press');
    later(300, () => cursor.classList.remove('press'));
    // 按下反馈：直接改 iframe 里的目标元素
    if (el && el.style) {
      const prev = el.getAttribute('data-snap-pressed');
      el.setAttribute('data-snap-pressed', '1');
      const d = doc();
      if (d) {
        let st = d.getElementById('snap-press-style');
        if (!st) { st = d.createElement('style'); st.id = 'snap-press-style';
          st.textContent = '[data-snap-pressed]{transform:scale(.965)!important;filter:brightness(1.15);transition:transform .1s ease, filter .1s ease!important;}';
          d.head.appendChild(st); }
      }
      later(180, () => { if (prev === null) el.removeAttribute('data-snap-pressed'); else el.setAttribute('data-snap-pressed', prev); });
    }
  }

  // 双缓冲之后文档不再重载，我们自己的改动必须自己撤销（否则第二次循环会看到上一轮打的字）。
  function remember(el) {
    if (originals.has(el)) return;
    const isInput = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA';
    originals.set(el, { isInput, value: isInput ? el.value : el.textContent });
    undo.push(() => {
      const o = originals.get(el);
      if (!o) return;
      if (o.isInput) el.value = o.value;
      else el.textContent = o.value;
    });
  }
  function rememberHidden(el) {
    if (hiddenOriginals.has(el)) return;
    hiddenOriginals.set(el, el.style.display);
    undo.push(() => { el.style.display = hiddenOriginals.get(el) || ''; });
  }
  function runUndo() {
    const list = undo.splice(0);
    for (const fn of list) { try { fn(); } catch { /* 层已经不在了 */ } }
    originals.clear();
    hiddenOriginals.clear();
  }

  function doType(el, text, cps, at) {
    if (!el || !text) return;
    remember(el);
    const tag = el.tagName;
    const isInput = tag === 'INPUT' || tag === 'TEXTAREA';
    if (isInput) el.value = '';
    else el.textContent = '';
    const chars = [...text];
    const total = (chars.length * 1000) / (cps || 12);
    const t0s = at !== undefined ? at : state.t;
    updates.push(() => {
      const p = Math.min(1, (state.t - t0s) / Math.max(1, total));
      const n = Math.round(p * chars.length);
      const val = chars.slice(0, n).join('');
      if (isInput) el.value = val;
      else if (el.textContent !== val) el.textContent = val;
      return p >= 1;
    });
  }

  function fire(step) {
    const d = doc();
    const to = step.to;
    const el = () => resolveTarget(d, to);
    switch (step.do) {
      case 'switch': {
        const rec = recOf(step.snapshot);
        if (!rec || !rec.ready) {
          // 到点了但那份快照还没就绪：不动画面，等它就绪后立刻切。宁可整体慢半拍。
          if (!warnedSteps.has(step._i)) {
            warnedSteps.add(step._i);
            const why = rec ? (rec.failed ? '装失败' : '还没就绪') : '还没开始装';
            delayed.push({ key: step.snapshot, stepAt: step.at, at: Math.round(state.t), why });
            console.warn('[player] 第 ' + (step._i + 1) + ' 步（' + step.at + 'ms）要切到 "' + step.snapshot + '" 时它' + why
              + '：继续显示当前这一帧，就绪后立刻切');
          }
        }
        want(step.snapshot);
        break;
      }
      case 'move': {
        const e = el();
        if (!e) return false;
        const c = centerOf(e);
        setCursor(c.x, c.y);
        break;
      }
      case 'highlight': {
        const e = el();
        if (!e) return false;
        showRing(e, step.ms);
        break;
      }
      case 'click': {
        const e = el();
        if (!e) return false;
        const c = centerOf(e);
        setCursor(c.x, c.y);
        doClick(e);
        break;
      }
      case 'type': {
        const e = el();
        if (!e) return false;
        const c = centerOf(e);
        setCursor(c.x, c.y);
        // 占位符先藏起来，免得和打字叠在一起
        for (const hs of step.hide || []) {
          try { const h = d.querySelector(hs); if (h) { rememberHidden(h); h.style.display = 'none'; } } catch { /* 选择器写错不该拖垮时间轴 */ }
        }
        doType(e, step.text, step.cps, step.at);
        break;
      }
      case 'wait':
        break;
      default:
        console.warn('[player] 未知步骤', step);
    }
    return true;
  }

  function fireDue() {
    for (const s of steps) {
      if (fired.has(s._i)) continue;
      if (s.at > state.t) continue;
      fired.add(s._i);
      if (fire(s) === false) retries.push({ step: s, until: state.t + 2500 });
      state.fired = fired.size;
    }
    if (retries.length) {
      retries = retries.filter((r) => {
        if (state.t > r.until) { console.warn('[player] 目标找不到，跳过', r.step); return false; }
        return fire(r.step) !== true;
      });
    }
  }

  // 回到第 1 步：撤销我们写进文档的东西，停表，把第一份快照要回来。
  // 起表交给交换那一刻（第一帧真的在屏幕上了才开始走时间），所以循环与重来都不会先播一帧错的画面。
  function resetPlayback() {
    cancelAnimationFrame(raf);
    wantPlay = state.playing;
    clearTimers();
    runUndo();
    updates = [];
    retries = [];
    fired.clear();
    requested.clear();
    warnedSteps.clear();
    state.t = 0;
    state.fired = 0;
    ring.classList.remove('show');
    ripple.classList.remove('go');
    setCursor(120, 120, true);
    // 第 1 步没有“前一步”可排程：一打开（或回到第 1 步）就把它装上。
    const key = firstKey();
    if (key !== null) {
      want(key);
      if (key === activeKey) {
        // 第 1 步那份快照已经在屏幕上：want() 不会触发交换，就地重播这一帧并起表。
        const rec = recOf(key);
        if (rec) rewindLayer(rec);
        startClock();
      }
    }
  }

  function tick(now) {
    if (!state.playing) return;
    if (!last) last = now;
    const dt = now - last;
    last = now;
    state.t += dt;
    scheduleLoads();
    fireDue();
    updates = updates.filter((fn) => fn() !== true);
    if (state.t >= duration) {
      if (loopEnabled) { resetPlayback(); return; }
      state.playing = false;
      onState && onState(publicState());
      return;
    }
    onState && onState(publicState());
    raf = requestAnimationFrame(tick);
  }

  /**
   * 把一份快照重新解析一遍：拆掉这一层，装一个新的（新 iframe、新 blob URL），
   * 就绪后照样硬切。零步骤的块没有时间轴可重来，restart() 走的就是这条路。
   */
  function reloadLayer(key) {
    if (key === null || key === undefined) return null;
    const old = recOf(key);
    if (!old) return loadLayer(key);
    if (activeKey === key) { activeKey = null; state.snapshot = null; }
    layers.delete(key);
    old.el.remove();
    if (blobUrls.has(key)) { try { URL.revokeObjectURL(blobUrls.get(key)); } catch { /* 已经没了 */ } blobUrls.delete(key); }
    const rec = loadLayer(key);
    if (rec) wantKey = key;
    return rec;
  }

  function publicState() {
    const ls = [];
    for (const r of layers.values()) {
      ls.push({ snap: r.key, ready: r.ready, on: r.el.style.visibility === 'visible', op: r.el.style.opacity, bg: r.bg, anims: r.animCount === undefined ? null : r.animCount, animCapped: !!r.animCapped });
    }
    return {
      t: Math.round(state.t), playing: state.playing, snapshot: state.snapshot, duration,
      stepsFired: state.fired, steps: steps.length, layers: ls,
      switched: switches.slice(-8), switchMs: switches.map((x) => x.costMs),
      // 排程账：开头装了什么、谁被推迟、谁没拿到、当前 lead
      loads: loads.slice(-8), delayed: delayed.slice(-8), failures: failures.slice(-8),
      lead: leadMs(), maxLayers: MAX_LAYERS, liveDocs: layers.size
    };
  }

  // 开场不把所有快照都装上（那是“打开就挂 N 份活文档”）：第 1 帧那份由
  // resetPlayback() 立刻装，其余按时间轴排程一份一份来。
  if (Object.keys(snapshots).length === 0) throw new Error('createPlayer: 没有可用的快照');
  resetPlayback();

  const api = {
    play() {
      if (!hasSteps) {
        // 零步骤：没有可以推进的时间轴，停在第 1 帧，一个定时器都不排。
        state.playing = false;
        onState && onState(publicState());
        return publicState();
      }
      if (state.playing) return publicState();
      state.playing = true;
      if (activeKey === null) { wantPlay = true; return publicState(); }   // 首帧还没上屏：等交换那一刻才起表
      last = 0;
      raf = requestAnimationFrame(tick);
      return publicState();
    },
    pause() {
      state.playing = false;
      wantPlay = false;
      cancelAnimationFrame(raf);
      return publicState();
    },
    // 一次性把时间轴推到 ms 处（用于逐帧核对/截图）：先落定最后一个 switch，再补跑其余步骤。
    // 双缓冲之后换页是同步的，但仍要等那层就绪，否则改的是还没画出来的文档。
    async seek(ms) {
      clearTimers();
      updates = [];
      retries = [];
      fired.clear();
      runUndo();
      const due = steps.filter((s) => s.at <= ms);
      const lastSwitch = [...due].reverse().find((s) => s.do === 'switch');
      if (lastSwitch) { want(lastSwitch.snapshot); await waitReady(lastSwitch.snapshot); }
      state.t = ms;
      for (const s of due) {
        fired.add(s._i);
        if (s.do !== 'switch') fire(s);
      }
      state.fired = fired.size;
      updates = updates.filter((fn) => fn() !== true);
      onState && onState(publicState());
      return publicState();
    },
    restart() {
      if (!hasSteps) {
        // 零步骤：时间轴归零没有意义，就把当前这一份重新解析一遍（⟲ 的文档那一半）。
        state.t = 0;
        reloadLayer(activeKey !== null ? activeKey : firstKey());
        return publicState();
      }
      state.playing = true;
      resetPlayback();
      return publicState();
    },
    destroy() {
      cancelAnimationFrame(raf);
      clearTimers();
      readyTimers.forEach(clearTimeout);
      readyTimers = [];
      blobUrls.forEach((u) => URL.revokeObjectURL(u));
      for (const r of layers.values()) r.el.remove();
      layers.clear();
      overlay.remove();
    },
    state: publicState,
    ready: () => activeKey !== null,
    // 核对用：当前帧里 iframe 的可见文本，证明演的是哪一份快照
    frameInfo() {
      const d = doc();
      let src = '';
      try { const rec = activeKey === null ? null : layers.get(activeKey); src = rec ? String(rec.el.src).slice(0, 48) : ''; } catch { src = ''; }
      return { snapshot: state.snapshot, src, text: d && d.body ? norm(d.body.innerText).slice(0, 160) : null, size: d && d.body ? d.body.getBoundingClientRect().width + 'x' + d.body.getBoundingClientRect().height : null };
    },
  };

  return api;
}
    // [/vendored-player]
      /** A sectioned body is served as its own document; a plain one stays srcdoc. */
      function hasSections(text) { return SECTION_LINE_RE.test(String(text == null ? '' : text)); }
      /** The document URL of one block, carrying the same pin the text read used. */
      function entryUrl(state) {
        var boot = window.__DSH_BOOT__ || {};
        var base = String(boot.basePath || '').replace(/\/$/, '');
        var token = '';
        try { token = new URLSearchParams(window.location.search).get('token') || ''; } catch (e) { token = ''; }
        var name = String(state.refPath || '').replace(/^ui-blocks\//, '').replace(/\.uiblock$/, '');
        var query = [];
        if (state.pin !== null && state.pin !== undefined) {
          query.push('pin=' + encodeURIComponent(state.pin.key));
          query.push('i=' + String(state.pin.index));
        }
        if (token !== '') query.push('token=' + encodeURIComponent(token));
        // Trailing slash on purpose: it is the directory the entry lives in, so the
        // entry's own ./logo.svg resolves inside the block instead of one level up.
        var url = base + '/ui-blocks/' + encodeURIComponent(name) + '/';
        return query.length === 0 ? url : url + '?' + query.join('&');
      }
      function paint(state) {
        // A block WITH a timeline is played from here, never painted as a
        // document. That is the only difference — a parameter, not a kind.
        if (!state.degraded && hasTimeline(state.spec)) { paintDemo(state); return; }
        var served = hasSections(state.body);
        // Served branch: what renders is the SERVER's copy, so the key carries a
        // hash of the body (an edit must still repaint) and the pin. The token
        // sheet stays out of it on purpose — a theme switch re-injects into the
        // live document instead of reloading it.
        var key = served
          ? state.res.w + 'x' + state.res.h + '|' + (state.pin === null || state.pin === undefined ? '' : state.pin.key + '#' + state.pin.index) + '|' + hashString(state.body)
          : state.res.w + 'x' + state.res.h + '|' + state.tokensKey + '|' + state.body;
        if (state.paintedKey === key) {
          // A served document carries two live copies of host state: the token sheet
          // and the mirrored body attributes. Either one moving re-injects; reloading
          // the document for it would only buy a visible flash.
          if (served && (state.appliedTokensKey !== state.tokensKey || state.appliedAttrsKey !== attrsKeyNow())) injectFrame(state);
          return;
        }
        state.paintedKey = key;
        state.frame.setAttribute('width', String(state.res.w));
        state.frame.setAttribute('height', String(state.res.h));
        state.urlMode = served;
        if (!served) {
          state.frame.removeAttribute('src');
          state.frame.setAttribute('srcdoc', buildSrcdoc(state, tokenCache));
          return;
        }
        state.frame.removeAttribute('srcdoc');
        // Hidden until the sheet is in: a served document paints on its own first,
        // and a flash of unstyled white is the one thing that cannot be undone.
        state.frame.style.visibility = 'hidden';
        state.frame.setAttribute('src', entryUrl(state));
      }
      /** Inject the live token sheet into the served document currently loaded. */
      function injectFrame(state) {
        if (!state.urlMode || !state.frame) return;
        var doc = null;
        try { doc = state.frame.contentDocument; } catch (e) { doc = null; }
        if (!doc || !doc.documentElement) return;
        // Attributes FIRST: the block's own rules gate on them (dark variant, skin),
        // and the token sheet only decides what the tokens inside them resolve to.
        var attrsKey = '';
        try { attrsKey = mirrorAttrs(doc); } catch (e) { attrsKey = ''; }
        state.appliedAttrsKey = attrsKey;
        var applied = false;
        try { applied = applyTokens(doc, tokenCache); } catch (e) { applied = false; }
        if (applied === true) {
          state.appliedTokensKey = state.tokensKey;
          try { doc.documentElement.setAttribute('data-dshpb-ready', '1'); } catch (e) { /* marker is a nicety */ }
        }
        // Visible either way: a document that refused the sheet still shows its
        // own markup instead of leaving an empty canvas.
        state.frame.style.visibility = '';
      }
      /**
       * ⟲ = 刷新 = 把这个块当前可见的内容重新解析一遍。对任何块都成立，没有第二种：
       *
       *   · 有时间轴 → 播放器整个重建，于是时间轴回到第 1 步、第 1 步那份快照
       *     重新解析（入场动画从 0 开始）。**回到第 1 步不是另一个动作，是重建的结果。**
       *   · 零步骤   → 画布上那唯一一份文档重新解析。
       *
       * 也就没有“只把时间轴放回第 1 步、却不重播当前快照”的捷径了：那条旁路
       * （demoRestart）已删除，播放器也不再对外提供只重置时间轴的入口。
       * 空窗由双缓冲挡住：旧层留在屏幕上，新首帧上屏那一刻才拆。
       */
      function reloadBlock(state) {
        if (!state) return null;
        if (!hasTimeline(state.spec)) return replayBlock(state);
        if (!state.stage || !state.stage.isConnected) { state.paintedBody = null; paint(state); return { mode: 'player' }; }
        var previous = state.player;
        state.player = null;
        state.playerState = null;
        // 同一个挂载点上再起一层播放器：旧层继续显示，新首帧交换后才拆旧的。
        startPlayer(state, previous);
        return { mode: 'player' };
      }
      /**
       * The document half of ⟲: load this block's entry again, exactly like F5.
       *
       * NOT a loop. A block copies the site as it is, and the site plays its
       * entrance once and stops on the final frame — turning that into an
       * infinite animation would change the thing being reproduced. So the
       * document keeps its one-shot timing, and only this button makes it run a
       * second time.
       *
       * Nothing else comes with it: no message, no reset hook, no window into
       * the block's own state. A reload is a reload — the document is parsed
       * again, CSS animations and transitions start over, scroll position goes
       * back to the top, images are fetched again.
       *
       * What a reload CANNOT bring back is an entrance the site played by
       * ADDING A CLASS after load: that class is already baked into the
       * snapshot, so the copied page simply starts in its final state. That is
       * the capture's boundary, not this button's — a page that wants such an
       * entrance back has to bring its own reset, and a block cannot run one
       * (script-inert by default).
       */
      function replayBlock(state) {
        if (!state || !state.frame || !state.frame.isConnected) return null;
        if (state.urlMode) {
          // Assigning the same src again is not a guaranteed navigation: the
          // counter makes it a different URL, and nothing else reads it.
          state.replays = (state.replays || 0) + 1;
          var url = entryUrl(state);
          state.frame.setAttribute('src', url + (url.indexOf('?') < 0 ? '?' : '&') + 'replay=' + state.replays);
          return { mode: 'url' };
        }
        // srcdoc: remove then write it back, so this really is a re-parse
        // (re-setting an identical value is not relied upon). Both happen in
        // one task, so nothing repaints in between; buildSrcdoc reads the live
        // token sheet, exactly like the first paint did. Measured: a marker
        // stamped on the old document is gone afterwards and
        // performance.timeOrigin changes — the old document is really gone.
        var html = buildSrcdoc(state, tokenCache);
        state.frame.removeAttribute('srcdoc');
        state.frame.setAttribute('srcdoc', html);
        return { mode: 'srcdoc' };
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
        // No title attribute anywhere in this row: the native hint is exactly what
        // failed on the user's machine (see attachTip below). The bubble is ours.
        attachTip(resButton, '画布分辨率（点开可改，含自定义 W×H）');
        resButton.addEventListener('click', function (event) { event.preventDefault(); event.stopPropagation(); openResMenu(state); });
        // Canvas picker toggle. Icon only (14x14), sitting to the RIGHT of the
        // resolution button; the lit state is the cyan stroke alone — the banner row
        // went borderless on 2026-11-11, so there is no border left to colour.
        var pickButton = document.createElement('button');
        pickButton.type = 'button';
        pickButton.className = 'dshpb-btn dshpb-pick';
        pickButton.setAttribute('aria-pressed', 'false');
        pickButton.setAttribute('aria-label', '在画布内选取元素');
        // Hover explanation = the row's own bubble (attachTip), same look and same
        // instant appearance as the copy-path tooltip beside it (user call,
        // 2026-11-11). The text names the thing first, then how it works.
        attachTip(pickButton, '在画布内选取元素 · 点元素插入输入框 · 滚轮切层 · 再点退出');
        pickButton.innerHTML = '<svg viewBox="0 0 13 13" aria-hidden="true"><path d="M2.5 2.5l5 11 1.8-4.2 4.2-1.8z"/></svg>';
        pickButton.addEventListener('click', function (event) {
          event.preventDefault();
          event.stopPropagation();
          armPick(state);
        });
        // ⟲ — ONE button, ONE wording, ONE action (user call, 2026-11-12).
        // One-shot animations copy the site honestly and then sit on their final
        // frame, which reads as "static" to anyone who looks a second later. This
        // button re-parses the content instead of changing that timing: the loop
        // stays a one-shot, the user decides when it runs.
        // Icon only (user call, 2026-11-11): no visible word, and the same 24x16
        // box as the picker, sitting BETWEEN 分辨率 and 选取元素. The name lives
        // in aria-label (what a screen reader says) and in the row's bubble (what
        // the pointer gets) — one hover mechanism for the whole row.
        // NOT branched on the kind of block: 重新加载 means the same thing for
        // every block (refresh = parse it again), so the label, the bubble and the
        // handler are constant. A block with a timeline gets back to step 1 as a
        // CONSEQUENCE of being re-parsed, not through a second action.
        var replayButton = document.createElement('button');
        replayButton.type = 'button';
        replayButton.className = 'dshpb-btn dshpb-replay';
        replayButton.setAttribute('aria-label', '重新加载');
        attachTip(replayButton, '重新加载（重新解析画布内容，等同刷新）');
        replayButton.innerHTML = '<svg viewBox="0 0 13 13" aria-hidden="true"><path d="M10.9 6.5a4.4 4.4 0 1 1-1.29-3.11"/><path d="M9.9 1.3v2.3H7.6"/><path class="dshpb-tri" d="M5.7 4.6l2.4 1.9-2.4 1.9z"/></svg>';
        replayButton.addEventListener('click', function (event) {
          event.preventDefault();
          event.stopPropagation();
          reloadBlock(state);
        });
        // The copy icon is OURS now (see the block further down): same 24x24 box,
        // no border, same hover fill as the other three, and the same attachTip.
        var copyButton = document.createElement('button');
        copyButton.type = 'button';
        copyButton.className = 'dshpb-btn dshpb-copy';
        copyButton.setAttribute('aria-label', COPY_LABEL);
        copyButton.innerHTML = COPY_ICON;
        // Wording follows the label: 复制路径, then 已复制 for COPIED_HOLD_MS.
        attachTip(copyButton, function () { return copyButton.getAttribute('aria-label') || COPY_LABEL; });
        copyButton.addEventListener('click', function (event) {
          event.preventDefault();
          event.stopPropagation();
          copyRefPath(state, copyButton);
        });
        var note = document.createElement('span');
        note.className = 'dshpb-note';
        note.textContent = '未声明，使用默认';
        controls.appendChild(resButton);
        // Between 分辨率 and the picker (user call): one more icon in the same
        // group, so neither the size button's x nor the copy-path button moves.
        controls.appendChild(replayButton);
        controls.appendChild(pickButton);
        // Rightmost, where the shell's copy icon used to be: the row reads
        // 尺寸 -> 重放 -> 选取 -> 复制, so neither of the other three moves.
        controls.appendChild(copyButton);
        if (!state.declared || !state.hDeclared) controls.appendChild(note);
        if (slot === header) slot.appendChild(controls);
        else slot.insertBefore(controls, slot.firstChild);
        state.controls = controls;
        state.resButton = resButton;
        state.pickButton = pickButton;
        state.replayButton = replayButton;
        state.copyButton = copyButton;
        state.note = note;
        // A rebuilt banner must not silently un-light an armed picker.
        if (state.pick) {
          pickButton.classList.add('dshpb-pick-on');
          pickButton.setAttribute('aria-pressed', 'true');
        }
        updateControls(state);
        // Ours are in place; now stand the shell's copy icon down. The .dshpb-ctl
        // wrapper is what tells our four apart from theirs, so this runs last.
        if (OWN_COPY_BUTTON) {
          try { hideShellCopyButton(state); } catch (e) { /* someone else's DOM: leave it be */ }
        }
      }

      // ── the banner's hover hint (2026-11-11, second pass) ────────────────────
      // History worth keeping: the row used to carry the browser's native title,
      // and that was reported DEAD on real hardware ("尺寸的悬停直接没了"). The
      // conclusion it replaced — "no floating node in headless means a native
      // title, so a title everywhere is consistent" — was an inference from
      // headless alone, and headless cannot tell the two apart: a native tooltip
      // lives in the browser UI layer and never enters the render tree, so
      // "nothing in the DOM" means either a native tip or NO tip at all. The user
      // saw the second. Hence: one hand-owned bubble, measured against the shell's
      // copy-path tooltip, the one hint on this row that is proven, controllable
      // and observable from headless. Values come from
      // out/probe/tooltip-bubble/report-shell.json.
      var TIP_ID = 'dshpb-tip';
      var TIP_GAP = 8;     // the shell's bubble sits 8px above the button
      var TIP_MARGIN = 8;  // and never closer than 8px to a viewport edge
      // Dwell before the pointer earns a bubble (user call, 2026-11-11, 4th
      // round: "一碰就弹" is noise in a row this dense). One number, one place:
      // 800ms — under 400 a sweep still pops, over 1500 reads as "no response".
      // The existing 150ms fade follows it, so a committed bubble is complete
      // at ~950ms. Keyboard focus never waits (see attachTip).
      var TIP_DELAY_MS = 800;
      var tipNode = null;
      var tipTimer = 0;       // the pending dwell, if any
      var tipPendingFor = null;  // the button that dwell belongs to
      var tipShownFor = null;    // the button the visible bubble belongs to
      function tipEl() {
        if (tipNode && tipNode.parentNode) return tipNode;
        tipNode = document.createElement('span');
        tipNode.className = 'dshpb-tip';
        tipNode.id = TIP_ID;
        tipNode.setAttribute('role', 'tooltip');
        document.body.appendChild(tipNode);
        return tipNode;
      }
      // Every exit path (mouseleave, blur, click, scroll, resize, dispose) comes
      // through here, so a pending dwell can never outlive its hover.
      function hideTip() {
        if (tipTimer) { window.clearTimeout(tipTimer); tipTimer = 0; }
        tipPendingFor = null;
        tipShownFor = null;
        if (tipNode) tipNode.style.display = 'none';
      }
      // The pointer path: wait TIP_DELAY_MS, and only then commit. Each button
      // keeps its own count — the timer is cleared the moment that hover ends,
      // so crossing four icons in a row accumulates nothing.
      function showTipAfterDwell(button, text) {
        // Already up for this same button: re-entering does not re-pop it.
        if (tipShownFor === button && tipNode && tipNode.style.display !== 'none') return;
        // Already counting for this same button (a click's focus lands here):
        // do not restart the clock.
        if (tipTimer && tipPendingFor === button) return;
        if (tipTimer) window.clearTimeout(tipTimer);
        tipPendingFor = button;
        tipTimer = window.setTimeout(function () {
          tipTimer = 0;
          tipPendingFor = null;
          showTip(button, text);
        }, TIP_DELAY_MS);
      }
      function showTip(button, text) {
        // A hint whose wording the shell owns (the copy button says 已复制 after a
        // click) passes a function, read at commit time, not at attach time.
        if (typeof text === 'function') text = text();
        var node = tipEl();
        tipShownFor = button;
        if (node.textContent !== text) node.textContent = text;
        node.style.display = 'inline-flex';
        var rect = button.getBoundingClientRect();
        var w = node.offsetWidth;
        var h = node.offsetHeight;
        // Above-centred; these icons sit at the right edge, so "centred" gets held
        // inside the viewport instead of being cut off (a clipped hint is worse
        // than one leaning left). No room above means below, same box maths.
        var cx = rect.left + rect.width / 2;
        var half = w / 2 + TIP_MARGIN;
        if (cx + half > window.innerWidth) cx = window.innerWidth - half;
        if (cx - half < 0) cx = half;
        var top = rect.top - TIP_GAP;
        var side = 'top';
        if (top - h < TIP_MARGIN) { side = 'bottom'; top = rect.bottom + TIP_GAP; }
        node.setAttribute('data-side', side);
        node.style.left = Math.round(cx) + 'px';
        node.style.top = Math.round(top) + 'px';
      }
      // Hover/focus hint for one banner button; aria-describedby points at it.
      function attachTip(button, text) {
        button.setAttribute('aria-describedby', TIP_ID);
        button.addEventListener('mouseenter', function () { showTipAfterDwell(button, text); });
        button.addEventListener('mouseleave', hideTip);
        // Keyboard focus is intent, not a sweep, so it skips the dwell. A pointer
        // that lands on the button focuses it too (mousedown), and that one must
        // NOT get the bubble for free — hence the :hover test. Leaving it out
        // would make every click flash the hint before its own click handler
        // hides it.
        button.addEventListener('focus', function () {
          if (button.matches(':hover')) showTipAfterDwell(button, text);
          else showTip(button, text);
        });
        button.addEventListener('blur', hideTip);
        // A click that opens something (the resolution menu, the picker) means the
        // hint has done its job; leaving it up would cover what it opened.
        button.addEventListener('click', hideTip);
      }

      // ── the 4th icon: we render our own copy button (2026-11-11, 5th round) ──────
      // Why not use the shell's: the banner is the shell's own CodeBlock, so its copy
      // icon comes from primitives' `CodeToolbar` — a <button> inside a `Tooltip` whose
      // `delayMs` defaults to 0. CodeBlock's props (code/lang/…/copyLabel/copiedLabel/
      // toolbarLabels/wrap) cannot reach that prop, and the bubble is portaled to
      // document.body, so no scoped CSS can delay it either. Every route to the shell's
      // bubble therefore ends up either patching React's own event delegation (failed
      // in practice: the same-node listeners at document still ran) or a global rule
      // that would slow every tooltip in the app.
      // So: our card gets its OWN fourth button, rendered here like the other three —
      // same attachTip, same 800ms, same #dshpb-tip node — and the shell's one is
      // hidden inside this card only (SHELL_COPY_HIDDEN class, node-identity matched).
      // Nothing global is intercepted: a chat code block elsewhere keeps the shell's
      // instant bubble because we never touch anything outside state.header.
      // If the shell ever changes the banner's DOM, the hide stops matching and the
      // symptom is visible and harmless: two copy buttons, not a silent slowdown.
      // OWN_COPY_BUTTON = false drops both halves and leaves the shell's button alone.
      var OWN_COPY_BUTTON = true;
      var COPIED_HOLD_MS = 1600;
      var COPY_ICON = '<svg viewBox="0 0 13 13" aria-hidden="true">' +
        '<rect x="2" y="4.2" width="6.8" height="6.8" rx="1.4"/>' +
        '<path d="M4.4 4.2V3.2c0-.9.7-1.6 1.6-1.6h3.2c.9 0 1.6.7 1.6 1.6v3.2c0 .9-.7 1.6-1.6 1.6h-1"/></svg>';
      var COPIED_ICON = '<svg viewBox="0 0 13 13" aria-hidden="true"><path d="M2.6 6.9l2.7 2.7 5.1-6"/></svg>';
      /**
       * The shell's copy button inside THIS banner, found by identity, not by class:
       * it is the only <button> left in the header that is not inside our .dshpb-ctl
       * (buildControls already removed the shell's wrap toggle).
       */
      function shellCopyButton(header) {
        if (!header || !header.querySelectorAll) return null;
        var all = header.querySelectorAll('button');
        var found = null;
        for (var i = 0; i < all.length; i += 1) {
          if (!all[i].closest('.dshpb-ctl')) found = all[i];
        }
        return found;
      }
      /**
       * Hide the shell's copy icon inside this banner. Kept in the DOM (React owns it;
       * removing it would fight the reconciler) — display:none via a class the shell
       * never writes, plus aria-hidden/tabIndex so it leaves the a11y tree too.
       * ponytail: a re-render that rewrites style/class would un-hide it, so a
       * MutationObserver re-asserts on that one node. Ceiling: one observer per block;
       * if the shell ever remounts the whole banner, buildControls runs again anyway.
       */
      function hideShellCopyButton(state) {
        var button = shellCopyButton(state.header);
        if (!button) return;
        var assert = function () {
          if (!button.isConnected) { if (state.copyObserver) state.copyObserver.disconnect(); return; }
          if (button.style.display !== 'none') button.style.display = 'none';
          if (!button.classList.contains('dshpb-shellcopy')) button.classList.add('dshpb-shellcopy');
          if (button.getAttribute('aria-hidden') !== 'true') button.setAttribute('aria-hidden', 'true');
          if (button.tabIndex !== -1) button.tabIndex = -1;
        };
        assert();
        if (state.hiddenCopy !== button) {
          if (state.copyObserver) state.copyObserver.disconnect();
          state.hiddenCopy = button;
          state.copyObserver = new MutationObserver(assert);
          state.copyObserver.observe(state.header, { subtree: true, childList: true, attributes: true, attributeFilter: ['style', 'class'] });
        }
      }
      /** Write the block's reference path, then show 已复制 for COPIED_HOLD_MS. */
      function copyRefPath(state, button) {
        var restore = function () {
          if (state.copyTimer) { window.clearTimeout(state.copyTimer); state.copyTimer = 0; }
          button.setAttribute('aria-label', COPY_LABEL);
          button.innerHTML = COPY_ICON;
        };
        var settle = function (ok, why) {
          if (state.copyTimer) window.clearTimeout(state.copyTimer);
          button.setAttribute('aria-label', ok ? COPIED_LABEL : '复制失败');
          button.innerHTML = ok ? COPIED_ICON : COPY_ICON;
          state.copyTimer = window.setTimeout(restore, COPIED_HOLD_MS);
          // A failed write must never be silent: the label is the bubble's wording,
          // and the toast says it out loud.
          if (!ok) showToast('复制失败' + (why ? '：' + why : ''));
        };
        var text = state.refPath || '';
        try {
          if (!navigator.clipboard || !navigator.clipboard.writeText) { settle(false, '此环境不允许写剪贴板'); return; }
          navigator.clipboard.writeText(text).then(function () { settle(true); }, function (e) { settle(false, (e && e.message) || '写剪贴板被拒绝'); });
        } catch (e) { settle(false, (e && e.message) || '写剪贴板抛错'); }
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
        if (state.player && state.pickWasPlaying) { state.pickWasPlaying = false; state.player.play(); }
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
        // A pick must not fight the running timeline: the player would keep
        // switching pages under the pointer. Remember, pause, restore on disarm.
        if (state.player) {
          state.pickWasPlaying = !!(state.playerState && state.playerState.playing);
          if (state.pickWasPlaying) state.player.pause();
        }
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
        if (node.closest('[contenteditable="true"], [data-lexical-editor], pre, code') !== null) return true;
        // A paragraph whose whole text sits inside an inline <code> (or a <pre>)
        // is markup that QUOTES a directive line, not one that asks for a block:
        // that is the same intent as a fence, so it gets the same answer. Text
        // like `文字 <code>::dsh-ui x::</code> 文字` already failed the parser;
        // this closes the case where the code element is the only content, whose
        // textContent still equals the line exactly.
        return node.querySelector('code, pre') !== null;
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
        frame.addEventListener('load', function () { injectFrame(state); });
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
        state.replayButton = null;
        state.note = null;
        state.paintedKey = null;
        state.appliedTokensKey = null;
        state.appliedAttrsKey = null;
        state.urlMode = false;
        destroyPlayer(state);
        state.stage = null;
        state.mount = null;
        state.paintedBody = null;
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
            // One content model for every block — always an object, never null.
            spec: readSpec(body),
            degraded: false,
            paintedKey: null,
            tokensKey: '',
            appliedAttrsKey: ''
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
        var bodyChanged = state.body !== body;
        state.firstLine = line;
        state.body = body;
        // The spec is re-read for every block, timeline or not: a block with no
        // timeline is the zero-step case of the same model, not another kind.
        state.spec = readSpec(body);
        // A new body gets a fresh chance: a block that had to fall back to its
        // entry document may well be fixed now.
        if (bodyChanged) state.degraded = false;
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
          destroyPlayer(state);
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
          if (!hasTimeline(state.spec) && state.frame.getAttribute('srcdoc') === null && state.frame.getAttribute('src') === null) { state.paintedKey = null; paint(state); }
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
      // The hint is fixed-positioned; once the page moves under it, it is lying.
      var onResize = function () { hideTip(); schedule(); };
      window.addEventListener('resize', onResize);
      window.addEventListener('scroll', hideTip, true);
      var onDown = function (event) { if (menu && !menu.contains(event.target)) closeMenu(); };
      var onKey = function (event) { if (event.key === 'Escape') closeMenu(); };
      document.addEventListener('pointerdown', onDown, true);
      document.addEventListener('keydown', onKey, true);
      schedule();

      var api = {
        version: '0.6.1',
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
          /** The token sheet alone: a served block document gets it injected. */
          sheet: function () { return tokenSheet(readTokens()); },
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
        /**
         * Test seam: a banner button, as a function — ⟲ calls EXACTLY what the
         * button calls (reloadBlock), never a nearby copy of it.
         */
        replay: function (index) { var s = live[index || 0]; if (!s) return null; return reloadBlock(s); },
        /** Test seam: the banner row as built (for comparing two blocks field by field). */
        header: function (index) {
          var s = live[index || 0];
          if (!s || !s.controls) return null;
          return { html: s.controls.outerHTML, buttons: s.controls.querySelectorAll('button').length };
        },
        /** Test seam: press the banner's ⟲ exactly the way a pointer does. */
        press: function (index) {
          var s = live[index || 0];
          if (!s || !s.controls) return null;
          var b = s.controls.querySelector('.dshpb-replay');
          if (!b) return null;
          b.click();
          return true;
        },
        /**
         * Test seam: one block's content model. Every block answers, timeline or
         * not — { snapshots, steps, loop, timeline, degraded }, never null for a
         * live block. `timeline` is the parameter every branch reads.
         */
        spec: function (index) {
          var s = live[index || 0];
          if (!s) return null;
          var spec = s.spec;
          return {
            snapshots: Object.keys(spec.snapshots),
            steps: spec.timeline.steps.length,
            loop: spec.timeline.loop !== false,
            timeline: hasTimeline(spec),
            degraded: !!s.degraded,
            player: !!s.player
          };
        },
        /**
         * Test seam: one block's player facts (player:false when the block has no
         * timeline). Read-only except play/pause/restart/reload, which are the
         * same functions the banner uses.
         */
        player: function (index) { return playerInfoOf(index); },
        play: function (index) { var s = live[index || 0]; if (s && s.player) s.player.play(); return playerInfoOf(index); },
        pause: function (index) { var s = live[index || 0]; if (s && s.player) s.player.pause(); return playerInfoOf(index); },
        sweep: function () {
          sweep();
          return {
            stats: stats,
            tokenCount: tokenCache.count,
            scheme: tokenCache.scheme,
            live: live.map(function (s) {
              return {
                ref: s.refPath,
                timeline: hasTimeline(s.spec),
                steps: s.spec.timeline.steps.length,
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
        if (typeof seatDispose === 'function') seatDispose();
        seatDispose = null;
        observer.disconnect();
        headObserver.disconnect();
        window.clearInterval(timer);
        window.removeEventListener('resize', onResize);
        window.removeEventListener('scroll', hideTip, true);
        if (tipTimer) { window.clearTimeout(tipTimer); tipTimer = 0; }
        tipPendingFor = null;
        tipShownFor = null;
        if (tipNode && tipNode.parentNode) tipNode.parentNode.removeChild(tipNode);
        tipNode = null;
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

    // -- browser-extension detail section ----------------------------------
    // One section under dsh-ui-block's own page in Settings -> Plugins: where the
    // packaged extension lives, a button that opens that folder, the three steps
    // to load it unpacked, and the "moving the plugin means reloading the
    // extension" note. The slot renders it on that page only and gives every
    // other detail page null. It only READS the host's fixed path and never
    // sends one, so nothing typed or clicked here can widen the host's reveal
    // route.
    var EXTENSION_ROUTE = '/ui-block-extension';
    var EXT_SETTINGS_CSS = [
      '.dshub-ext{display:flex;flex-direction:column;gap:12px}',
      '.dshub-ext-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;align-items:start}',
      '.dshub-ext-card{display:flex;flex-direction:column;gap:8px;min-width:0;padding:12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px}',
      '.dshub-ext-title{margin:0;font-size:14px;font-weight:500;line-height:20px;color:var(--dsw-alias-label-primary)}',
      '.dshub-ext-tag{align-self:flex-start;height:18px;line-height:18px;padding:0 6px;border-radius:4px;background:var(--dsw-alias-interactive-bg);color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xxs-12)}',
      '.dshub-ext-line{margin:0;font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-secondary);line-height:1.6}',
      '.dshub-ext-ver{font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-tertiary)}',
      '.dshub-ext-row{display:flex;align-items:center;gap:8px}',
      '.dshub-ext-path{flex:1 1 auto;min-width:0;height:28px;padding:0 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:var(--dsw-font-xxs-12)}',
      '.dshub-ext-btn{flex:none;height:28px;padding:0 14px;border-radius:6px;cursor:pointer;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-interactive-bg);color:var(--dsw-alias-label-primary);font:var(--dsw-font-xxs-12)}',
      '.dshub-ext-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dshub-ext-steps{margin:0;padding-left:18px;display:flex;flex-direction:column;gap:4px;font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-secondary);line-height:1.6}',
      '.dshub-ext-hint{font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-tertiary);line-height:1.6}',
      '.dshub-ext-status{font:var(--dsw-font-xxs-12);line-height:1.6;color:var(--dsw-alias-label-tertiary)}',
      '.dshub-ext-status-on{color:var(--dsw-alias-state-success-primary)}',
      '.dshub-ext-note{font:var(--dsw-font-xxs-12);color:var(--dsw-alias-state-success-primary);word-break:break-all}',
      '.dshub-ext-bad{font:var(--dsw-font-xxs-12);color:var(--dsw-alias-state-error-primary);word-break:break-all}'
    ].join('');

    /** "12 秒前": an ISO timestamp as time since, '' when it is not one. */
    function relativeTime(value) {
      var at = Date.parse(String(value === undefined || value === null ? '' : value));
      if (!isFinite(at)) return '';
      var seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
      if (seconds < 60) return seconds + ' 秒前';
      var minutes = Math.round(seconds / 60);
      if (minutes < 60) return minutes + ' 分钟前';
      var hours = Math.round(minutes / 60);
      if (hours < 24) return hours + ' 小时前';
      return Math.round(hours / 24) + ' 天前';
    }

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

    /** The slot entry the card lives in. The self-check reads this, not the DOM. */
    var EXT_SETTINGS_ENTRY = { name: 'plugins.detail.section', id: 'ui-block-extension', order: 100 };

    /**
     * True only for dsh-ui-block's own package page. The slot hands every detail
     * page the same { subject } props, so the card has to say no to the rest:
     * official plugins and single rows are 'item' / 'row', and another package is
     * a 'bundle' whose pkg.name is something else.
     */
    function extensionSubjectMatch(subject) {
      return subject !== null && typeof subject === 'object'
        && subject.kind === 'bundle'
        && subject.pkg !== null && typeof subject.pkg === 'object'
        && subject.pkg.name === 'dsh-ui-block';
    }

    /** One card: name, one line of purpose, path, copy, reveal, the three steps. */
    function ExtensionCard(props) {
      var h = react.createElement;
      var copiedState = react.useState(false);
      var copied = copiedState[0];
      var setCopied = copiedState[1];
      var noteState = react.useState('');
      var note = noteState[0];
      var setNote = noteState[1];
      var dir = String(props.dir || '');

      function copyDir() {
        if (dir === '') return;
        var done = function () {
          setCopied(true);
          window.setTimeout(function () { setCopied(false); }, 1600);
        };
        try {
          if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            navigator.clipboard.writeText(dir).then(done, function () {
              fallbackCopy(dir);
              done();
            });
            return;
          }
        } catch (e) { /* fall through to the textarea path */ }
        fallbackCopy(dir);
        done();
      }

      /** Reveal THIS card's directory: the host picks it by name, never by a path from here. */
      function reveal() {
        setNote('正在打开文件夹…');
        var query = props.kind === 'capture' ? '?which=extension-capture' : '';
        window.fetch(EXTENSION_ROUTE + '/reveal' + query, {
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

      var pathValue = dir === ''
        ? (props.phase === 'error' ? '（读取失败）' : '读取中…')
        : dir;
      return h('div', { className: 'dshub-ext-card', 'data-dsh-ui-block-extension': props.kind },
        h('div', { className: 'dshub-ext-title' }, props.title),
        h('span', { className: 'dshub-ext-tag' }, props.tag),
        h('p', { className: 'dshub-ext-line' }, props.line),
        h('div', { className: 'dshub-ext-ver' }, props.version === '' ? '扩展版本未知' : '扩展版本 ' + props.version + ' · 与插件 package.json 同版'),
        h('div', { className: 'dshub-ext-row' },
          h('input', {
            className: 'dshub-ext-path',
            value: pathValue,
            readOnly: true,
            'aria-label': props.title + ' 的安装目录',
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
        props.extra === '' ? null : h('div', { className: 'dshub-ext-hint' }, props.extra),
        props.missing === true && dir !== '' ? h('div', { className: 'dshub-ext-bad' }, '目录不存在：' + dir) : null,
        note === '' ? null : h('div', { className: /失败/.test(note) ? 'dshub-ext-bad' : 'dshub-ext-note' }, note)
      );
    }

    /**
     * Plugins -> dsh-ui-block: the two companion extensions, side by side.
     * One takes a single element, the other takes the whole page — the tag on
     * each card says which, because picking the wrong one is the only way this
     * page can fail its user.
     */

    function ExtensionSettingsCard(props) {
      if (!extensionSubjectMatch(props ? props.subject : undefined)) return null;
      if (react === null || typeof react.useState !== 'function') return null;
      var h = react.createElement;
      var infoState = react.useState({
        phase: 'loading', dir: '', version: '', captureDir: '', captureVersion: '', captureExists: false, agents: []
      });
      var info = infoState[0];
      var setInfo = infoState[1];
      var noteState = react.useState('');
      var note = noteState[0];
      var setNote = noteState[1];

      react.useEffect(function () {
        var live = true;
        // The status line is about RIGHT NOW, so the same read repeats on a slow
        // timer: an extension that starts or stops reporting shows up without
        // anyone reopening this page, and the relative time stays honest.
        function load() {
          window.fetch(EXTENSION_ROUTE, { credentials: 'same-origin', cache: 'no-store' })
            .then(function (res) {
              if (!res.ok) throw new Error('HTTP ' + res.status);
              return res.json();
            })
            .then(function (body) {
              if (!live) return;
              setInfo({
                phase: 'ready',
                dir: String(body.dir || ''),
                version: String(body.version || ''),
                captureDir: String(body.captureDir || ''),
                captureVersion: String(body.captureVersion || ''),
                captureExists: body.captureExists === true,
                agents: Array.isArray(body.agents) ? body.agents : []
              });
            })
            .catch(function (error) {
              if (!live) return;
              setInfo({ phase: 'error', dir: '', version: '', captureDir: '', captureVersion: '', captureExists: false, agents: [] });
              setNote('读取扩展目录失败：' + errorText(error));
            });
        }
        load();
        var timer = window.setInterval(load, 5000);
        return function () {
          live = false;
          window.clearInterval(timer);
        };
      }, []);

      var ready = info.phase === 'ready';
      // Who is reporting in right now. The newest live report wins the line; a page
      // with several browsers says how many instead of pretending there is one.
      // A record the host marked stale is OFFLINE, not connected, and gets its own
      // wording: "已断开" says it was here and stopped, which "尚未检测到" cannot.
      var agents = ready && Array.isArray(info.agents) ? info.agents : [];
      var newest = null;       // reporting right now
      var newestStale = null;  // reported before, now offline
      var liveCount = 0;
      for (var agentIndex = 0; agentIndex < agents.length; agentIndex += 1) {
        var agent = agents[agentIndex];
        var spot = Date.parse(String((agent && agent.lastSeenAt) || ''));
        if (!isFinite(spot)) continue;
        if (agent.stale === true) {
          if (newestStale === null || spot > newestStale.at) newestStale = { at: spot, agent: agent };
          continue;
        }
        liveCount += 1;
        if (newest === null || spot > newest.at) newest = { at: spot, agent: agent };
      }
      var statusText = newest !== null
        ? '已连接：' + String(newest.agent.instance || '未知实例') + '（' + relativeTime(newest.agent.lastSeenAt)
          + (liveCount > 1 ? '，共 ' + liveCount + ' 个实例上报' : '') + '）'
        : newestStale !== null
          ? '已断开：' + String(newestStale.agent.instance || '未知实例') + '（' + relativeTime(newestStale.agent.lastSeenAt) + '）'
          : (ready || info.phase === 'error' ? '尚未检测到扩展上报' : '正在读取扩展状态…');
      return h('div', { className: 'dshub-ext' },
        h('div', {
          className: 'dshub-ext-status' + (newest === null ? '' : ' dshub-ext-status-on'),
          'data-dsh-ui-block-agents': String(agents.length)
        }, statusText),
        h('div', { className: 'dshub-ext-grid' },
          h(ExtensionCard, {
            kind: 'picker',
            title: '浏览器扩展 dsh-element-picker',
            tag: '取一个元素',
            line: '点页面上某一个按钮、卡片或输入框，把它的样子连同样式复制成一段素材。改单个组件、做局部对齐时用它。',
            phase: info.phase,
            dir: ready ? info.dir : '',
            version: info.version,
            extra: ''
          }),
          h(ExtensionCard, {
            kind: 'capture',
            title: '浏览器扩展 dsh-page-capture',
            tag: '取整页',
            line: '把当前这一整页抽成素材包（HTML + 样式 + 图片 + 字体），交给 DSH 装成块。复刻一整页、做页面级草稿时用它。',
            phase: info.phase,
            dir: ready ? info.captureDir : '',
            version: info.captureVersion,
            missing: ready && info.captureExists !== true,
            extra: '装好后打开这个扩展的「扩展程序选项」，把 baseURL 指到当前实例的端口（http://127.0.0.1:3080 或 http://127.0.0.1:4000）。指到另一个实例时，这边的 list_pages 永远是空的。'
          })
        ),
        h('div', { className: 'dshub-ext-hint' }, '插件换目录（重装、换实例）后，两张扩展都要回到 chrome://extensions 重新加载一次，否则浏览器里跑的仍是旧目录那份。'),
        note === '' ? null : h('div', { className: /失败/.test(note) ? 'dshub-ext-bad' : 'dshub-ext-note' }, note)
      );
    }

    /**
     * Register the Plugins -> dsh-ui-block detail section. The slots service can
     * still be inactive at first paint, so read it non-strictly and skip silently
     * when it is absent; the registration itself waits for the slot declaration.
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
        return slots.inject(EXT_SETTINGS_ENTRY.name, function () {
          return slots.register(EXT_SETTINGS_ENTRY, ExtensionSettingsCard);
        });
      }, 'dsh-ui-block: extension detail section');
    }

    return {
      apply: function (ctx) {
        // Element half FIRST: the `element` @ source this file registers is what
        // renders a picked element as a chip and what serializes it back, so the
        // canvas picker below can never run before it exists.
        applyElementChip(ctx);
        // Third half: the packaged browser extension's detail section. Independent
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
        extensionSubjectMatch: extensionSubjectMatch,
        extensionEntry: EXT_SETTINGS_ENTRY,
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
