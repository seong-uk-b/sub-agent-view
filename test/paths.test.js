import test from 'node:test';
import assert from 'node:assert/strict';
import { projectsDir, sessionFromTranscriptPath, agentIdFromFile, metaPathFor, displayName } from '../server/lib/paths.js';

test('projectsDir respects CLAUDE_CONFIG_DIR', () => {
  assert.equal(projectsDir({ CLAUDE_CONFIG_DIR: '/x' }), '/x/projects');
});

test('projectsDir defaults to ~/.claude/projects', () => {
  assert.equal(projectsDir({ HOME: '/home/u' }), '/home/u/.claude/projects');
});

test('sessionFromTranscriptPath parses main transcript', () => {
  const r = sessionFromTranscriptPath('/h/.claude/projects/-home-u-app/30f22d5c.jsonl');
  assert.deepEqual(r, {
    projectDir: '/h/.claude/projects/-home-u-app',
    projectKey: '-home-u-app',
    sessionId: '30f22d5c',
    sessionDir: '/h/.claude/projects/-home-u-app/30f22d5c',
    subagentsDir: '/h/.claude/projects/-home-u-app/30f22d5c/subagents',
  });
});

test('sessionFromTranscriptPath rejects subagent file', () => {
  assert.equal(sessionFromTranscriptPath('/h/.claude/projects/-p/s1/subagents/agent-a.jsonl'), null);
});

test('agentIdFromFile', () => {
  assert.equal(agentIdFromFile('agent-a352b6ff.jsonl'), 'a352b6ff');
  assert.equal(agentIdFromFile('agent-a352b6ff.meta.json'), null);
  assert.equal(agentIdFromFile('notes.jsonl'), null);
});

test('metaPathFor', () => {
  assert.equal(metaPathFor('/d/subagents/agent-x.jsonl'), '/d/subagents/agent-x.meta.json');
});

test('sessionFromTranscriptPath handles a Windows path on a POSIX server', () => {
  const info = sessionFromTranscriptPath('C:\\Users\\u\\.claude\\projects\\C--w-proj\\s1.jsonl');
  assert.equal(info.projectKey, 'C--w-proj'); assert.equal(info.sessionId, 's1');
  assert.equal(info.subagentsDir, 'C:\\Users\\u\\.claude\\projects\\C--w-proj\\s1\\subagents');
  assert.equal(sessionFromTranscriptPath('C:\\x\\s1\\subagents\\agent-a.jsonl'), null);
});

test('displayName', () => {
  assert.equal(displayName({ cwd: '/home/u/sub-agent-view' }), 'sub-agent-view');
  assert.equal(displayName({ cwd: 'C:\\Users\\u\\proj\\' }), 'proj');   // 서버가 POSIX여도 윈도우 cwd를 자른다
  assert.equal(displayName({ projectKey: '-home-u-app' }), 'home-u-app');
  assert.equal(displayName({ projectKey: 'C--Projects-editorAI' }), 'Projects-editorAI');   // Windows drive prefix
  assert.equal(displayName({ projectKey: 'D--work' }), 'work');
});
