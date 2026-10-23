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
