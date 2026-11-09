// cdp.mjs — 最小 CDP 客户端：无头 Chrome + DevTools 协议，零依赖（Node 24 自带 WebSocket/fetch）
// ponytail: 只实现本工程要用的三种能力 navigate/evaluate/screenshot，不封装 Target/Session。
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

export const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, { tries = 200, gap = 100, label = 'ready' } = {}) {
  for (let i = 0; i < tries; i++) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {}
    await sleep(gap);
  }
  throw new Error('timeout waiting for ' + label);
}

export async function launch({ width = 1440, height = 900 } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'uicap-'));
  const proc = spawn(
    CHROME,
    [
      '--headless=new',
      '--no-sandbox', // 不加起不来（本机实测）
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--disable-extensions',
      '--hide-scrollbars',
      '--mute-audio',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-features=Translate,MediaRouter,OptimizationHints',
      `--user-data-dir=${dir}`, // 独立临时目录，绝不碰用户的 Chrome
      `--window-size=${width},${height}`,
      '--remote-debugging-port=0', // 0 = 让 Chrome 自己挑端口，写进 DevToolsActivePort
      'about:blank',
    ],
    { stdio: 'ignore', windowsHide: true }
  );

  const portFile = path.join(dir, 'DevToolsActivePort');
  const port = await waitFor(() => {
    if (!existsSync(portFile)) return 0;
    const t = readFileSync(portFile, 'utf8').trim().split(/\r?\n/);
    return t[0] ? Number(t[0]) : 0;
  }, { label: 'chrome devtools port' });

  const page = await waitFor(async () => {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const p = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    return p ? p.webSocketDebuggerUrl : null;
  }, { label: 'page target' });

  const s = await connect(page);
  await s.send('Page.enable');
  await s.send('Runtime.enable');
  await s.send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: 1, mobile: false,
  });

  return {
    dir,
    session: s,
    async close() {
      try { await s.send('Browser.close'); } catch {}
      try { s.ws.close(); } catch {}
      // 兜底：连整棵进程树一起收，绝不残留无头 Chrome
      spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    },
  };
}

export async function connect(url) {
  const ws = new WebSocket(url);
  let nextId = 1;
  const pending = new Map();
  const events = [];
  const waiters = [];

  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? rej(new Error(m.method + ' ' + JSON.stringify(m.error))) : res(m.result);
      return;
    }
    events.push(m);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].pred(m)) {
        waiters[i].res(m);
        waiters.splice(i, 1);
      }
    }
  });

  await new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', rej);
  });

  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const id = nextId++;
      pending.set(id, { res, rej });
      ws.send(JSON.stringify({ id, method, params }));
    });

  const on = (pred, timeoutMs = 30000) =>
    new Promise((res, rej) => {
      const w = { pred, res };
      waiters.push(w);
      setTimeout(() => {
        const i = waiters.indexOf(w);
        if (i >= 0) { waiters.splice(i, 1); rej(new Error('event timeout')); }
      }, timeoutMs);
    });

  return { send, on, ws, events };
}

export async function navigate(s, url, { settle = 700, timeout = 30000 } = {}) {
  // catch 必须立刻挂上：否则 send 期间事件超时会把整个进程作为 unhandled rejection 掐掉
  const loaded = s.on((m) => m.method === 'Page.loadEventFired', timeout).catch(() => null);
  await s.send('Page.navigate', { url });
  await loaded;
  await sleep(settle);
}

export async function evaluate(s, fnOrExpr, { isExpression = false } = {}) {
  const expression = isExpression ? fnOrExpr : `(${fnOrExpr.toString()})()`;
  const r = await s.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    allowUnsafeEvalBlockedByCSP: true,
  });
  if (r.exceptionDetails) {
    throw new Error('evaluate failed: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  }
  return r.result.value;
}

export async function screenshot(s) {
  const r = await s.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  return Buffer.from(r.data, 'base64');
}
