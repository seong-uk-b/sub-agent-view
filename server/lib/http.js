import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

/*
 * HTTP 서버: 정적 파일, POST /hook, GET /events(SSE), GET /api/*.
 * 127.0.0.1 바인딩은 호출자(listen) 책임. 서버는 요청 본문을 로그에 남기지 않는다.
 */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.svg': 'image/svg+xml' };
const MAX_HOOK_BODY = 2 * 1024 * 1024;
const PING_MS = 15_000;

export function createServer({ store, webDir, log = () => {} }) {
  const webRoot = path.resolve(webDir);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    try {
      if (req.method === 'POST' && url.pathname === '/hook') return await handleHook(req, res);
      if (req.method !== 'GET') return send(res, 405, 'method not allowed');
      if (url.pathname === '/events') return handleEvents(req, res, url);
      if (url.pathname === '/api/snapshot') return json(res, store.snapshot());
      const m = /^\/api\/agent\/([^/]+)\/([^/]+)\/lines$/.exec(url.pathname);
      if (m) {
        const after = Number(url.searchParams.get('after')) || 0;
        return json(res, { lines: store.agentLines(decodeURIComponent(m[1]), decodeURIComponent(m[2]), after) });
      }
      return await serveStatic(url.pathname, res);
    } catch (err) {
      log('error', err?.message);
      if (!res.headersSent) send(res, 500, 'internal error');
      else res.end();
    }
  });

  async function handleHook(req, res) {
    const body = await readBody(req, MAX_HOOK_BODY);
    let payload = null;
    try { payload = JSON.parse(body); } catch { payload = null; }
    if (payload && typeof payload === 'object') {
      log('hook', payload.hook_event_name, payload.agent_id ? 'agent' : 'main');
      store.applyHook(payload);
    }
    json(res, {});
  }

  function handleEvents(req, res, url) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    const write = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    write('snapshot', store.snapshot());
    const agentKey = url.searchParams.get('agent');   // "<sessionId>/<agentId>"
    const onPatch = (snap) => write('patch', snap);
    const onLine = (e) => { if (agentKey && `${e.sessionId}/${e.agentId}` === agentKey) write('line', e); };
    store.on('patch', onPatch); store.on('line', onLine);
    const ping = setInterval(() => res.write(': ping\n\n'), PING_MS);
    req.on('close', () => { clearInterval(ping); store.off('patch', onPatch); store.off('line', onLine); });
  }

  async function serveStatic(pathname, res) {
    const rel = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
    const file = path.resolve(webRoot, '.' + rel);
    if (!file.startsWith(webRoot + path.sep) && file !== webRoot) return send(res, 404, 'not found');
    let st; try { st = await fsp.stat(file); } catch { return send(res, 404, 'not found'); }
    if (!st.isFile()) return send(res, 404, 'not found');
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'content-length': st.size, 'cache-control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  }

  return server;
}

function readBody(req, max) {
  return new Promise((resolve) => {
    let data = ''; let size = 0;
    req.on('data', (c) => { size += c.length; if (size <= max) data += c; });
    req.on('end', () => resolve(size <= max ? data : ''));
    req.on('error', () => resolve(''));
  });
}
function json(res, obj) { const body = JSON.stringify(obj); res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) }); res.end(body); }
function send(res, status, text) { res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' }); res.end(text); }
