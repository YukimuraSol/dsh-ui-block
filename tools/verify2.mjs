// verify2.mjs — 多文件块验收：3 页帧证据 + 像素对照 + 体积账
// 用法：node verify2.mjs "http://127.0.0.1:3911/out/site/index.html" "http://127.0.0.1:3080/?token=<token>"
import { launch, navigate, evaluate, screenshot } from './cdp.mjs';
import { writeFile, readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const HARNESS = process.argv[2] || 'http://127.0.0.1:3911/out/site/index.html';
const LIVE = process.argv[3] || null;
const OUT = path.resolve('out');
const SITE = path.resolve('out/site');
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 每页在自己的时间轴上对应哪一刻（切页步骤之后、下一段动作之前）
const FRAMES = [
  { name: 'home', t: 300, snapshot: 'home' },
  { name: 'plugins', t: 3000, snapshot: 'plugins' },
  { name: 'market', t: 4500, snapshot: 'market' },
  { name: 'back-plugins', t: 6800, snapshot: 'plugins' },
];

const PREPS = {
  home: null,
  plugins: "(async () => { const r = [...document.querySelectorAll('button')].find((b) => (b.innerText || '').trim() === '插件'); r.click(); await new Promise((x) => setTimeout(x, 1800)); return true; })()",
  market: "(async () => { const c = (t, f) => { const e = [...document.querySelectorAll('button, [role=\"tab\"]')].find((x) => (x.innerText || '').trim() === t && (!f || f(x))); if (!e) throw new Error(t); e.click(); }; c('插件'); await new Promise((x) => setTimeout(x, 1500)); c('插件市场', (x) => x.getBoundingClientRect().top < 160); await new Promise((x) => setTimeout(x, 1800)); return true; })()",
};

// ---- 体积账 -----------------------------------------------------------------
async function walk(dir, base = '') {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const rel = base ? base + '/' + e.name : e.name;
    if (e.isDirectory()) out.push(...(await walk(path.join(dir, e.name), rel)));
    else out.push({ path: rel, bytes: (await readFile(path.join(dir, e.name))).length });
  }
  return out.sort((a, b) => b.bytes - a.bytes);
}
const files = await walk(SITE);
const payload = files.reduce((a, f) => a + f.bytes, 0);
const uiblock = await readFile(path.resolve('out/demo.uiblock'));
const budget = {
  files,
  payloadBytes: payload,
  uiblockBytes: uiblock.length,
  perFileLimit: 262144,
  blockLimit: 2097152,
  maxFile: files[0],
  overPerFile: files.filter((f) => f.bytes > 262144).map((f) => f.path),
  overBlock: Math.max(0, payload - 2097152),
};

const b = await launch({ width: 1440, height: 900 });
const report = { harness: HARNESS, budget };
try {
  // ---- A. 帧证据：4 个时刻、3 份快照（含一次回到上一页） --------------------
  await navigate(b.session, HARNESS + '?autoplay=0', { settle: 900 });
  for (let i = 0; i < 100; i++) {
    if (await evaluate(b.session, () => window.__playerReady === true)) break;
    await sleep(100);
  }
  console.error('[verify2] player ready');
  report.player = { frames: [] };
  for (const f of FRAMES) {
    await evaluate(b.session, '(async (ms) => { await window.__player.seek(ms); return true; })(' + f.t + ')', { isExpression: true });
    await sleep(400);
    const png = await screenshot(b.session);
    const info = await evaluate(b.session, () => window.__playerFrame());
    const file = 'frame2-' + f.name + '.png';
    await writeFile(path.join(OUT, file), png);
    report.player.frames.push({ name: f.name, t: f.t, file, sha256: sha(png), bytes: png.length, snapshot: info.snapshot, size: info.size, text: (info.text || '').replace(/\s+/g, ' ').slice(0, 70) });
  }
  const hashes = report.player.frames.map((f) => f.sha256);
  report.player.uniqueHashes = new Set(hashes).size;
  report.player.hashAllDifferent = new Set(hashes).size === hashes.length;
  report.player.snapshotMatchesTimeline = report.player.frames.every((f) => f.snapshot === FRAMES.find((x) => x.name === f.name).snapshot);

  // 继续播 2 秒确认时间轴在推进（不是卡住的一张图）
  await evaluate(b.session, () => { window.__player.play(); return true; });
  await sleep(2000);
  const st = await evaluate(b.session, () => window.__playerState);
  report.player.stillRunning = { t: st.t, playing: st.playing, stepsFired: st.stepsFired, steps: st.steps };

  // ---- B. 像素对照 ---------------------------------------------------------
  // 单列在 pixels.mjs：必须先等实机进完成态再截，否则比的是加载骨架态。
  // 这里只留一句指向，避免两份口径混在一起。
  report.compareNote = '见 out/pixels.json（pixels.mjs：等实机完成态再截）';


  // ---- C. 兼容：旧的单文件 demo 仍能播 -------------------------------------
  await navigate(b.session, 'http://127.0.0.1:3911/harness.html?autoplay=0', { settle: 1200 });
  let legacy = { ok: false };
  for (let i = 0; i < 60; i++) { if (await evaluate(b.session, () => window.__playerReady === true)) { legacy.ok = true; break; } await sleep(100); }
  if (legacy.ok) {
    await evaluate(b.session, '(async () => { await window.__player.seek(3500); return true; })()', { isExpression: true });
    await sleep(300);
    const info = await evaluate(b.session, () => window.__playerFrame());
    legacy = { ok: true, snapshot: info.snapshot, size: info.size };
  }
  report.legacySingleFile = legacy;
} finally {
  await b.close();
}
console.log(JSON.stringify(report, null, 1));
await writeFile(path.join(OUT, 'verify2.json'), JSON.stringify(report, null, 1));
