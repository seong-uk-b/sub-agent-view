import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { HOOK_EVENTS, hookCommand, installHooks, uninstallHooks } from '../server/lib/hooks-install.js';

async function tmpSettings(obj) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sav-settings-'));
  const file = path.join(dir, 'settings.json');
  if (obj !== undefined) await fs.writeFile(file, JSON.stringify(obj, null, 2));
  return file;
}
const read = async (f) => JSON.parse(await fs.readFile(f, 'utf8'));

test('install adds 9 events with async command and keeps existing hooks', async () => {
  const existing = { permissions: { allow: ['Bash(ls)'] }, hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo orca' }] }] } };
  const file = await tmpSettings(existing);
  const { added } = await installHooks(file, { port: 4711 });
  assert.deepEqual(added, HOOK_EVENTS);
  assert.equal(HOOK_EVENTS.length, 9);
  const s = await read(file);
  assert.deepEqual(s.permissions, existing.permissions);
  assert.equal(s.hooks.UserPromptSubmit.length, 2);
  assert.equal(s.hooks.UserPromptSubmit[0].hooks[0].command, 'echo orca');
  const ours = s.hooks.PreToolUse[0].hooks[0];
  assert.equal(ours.type, 'command'); assert.equal(ours.async, true);
  assert.equal(ours.command, hookCommand(4711));
  assert.match(ours.command, /127\.0\.0\.1:4711\/hook/); assert.match(ours.command, /-m 1/); assert.match(ours.command, /\|\| true/);
  assert.equal('matcher' in s.hooks.PreToolUse[0], false);
});

test('install works when settings.json does not exist and is idempotent', async () => {
  const file = await tmpSettings(undefined);
  await installHooks(file, { port: 4711 });
  const { added } = await installHooks(file, { port: 4711 });
  assert.deepEqual(added, []);
  const s = await read(file);
  for (const ev of HOOK_EVENTS) assert.equal(s.hooks[ev].length, 1, ev);
});

test('uninstall removes only tagged entries and drops empty keys', async () => {
  const file = await tmpSettings({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo orca' }] }] } });
  await installHooks(file, { port: 4711 });
  const { removed } = await uninstallHooks(file);
  assert.deepEqual(removed, HOOK_EVENTS);
  const s = await read(file);
  assert.deepEqual(Object.keys(s.hooks), ['UserPromptSubmit']);
  assert.equal(s.hooks.UserPromptSubmit.length, 1);
  assert.equal(s.hooks.UserPromptSubmit[0].hooks[0].command, 'echo orca');
});

test('hookCommand exits 0 quickly when the server is down', () => {
  const t0 = Date.now();
  assert.doesNotThrow(() => execSync(hookCommand(1), { input: '{}', shell: '/bin/sh', stdio: ['pipe', 'ignore', 'ignore'] }));
  assert.ok(Date.now() - t0 < 1500, 'finished within 1.5s');
});
