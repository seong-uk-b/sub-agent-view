import path from 'node:path';
import os from 'node:os';

/** Claude Code가 트랜스크립트를 쌓는 projects 폴더. CLAUDE_CONFIG_DIR 우선. */
export function projectsDir(env = process.env) {
  const base = env.CLAUDE_CONFIG_DIR || path.join(env.HOME || os.homedir(), '.claude');
  return path.join(base, 'projects');
}

/**
 * `<projectsDir>/<projectKey>/<sessionId>.jsonl` → 세션 경로 정보.
 * 서브에이전트 파일(`.../<sessionId>/subagents/agent-x.jsonl`)이나 그 밖의 경로면 null.
 */
export function sessionFromTranscriptPath(p) {
  if (!p || !p.endsWith('.jsonl')) return null;
  const projectDir = path.dirname(p);
  if (path.basename(projectDir) === 'subagents') return null;   // 서브에이전트 파일은 세션이 아님
  const sessionId = path.basename(p, '.jsonl');
  const sessionDir = path.join(projectDir, sessionId);
  return {
    projectDir,
    projectKey: path.basename(projectDir),
    sessionId,
    sessionDir,
    subagentsDir: path.join(sessionDir, 'subagents'),
  };
}

/** `agent-<id>.jsonl` → `<id>`. `.meta.json`이나 다른 이름이면 null. */
export function agentIdFromFile(name) {
  const m = /^agent-([^.]+)\.jsonl$/.exec(name);
  return m ? m[1] : null;
}

export function metaPathFor(jsonlPath) {
  return jsonlPath.replace(/\.jsonl$/, '.meta.json');
}

/** 세션 표시 이름: cwd가 있으면 마지막 폴더, 없으면 projectKey에서 앞의 '-' 제거. */
export function displayName({ cwd, projectKey } = {}) {
  if (cwd) return path.basename(cwd);
  return (projectKey || '').replace(/^[A-Za-z]--/, '').replace(/^-/, '');   // 'C--Projects-x' / '-home-u-x'
}
