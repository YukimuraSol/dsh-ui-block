// dsh-element-picker content script.
// Injected on demand by background.js (chrome.action.onClicked -> executeScript).
// Picks elements into an inline-editable toolbar. "确定" writes the body text to the clipboard;
// every pick expands in place to a self-contained element«four lines» token, so the body text is
// the whole truth - no [N] markers, no payload block, no appendix.
// No bridge, no WebSocket, no prompt() - picking is the only step.
(() => {
  if (globalThis.__dshElementPickerInstalled) return
  globalThis.__dshElementPickerInstalled = true

  // Clipboard contract. The body IS the truth: every pick expands in place to one
  // element«four lines» token, so there is no marker to find, no [N] to pair, no appendix.
  const TOKEN_OPEN = 'element\u00ab'
  const TOKEN_CLOSE = '\u00bb'
  // Truncation ceilings for the HTML Element line (plan 5.3): a big div must not explode.
  const MAX_ATTRS = 8
  const MAX_TEXT = 80
  const PLACEHOLDER = '点页面元素加入引用，可直接打字说明'
  const GREEN = '#7bd88f'
  const BLUE = '#4d6bfe'
  const MIN_W = 300
  const MIN_H = 96

  // Element names we are willing to print unquoted in a chip tooltip. Anything else is a
  // class/attribute being mistaken for a tag (body.tab-stasis used to read as <tab-stasis>).
  const KNOWN_TAGS = new Set(('a abbr address area article aside audio b base bdi bdo blockquote body br button canvas ' +
    'caption cite code col colgroup data datalist dd del details dfn dialog div dl dt em embed fieldset ' +
    'figcaption figure footer form h1 h2 h3 h4 h5 h6 head header hgroup hr html i iframe img input ins kbd ' +
    'label legend li link main map mark menu meta meter nav noscript object ol optgroup option output p ' +
    'param picture pre progress q rp rt ruby s samp script section select slot small source span strong style ' +
    'sub summary sup table tbody td template textarea tfoot th thead time title tr track u ul var video wbr').split(' '))

  let cleanup = () => {}
  const IS_TOP = window === window.top
  // Assigned by the top frame's start(). Registered once, not per start(), so repeated picks
  // cannot stack listeners.
  let onFramePick = null
  let onFrameHover = null
  let onStopAll = null
  // Set by the top frame's mode switch. Every frame is armed, so a child frame needs the same
  // browsing flag; this is the hook the one-shot 'mode' broadcast lands on.
  let onModeAll = null
  let stopping = false

  // Release every frame. Esc and 确定 land in whichever frame has focus, but the picker is
  // armed in all of them, so a local cleanup is never enough.
  function stopEverywhere() {
    if (stopping) return
    stopping = true
    cleanup()
    if (IS_TOP) {
      for (let i = 0; i < window.frames.length; i++) {
        try { window.frames[i].postMessage({ __dshElementPicker: 'stop-all' }, '*') } catch {}
      }
    } else {
      try { window.top.postMessage({ __dshElementPicker: 'stop' }, '*') } catch {}
    }
    stopping = false
  }

  // Top-frame viewport offset of the frame that sent a message. A child frame reports rects in
  // its own viewport, so the top frame must add this before painting anything.
  // ponytail: same-origin and one nesting level deep only - a cross-origin or deeper frame
  // reports (0,0) and its highlight lands in the wrong place. That is the documented ceiling.
  function frameOffset(source) {
    const frames = document.querySelectorAll('iframe')
    for (const frame of frames) {
      try {
        if (frame.contentWindow !== source) continue
        const rect = frame.getBoundingClientRect()
        return { vx: rect.left + frame.clientLeft, vy: rect.top + frame.clientTop }
      } catch {}
    }
    return { vx: 0, vy: 0 }
  }

  if (IS_TOP) {
    window.addEventListener('message', event => {
      const data = event.data
      if (!data || !data.__dshElementPicker) return
      const offset = frameOffset(event.source)
      if (data.__dshElementPicker === 'pick' && Array.isArray(data.elements)) { if (onFramePick) onFramePick(data.elements, offset); return }
      // The armed frame is an iframe, so the top frame cannot compute its stack; the frame that
      // has the pointer computes the rect and sends it for the top frame to paint.
      if (data.__dshElementPicker === 'hover' && onFrameHover) onFrameHover(data.rect || null, offset)
      // Esc / 确定 pressed while focus sits in a child frame must release the whole page.
      if (data.__dshElementPicker === 'stop') stopEverywhere()
    }, true)
  } else {
    // A child frame only ever needs the top frame's release broadcast. Without this listener a
    // top-frame Esc/确定 cleaned up the top frame while the iframe stayed armed and kept
    // swallowing the page's clicks.
    window.addEventListener('message', event => {
      const data = event.data
      if (data && data.__dshElementPicker === 'stop-all' && onStopAll) onStopAll()
      // The toolbar lives in the top frame only, but this frame swallows the page's events too,
      // so a mode switch there has to reach every armed frame or an iframe keeps eating clicks.
      if (data && data.__dshElementPicker === 'mode' && onModeAll) onModeAll(data.mode)
    }, true)
  }

  chrome.runtime.onMessage.addListener(message => {
    if (message && message.type === 'dsh-picker-start') start()
  })

  function start() {
    cleanup()
    // Every frame is injected and armed (background uses allFrames). Freeze listeners must be
    // live in the frame the click actually lands in, and only that frame receives the click -
    // so arming all of them is what makes an iframe table pickable and freezable. Only the top
    // frame paints UI: one toolbar, one clipboard owner, no toolbar per frame.
    const picks = []
    let hovered
    let lastError
    let dragging = false
    let suppressClickUntil = 0
    let pickCount = 0
    let manualPanel = null
    // Browse mode: every listener stays registered and simply stops doing the work.
    let browsing = false

    const hoverBox = document.createElement('div')
    hoverBox.dataset.dshElementPickerHover = 'true'
    Object.assign(hoverBox.style, {
      position: 'fixed', pointerEvents: 'none', zIndex: '2147483646',
      border: '2px solid ' + BLUE, background: 'rgba(77,107,254,.12)', display: 'none',
    })

    const toolbar = document.createElement('div')
    toolbar.dataset.dshElementPickerUi = 'true'
    Object.assign(toolbar.style, {
      position: 'fixed', top: '16px', zIndex: '2147483647',
      display: 'flex', flexDirection: 'column', gap: '6px', boxSizing: 'border-box',
      padding: '8px 10px 10px', borderRadius: '10px', background: '#111827',
      color: '#fff', font: '13px system-ui, sans-serif', boxShadow: '0 8px 30px rgba(0,0,0,.3)',
      overflow: 'hidden',
    })
    const initialWidth = Math.max(280, Math.min(560, innerWidth - 24))
    toolbar.style.width = initialWidth + 'px'
    toolbar.style.left = Math.max(8, Math.round((innerWidth - initialWidth) / 2)) + 'px'

    // Title bar: drag handle + hint + 确定, one line. Dragging the bar moves the panel so it
    // cannot sit on the page content the user is trying to look at.
    const handle = document.createElement('div')
    handle.dataset.dshElementPickerHandle = 'true'
    Object.assign(handle.style, {
      display: 'flex', alignItems: 'center', gap: '6px', cursor: 'move',
      font: '11px system-ui, sans-serif', color: '#9aa4b2', userSelect: 'none',
      minHeight: '26px',
      // Containing block for the centred mode switch below. It is absolutely positioned, so
      // this does not touch the bar's flex layout and 确定 keeps its marginLeft:auto.
      position: 'relative',
    })
    const handleGrip = document.createElement('span')
    handleGrip.textContent = '\u283F'
    const handleText = document.createElement('span')
    handleText.textContent = '拖动此处移动面板'
    const notice = document.createElement('span')
    notice.dataset.dshElementPickerNotice = 'true'
    Object.assign(notice.style, { color: '#fca5a5', display: 'none', marginLeft: 'auto' })
    const done = document.createElement('button')
    done.dataset.dshElementPickerDone = 'true'
    done.textContent = '确定'
    Object.assign(done.style, {
      marginLeft: 'auto', flex: '0 0 auto', border: '0', borderRadius: '6px',
      padding: '3px 12px', cursor: 'pointer', background: BLUE, color: '#fff',
      fontSize: '12px', fontWeight: '600',
    })
    done.addEventListener('click', event => { event.stopPropagation(); void confirm() })
    // The button sits inside the drag bar, so the gesture must never start on it.
    done.addEventListener('pointerdown', event => { event.stopPropagation() })

    // Mode switch, dead centre of the title bar: 选取 (pick) / 浏览 (browse). It is a <button>,
    // so gesture()'s closest('button') guard already stops it from starting a panel drag.
    const modeBox = document.createElement('div')
    modeBox.dataset.dshElementPickerModeBox = 'true'
    Object.assign(modeBox.style, {
      position: 'absolute', left: '50%', transform: 'translateX(-50%)', top: '50%',
      marginTop: '-11px', display: 'flex', border: '1px solid #3a4658',
      borderRadius: '999px', overflow: 'hidden', background: '#1b2231',
    })
    const modePick = document.createElement('button')
    modePick.dataset.dshElementPickerModePick = 'true'
    modePick.type = 'button'
    modePick.textContent = '选取'
    const modeBrowse = document.createElement('button')
    modeBrowse.dataset.dshElementPickerModeBrowse = 'true'
    modeBrowse.type = 'button'
    modeBrowse.textContent = '浏览'
    for (const part of [modePick, modeBrowse]) {
      Object.assign(part.style, {
        border: '0', borderRadius: '0', padding: '2px 10px', cursor: 'pointer',
        font: '11px system-ui, sans-serif', fontWeight: '600', lineHeight: '18px',
      })
      // Stop the press at the button: the drag bar underneath must never see it.
      part.addEventListener('pointerdown', event => event.stopPropagation())
    }
    // blur() on both: a momentary toggle must not hold focus. While a toolbar button owns the
    // focus, keydown targets it, onKey()'s isUi() guard bails and Esc stops closing the panel -
    // and Enter would re-fire the switch instead of reaching the page.
    modePick.addEventListener('click', event => { event.stopPropagation(); modePick.blur(); setMode('pick') })
    modeBrowse.addEventListener('click', event => { event.stopPropagation(); modeBrowse.blur(); setMode('browse') })
    modeBox.append(modePick, modeBrowse)

    // The switch is appended last on purpose: absolute positioning does not depend on document
    // order, and the two paint segments are flex children of modeBox, so no DOM reordering
    // needed. Kept here so the diff for the title bar stays in one place.
    handle.append(handleGrip, handleText, notice, done)
    handle.append(modeBox)

    // Test seam for the headless harness, and the single source of truth for the highlight.
    function paintMode() {
      toolbar.dataset.dshElementPickerMode = browsing ? 'browse' : 'pick'
      modePick.style.background = browsing ? '#9aa4b2' : BLUE
      modePick.style.color = '#fff'
      modeBrowse.style.background = browsing ? BLUE : '#9aa4b2'
      modeBrowse.style.color = '#fff'
    }

    function setMode(mode) {
      browsing = mode === 'browse'
      if (browsing) {
        // Leave no stale highlight behind: the next mousemove in pick mode re-acquires.
        hoverBox.style.display = 'none'
        hovered = undefined
        stack = []
      }
      paintMode()
      // The toolbar is top-frame only, but every frame is armed and swallows the page's events,
      // so the switch has to reach all of them. stopEverywhere()'s broadcast shape, one message.
      if (IS_TOP) {
        for (let i = 0; i < window.frames.length; i++) {
          try { window.frames[i].postMessage({ __dshElementPicker: 'mode', mode: browsing ? 'browse' : 'pick' }, '*') } catch {}
        }
      }
    }

    const fieldWrap = document.createElement('div')
    Object.assign(fieldWrap.style, { position: 'relative', display: 'flex', flex: '1 1 auto', minWidth: '0' })

    // The editable body: an inline token model. Chips are contenteditable=false so the caret
    // can never enter them, and plain text can sit before, between and after them.
    const field = document.createElement('div')
    field.dataset.dshElementPickerField = 'true'
    field.contentEditable = 'true'
    field.spellcheck = false
    Object.assign(field.style, {
      flex: '1 1 auto', minWidth: '0', minHeight: '32px', maxHeight: '40vh',
      overflow: 'auto', boxSizing: 'border-box', background: '#1b2231',
      border: '1px solid #2b3446', borderRadius: '7px', padding: '5px 8px',
      lineHeight: '22px', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
      overflowWrap: 'anywhere', outline: 'none', color: '#e6e8ee', cursor: 'text',
    })
    const placeholder = document.createElement('div')
    placeholder.textContent = PLACEHOLDER
    Object.assign(placeholder.style, {
      position: 'absolute', left: '9px', top: '6px', color: '#7c869a',
      pointerEvents: 'none', font: '13px system-ui, sans-serif', lineHeight: '22px',
    })
    fieldWrap.append(field, placeholder)

    // Resize grip. CSS resize:both is unreliable on position:fixed, so this is drawn by hand.
    const grip = document.createElement('div')
    grip.dataset.dshElementPickerGrip = 'true'
    Object.assign(grip.style, {
      position: 'absolute', right: '0', bottom: '0', width: '16px', height: '16px',
      cursor: 'nwse-resize', background: 'linear-gradient(135deg, rgba(0,0,0,0) 0 55%, #4b5563 55% 65%, rgba(0,0,0,0) 65% 72%, #4b5563 72% 82%, rgba(0,0,0,0) 82%)',
    })

    toolbar.append(handle, fieldWrap, grip)
    // Only the top frame paints. A child frame still builds these nodes but never attaches
    // them, so an iframe never gets a second toolbar.
    if (IS_TOP) document.documentElement.append(hoverBox, toolbar)

    function isUi(element) {
      return element && element.closest && element.closest('[data-dsh-element-picker-ui=\'true\']')
    }

    function clamp(value, min, max) {
      return Math.max(min, Math.min(value, max))
    }

    // Keep the panel grabbable: at least 80px of it stays inside the viewport.
    function clampIntoView() {
      const rect = toolbar.getBoundingClientRect()
      toolbar.style.left = clamp(rect.left, 0, Math.max(0, innerWidth - 80)) + 'px'
      toolbar.style.top = clamp(rect.top, 0, Math.max(0, innerHeight - 32)) + 'px'
    }

    // One pointer-capture gesture. dragging suppresses hover and select for the whole gesture,
    // so a drag that crosses the page cannot pick the element under the pointer.
    function gesture(event, kind, onMove) {
      event.preventDefault()
      event.stopPropagation()
      // 确定 lives inside the drag bar: never let a press on it start a move.
      if (event.target && event.target.closest && event.target.closest('button')) return
      const base = toolbar.getBoundingClientRect()
      const startX = event.clientX
      const startY = event.clientY
      dragging = true
      // Test seam: lets the headless harness see which gesture started and from where.
      toolbar.dataset.dshElementPickerGesture = kind
      toolbar.dataset.dshElementPickerBase = JSON.stringify({
        left: Math.round(base.left), top: Math.round(base.top),
        width: Math.round(base.width), height: Math.round(base.height),
      })
      toolbar.dataset.dshElementPickerAt = event.clientX + ',' + event.clientY
      // Tracked on window rather than the handle: pointer capture is not guaranteed for every
      // input source, and a lost capture would freeze the panel mid-drag.
      const move = ev => {
        const dx = ev.clientX - startX, dy = ev.clientY - startY
        toolbar.dataset.dshElementPickerDelta = dx + ',' + dy
        onMove(base, dx, dy)
      }
      const end = () => {
        dragging = false
        suppressClickUntil = performance.now() + 350
        toolbar.dataset.dshElementPickerGesture = ''
        window.removeEventListener('pointermove', move, true)
        window.removeEventListener('pointerup', end, true)
        window.removeEventListener('pointercancel', end, true)
      }
      window.addEventListener('pointermove', move, true)
      window.addEventListener('pointerup', end, true)
      window.addEventListener('pointercancel', end, true)
      try { toolbar.setPointerCapture(event.pointerId) } catch {}
    }

    handle.addEventListener('pointerdown', event => gesture(event, 'move', (base, dx, dy) => {
      toolbar.style.left = clamp(base.left + dx, 0, Math.max(0, innerWidth - 80)) + 'px'
      toolbar.style.top = clamp(base.top + dy, 0, Math.max(0, innerHeight - 32)) + 'px'
    }))
    grip.addEventListener('pointerdown', event => gesture(event, 'resize', (base, dx, dy) => {
      toolbar.style.width = clamp(base.width + dx, MIN_W, Math.max(MIN_W, innerWidth - 24)) + 'px'
      toolbar.style.height = clamp(base.height + dy, MIN_H, Math.max(MIN_H, innerHeight - 24)) + 'px'
      clampIntoView()
    }))

    // --- inline token model ---------------------------------------------------------
    // picks is kept in field (reading) order by sync(), so [N] in the body, the payload array
    // and the page badge always agree.
    function titleFor(captured) {
      const tag = KNOWN_TAGS.has(captured.tagName) ? captured.tagName : '"' + captured.tagName + '"'
      return tag + (captured.id ? '#' + captured.id : '')
    }

    function makeChip(entry) {
      const chip = document.createElement('span')
      chip.dataset.dshElementPickerChip = 'true'
      chip.dataset.num = '0'
      chip.contentEditable = 'false'
      chip.title = titleFor(entry.captured)
      Object.assign(chip.style, {
        display: 'inline-block', background: BLUE, color: '#fff', borderRadius: '5px',
        padding: '0 6px', margin: '0 2px', fontWeight: '600', fontSize: '12px',
        lineHeight: '18px', verticalAlign: '1px', userSelect: 'none', cursor: 'default',
      })
      // The panel keeps a human-facing 1/2/3 badge; that number never reaches the clipboard.
      chip.textContent = '0'
      return chip
    }

    function updateEmpty() {
      const empty = picks.length === 0 && field.textContent.length === 0
      field.dataset.empty = empty ? 'true' : 'false'
      placeholder.style.display = empty ? '' : 'none'
    }

    // Any chip that left the DOM without our keydown handler (select-all + delete, cut, drag
    // out) must still drop its picks entry, its badge and its box.
    function sync() {
      for (const entry of picks.slice()) {
        if (entry.chip.isConnected) continue
        if (entry.marker) entry.marker.remove()
        if (entry.box) entry.box.remove()
      }
      const ordered = []
      for (const chip of field.querySelectorAll('[data-dsh-element-picker-chip]')) {
        const entry = picks.find(item => item.chip === chip)
        if (entry) ordered.push(entry)
      }
      picks.length = 0
      picks.push(...ordered)
      picks.forEach((entry, index) => {
        entry.n = index + 1
        entry.chip.dataset.num = String(entry.n)
        entry.chip.textContent = String(entry.n)
        if (entry.marker) entry.marker.textContent = String(entry.n)
      })
      updateEmpty()
    }

    function insertChip(chip) {
      const selection = getSelection()
      const range = selection.rangeCount ? selection.getRangeAt(0) : null
      if (range && field.contains(range.startContainer)) {
        range.deleteContents()
        range.insertNode(chip)
        range.setStartAfter(chip)
        range.collapse(true)
        selection.removeAllRanges()
        selection.addRange(range)
        return
      }
      field.append(chip)
    }

    function insertText(text) {
      const selection = getSelection()
      if (!selection.rangeCount) return
      const range = selection.getRangeAt(0)
      range.deleteContents()
      const node = document.createTextNode(text)
      range.insertNode(node)
      range.setStartAfter(node)
      range.collapse(true)
      selection.removeAllRanges()
      selection.addRange(range)
    }

    function chipAt(node, forward) {
      if (node.nodeType === Node.TEXT_NODE) {
        if (forward ? node.data.length > 0 : node.data.length > 0) return null
      }
      return null
    }

    // The element sibling immediately before/after a caret that sits in a text node.
    function adjacentElement(node, forward) {
      let at = forward ? node.nextSibling : node.previousSibling
      while (at && at.nodeType === Node.TEXT_NODE && at.data === '') at = forward ? at.nextSibling : at.previousSibling
      return at
    }

    // The chip the caret sits flush against, or null. Chrome treats a contenteditable=false
    // token as atomic but sometimes needs two backspaces; doing it ourselves is one press.
    function adjacentChip(forward) {
      const selection = getSelection()
      if (!selection.rangeCount || !selection.isCollapsed) return null
      const range = selection.getRangeAt(0)
      const node = range.startContainer
      let candidate = null
      if (node.nodeType === Node.TEXT_NODE) {
        if (forward ? range.startOffset < node.data.length : range.startOffset > 0) return null
        candidate = adjacentElement(node, forward)
      } else {
        let at = forward ? range.startOffset : range.startOffset - 1
        while (at >= 0 && at < node.childNodes.length) {
          const child = node.childNodes[at]
          if (child.nodeType !== Node.TEXT_NODE || child.data !== '') break
          at += forward ? 1 : -1
        }
        candidate = at >= 0 && at < node.childNodes.length ? node.childNodes[at] : null
      }
      if (!candidate || candidate.nodeType !== Node.ELEMENT_NODE) return null
      return candidate.dataset && candidate.dataset.dshElementPickerChip === 'true' ? candidate : null
    }

    function removeChip(chip) {
      chip.remove()
      sync()
    }

    // IME guard: while a Chinese/Japanese IME is composing, Enter picks a candidate (选词上屏)
    // and is NOT a submit. Three signals, because no single one is reliable everywhere:
    // event.isComposing (standard), this flag (composition events), keyCode 229 (legacy stage).
    let composing = false

    function onFieldKey(event) {
      // Composing: hand Enter back to the IME — no preventDefault, no stopPropagation, no submit.
      if (event.isComposing || composing || event.keyCode === 229) return
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancel(); return }
      // Enter submits through the same path as 确定; Shift+Enter is the line break.
      if (event.key === 'Enter') {
        event.preventDefault(); event.stopPropagation()
        if (event.shiftKey) { insertText('\n'); sync() } else { void confirm() }
        return
      }
      if (event.key === 'Backspace' || event.key === 'Delete') {
        const chip = adjacentChip(event.key === 'Delete')
        if (chip) { event.preventDefault(); event.stopPropagation(); removeChip(chip) }
      }
    }
    field.addEventListener('keydown', onFieldKey, true)
    field.addEventListener('compositionstart', () => { composing = true })
    field.addEventListener('compositionend', () => { composing = false })
    field.addEventListener('input', () => sync())
    field.addEventListener('paste', event => {
      event.preventDefault()
      const text = (event.clipboardData && event.clipboardData.getData('text/plain')) || ''
      if (text) { insertText(text.replace(/\r\n?/g, '\n')); sync() }
    })
    field.addEventListener('focus', () => { field.style.borderColor = BLUE })
    field.addEventListener('blur', () => { field.style.borderColor = '#2b3446' })

    // The body IS the clipboard text. A chip expands in place to its self-contained token, in
    // field order, so what the user sees numbered 1/2/3 is what the model reads in full.
    function bodyText() {
      let out = ''
      for (const node of field.childNodes) {
        if (node.nodeType === Node.TEXT_NODE) { out += node.data; continue }
        if (node.nodeType !== Node.ELEMENT_NODE) continue
        if (node.dataset.dshElementPickerChip === 'true') {
          const entry = picks.find(item => item.chip === node)
          if (entry) out += tokenFor(entry.captured) + (startsWithSpace(node) ? '' : ' ')
        }
        else if (node.tagName === 'BR') out += '\n'
        else if (node.tagName === 'DIV' || node.tagName === 'P') out += '\n' + node.textContent
        else out += node.textContent
      }
      return out
    }

    // DSH's shell rule is "a chip gets a space after it unless one already follows". Emitting that
    // separator here makes the clipboard byte-identical to the outbound text instead of gaining a
    // space per token downstream. A token with nothing behind it keeps a trailing space that
    // clipboardText() strips, exactly as before.
    function startsWithSpace(chip) {
      let at = chip.nextSibling
      while (at && at.nodeType === Node.TEXT_NODE && at.data === '') at = at.nextSibling
      if (!at) return true
      if (at.nodeType === Node.TEXT_NODE) return /^\s/.test(at.data)
      return at.tagName === 'BR' || at.tagName === 'DIV' || at.tagName === 'P'
    }

    // --- token text ------------------------------------------------------------------
    // Plan 5.4: « and » delimit the token, so any literal occurrence in page content is escaped
    // to \u00ab / \u00bb. A backslash before a quote is escaped too - without that the escape
    // is not reversible (\" inside an attribute value would read back as a bare quote).
    function escapeToken(text) {
      return String(text)
        .replace(/\\/g, '\\\\')
        .replace(/«/g, '\\u00ab')
        .replace(/»/g, '\\u00bb')
    }

    // Plan 5.3: the HTML Element line is capped so a large div cannot expand its whole subtree.
    // Only the element's OWN text is printed, never its children's markup.
    function htmlElementText(captured) {
      const all = Object.entries(captured.attributes || {})
      const kept = all.slice(0, MAX_ATTRS)
      const parts = kept.map(item => item[0] + '="' + String(item[1]).replace(/"/g, '\\"') + '"')
      if (all.length > kept.length) parts.push('...+' + (all.length - kept.length) + ' more')
      const open = '<' + captured.tagName + (parts.length ? ' ' + parts.join(' ') : '') + '>'
      const text = String(captured.text || '').trim().replace(/\s+/g, ' ')
      return open + (text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) + '…' : text) + '</' + captured.tagName + '>'
    }

    // element«DOM Path: ...\nPosition: ...\nHTML Element: ...»  (3 lines: location only, no styles)
    // ponytail: the Styles line was removed on purpose - the model reads the source in the workspace
    // instead of being handed computed styles. capture() still collects .styles; nothing consumes it.
    function tokenFor(captured) {
      const rect = captured.rect
      const lines = [
        'DOM Path: ' + captured.selector,
        'Position: top=' + rect.y + 'px, left=' + rect.x + 'px, width=' + rect.width + 'px, height=' + rect.height + 'px',
        'HTML Element: ' + htmlElementText(captured),
      ]
      return TOKEN_OPEN + escapeToken(lines.join('\n')) + TOKEN_CLOSE
    }

    // --- layer model -----------------------------------------------------------------
    // stack = every element under the pointer, topmost first. elementFromPoint only ever
    // returns stack[0], which is why occluded elements were unreachable before.
    // The layer path is deliberately never rendered; only the wheel navigation survives.
    let stack = []

    function stackAt(x, y) {
      const list = document.elementsFromPoint(x, y)
        .filter(item => item instanceof Element && !isUi(item))
      // Chrome omits pointer-events:none subtrees from elementsFromPoint, so keep climbing
      // ancestors as a safety net (also covers shadow boundaries).
      let current = list[list.length - 1]
      while (current && current.parentElement) {
        current = current.parentElement
        if (!list.includes(current)) list.push(current)
      }
      return list
    }

    function paintHover(rect, offset) {
      Object.assign(hoverBox.style, {
        display: 'block',
        left: (offset.vx + rect.x) + 'px',
        top: (offset.vy + rect.y) + 'px',
        width: rect.width + 'px',
        height: rect.height + 'px',
      })
    }

    function setCurrent(element) {
      if (!(element instanceof Element) || isUi(element)) return
      hovered = element
      const rect = element.getBoundingClientRect()
      paintHover(rect, { vx: 0, vy: 0 })
      relayHover(rect)
    }

    function step(element) {
      if (!(element instanceof Element) || isUi(element)) return
      setCurrent(element)
    }

    function move(event) {
      // Browse mode: no hover tracking, and no stale box left on screen either.
      if (browsing) { hoverBox.style.display = 'none'; return }
      if (dragging) return
      if (isUi(event.target)) return
      const list = stackAt(event.clientX, event.clientY)
      if (!list.length) return
      stack = list
      setCurrent(list[0])
    }

    // Wheel walks down the paint stack, through whatever covers the target, so an occluded
    // element becomes selectable; past either end it falls back to parent / first child.
    function wheel(event) {
      // Browse mode: the page scrolls normally. Returning before preventDefault is the whole
      // point - a preventDefault here would swallow the scroll even though nothing was picked.
      if (browsing) return
      if (dragging) return
      if (isUi(event.target)) return
      event.preventDefault()
      event.stopImmediatePropagation()
      if (!(hovered instanceof Element)) return
      const at = stack.indexOf(hovered)
      if (at >= 0) {
        const next = event.deltaY < 0 ? Math.min(at + 1, stack.length - 1) : Math.max(at - 1, 0)
        setCurrent(stack[next])
      } else {
        step(event.deltaY < 0 ? hovered.parentElement : hovered.firstElementChild)
      }
    }

    function siblings(element, direction) {
      const list = element.parentElement
        ? [...element.parentElement.children].filter(item => !isUi(item))
        : []
      const at = list.indexOf(element)
      return at < 0 ? null : (list[at + direction] || null)
    }

    // Green solid box + numbered badge, owned by the top frame and placed with converted
    // coordinates so a pick made inside an iframe lands on the right pixels.
    function annotate(entry, offset) {
      const rect = entry.captured.rect
      const left = offset.vx + scrollX + rect.pageX
      const top = offset.vy + scrollY + rect.pageY
      const box = document.createElement('div')
      box.dataset.dshElementPickerUi = 'true'
      box.dataset.dshElementPickerBox = 'true'
      Object.assign(box.style, {
        position: 'absolute', left: left + 'px', top: top + 'px',
        width: rect.width + 'px', height: rect.height + 'px',
        outline: '2px solid ' + GREEN, outlineOffset: '2px',
        pointerEvents: 'none', zIndex: '2147483646',
      })
      const marker = document.createElement('div')
      marker.dataset.dshElementPickerUi = 'true'
      marker.dataset.dshElementPickerMarker = 'true'
      Object.assign(marker.style, {
        position: 'absolute', left: (left - 9) + 'px', top: (top - 9) + 'px',
        width: '18px', height: '18px', borderRadius: '999px', display: 'grid',
        placeItems: 'center', background: GREEN, color: '#0f1115',
        font: 'bold 11px system-ui, sans-serif', pointerEvents: 'none', zIndex: '2147483647',
      })
      marker.textContent = String(entry.n)
      document.documentElement.append(box, marker)
      entry.box = box
      entry.marker = marker
    }

    function addPick(captured, offset) {
      // Test seam: counts committed picks so the harness can prove a drag picks nothing.
      pickCount += 1
      toolbar.dataset.dshElementPickerSelects = String(pickCount)
      const entry = { captured, n: 0, chip: null, marker: null, box: null }
      entry.chip = makeChip(entry)
      insertChip(entry.chip)
      picks.push(entry)
      sync()
      annotate(entry, offset)
    }

    function select() {
      if (!(hovered instanceof Element)) return
      // In a child frame the top frame owns the toolbar, the overlay and the clipboard; forward
      // the capture and stop here.
      if (!IS_TOP && relay(hovered)) return
      addPick(capture(hovered), { vx: 0, vy: 0 })
    }

    // --- cross-frame bridge ----------------------------------------------------------
    // The armed frame may be an iframe, so its clipboard write belongs to that frame; a frame
    // that is not the top one forwards the pick to the top frame, which owns the clipboard,
    // the toolbar and the payload. Same-origin only - that is the documented ceiling.
    if (IS_TOP) {
      onFramePick = (elements, offset) => { for (const element of elements) addPick(element, offset) }
      onFrameHover = (rect, offset) => { if (rect) paintHover(rect, offset) }
    }
    onStopAll = () => cleanup()
    // A mode broadcast from the top frame only flips this frame's flag and repaints nothing:
    // there is no toolbar here, and paintMode() touches toolbar.dataset.
    onModeAll = mode => {
      browsing = mode === 'browse'
      if (browsing) { hoverBox.style.display = 'none'; hovered = undefined; stack = [] }
    }
    paintMode()

    function relayHover(rect) {
      if (IS_TOP) return
      let target = null
      try { target = window.top } catch { return }
      if (target === window) return
      try {
        target.postMessage({
          __dshElementPicker: 'hover',
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        }, '*')
      } catch {}
    }

    function relay(element) {
      let target = null
      try { target = window.top } catch { return false }
      if (target === window) return false
      try {
        target.postMessage({ __dshElementPicker: 'pick', elements: [capture(element)], url: location.href }, '*')
        return true
      } catch { return false }
    }

    // The body text IS the clipboard text. Nothing is appended: no marker, no payload, no
    // appendix. The only edit is dropping a trailing newline so a paste cannot add a blank line.
    function clipboardText() {
      return bodyText().replace(/\s+$/, '')
    }

    async function writeClipboard(text) {
      // Test seam: setting __dshElementPickerForceFallback skips the modern API so the
      // headless verification script can exercise the fallback path too.
      const skipModern = globalThis.__dshElementPickerForceFallback === true
      try {
        if (!skipModern && navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(text)
          return { ok: true, via: 'navigator.clipboard' }
        }
      } catch (error) { lastError = String(error && error.message || error) }
      // Fallback 1: execCommand on a selected off-screen textarea.
      try {
        const scratch = document.createElement('textarea')
        scratch.value = text
        scratch.setAttribute('readonly', '')
        Object.assign(scratch.style, { position: 'fixed', top: '0', left: '-9999px', opacity: '0' })
        document.documentElement.append(scratch)
        scratch.select()
        scratch.setSelectionRange(0, text.length)
        const ok = document.execCommand('copy')
        scratch.remove()
        if (ok) return { ok: true, via: 'execCommand' }
        lastError = lastError || 'execCommand returned false'
      } catch (error) { lastError = lastError || String(error && error.message || error) }
      // Fallback 2: show it so the user can press Ctrl+C themselves.
      showManual(text)
      return { ok: false, via: 'manual', error: lastError }
    }

    function showManual(text) {
      if (!manualPanel) {
        manualPanel = document.createElement('textarea')
        manualPanel.dataset.dshElementPickerManual = 'true'
        manualPanel.dataset.dshElementPickerUi = 'true'
        Object.assign(manualPanel.style, {
          position: 'fixed', top: '72px', left: '50%', transform: 'translateX(-50%)',
          width: '80vw', height: '30vh', zIndex: '2147483647',
          font: '12px ui-monospace, monospace', background: '#fff', color: '#111827',
        })
        manualPanel.addEventListener('click', event => event.stopPropagation())
        document.documentElement.append(manualPanel)
      }
      manualPanel.value = text
      manualPanel.focus()
      manualPanel.select()
      notice.textContent = '剪贴板被拦截：请按 Ctrl+C 复制'
      notice.style.display = ''
    }

    async function confirm() {
      if (!picks.length && !bodyText().trim()) { cancel(); return }
      const result = await writeClipboard(clipboardText())
      if (result.ok) cancel()
    }

    function cancel() {
      stopEverywhere()
    }

    function onKey(event) {
      if (isUi(event.target)) return
      // Esc stays an exit door in both modes; everything else is the page's while
      // browsing. Checked before the early return, or browse mode would trap the user.
      if (event.key === 'Escape') { cancel(); return }
      if (browsing) return
      // Enter is 确定, never 选中: it submits and closes, the same path as the 确定 button.
      // Deliberately BEFORE the hovered check, so it still works with nothing under the pointer.
      // Clicking an element still calls select() (see block()); only this key changed.
      if (event.key === 'Enter') { event.preventDefault(); event.stopImmediatePropagation(); void confirm(); return }
      if (!(hovered instanceof Element)) return
      // Layer navigation. Anything else (typing, page shortcuts) stays untouched.
      let target = null
      if (event.key === 'ArrowUp') target = hovered.parentElement
      else if (event.key === 'ArrowDown') target = hovered.firstElementChild
      else if (event.key === 'ArrowLeft') target = siblings(hovered, -1)
      else if (event.key === 'ArrowRight') target = siblings(hovered, 1)
      if (!target) return
      event.preventDefault()
      event.stopImmediatePropagation()
      step(target)
    }

    // A1 freeze. Bound on window in the capture phase, so this runs before ANY listener the
    // page registered on any node; stopImmediatePropagation then keeps same-node siblings
    // from running, which document-level stopPropagation could never do.
    // ponytail: keydown is deliberately NOT in this set - swallowing every key would break
    // Esc and the arrow keys above; a page shortcut on an already-selected element is the
    // accepted ceiling.
    const INTERCEPT = [
      'pointerdown', 'mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu', 'submit',
      'pointerup', 'auxclick',
    ]
    // A click is taken on pointerdown when we can (preventDefault there also suppresses the
    // compatibility mousedown/mouseup/click). The click fallback only fires when a page
    // listener registered before us swallowed our pointerdown, hence the 200ms de-dupe.
    const SELECT_GESTURES = ['pointerdown', 'click']
    let lastSelectAt = 0
    const block = event => {
      // A drag that leaves the panel must not pick whatever it passes over. pointerup /
      // pointercancel must stay un-swallowed: this listener is registered before the gesture's
      // own, so stopImmediatePropagation here would also kill the handler that ends the drag
      // and leave the panel glued to the mouse.
      if (dragging) {
        event.preventDefault()
        if (event.type !== 'pointerup' && event.type !== 'pointercancel') event.stopImmediatePropagation()
        return
      }
      // The click synthesized by a drag's own release must not pick whatever the pointer
      // happened to end over: that gesture was a move, not a pick.
      if (event.type === 'click' && performance.now() < suppressClickUntil) {
        event.preventDefault()
        event.stopImmediatePropagation()
        return
      }
      // Let the picker's own toolbar work: never swallow events aimed at our UI.
      if (isUi(event.target)) return
      // Browse mode: hand every page event back untouched - that is what makes a menu open.
      // Deliberately after the two guards above, so a panel drag that ends while browsing still
      // swallows its own synthesized click and the toolbar stays usable in either mode.
      if (browsing) return
      event.preventDefault()
      event.stopImmediatePropagation()
      if (SELECT_GESTURES.includes(event.type) && event.timeStamp - lastSelectAt > 200) {
        lastSelectAt = event.timeStamp
        select()
      }
    }
    const onWheel = event => wheel(event)

    for (const type of INTERCEPT) window.addEventListener(type, block, true)
    window.addEventListener('mousemove', move, true)
    window.addEventListener('wheel', onWheel, { capture: true, passive: false })
    window.addEventListener('keydown', onKey, true)
    updateEmpty()
    cleanup = () => {
      for (const type of INTERCEPT) window.removeEventListener(type, block, true)
      window.removeEventListener('mousemove', move, true)
      window.removeEventListener('wheel', onWheel, true)
      window.removeEventListener('keydown', onKey, true)
      field.removeEventListener('keydown', onFieldKey, true)
      onFramePick = null
      onFrameHover = null
      onStopAll = null
      onModeAll = null
      hoverBox.remove(); toolbar.remove()
      if (manualPanel) manualPanel.remove()
      picks.forEach(entry => { if (entry.marker) entry.marker.remove(); if (entry.box) entry.box.remove() })
      cleanup = () => {}
    }
  }

  function selectorFor(element) {
    if (element.id) return '#' + CSS.escape(element.id)
    const parts = []
    let current = element
    while (current && parts.length < 4) {
      let part = current.tagName.toLowerCase()
      const classes = [...current.classList].slice(0, 2)
      if (classes.length) part += '.' + classes.map(value => CSS.escape(value)).join('.')
      const siblings = current.parentElement
        ? [...current.parentElement.children].filter(item => item.tagName === current.tagName)
        : []
      if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')'
      parts.unshift(part)
      current = current.parentElement
    }
    return parts.join(' > ')
  }

  function capture(element) {
    const rect = element.getBoundingClientRect()
    const computed = getComputedStyle(element)
    const attributes = Object.fromEntries(
      [...element.attributes].slice(0, 20).map(item => [item.name, item.value]),
    )
    const role = element.getAttribute('role') || implicitRole(element)
    const name = element.getAttribute('aria-label')
      || (element.textContent || '').trim().slice(0, 200)
      || undefined
    return {
      selector: selectorFor(element),
      tagName: element.tagName.toLowerCase(),
      ...(element.id ? { id: element.id } : {}),
      classes: [...element.classList],
      text: (element.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 500),
      rect: {
        x: Math.round(rect.x), y: Math.round(rect.y),
        width: Math.round(rect.width), height: Math.round(rect.height),
        pageX: Math.round(rect.x + scrollX), pageY: Math.round(rect.y + scrollY),
      },
      attributes,
      // ponytail: collected but no longer emitted (the Styles line is gone). Kept because the
      // token is now location-only and these computed values are the natural thing to re-enable
      // if a future round wants styles back; delete the block if that never happens.
      styles: {
        display: computed.display, position: computed.position,
        width: computed.width, height: computed.height,
        color: computed.color, backgroundColor: computed.backgroundColor,
        font: computed.font, margin: computed.margin, padding: computed.padding,
        border: computed.border, overflow: computed.overflow, cursor: computed.cursor,
        opacity: computed.opacity, visibility: computed.visibility, zIndex: computed.zIndex,
        // Longhands, kept for the same reason as above: the font shorthand serializes with
        // spaces around the slash in Chrome, and borderRadius has no shorthand to reuse.
        fontWeight: computed.fontWeight, fontSize: computed.fontSize,
        lineHeight: computed.lineHeight, fontFamily: computed.fontFamily,
        borderRadius: computed.borderRadius,
      },
      accessibility: {
        ...(role ? { role } : {}), ...(name ? { name } : {}),
        focusable: element.matches('a[href],button,input,select,textarea,[tabindex]'),
        disabled: element.matches(':disabled,[aria-disabled="true"]'),
      },
    }
  }

  function implicitRole(element) {
    const roles = { A: 'link', BUTTON: 'button', INPUT: 'textbox', SELECT: 'combobox', TEXTAREA: 'textbox', IMG: 'img' }
    return roles[element.tagName]
  }
})()
