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

export function createServer({ store, webDir, log = () => {}, debugInfo = () => ({}) }) {
  const webRoot = path.resolve(webDir);
  const hooks = { received: 0, byEvent: {}, lastAt: null };   // /api/debug용 카운터 (본문은 기록하지 않는다)

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (!hostAllowed(req.headers.host)) return send(res, 403, 'forbidden host');   // DNS 리바인딩 방지
    try {
      if (req.method === 'POST' && url.pathname === '/hook') return await handleHook(req, res);
      if (req.method !== 'GET') return send(res, 405, 'method not allowed');
      if (url.pathname === '/events') return handleEvents(req, res, url);
      if (url.pathname === '/api/snapshot') return json(res, store.snapshot());
      if (url.pathname === '/api/health') {
        const m = process.memoryUsage(); const snap = store.snapshot();
        return json(res, { pid: process.pid, rssMB: +(m.rss / 1048576).toFixed(1), heapUsedMB: +(m.heapUsed / 1048576).toFixed(1), sessions: snap.sessions.length, agents: snap.sessions.reduce((n, s) => n + s.agents.length, 0), uptimeSec: Math.floor(process.uptime()) });
      }
      if (url.pathname === '/api/debug') {
        return json(res, { platform: process.platform, node: process.version, pid: process.pid, uptimeSec: Math.floor(process.uptime()), now: Date.now(), hooks, ...debugInfo(), sessions: store.debug() });
      }
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
      hooks.received++; hooks.lastAt = Date.now();
      const ev = String(payload.hook_event_name || '?'); hooks.byEvent[ev] = (hooks.byEvent[ev] || 0) + 1;
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

/** 127.0.0.1 / localhost / [::1] (포트 무관) 만 허용. Host 없음은 거부. */
function hostAllowed(host) {
  if (!host) return false;
  const h = host.replace(/:\d+$/, '').toLowerCase();
  return h === '127.0.0.1' || h === 'localhost' || h === '[::1]';
}
function readBody(req, max) {
  return new Promise((resolve) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size <= max) chunks.push(c); });
    req.on('end', () => resolve(size <= max ? Buffer.concat(chunks).toString('utf8') : ''));
    req.on('error', () => resolve(''));
  });
}
function json(res, obj) { const body = JSON.stringify(obj); res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) }); res.end(body); }
function send(res, status, text) { res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' }); res.end(text); }
