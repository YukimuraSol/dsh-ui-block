// player.mjs — 宿主侧时间轴播放器（路线 1：块只当素材，外面演）
// 用法：createPlayer({ snapshots, timeline, mount }) → { play, pause, seek, restart, destroy, state }
// 快照是纯数据 HTML，用 blob: 装进同源 iframe；播放器在 iframe 之上画光标/高亮/涟漪，
// 并直接改 iframe 里的 DOM（同源）来演示“填字 / 按下”。

const STYLE_ID = 'snap-player-style';

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const st = document.createElement('style');
  st.id = STYLE_ID;
  st.textContent = `
  .snap-stage { position: relative; overflow: hidden; background: #000; }
  .snap-frame { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; display: block; }
  .snap-overlay { position: absolute; inset: 0; pointer-events: none; overflow: hidden; z-index: 5; }
  .snap-cursor { position: absolute; left: 0; top: 0; width: 22px; height: 22px; margin: -2px 0 0 -2px;
    filter: drop-shadow(0 2px 4px rgba(0,0,0,.45)); transition: transform .55s cubic-bezier(.33,.02,.2,1); z-index: 3; }
  .snap-cursor.press { transform-origin: 2px 2px; }
  .snap-cursor.press::after { content: ''; position: absolute; left: 2px; top: 2px; width: 12px; height: 12px;
    border: 2px solid rgba(255,255,255,.9); border-radius: 50%; animation: snap-press .28s ease-out forwards; }
  .snap-ring { position: absolute; border: 2px solid #4da3ff; border-radius: 6px; opacity: 0;
    box-shadow: 0 0 0 3px rgba(77,163,255,.28), 0 0 18px rgba(77,163,255,.5);
    transition: opacity .18s ease, transform .18s ease, width .18s ease, height .18s ease; }
  .snap-ring.show { opacity: 1; }
  .snap-ripple { position: absolute; width: 16px; height: 16px; margin: -8px 0 0 -8px; border-radius: 50%;
    border: 2px solid rgba(255,255,255,.85); opacity: 0; z-index: 2; }
  .snap-ripple.go { animation: snap-ripple .5s ease-out forwards; }
  @keyframes snap-ripple { 0% { opacity: .9; transform: scale(.4); } 100% { opacity: 0; transform: scale(4.2); } }
  @keyframes snap-press { 0% { opacity: .9; transform: scale(.6); } 100% { opacity: 0; transform: scale(1.9); } }
  `;
  document.head.appendChild(st);
}

const CURSOR_SVG =
  '<svg viewBox="0 0 24 24" width="22" height="22"><path d="M4 2 L4 20 L9.2 15.3 L12.4 21.6 L15.6 20 L12.3 13.8 L19 13.4 Z" fill="#fff" stroke="#1b1b1b" stroke-width="1.2" stroke-linejoin="round"/></svg>';

const norm = (s) => (s || '').replace(/s+/g, ' ').trim();

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

