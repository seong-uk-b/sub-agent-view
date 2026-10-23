import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { assignSeats, sheetFor, tabTone, sortSessions, liveAgentCount } from '../web/office.js';
import { changedFiles, mergeLines, missingAfter, DOM_LINE_CAP } from '../web/terminal.js';

const ag = (id, state, extra = {}) => ({ id, state, startedAt: 0, endedAt: null, ...extra });

test('assignSeats puts up to 4 active agents at desks, extras on the floor, done on the sofa up to 3', () => {
  const agents = [ag('a1', 'edit'), ag('a2', 'read'), ag('a3', 'run'), ag('a4', 'wait'), ag('a5', 'edit'), ag('d1', 'done', { endedAt: 1 }), ag('d2', 'done', { endedAt: 2 }), ag('d3', 'done', { endedAt: 3 }), ag('d4', 'done', { endedAt: 4 })];
  const r = assignSeats(agents);
  assert.deepEqual(r.deskSlots, ['a1', 'a2', 'a3', 'a4']);
  assert.deepEqual(r.floor.sort(), ['a5', 'd4']);
  assert.deepEqual(r.sofa, ['d1', 'd2', 'd3']);
});

test('assignSeats skips gone agents and keeps empty desk slots as null', () => {
  const r = assignSeats([ag('a1', 'edit'), ag('g1', 'gone', { endedAt: 1 })]);
  assert.deepEqual(r.deskSlots, ['a1', null, null, null]);
  assert.deepEqual(r.sofa, []); assert.deepEqual(r.floor, []);
});

test('assignSeats keeps a revived agent at its desk order by start time', () => {
  const r = assignSeats([ag('b', 'edit', { startedAt: 20 }), ag('a', 'run', { startedAt: 10 })]);
  assert.deepEqual(r.deskSlots, ['a', 'b', null, null]);
});

test('sheetFor is stable and within 0..5', () => {
  const ids = ['a352b6ff5cf549bef', 'main', 'x', '30f22d5c-3729-4d47-8d4a-4a91559b697f'];
  for (const id of ids) { const n = sheetFor(id); assert.equal(n, sheetFor(id)); assert.ok(n >= 0 && n <= 5, id); }
  assert.notEqual(sheetFor('a'), sheetFor('b'));
});

test('tabTone prefers wait, then active, then done, then idle; main wait counts', () => {
  const session = (mainState, states) => ({ main: { state: mainState }, agents: states.map((s, i) => ag('a' + i, s)) });
  assert.equal(tabTone(session('delegating', ['edit', 'wait'])), 'wait');
  assert.equal(tabTone(session('wait', ['done'])), 'wait');
  assert.equal(tabTone(session('delegating', ['edit', 'done'])), 'edit');
  assert.equal(tabTone(session('idle', ['done', 'gone'])), 'done');
  assert.equal(tabTone(session('idle', [])), 'idle');
  assert.equal(tabTone(session('edit', [])), 'edit');
});

test('sortSessions orders wait, active, done, idle then by name', () => {
  const s = (id, name, mainState, states) => ({ id, name, main: { state: mainState }, agents: states.map((x, i) => ag(id + i, x)) });
  const out = sortSessions([s('1', 'zeta', 'idle', []), s('2', 'beta', 'delegating', ['edit']), s('3', 'alpha', 'delegating', ['edit']), s('4', 'done', 'idle', ['done']), s('5', 'w', 'wait', [])]);
  assert.deepEqual(out.map((x) => x.id), ['5', '3', '2', '4', '1']);
});

test('changedFiles aggregates Edit/Write targets with counts', () => {
  const lines = [
    { kind: 'tool', tool: 'Read', text: 'a.ts' },
    { kind: 'tool', tool: 'Edit', text: 'src/x.ts' },
    { kind: 'tool', tool: 'Edit', text: 'src/x.ts' },
    { kind: 'tool', tool: 'Write', text: 'src/new.ts' },
    { kind: 'out', text: '+3 -1' },
  ];
  assert.deepEqual(changedFiles(lines), [{ path: 'src/x.ts', edits: 2, kind: 'M' }, { path: 'src/new.ts', edits: 1, kind: 'A' }]);
});

test('mergeLines appends only newer lines, keeps order, and trims to the cap', () => {
  const existing = [{ n: 1, text: 'a' }, { n: 2, text: 'b' }];
  const { lines, added } = mergeLines(existing, [{ n: 2, text: 'dup' }, { n: 3, text: 'c' }, { n: 4, text: 'd' }], 3);
  assert.deepEqual(lines.map((l) => l.n), [2, 3, 4]);
  assert.deepEqual(added.map((l) => l.n), [3, 4]);
  assert.equal(DOM_LINE_CAP, 500);
});

test('missingAfter tells which line number to fetch from when the server has more', () => {
  assert.equal(missingAfter([{ n: 7 }], 10), 7);       // 8..10 누락 → after=7
  assert.equal(missingAfter([{ n: 10 }], 10), null);   // 최신
  assert.equal(missingAfter([], 3), 0);                // 비어 있으면 처음부터
  assert.equal(missingAfter([], 0), null);
});

test('the "no sessions" overlay is hidden when the hidden attribute is set, so it cannot swallow clicks on characters', () => {
  const css = fs.readFileSync(new URL('../web/styles.css', import.meta.url), 'utf8');
  // .empty sets display:grid, which beats the UA [hidden] rule; the sheet must restore display:none for [hidden].
  assert.match(css, /\.empty\[hidden\]\s*\{[^}]*display\s*:\s*none/);
});

test('liveAgentCount leaves out agents that have already left the office', () => {
  const agents = [{ state: 'edit' }, { state: 'done' }, { state: 'gone' }, { state: 'gone' }];
  assert.equal(liveAgentCount({ agents }), 2);
  assert.equal(liveAgentCount({ agents: [] }), 0);
});

test('status bar title truncates with an ellipsis instead of overlapping the chips', () => {
  const css = fs.readFileSync(new URL('../web/styles.css', import.meta.url), 'utf8');
  const rule = /\.sb-title\{([^}]*)\}/.exec(css)?.[1] || '';
  assert.match(rule, /overflow\s*:\s*hidden/); assert.match(rule, /text-overflow\s*:\s*ellipsis/); assert.match(rule, /min-width\s*:\s*0/);
});
