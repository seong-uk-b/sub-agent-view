import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../server/lib/state.js';
import { ProjectsWatcher } from '../server/lib/watcher.js';

const FIX = path.join(import.meta.dirname, 'fixtures');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 임시 projects 루트에 세션 1개(s1) + 서브에이전트 a1을 픽스처로 구성 */
async function makeRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sav-root-'));
  const proj = path.join(root, '-home-u-demo');
  const subs = path.join(proj, 's1', 'subagents');
  await fs.mkdir(subs, { recursive: true });
  await fs.copyFile(path.join(FIX, 'main.jsonl'), path.join(proj, 's1.jsonl'));
  await fs.copyFile(path.join(FIX, 'subagent.jsonl'), path.join(subs, 'agent-a1.jsonl'));
  await fs.copyFile(path.join(FIX, 'agent-x.meta.json'), path.join(subs, 'agent-a1.meta.json'));
  return { root, proj, subs };
}
function startWatcher(root, store) {
  const w = new ProjectsWatcher({ root, store, pollMs: 50, scanMs: 50, usePolling: true });
  return w;
}

test('scan discovers session and subagent and attaches meta', async (t) => {
  const { root } = await makeRoot();
  const store = new Store();
  const w = startWatcher(root, store); t.after(() => w.stop());
  await w.scan();
  const [s] = store.snapshot().sessions;
  assert.ok(s, 'session discovered');
  assert.equal(s.id, 's1');
  assert.equal(s.name, 'demo');                       // cwd from transcript record
  const a = s.agents.find((x) => x.id === 'a1');
  assert.equal(a.name, '탐색-auth');
  assert.equal(a.type, 'Explore');
  assert.equal(a.task, 'src/auth 아래 토큰 갱신 로직 위치를 찾아줘');
  assert.equal(a.toolCalls, 1);
  assert.equal(a.outputTokens, 200);                  // msg_1 once (120) + msg_2 (80)
  assert.equal(store.agentLines('s1', 'a1', 0).length, 5);
  w.stop();
});

test('appending a line to the subagent transcript updates state', async (t) => {
  const { root, subs } = await makeRoot();
  const store = new Store();
  const w = startWatcher(root, store); t.after(() => w.stop());
  await w.start();
  const line = JSON.stringify({ sessionId: 's1', agentId: 'a1', isSidechain: true, type: 'assistant', timestamp: new Date().toISOString(),
    message: { id: 'msg_9', role: 'assistant', content: [{ type: 'tool_use', id: 't_edit', name: 'Edit', input: { file_path: 'src/x.ts' } }], usage: { output_tokens: 5 } } });
  await fs.appendFile(path.join(subs, 'agent-a1.jsonl'), line + '\n');
  await sleep(200);
  const a = store.snapshot().sessions[0].agents.find((x) => x.id === 'a1');
  assert.equal(a.state, 'edit'); assert.equal(a.target, 'src/x.ts');
  w.stop();
});

test('stale transcripts are ignored', async (t) => {
  const { root, proj } = await makeRoot();
  const old = new Date(Date.now() - 3 * 3600_000);
  await fs.utimes(path.join(proj, 's1.jsonl'), old, old);
  const store = new Store();
  const w = startWatcher(root, store); t.after(() => w.stop());
  await w.scan();
  assert.equal(store.snapshot().sessions.length, 0);
  w.stop();
});

test('a new subagent file appearing after start is picked up', async (t) => {
  const { root, subs } = await makeRoot();
  const store = new Store();
  const w = startWatcher(root, store); t.after(() => w.stop());
  await w.start();
  await fs.copyFile(path.join(FIX, 'subagent.jsonl'), path.join(subs, 'agent-a2.jsonl'));
  await sleep(250);
  const ids = store.snapshot().sessions[0].agents.map((a) => a.id).sort();
  assert.deepEqual(ids, ['a1', 'a2']);
  w.stop();
});

test('session cwd comes from transcript records when no hook has arrived', async (t) => {
  const { root } = await makeRoot();
  const store = new Store();
  const w = startWatcher(root, store); t.after(() => w.stop());
  await w.scan();
  assert.equal(store.snapshot().sessions[0].cwd, '/home/u/demo');
  w.stop();
});

