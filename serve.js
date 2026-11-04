const http = require('http');
const fs = require('fs');
const path = require('path');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.xlsx': 'application/octet-stream',
};

// /api/<이름> → api/<이름>.mjs 핸들러를 Vercel처럼 실행 (로컬 확인용. 운영은 Vercel이 직접 실행)
const { pathToFileURL } = require('url');
function runApi(name, req, res) {
  const file = path.join(__dirname, 'api', name.replace(/[^a-z0-9_-]/gi, '') + '.mjs');
  if (!fs.existsSync(file)) { res.writeHead(404); res.end('Not found'); return; }
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', async () => {
    const shim = {
      statusCode: 200,
      setHeader: (k, v) => res.setHeader(k, v),
      status(c) { this.statusCode = c; return this; },
      json(o) { res.writeHead(this.statusCode, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(o)); },
    };
    try {
      const mod = await import(pathToFileURL(file).href + '?t=' + fs.statSync(file).mtimeMs); // 파일 바뀌면 다시 읽음
      let body = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch { body = raw; }
      await mod.default({ method: req.method, headers: req.headers, body }, shim);
    } catch (e) {
      console.error('[api]', name, e);
      if (!res.headersSent) { res.writeHead(500); res.end(String(e.message || e)); }
    }
  });
}

http.createServer((req, res) => {
  let url = decodeURIComponent(req.url.split('?')[0]);
  if (url.startsWith('/api/')) { runApi(url.slice(5), req, res); return; }
  if (url === '/') url = '/index.html';
  const filePath = path.join(__dirname, url);
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(3001, () => console.log('Listening on 3001'));
