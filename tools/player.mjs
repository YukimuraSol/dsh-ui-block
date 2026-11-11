// player.mjs — 宿主侧时间轴播放器（路线 1：块只当素材，外面演）
// 用法：createPlayer({ snapshots, timeline, mount }) → { play, pause, seek, restart, destroy, state }
// 快照是纯数据 HTML，用 blob: 装进同源 iframe；播放器在 iframe 之上画光标/高亮/涟漪，
// 并直接改 iframe 里的 DOM（同源）来演示“填字 / 按下”。
//
// 双缓冲（2026-11-11）。用户口径：浏览器里点链接就是硬切，不许我们“帮他画过渡”。
// 所以这里做的只有一件事——**下一份文档画好之前，不把旧内容撤掉**：
//   · 每份快照各自一个 iframe，开场全部导航一次；切步骤只改「显示哪一层」，永不重新导航；
//   · 就绪判据 = load 之后 readyState complete + document.fonts.status loaded，超时 800ms 兜底；
//   · 就绪的那一刻在 requestAnimationFrame 里一次交换（opacity 直接 1/0，没有 transition/animation，
//     没有淡入淡出）——硬切，只是把这次硬切挪到内容完整的那一刻；
//   · 容器不写死底色：底色由每份快照自己的 body 背景色补上，取不到就保持透明。

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

export function createPlayer({ snapshots = {}, timeline = {}, mount, onState = null }) {
  if (!mount) throw new Error('createPlayer: mount 必填');
  ensureStyle();

  const steps = [...(timeline.steps || [])].sort((a, b) => a.at - b.at).map((s, i) => ({ ...s, _i: i }));
  const loopEnabled = timeline.loop !== false;
  const duration = timeline.duration || Math.max(0, ...steps.map((s) => s.at)) + 1500;
  const READY_TIMEOUT_MS = 800;
  // 隐藏层上不许让动画偷跑：最多管这么多条，超了如实记下来（不假装全管住）。
  const MAX_ANIM = 300;

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

  // ── 双缓冲：一层一快照，开场各自导航一次 ─────────────────────────────────────
  function makeLayer(key) {
    const el = document.createElement('iframe');
    el.className = 'snap-frame';
    el.setAttribute('scrolling', 'no');
    el.setAttribute('title', 'snapshot');
    el.setAttribute('data-snap', key);
    // 沙箱不变：可被同源读取，绝不执行脚本。
    el.setAttribute('sandbox', 'allow-same-origin');
    const rec = { key, el, ready: false, bg: '', decideAt: 0, readyAt: 0 };
    el.addEventListener('load', () => settle(rec, Date.now() + READY_TIMEOUT_MS));
    el.src = srcFor(key);
    mount.insertBefore(el, overlay);
    layers.set(key, rec);
    return rec;
  }

  function settle(rec, deadline) {
    if (rec.ready) return;
    let complete = false, fonts = true;
    try {
      const d = rec.el.contentDocument;
      complete = !!d && d.readyState === 'complete' && !!d.body;
      fonts = !d || !d.fonts || d.fonts.status === 'loaded';
    } catch { complete = false; }
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
    if (rec.ready) return;
    rec.ready = true;
    rec.readyAt = performance.now();
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
      if (rec.bg) mount.style.background = rec.bg;
      ring.classList.remove('show');
      const appliedAt = performance.now();
      // 相位证据：交换这一刻新层动画的当前时间（≈0 才说明它没偷跑）
      let phaseMs = null;
      try { const first = layerAnims(rec)[0]; phaseMs = first ? Math.round(Number(first.currentTime) || 0) : null; } catch { phaseMs = null; }
      switches.push({ key: rec.key, costMs: Math.round(appliedAt - decideAt), applyAt: Math.round(appliedAt - t0), phaseMs, anims: rec.animCount === undefined ? null : rec.animCount, animCapped: !!rec.animCapped });
      if (switches.length > 24) switches.shift();
      if (wantPlay) { wantPlay = false; last = 0; raf = requestAnimationFrame(tick); }
      onState && onState(publicState());
    });
  }

  function want(key) {
    if (!(key in snapshots)) return false;
    wantKey = key;
    const rec = recOf(key);
    if (!rec) return false;
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
      case 'switch':
        want(step.snapshot);
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
    state.t = 0;
    state.fired = 0;
    ring.classList.remove('show');
    ripple.classList.remove('go');
    setCursor(120, 120, true);
    const first = steps.find((s) => s.do === 'switch');
    const key = first ? first.snapshot : (Object.keys(snapshots)[0] || null);
    if (key !== null) want(key);
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
      if (loopEnabled) { resetPlayback(); return; }
      state.playing = false;
      onState && onState(publicState());
      return;
    }
    onState && onState(publicState());
    raf = requestAnimationFrame(tick);
  }

  function publicState() {
    const ls = [];
    for (const r of layers.values()) {
      ls.push({ snap: r.key, ready: r.ready, on: r.el.style.visibility === 'visible', op: r.el.style.opacity, bg: r.bg, anims: r.animCount === undefined ? null : r.animCount, animCapped: !!r.animCapped });
    }
    return {
      t: Math.round(state.t), playing: state.playing, snapshot: state.snapshot, duration,
      stepsFired: state.fired, steps: steps.length, layers: ls,
      switched: switches.slice(-8), switchMs: switches.map((x) => x.costMs)
    };
  }

  // 开场：每一份快照各就位（各自导航一次，之后永不重导航）
  for (const key of Object.keys(snapshots)) {
    try { makeLayer(key); } catch (e) { console.warn('[player] 快照装不进层：' + String((e && e.message) || e)); }
  }
  if (layers.size === 0) throw new Error('createPlayer: 没有可用的快照');
  resetPlayback();

  const api = {
    play() {
      if (state.playing) return;
      state.playing = true;
      if (activeKey === null) { wantPlay = true; return; }   // 首帧还没上屏：等交换那一刻才起表
      last = 0;
      raf = requestAnimationFrame(tick);
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
