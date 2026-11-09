// serve.mjs — 给 harness 用的极简静态服务器（播放器必须跑在 http 下：blob: iframe 在 file:// 是不透明源）
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const root = process.cwd();
const port = Number(process.argv[2] || 3911);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.css': 'text/css; charset=utf-8' };

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
  const file = join(root, rel || 'harness.html');
  if (!file.startsWith(root)) { res.writeHead(403).end('no'); return; }
  try {
    const buf = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(buf);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('404 ' + rel);
  }
}).listen(port, '127.0.0.1', () => console.log('ui-snapshot harness: http://127.0.0.1:' + port + '/harness.html'));
