// verify.mjs — 闭环验收：0.5s / 3.5s 两帧像素哈希不同 + 3.5s 演的是另一份快照 + 快照与实机对照
import { launch, navigate, evaluate, screenshot } from './cdp.mjs';
import { writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const HARNESS = process.argv[2] || 'http://127.0.0.1:3911/harness.html';
const LIVE = process.argv[3] || null; // 源页面 URL（对照用）
const OUT = path.resolve('out');
const sha = (buf) => createHash('sha256').update(buf).digest('hex');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitT(s, ms) {
  for (let i = 0; i < 200; i++) {
    const st = await evaluate(s, () => window.__playerState || null);
    if (st && st.t >= ms) return st;
    await sleep(30);
  }
  throw new Error('state never reached ' + ms);
}

const b = await launch({ width: 1440, height: 900 });
const report = { harness: HARNESS };
try {
  // ---- A. 播放器：两个时刻各截一帧 ----
  await navigate(b.session, HARNESS + '?autoplay=0', { settle: 800 });
  for (let i = 0; i < 100; i++) {
    if (await evaluate(b.session, () => window.__playerReady === true)) break;
    await sleep(100);
  }
  await evaluate(b.session, () => { window.__player.play(); return true; });

  const st1 = await waitT(b.session, 500);
  const png1 = await screenshot(b.session);
  const info1 = await evaluate(b.session, () => window.__playerFrame());
  await writeFile(path.join(OUT, 'frame-0.5s.png'), png1);

  const st2 = await waitT(b.session, 3500);
  const png2 = await screenshot(b.session);
  const info2 = await evaluate(b.session, () => window.__playerFrame());
  await writeFile(path.join(OUT, 'frame-3.5s.png'), png2);

  // 继续跑 3 秒，确认循环/时间轴还在推进
  await sleep(1500);
  const st3 = await evaluate(b.session, () => window.__playerState);
  const png3 = await screenshot(b.session);
  await writeFile(path.join(OUT, 'frame-later.png'), png3);

  report.player = {
    frame1: { t: st1.t, snapshot: st1.snapshot, sha256: sha(png1), bytes: png1.length, text: info1.text },
    frame2: { t: st2.t, snapshot: st2.snapshot, sha256: sha(png2), bytes: png2.length, text: info2.text },
    later: { t: st3.t, snapshot: st3.snapshot, sha256: sha(png3) },
    hashDifferent: sha(png1) !== sha(png2),
    snapshotDifferent: st1.snapshot !== st2.snapshot,
    size1: info1.size, size2: info2.size,
  };

  // ---- B/C. 快照 vs 实机 同尺寸对照（两页各一次） ----
  if (LIVE) {
    const boot = () => {
      const s = document.querySelector('.dshba');
      if (s) { const v = s.querySelector('video'); if (v) { try { v.pause(); v.muted = true; } catch {} } s.remove(); }
      window.scrollTo(0, 0);
      return true;
    };
    const PAGES = [
      { name: 'home', snap: 'out/snap-home.html', prep: null },
      {
        name: 'plugins',
        snap: 'out/snap-plugins.html',
        prep: "(async () => { const r = [...document.querySelectorAll('button')].find((b) => (b.innerText || '').trim() === '插件'); r.click(); await new Promise((x) => setTimeout(x, 1800)); return true; })()",
      },
    ];
    report.compare = {};
    for (const pg of PAGES) {
      await navigate(b.session, LIVE, { settle: 2600 });
      await evaluate(b.session, boot);
      if (pg.prep) await evaluate(b.session, pg.prep, { isExpression: true });
      await sleep(600);
      const livePng = await screenshot(b.session);
      await writeFile(path.join(OUT, 'live-' + pg.name + '-1440x900.png'), livePng);

      await navigate(b.session, 'http://127.0.0.1:3911/' + pg.snap, { settle: 1200 });
      const snapPng = await screenshot(b.session);
      await writeFile(path.join(OUT, 'snap-' + pg.name + '-1440x900.png'), snapPng);

      await navigate(b.session, 'http://127.0.0.1:3911/harness.html?autoplay=0', { settle: 200 });
      const diff = await evaluate(
        b.session,
        '(async () => {\n' +
          '  const a = "data:image/png;base64,' + livePng.toString('base64') + '";\n' +
          '  const b2 = "data:image/png;base64,' + snapPng.toString('base64') + '";\n' +
          '  const load = (src) => new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.src = src; });\n' +
          '  const [ia, ib] = await Promise.all([load(a), load(b2)]);\n' +
          '  const w = Math.min(ia.width, ib.width), h = Math.min(ia.height, ib.height);\n' +
          '  const cv = new OffscreenCanvas(w, h); const ctx = cv.getContext("2d", { willReadFrequently: true });\n' +
          '  ctx.drawImage(ia, 0, 0); const da = ctx.getImageData(0, 0, w, h).data;\n' +
          '  ctx.clearRect(0, 0, w, h); ctx.drawImage(ib, 0, 0); const db = ctx.getImageData(0, 0, w, h).data;\n' +
          '  let sum = 0, big = 0;\n' +
          '  for (let i = 0; i < da.length; i += 4) { const d = Math.abs(da[i] - db[i]) + Math.abs(da[i+1] - db[i+1]) + Math.abs(da[i+2] - db[i+2]); sum += d; if (d > 48) big++; }\n' +
          '  const px = w * h;\n' +
          '  return { width: w, height: h, meanChannelDiff: +(sum / (px * 3)).toFixed(2), pctPixelsOver16: +((big / px) * 100).toFixed(2) };\n' +
        '})()',
        { isExpression: true }
      );
      report.compare[pg.name] = { liveBytes: livePng.length, snapBytes: snapPng.length, liveSha: sha(livePng), snapSha: sha(snapPng), size: '1440x900', diff };
    }
  }
} finally {
  await b.close();
}
console.log(JSON.stringify(report, null, 1));
await writeFile(path.join(OUT, 'verify.json'), JSON.stringify(report, null, 1));