test('a session removed after SessionEnd is not re-registered by scan until its transcript changes', async (t) => {
  const { root, proj } = await makeRoot();
  let now = Date.now();
  const store = new Store({ now: () => now, sessionEndGraceMs: 1000 });
  const w = startWatcher(root, store); t.after(() => w.stop());
  await w.start();
  assert.equal(store.snapshot().sessions.length, 1);
  store.applyHook({ hook_event_name: 'SessionEnd', session_id: 's1', cwd: '/home/u/demo', reason: 'other' });
  now += 2000; store.tick();
  assert.equal(store.snapshot().sessions.length, 0);
  await w.scan();
  assert.equal(store.snapshot().sessions.length, 0, 'ghost session must not come back');
  await sleep(20);
  await fs.appendFile(path.join(proj, 's1.jsonl'), JSON.stringify({ sessionId: 's1', type: 'user', cwd: '/home/u/demo', timestamp: new Date().toISOString(), turnOrigin: 'human', message: { role: 'user', content: '다시 시작' } }) + '\n');
  await w.scan();
  assert.equal(store.snapshot().sessions.length, 1, 'new activity re-registers the session');
  assert.equal(store.snapshot().sessions[0].title, '다시 시작');
});

test('fs.watch mode picks up rapid consecutive appends without losing lines', async (t) => {
  const { root, subs } = await makeRoot();
  const store = new Store();
  const w = new ProjectsWatcher({ root, store, pollMs: 50, scanMs: 50, usePolling: false }); t.after(() => w.stop());
  await w.start();
  const before = store.agentLines('s1', 'a1', 0).length;
  const file = path.join(subs, 'agent-a1.jsonl');
  const mk = (i) => JSON.stringify({ sessionId: 's1', agentId: 'a1', isSidechain: true, type: 'assistant', timestamp: new Date().toISOString(), message: { id: 'm' + i, role: 'assistant', content: [{ type: 'text', text: 'line ' + i }], usage: { output_tokens: 1 } } }) + '\n';
  for (let i = 0; i < 5; i++) await fs.appendFile(file, mk(i));
  await sleep(400);
  assert.equal(store.agentLines('s1', 'a1', 0).length, before + 5);
});

test('a registry entry whose pid is dead ends the session; a live one names it from cwd', async (t) => {
  const { root } = await makeRoot();
  const proj = path.join(root, '-home-u-demo');
  // s2: cwd 기록이 없는 트랜스크립트 → 이름은 레지스트리 cwd에서 와야 한다
  await fs.writeFile(path.join(proj, 's2.jsonl'), JSON.stringify({ type: 'user', timestamp: '2026-10-23T01:00:00Z', message: { role: 'user', content: 'hello' } }) + '\n');
  const sessionsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sav-sess-'));
  await fs.writeFile(path.join(sessionsRoot, '1.json'), JSON.stringify({ pid: 1, sessionId: 's1', cwd: '/home/u/demo' }));
  await fs.writeFile(path.join(sessionsRoot, '2.json'), JSON.stringify({ pid: 2, sessionId: 's2', cwd: '/srv/other-project' }));
  const store = new Store();
  const w = new ProjectsWatcher({ root, store, sessionsRoot, isPidAlive: (pid) => pid === 2, pollMs: 50, scanMs: 50, usePolling: true });
  t.after(() => w.stop());
  await w.scan();
  const byId = Object.fromEntries(store.snapshot().sessions.map((s) => [s.id, s]));
  assert.ok(store.sessions.get('s1').endedAt != null, 's1 (dead pid) is marked ended');
  assert.equal(store.sessions.get('s2').endedAt, null, 's2 (live pid) stays open');
  assert.equal(byId.s2.name, 'other-project', 'live session is named from the registry cwd');
});

test('without a sessions directory the watcher behaves as before', async (t) => {
  const { root } = await makeRoot();
  const store = new Store();
  const w = new ProjectsWatcher({ root, store, sessionsRoot: path.join(root, 'no-such-dir'), pollMs: 50, scanMs: 50, usePolling: true });
  t.after(() => w.stop());
  await w.scan();
  assert.equal(store.snapshot().sessions.length, 1);
  assert.equal(store.sessions.get('s1').endedAt, null);
});

test('debug() reports mode, roots, last scan time and registry bookkeeping', async (t) => {
  const { root } = await makeRoot();
  const sessionsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sav-sess-'));
  await fs.writeFile(path.join(sessionsRoot, '7.json'), JSON.stringify({ pid: 7, sessionId: 's1', cwd: '/home/u/demo' }));
  const store = new Store();
  const w = new ProjectsWatcher({ root, store, sessionsRoot, isPidAlive: () => true, pollMs: 50, scanMs: 50, usePolling: true });
  t.after(() => w.stop());
  assert.equal(w.debug().mode, 'idle');
  await w.scan();
  const d = w.debug();
  assert.equal(d.root, root); assert.equal(d.sessionsRoot, sessionsRoot);
  assert.ok(Date.now() - d.lastScanAt < 5000); assert.equal(d.tailers, 2); assert.deepEqual(d.registrySeen, ['s1']);
  assert.deepEqual(d.registry, [{ sessionId: 's1', pid: 7, alive: true }]);
});
