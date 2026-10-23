import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sessionsDir, readRegistry, isPidAlive, procStartOf } from '../server/lib/sessions-registry.js';

async function makeDir(files) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sav-sessions-'));
  for (const [name, body] of Object.entries(files)) await fs.writeFile(path.join(dir, name), body);
  return dir;
}

test('sessionsDir sits next to projects under the Claude config dir', () => {
  assert.equal(sessionsDir({ CLAUDE_CONFIG_DIR: '/cfg' }), path.join('/cfg', 'sessions'));
  assert.equal(sessionsDir({ HOME: '/home/u' }), path.join('/home/u', '.claude', 'sessions'));
});

test('readRegistry maps sessionId → {pid, cwd, name, alive} using the injected liveness check', async () => {
  const dir = await makeDir({
    '101.json': JSON.stringify({ pid: 101, sessionId: 'sess-a', cwd: '/w/alpha', name: 'alpha-c0', status: 'busy' }),
    '202.json': JSON.stringify({ pid: 202, sessionId: 'sess-b', cwd: 'C:\\w\\beta' }),
    '202.abc.key': 'secret',
    'junk.json': '{not json',
    '303.json': JSON.stringify({ pid: 303 }),                     // sessionId 없음 → 무시
  });
  const reg = await readRegistry(dir, { isAlive: (pid) => pid === 101 });
  assert.deepEqual(reg.get('sess-a'), { pid: 101, cwd: '/w/alpha', name: 'alpha-c0', alive: true });
  assert.deepEqual(reg.get('sess-b'), { pid: 202, cwd: 'C:\\w\\beta', name: '', alive: false });
  assert.equal(reg.size, 2);
});

test('readRegistry returns an empty map when the directory is missing', async () => {
  const reg = await readRegistry(path.join(os.tmpdir(), 'sav-does-not-exist-' + Date.now()));
  assert.equal(reg.size, 0);
});

test('isPidAlive is true for this process and false for an impossible pid', () => {
  assert.equal(isPidAlive(process.pid), true);
  assert.equal(isPidAlive(2 ** 22 - 1), false);
  assert.equal(isPidAlive(0), false);
  assert.equal(isPidAlive(NaN), false);
});

test('on Linux, isPidAlive rejects a pid whose /proc start time differs from the registry procStart (pid reuse / zombie guard)', { skip: process.platform !== 'linux' }, () => {
  const mine = procStartOf(process.pid);
  assert.match(String(mine), /^\d+$/);
  assert.equal(isPidAlive(process.pid, { procStart: mine }), true);
  assert.equal(isPidAlive(process.pid, { procStart: '1' }), false);
  assert.equal(isPidAlive(process.pid), true, 'without procStart it falls back to the signal-0 check');
});

test('readRegistry passes the entry procStart into the liveness check', async () => {
  const dir = await makeDir({ '5.json': JSON.stringify({ pid: 5, sessionId: 's', procStart: '777' }) });
  const seen = [];
  await readRegistry(dir, { isAlive: (pid, opts) => { seen.push([pid, opts?.procStart]); return true; } });
  assert.deepEqual(seen, [[5, '777']]);
});
