import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/lib/state.js';

const T0 = Date.parse('2026-10-23T01:00:00Z');
function makeStore(opts = {}) {
  let now = T0;
  const store = new Store({ now: () => now, ...opts });
  store.advance = (ms) => { now += ms; };
  return store;
}
const hook = (name, extra = {}) => ({ hook_event_name: name, session_id: 's1', transcript_path: '/h/.claude/projects/-home-u-demo/s1.jsonl', cwd: '/home/u/demo', ...extra });
const sub = (store) => store.snapshot().sessions[0];
const agentOf = (store, id) => sub(store).agents.find((a) => a.id === id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('PreToolUse Edit sets edit state, tool and target', () => {
  const s = makeStore();
  s.applyHook(hook('SubagentStart', { agent_id: 'a1', agent_type: 'Explore' }));
  s.applyHook(hook('PreToolUse', { agent_id: 'a1', tool_name: 'Edit', tool_input: { file_path: 'src/api/refund.ts' }, tool_use_id: 't1' }));
  const a = agentOf(s, 'a1');
  assert.equal(a.state, 'edit'); assert.equal(a.tool, 'Edit'); assert.equal(a.target, 'src/api/refund.ts'); assert.equal(a.toolCalls, 1);
  assert.equal(a.type, 'Explore');
});

test('PermissionRequest sets wait and PostToolUse restores previous state', () => {
  const s = makeStore();
  s.applyHook(hook('SubagentStart', { agent_id: 'a1', agent_type: 'general-purpose' }));
  s.applyHook(hook('PreToolUse', { agent_id: 'a1', tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: 't1' }));
  s.applyHook(hook('PermissionRequest', { agent_id: 'a1', tool_name: 'Bash', tool_input: { command: 'rm -rf dist/' } }));
  let a = agentOf(s, 'a1');
  assert.equal(a.state, 'wait'); assert.equal(a.waitReason, 'Bash 실행 권한 요청'); assert.equal(a.waitDetail, 'rm -rf dist/');
  s.applyHook(hook('PostToolUse', { agent_id: 'a1', tool_name: 'Bash', tool_use_id: 't1', duration_ms: 10 }));
  a = agentOf(s, 'a1');
  assert.equal(a.state, 'run');
});

test('PreToolUse AskUserQuestion sets wait with reason 사용자 답변 대기', () => {
  const s = makeStore();
  s.applyHook(hook('SubagentStart', { agent_id: 'a1', agent_type: 'x' }));
  s.applyHook(hook('PreToolUse', { agent_id: 'a1', tool_name: 'AskUserQuestion', tool_input: { questions: [] }, tool_use_id: 't1' }));
  assert.equal(agentOf(s, 'a1').state, 'wait'); assert.equal(agentOf(s, 'a1').waitReason, '사용자 답변 대기');
});

test('PostToolUse before PreToolUse counts one call and does not stay in wait', () => {
  const s = makeStore();
  s.applyHook(hook('SubagentStart', { agent_id: 'a1', agent_type: 'x' }));
  s.applyHook(hook('PermissionRequest', { agent_id: 'a1', tool_name: 'Bash', tool_input: { command: 'ls' } }));
  s.applyHook(hook('PostToolUse', { agent_id: 'a1', tool_name: 'Bash', tool_use_id: 't9' }));
  s.applyHook(hook('PreToolUse', { agent_id: 'a1', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 't9' }));
  const a = agentOf(s, 'a1');
  assert.equal(a.toolCalls, 1); assert.notEqual(a.state, 'wait');
});

test('SubagentStop marks done with summary; later tool_use revives to run', () => {
  const s = makeStore();
  s.applyHook(hook('SubagentStart', { agent_id: 'a1', agent_type: 'x' }));
  s.applyHook(hook('SubagentStop', { agent_id: 'a1', agent_type: 'x', last_assistant_message: 'A'.repeat(200) }));
  let a = agentOf(s, 'a1');
  assert.equal(a.state, 'done'); assert.equal(a.summary.length, 160); assert.equal(a.endedAt, T0);
  s.applyAgentEvents('s1', 'a1', [{ kind: 'tool_use', id: 't2', name: 'Bash', input: { command: 'npm run build' }, ts: T0 + 1000 }]);
  a = agentOf(s, 'a1');
  assert.equal(a.state, 'run'); assert.equal(a.endedAt, null);
});

test('attachMeta links name/type/task from main spawn by toolUseId', () => {
  const s = makeStore();
  s.ensureSession('s1', { cwd: '/home/u/demo' });
  s.applyMainEvents('s1', [{ kind: 'spawn', toolUseId: 'toolu_01', agentType: 'Explore', description: '탐색-auth', prompt: 'src/auth 아래 토큰 갱신 로직 찾기', ts: T0 }]);
  s.ensureAgent('s1', 'a1');
  s.attachMeta('s1', 'a1', { agentType: 'Explore', description: '탐색-auth', toolUseId: 'toolu_01', finished: false, spawnDepth: 1 });
  const a = agentOf(s, 'a1');
  assert.equal(a.name, '탐색-auth'); assert.equal(a.type, 'Explore'); assert.equal(a.task, 'src/auth 아래 토큰 갱신 로직 찾기'); assert.equal(a.depth, 1);
});

test('main becomes delegating when a subagent is alive, idle after Stop, and main wait counts', () => {
  const s = makeStore();
  s.applyHook(hook('UserPromptSubmit', { prompt: '결제 모듈 리팩터링 해줘\n자세히' }));
  s.applyHook(hook('PreToolUse', { tool_name: 'Agent', tool_input: { description: '탐색' }, tool_use_id: 'tA' }));
  s.applyHook(hook('PostToolUse', { tool_name: 'Agent', tool_use_id: 'tA' }));
  s.applyHook(hook('SubagentStart', { agent_id: 'a1', agent_type: 'Explore' }));
  s.tick();
  assert.equal(sub(s).main.state, 'delegating');
  s.applyHook(hook('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'git push' } }));
  assert.equal(sub(s).main.state, 'wait'); assert.equal(sub(s).counts.wait, 1);
  s.applyHook(hook('SubagentStop', { agent_id: 'a1', last_assistant_message: 'ok' }));
  s.applyHook(hook('Stop', { last_assistant_message: '끝' }));
  assert.equal(sub(s).main.state, 'idle');
});

test('tick turns done into gone after 10 min and gone still counts as done', () => {
  const s = makeStore();
  s.applyHook(hook('SubagentStart', { agent_id: 'a1', agent_type: 'x' }));
  s.applyHook(hook('SubagentStop', { agent_id: 'a1', last_assistant_message: 'ok' }));
  s.advance(9 * 60_000); s.tick();
  assert.equal(agentOf(s, 'a1').state, 'done');
  s.advance(2 * 60_000); s.tick();
  assert.equal(agentOf(s, 'a1').state, 'gone'); assert.equal(sub(s).counts.done, 1);
});

test('tick marks a quiet agent done 60s after its last assistant text', () => {
  const s = makeStore();
  s.applyHook(hook('SubagentStart', { agent_id: 'a1', agent_type: 'x' }));
  s.applyAgentEvents('s1', 'a1', [
    { kind: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a.ts' }, ts: T0 },
    { kind: 'text', role: 'assistant', text: '정리 끝', ts: T0 + 1000 },
  ]);
  s.advance(30_000); s.tick(); assert.equal(agentOf(s, 'a1').state, 'read');
  s.advance(40_000); s.tick(); assert.equal(agentOf(s, 'a1').state, 'done');
});

test('tick removes session 60s after SessionEnd and after 2h without activity', () => {
  const s = makeStore();
  s.applyHook(hook('SessionStart'));
  s.applyHook(hook('SessionEnd', { reason: 'other' }));
  s.advance(30_000); s.tick(); assert.equal(s.snapshot().sessions.length, 1);
  s.advance(40_000); s.tick(); assert.equal(s.snapshot().sessions.length, 0);
  s.applyHook({ ...hook('SessionStart'), session_id: 's2' });
  s.advance(2 * 3600_000 + 1000); s.tick(); assert.equal(s.snapshot().sessions.length, 0);
});

test('line cap keeps the last N lines and agentLines(after) returns only newer', () => {
  const s = makeStore({ lineCap: 5 });
  s.applyHook(hook('SubagentStart', { agent_id: 'a1', agent_type: 'x' }));
  for (let i = 1; i <= 8; i++) s.applyAgentEvents('s1', 'a1', [{ kind: 'text', role: 'assistant', text: 'l' + i, ts: T0 + i }]);
  const lines = s.agentLines('s1', 'a1', 0);
  assert.equal(lines.length, 5); assert.equal(lines[0].text, 'l4'); assert.equal(lines[4].text, 'l8');
  assert.deepEqual(s.agentLines('s1', 'a1', lines[2].n).map((l) => l.text), ['l7', 'l8']);
  assert.equal(agentOf(s, 'a1').lineCount, 8);
});

test('lines carry kinds matching the terminal renderer', () => {
  const s = makeStore();
  s.applyHook(hook('SubagentStart', { agent_id: 'a1', agent_type: 'x' }));
  s.applyAgentEvents('s1', 'a1', [
    { kind: 'text', role: 'user', text: '프롬프트', ts: T0 },
    { kind: 'tool_use', id: 't1', name: 'Grep', input: { pattern: 'x' }, ts: T0 },
    { kind: 'tool_result', toolUseId: 't1', text: '3 files', isError: false, ts: T0 },
    { kind: 'tool_result', toolUseId: 't1', text: 'boom', isError: true, ts: T0 },
    { kind: 'text', role: 'assistant', text: '생각', ts: T0 },
  ]);
  s.applyHook(hook('SubagentStop', { agent_id: 'a1', last_assistant_message: '끝' }));
  assert.deepEqual(s.agentLines('s1', 'a1', 0).map((l) => l.kind), ['user', 'tool', 'out', 'err', 'think', 'ok']);
  assert.equal(s.agentLines('s1', 'a1', 0)[1].tool, 'Grep');
});

test('usage is counted once per messageId and sets model/context', () => {
  const s = makeStore();
  s.applyHook(hook('SubagentStart', { agent_id: 'a1', agent_type: 'x' }));
  const u = { kind: 'usage', messageId: 'm1', output: 120, input: 2, cacheRead: 2500, cacheCreate: 500, model: 'claude-haiku-5-5', ts: T0 };
  s.applyAgentEvents('s1', 'a1', [u, u, { ...u, messageId: 'm2', output: 80 }]);
  const a = agentOf(s, 'a1');
  assert.equal(a.outputTokens, 200); assert.equal(a.contextTokens, 3002); assert.equal(a.model, 'claude-haiku-5-5');
});

test('snapshot desc, goal, title and counts', () => {
  const s = makeStore();
  s.applyHook(hook('UserPromptSubmit', { prompt: '결제 모듈 리팩터링 해줘\n둘째 줄' }));
  s.applyHook(hook('SubagentStart', { agent_id: 'a1', agent_type: 'x' }));
  s.applyHook(hook('PreToolUse', { agent_id: 'a1', tool_name: 'Edit', tool_input: { file_path: 'a' }, tool_use_id: 't1' }));
  s.applyHook(hook('SubagentStart', { agent_id: 'a2', agent_type: 'y' }));
  s.applyHook(hook('SubagentStop', { agent_id: 'a2', last_assistant_message: 'ok' }));
  const v = sub(s);
  assert.equal(v.name, 'demo');
  assert.equal(v.title, '결제 모듈 리팩터링 해줘');
  assert.equal(v.desc, '서브에이전트 2명 · 일하는 중 1 · 완료 1');
  assert.deepEqual(v.goal, ['결제 모듈 리팩터링 해줘', 'demo']);
  assert.deepEqual(v.counts, { edit: 1, read: 0, run: 0, wait: 0, done: 1 });
});

test('patch is emitted once for a burst of events', async () => {
  const s = makeStore();
  let n = 0; s.on('patch', () => n++);
  for (let i = 0; i < 5; i++) s.applyHook(hook('PreToolUse', { agent_id: 'a1', tool_name: 'Read', tool_input: { file_path: 'f' + i }, tool_use_id: 't' + i }));
  await sleep(60);
  assert.equal(n, 1);
});

test('human user text from transcripts sets session title and agent task fallback', () => {
  const s = makeStore();
  s.ensureSession('s1', { cwd: '/home/u/demo' });
  s.applyMainEvents('s1', [{ kind: 'text', role: 'user', text: '<task-notification>', human: false, ts: T0 }, { kind: 'text', role: 'user', text: '결제 리팩터링\n둘째', human: true, ts: T0 }]);
  assert.equal(sub(s).title, '결제 리팩터링');
  s.ensureAgent('s1', 'a1');
  s.applyAgentEvents('s1', 'a1', [{ kind: 'text', role: 'user', text: 'src/auth 찾아줘', human: true, ts: T0 }]);
  assert.equal(agentOf(s, 'a1').task, 'src/auth 찾아줘');
});

test('timestamps from transcripts set startedAt/endedAt and summary falls back to last assistant text', () => {
  const s = makeStore();
  s.ensureSession('s1', { cwd: '/home/u/demo' });
  s.applyMainEvents('s1', [{ kind: 'text', role: 'user', text: '시작', human: true, ts: T0 - 600_000 }]);
  s.ensureAgent('s1', 'a1');
  s.applyAgentEvents('s1', 'a1', [
    { kind: 'text', role: 'user', text: '일 시켜', human: true, ts: T0 - 300_000 },
    { kind: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a' }, ts: T0 - 200_000 },
    { kind: 'text', role: 'assistant', text: '결론은 이렇습니다. ' + 'x'.repeat(300), ts: T0 - 100_000 },
  ]);
  s.attachMeta('s1', 'a1', { agentType: 'Explore', description: '탐색', toolUseId: 'none', finished: true, spawnDepth: 1 });
  const a = agentOf(s, 'a1');
  assert.equal(a.startedAt, T0 - 300_000);
  assert.equal(a.endedAt, T0 - 100_000);
  assert.equal(a.summary.length, 160); assert.ok(a.summary.startsWith('결론은 이렇습니다.'));
  assert.equal(sub(s).baseElapsed, 600);
});

test('Stop while subagents are alive keeps main delegating instead of idle', () => {
  const s = makeStore();
  s.applyHook(hook('UserPromptSubmit', { prompt: '조사해줘' }));
  s.applyHook(hook('SubagentStart', { agent_id: 'a1', agent_type: 'Explore' }));
  s.applyHook(hook('Stop', { last_assistant_message: '' }));
  assert.equal(sub(s).main.state, 'delegating');
  s.applyHook(hook('SubagentStop', { agent_id: 'a1', last_assistant_message: 'ok' }));
  s.applyHook(hook('Stop', { last_assistant_message: '끝' }));
  assert.equal(sub(s).main.state, 'idle');
});

test('system-injected prompts (starting with <) never become the session title', () => {
  const s = makeStore();
  s.applyHook(hook('UserPromptSubmit', { prompt: '결제 리팩터링' }));
  s.applyHook(hook('UserPromptSubmit', { prompt: '<task-notification>\n<task-id>x</task-id>' }));
  assert.equal(sub(s).title, '결제 리팩터링');
  s.applyMainEvents('s1', [{ kind: 'text', role: 'user', text: '<system-reminder>…', human: true, ts: T0 }]);
  assert.equal(sub(s).title, '결제 리팩터링');
});

test('line event is emitted per line', () => {
  const s = makeStore();
  const got = []; s.on('line', (e) => got.push(e));
  s.applyHook(hook('SubagentStart', { agent_id: 'a1', agent_type: 'x' }));
  s.applyAgentEvents('s1', 'a1', [{ kind: 'text', role: 'assistant', text: 'hi', ts: T0 }]);
  assert.equal(got.length, 1); assert.equal(got[0].agentId, 'a1'); assert.equal(got[0].line.text, 'hi');
});

test('session and agent caps evict oldest', () => {
  const s = makeStore({ sessionCap: 2, agentCap: 2 });
  for (const id of ['s1', 's2', 's3']) { s.applyHook({ ...hook('SessionStart'), session_id: id }); s.advance(1000); }
  s.tick();
  assert.deepEqual(s.snapshot().sessions.map((x) => x.id).sort(), ['s2', 's3']);
  for (const a of ['a1', 'a2', 'a3']) { s.applyHook({ ...hook('SubagentStart', { agent_id: a, agent_type: 'x' }), session_id: 's3' }); s.applyHook({ ...hook('SubagentStop', { agent_id: a }), session_id: 's3' }); s.advance(1000); }
  s.tick();
  assert.deepEqual(s.snapshot().sessions.find((x) => x.id === 's3').agents.map((a) => a.id), ['a2', 'a3']);
});
