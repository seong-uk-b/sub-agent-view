import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { normalizeRecord, MAIN_LINE_FILTER, readMeta, classifyTool, toolTarget } from '../server/lib/transcript.js';

const FIX = path.join(import.meta.dirname, 'fixtures');
async function records(name) {
  const text = await fs.readFile(path.join(FIX, name), 'utf8');
  return text.trim().split('\n').map((l) => JSON.parse(l));
}

test('assistant tool_use yields tool_use and usage with messageId', async () => {
  const recs = await records('subagent.jsonl');
  const ev = normalizeRecord(recs[3]);
  assert.deepEqual(ev[0], { kind: 'tool_use', id: 'toolu_grep', name: 'Grep', input: { pattern: 'refreshToken', path: 'src/auth' }, ts: Date.parse('2026-10-23T01:45:06.307Z') });
  assert.deepEqual(ev[1], { kind: 'usage', messageId: 'msg_1', output: 120, input: 2, cacheRead: 2500, cacheCreate: 500, model: 'claude-haiku-5-5', ts: Date.parse('2026-10-23T01:45:06.307Z') });
});

test('assistant text yields text(assistant)', async () => {
  const recs = await records('subagent.jsonl');
  const ev = normalizeRecord(recs[2]);
  assert.equal(ev[0].kind, 'text'); assert.equal(ev[0].role, 'assistant'); assert.equal(ev[0].text, '먼저 grep으로 찾겠습니다.');
});

test('Agent tool_use yields spawn', async () => {
  const recs = await records('main.jsonl');
  const ev = normalizeRecord(recs[1]);
  const spawn = ev.find((e) => e.kind === 'spawn');
  assert.deepEqual(spawn, { kind: 'spawn', toolUseId: 'toolu_01', agentType: 'Explore', description: '탐색-auth', prompt: 'src/auth 아래 토큰 갱신 로직 위치를 찾아줘', ts: Date.parse('2026-10-23T01:45:00.000Z') });
});

test('user string content yields text(user) with human flag', async () => {
  const recs = await records('subagent.jsonl');
  assert.deepEqual(normalizeRecord(recs[0]), [{ kind: 'text', role: 'user', text: 'src/auth 아래 토큰 갱신 로직 위치를 찾아줘', human: true, ts: Date.parse('2026-10-23T01:45:03.623Z') }]);
  assert.equal(normalizeRecord({ type: 'user', parentUuid: 'x', turnOrigin: 'human', message: { content: '안녕' } })[0].human, true);
  assert.equal(normalizeRecord({ type: 'user', parentUuid: 'x', promptSource: 'system', turnOrigin: 'task_notification', message: { content: '<task-notification>' } })[0].human, false);
  assert.equal(normalizeRecord({ type: 'user', parentUuid: null, isMeta: true, message: { content: '[Image]' } })[0].human, false);
});

test('user tool_result yields tool_result; array content is joined', async () => {
  const sub = await records('subagent.jsonl');
  assert.deepEqual(normalizeRecord(sub[4]), [{ kind: 'tool_result', toolUseId: 'toolu_grep', text: 'src/auth/session.ts:41\nsrc/auth/client.ts:88', isError: false, ts: Date.parse('2026-10-23T01:45:07.000Z') }]);
  const main = await records('main.jsonl');
  assert.equal(normalizeRecord(main[3])[0].text, 'Async agent launched successfully. agentId: a1');
});

test('ignores unknown types and never throws', () => {
  assert.deepEqual(normalizeRecord({ type: 'api-request-blob', blob: 'x' }), []);
  assert.deepEqual(normalizeRecord({}), []);
  assert.deepEqual(normalizeRecord(null), []);
  assert.deepEqual(normalizeRecord({ type: 'assistant', message: { content: 'weird' } }), []);
});

test('MAIN_LINE_FILTER keeps user/assistant/system lines and drops blobs without parsing', async () => {
  const text = await fs.readFile(path.join(FIX, 'main.jsonl'), 'utf8');
  const lines = text.trim().split('\n');
  assert.equal(MAIN_LINE_FILTER(lines[0]), true);   // user
  assert.equal(MAIN_LINE_FILTER(lines[1]), true);   // assistant
  assert.equal(MAIN_LINE_FILTER(lines[2]), false);  // api-request-blob (200KB)
  assert.equal(MAIN_LINE_FILTER(lines[4]), true);   // system
  assert.equal(MAIN_LINE_FILTER('{"type":"attachment"}'), false);
  // 실제 assistant 줄: message가 먼저 오고 최상위 type은 줄 끝에 있다
  const tailLine = '{"parentUuid":"x","message":{"type":"message","content":[{"type":"text","text":"' + 'y'.repeat(2000) + '"}]},"type":"assistant","uuid":"u"}';
  assert.equal(MAIN_LINE_FILTER(tailLine), true);
  const blobTail = '{"type":"api-request-blob","blob":"' + 'z'.repeat(2000) + '"}';
  assert.equal(MAIN_LINE_FILTER(blobTail), false);
});

test('readMeta returns fields and null when missing', async () => {
  assert.deepEqual(await readMeta(path.join(FIX, 'agent-x.meta.json')), { agentType: 'Explore', description: '탐색-auth', toolUseId: 'toolu_01', finished: false, spawnDepth: 1 });
  assert.equal(await readMeta(path.join(FIX, 'nope.meta.json')), null);
});

test('classifyTool', () => {
  for (const n of ['Edit', 'Write', 'NotebookEdit']) assert.equal(classifyTool(n), 'edit');
  for (const n of ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch']) assert.equal(classifyTool(n), 'read');
  assert.equal(classifyTool('Bash'), 'run');
  assert.equal(classifyTool('Agent'), 'edit');
});

test('toolTarget', () => {
  assert.equal(toolTarget('Edit', { file_path: '/a/b.ts' }), '/a/b.ts');
  assert.equal(toolTarget('Grep', { pattern: 'refreshToken' }), 'refreshToken');
  assert.equal(toolTarget('Bash', { command: 'x'.repeat(100) }), 'x'.repeat(80));
  assert.equal(toolTarget('Agent', { description: '탐색-auth', prompt: '...' }), '탐색-auth');
  assert.equal(toolTarget('Mystery', { foo: 1, bar: 'hello' }), 'hello');
  assert.equal(toolTarget('Mystery', {}), '');
});
