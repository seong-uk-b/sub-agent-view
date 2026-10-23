import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JsonlTailer } from '../server/lib/jsonl-tail.js';

async function tmpFile(content = '') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sav-tail-'));
  const file = path.join(dir, 'a.jsonl');
  await fs.writeFile(file, content);
  return file;
}

test('reads existing lines then only new ones', async () => {
  const file = await tmpFile('{"a":1}\n{"a":2}\n');
  const t = new JsonlTailer(file);
  assert.deepEqual(await t.read(), [{ a: 1 }, { a: 2 }]);
  await fs.appendFile(file, '{"a":3}\n');
  assert.deepEqual(await t.read(), [{ a: 3 }]);
  assert.deepEqual(await t.read(), []);
});

test('keeps a partial line until newline arrives', async () => {
  const file = await tmpFile('{"a":1}\n{"b":');
  const t = new JsonlTailer(file);
  assert.deepEqual(await t.read(), [{ a: 1 }]);
  await fs.appendFile(file, '2}\n');
  assert.deepEqual(await t.read(), [{ b: 2 }]);
});

test('skips malformed lines', async () => {
  const file = await tmpFile('not json\n{"ok":true}\n\n');
  const t = new JsonlTailer(file);
  assert.deepEqual(await t.read(), [{ ok: true }]);
});

test('restarts when file is truncated', async () => {
  const file = await tmpFile('{"n":1}\n{"n":2}\n{"n":3}\n');
  const t = new JsonlTailer(file);
  assert.equal((await t.read()).length, 3);
  await fs.writeFile(file, '{"n":9}\n');
  assert.deepEqual(await t.read(), [{ n: 9 }]);
});

test('returns empty when file is missing and recovers when it appears', async () => {
  const file = await tmpFile();
  await fs.rm(file);
  const t = new JsonlTailer(file);
  assert.deepEqual(await t.read(), []);
  await fs.writeFile(file, '{"x":1}\n');
  assert.deepEqual(await t.read(), [{ x: 1 }]);
});

test('lineFilter skips parsing of filtered lines', async () => {
  const file = await tmpFile('{"type":"x","big":"' + 'z'.repeat(1000) + '"}\n{"type":"user"}\n');
  const t = new JsonlTailer(file, { lineFilter: (line) => /"type":"user"/.test(line) });
  assert.deepEqual(await t.read(), [{ type: 'user' }]);
});

test('handles multi-byte UTF-8 split across reads', async () => {
  const file = await tmpFile('');
  const t = new JsonlTailer(file);
  const full = Buffer.from('{"k":"한글"}\n');
  await fs.appendFile(file, full.subarray(0, 8));   // '한' 글자 중간에서 끊김
  assert.deepEqual(await t.read(), []);
  await fs.appendFile(file, full.subarray(8));
  assert.deepEqual(await t.read(), [{ k: '한글' }]);
});

test('reads files larger than one chunk without losing or splitting lines', async () => {
  const file = await tmpFile('');
  const line = JSON.stringify({ pad: 'p'.repeat(100_000), k: '한글' }) + '\n';
  await fs.writeFile(file, line.repeat(30));                 // ~3MB, 청크(1MB) 경계가 줄 중간에 걸림
  const t = new JsonlTailer(file, { chunkSize: 1024 * 1024 });
  const recs = await t.read();
  assert.equal(recs.length, 30);
  assert.ok(recs.every((r) => r.k === '한글'));
  assert.equal(t.offset, Buffer.byteLength(line) * 30);
});
