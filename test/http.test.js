import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../server/lib/state.js';
import { createServer } from '../server/lib/http.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function boot(t) {
  const webDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sav-web-'));
  await fs.writeFile(path.join(webDir, 'index.html'), '<!doctype html><title>sav</title>');
  const store = new Store();
  const server = createServer({ store, webDir });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => new Promise((r) => server.close(r)));
  return { store, server, base };
}
function post(url, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
      let data = ''; res.on('data', (c) => (data += c)); res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject); req.end(body);
  });
}
function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => { let data = ''; res.on('data', (c) => (data += c)); res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers })); }).on('error', reject);
  });
}
/** SSE: 이벤트 n개를 모을 때까지 읽고 끊는다 */
function sse(url, count, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const events = []; let buf = '';
    const req = http.get(url, (res) => {
      res.on('data', (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n\n')) !== -1) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          if (block.startsWith(':')) continue;
          const ev = /^event: (.*)$/m.exec(block)?.[1]; const data = /^data: (.*)$/m.exec(block)?.[1];
          if (ev) events.push({ event: ev, data: JSON.parse(data) });
          if (events.length >= count) { req.destroy(); resolve(events); }
        }
      });
    });
    req.on('error', (e) => { if (events.length >= count) return; reject(e); });
    setTimeout(() => { req.destroy(); resolve(events); }, timeoutMs);
  });
}
const hook = (name, extra = {}) => JSON.stringify({ hook_event_name: name, session_id: 's1', cwd: '/home/u/demo', ...extra });

test('POST /hook feeds the store and returns 200 even for bad JSON', async (t) => {
  const { store, base } = await boot(t);
  const ok = await post(base + '/hook', hook('SubagentStart', { agent_id: 'a1', agent_type: 'Explore' }));
  assert.equal(ok.status, 200);
  assert.equal(store.snapshot().sessions[0].agents[0].id, 'a1');
  const bad = await post(base + '/hook', '{not json');
  assert.equal(bad.status, 200); assert.equal(bad.body, '{}');
});

test('GET /events sends snapshot first then patch after a hook', async (t) => {
  const { base } = await boot(t);
  const pending = sse(base + '/events', 2);
  await sleep(100);
  await post(base + '/hook', hook('SessionStart'));
  const events = await pending;
  assert.equal(events[0].event, 'snapshot'); assert.deepEqual(events[0].data, { sessions: [] });
  assert.equal(events[1].event, 'patch'); assert.equal(events[1].data.sessions[0].id, 's1');
});

test('GET /events?agent= streams line events for that agent only', async (t) => {
  const { store, base } = await boot(t);
  store.applyHook(JSON.parse(hook('SubagentStart', { agent_id: 'a1', agent_type: 'x' })));
  store.applyHook(JSON.parse(hook('SubagentStart', { agent_id: 'a2', agent_type: 'x' })));
  const pending = sse(base + '/events?agent=s1/a1', 3, 1500);
  await sleep(100);
  store.applyAgentEvents('s1', 'a2', [{ kind: 'text', role: 'assistant', text: 'other', ts: Date.now() }]);
  store.applyAgentEvents('s1', 'a1', [{ kind: 'text', role: 'assistant', text: 'mine', ts: Date.now() }]);
  const events = await pending;
  const lines = events.filter((e) => e.event === 'line');
  assert.equal(lines.length, 1); assert.equal(lines[0].data.line.text, 'mine'); assert.equal(lines[0].data.agentId, 'a1');
});

test('GET /api/agent/<s>/<a>/lines?after=n returns newer lines', async (t) => {
  const { store, base } = await boot(t);
  store.applyHook(JSON.parse(hook('SubagentStart', { agent_id: 'a1', agent_type: 'x' })));
  for (let i = 1; i <= 4; i++) store.applyAgentEvents('s1', 'a1', [{ kind: 'text', role: 'assistant', text: 'l' + i, ts: i }]);
  const r = await get(base + '/api/agent/s1/a1/lines?after=2');
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(r.body).lines.map((l) => l.text), ['l3', 'l4']);
  const snap = await get(base + '/api/snapshot');
  assert.equal(JSON.parse(snap.body).sessions.length, 1);
});

test('static serving returns index and blocks path traversal', async (t) => {
  const { base } = await boot(t);
  const idx = await get(base + '/');
  assert.equal(idx.status, 200); assert.match(idx.headers['content-type'], /text\/html/);
  const bad = await get(base + '/../package.json');
  assert.equal(bad.status, 404);
  const missing = await get(base + '/nope.js');
  assert.equal(missing.status, 404);
});

test('server only listens on 127.0.0.1', async (t) => {
  const { server } = await boot(t);
  assert.equal(server.address().address, '127.0.0.1');
});