export function createPlayer({ snapshots = {}, timeline = {}, mount, onState = null }) {
  if (!mount) throw new Error('createPlayer: mount 必填');
  ensureStyle();

  const steps = [...(timeline.steps || [])].sort((a, b) => a.at - b.at).map((s, i) => ({ ...s, _i: i }));
  const loopEnabled = timeline.loop !== false;
  const duration = timeline.duration || Math.max(0, ...steps.map((s) => s.at)) + 1500;

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
  const iframe = document.createElement('iframe');
  iframe.className = 'snap-frame';
  iframe.setAttribute('scrolling', 'no');
  iframe.setAttribute('title', 'snapshot');
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
  mount.append(iframe, overlay);

  const state = { t: 0, playing: false, snapshot: null, fired: 0, done: 0 };
  let raf = 0, last = 0, fired = new Set(), updates = [], retries = [], switchWait = null;
  let cursorAt = { x: 120, y: 120 }, timers = [];

  const later = (ms, fn) => { const id = setTimeout(() => { timers = timers.filter((x) => x !== id); fn(); }, ms); timers.push(id); return id; };
  const clearTimers = () => { timers.forEach(clearTimeout); timers = []; };

  const doc = () => { try { return iframe.contentDocument; } catch { return null; } };

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

  function doType(el, text, cps, at) {
    if (!el || !text) return;
    const tag = el.tagName;
    const isInput = tag === 'INPUT' || tag === 'TEXTAREA';
    if (isInput) el.value = '';
    else el.textContent = '';
    const chars = [...text];
    const total = (chars.length * 1000) / (cps || 12);
    const t0 = at !== undefined ? at : state.t;
    updates.push(() => {
      const p = Math.min(1, (state.t - t0) / Math.max(1, total));
      const n = Math.round(p * chars.length);
      const val = chars.slice(0, n).join('');
      if (isInput) el.value = val;
      else if (el.textContent !== val) el.textContent = val;
      return p >= 1;
    });
  }

  function switchSnapshot(key) {
    if (!(key in snapshots)) return Promise.resolve(false);
    state.snapshot = key;
    return new Promise((res) => {
      switchWait = res;
      iframe.addEventListener('load', onLoad, { once: true });
      iframe.src = srcFor(key);
    });
  }
  function onLoad() {
    const cb = switchWait; switchWait = null;
    // 切页后 overlay 状态清掉，避免上一页的框残留
    ring.classList.remove('show');
    cb && cb(true);
  }

  function fire(step) {
    const d = doc();
    const to = step.to;
    const el = () => resolveTarget(d, to);
    switch (step.do) {
      case 'switch':
        switchSnapshot(step.snapshot);
        break;
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
          try { const h = d.querySelector(hs); if (h) h.style.display = 'none'; } catch {}
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

  function resetPlayback() {
    clearTimers();
    updates = [];
    retries = [];
    fired.clear();
    state.t = 0;
    state.fired = 0;
    ring.classList.remove('show');
    ripple.classList.remove('go');
    // 回到第一帧应当的画面：第一个 switch 步骤
    const first = steps.find((s) => s.do === 'switch');
    if (first) switchSnapshot(first.snapshot);
    setCursor(120, 120, true);
  }

  function tick(now) {
    if (!state.playing) return;
    if (!last) last = now;
    const dt = now - last;
    last = now;
    state.t += dt;
    fireDue();
    updates = updates.filter((fn) => fn() !== true);
    if (state.t >= duration) {
      if (loopEnabled) { resetPlayback(); last = now; }
      else { state.playing = false; onState && onState(publicState()); return; }
    }
    onState && onState(publicState());
    raf = requestAnimationFrame(tick);
  }

  function publicState() {
    return { t: Math.round(state.t), playing: state.playing, snapshot: state.snapshot, duration, stepsFired: state.fired, steps: steps.length };
  }

  const api = {
    play() {
      if (state.playing) return;
      state.playing = true;
      last = 0;
      raf = requestAnimationFrame(tick);
    },
    pause() {
      state.playing = false;
      cancelAnimationFrame(raf);
      return publicState();
    },
    // 一次性把时间轴推到 ms 处（用于逐帧核对/截图）：先落定最后一个 switch，再补跑其余步骤。
    // 必须 await：iframe 换源是异步的，加载完会把之前的 DOM 改动冲掉。
    async seek(ms) {
      clearTimers();
      updates = [];
      retries = [];
      fired.clear();
      const due = steps.filter((s) => s.at <= ms);
      const lastSwitch = [...due].reverse().find((s) => s.do === 'switch');
      if (lastSwitch) await switchSnapshot(lastSwitch.snapshot);
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
    restart() { resetPlayback(); api.play(); return publicState(); },
    destroy() {
      cancelAnimationFrame(raf);
      clearTimers();
      blobUrls.forEach((u) => URL.revokeObjectURL(u));
      iframe.remove();
      overlay.remove();
    },
    state: publicState,
    // 核对用：当前帧里 iframe 的可见文本，证明演的是哪一份快照
    frameInfo() {
      const d = doc();
      return { snapshot: state.snapshot, src: iframe.src.slice(0, 40), text: d ? norm(d.body.innerText).slice(0, 160) : null, size: d ? d.body.getBoundingClientRect().width + 'x' + d.body.getBoundingClientRect().height : null };
    },
  };

  resetPlayback();
  return api;
}