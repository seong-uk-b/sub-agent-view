import test from 'node:test';
import assert from 'node:assert/strict';
import { assignSeats, sheetFor, tabTone, sortSessions } from '../web/office.js';
import { changedFiles } from '../web/terminal.js';

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
