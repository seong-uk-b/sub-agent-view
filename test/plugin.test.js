import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { HOOK_EVENTS, hooksJson } from '../server/lib/hooks-install.js';

const ROOT = path.join(import.meta.dirname, '..');
const readJson = async (p) => JSON.parse(await fs.readFile(path.join(ROOT, p), 'utf8'));

test('plugin.json has a valid kebab-case name and version', async () => {
  const p = await readJson('.claude-plugin/plugin.json');
  assert.equal(p.name, 'sub-agent-view');
  assert.match(p.name, /^[a-z0-9]+(-[a-z0-9]+)*$/);
  assert.ok(!/^(claude-|anthropic-|anthropics-|cc-plugin-)/.test(p.name));
  assert.match(p.version, /^\d+\.\d+\.\d+$/);
  assert.ok(p.description.length > 10);
});

test('hooks/hooks.json wraps the 9 events under "hooks" with async curl commands equal to hooksJson(4711)', async () => {
  const h = await readJson('hooks/hooks.json');
  assert.deepEqual(Object.keys(h), ['description', 'hooks']);
  assert.deepEqual(Object.keys(h.hooks).sort(), [...HOOK_EVENTS].sort());
  assert.deepEqual(h.hooks, hooksJson(4711).hooks);
  for (const ev of HOOK_EVENTS) {
    const entry = h.hooks[ev][0].hooks[0];
    assert.equal(entry.type, 'command'); assert.equal(entry.async, true);
    assert.match(entry.command, /127\.0\.0\.1:4711\/hook/); assert.match(entry.command, /\|\| true/);
    assert.equal('matcher' in h.hooks[ev][0], false);
  }
});

test('marketplace.json lists the plugin with source "."', async () => {
  const m = await readJson('.claude-plugin/marketplace.json');
  assert.equal(typeof m.name, 'string'); assert.equal(typeof m.owner.name, 'string');
  assert.deepEqual(m.plugins.map((p) => [p.name, p.source]), [['sub-agent-view', '.']]);
});

test('SKILL.md has name and description frontmatter and starts the bundled server', async () => {
  const text = await fs.readFile(path.join(ROOT, 'skills/office/SKILL.md'), 'utf8');
  const fm = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] || '';
  assert.match(fm, /^name: office$/m);
  assert.match(fm, /^description: .{10,}/m);
  assert.match(fm, /^disable-model-invocation: true$/m);
  assert.match(text, /\$\{CLAUDE_PLUGIN_ROOT\}\/server\/index\.js/);
  assert.match(text, /127\.0\.0\.1:4711/);
});
