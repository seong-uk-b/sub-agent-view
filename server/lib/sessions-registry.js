import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

/**
 * Claude Code는 실행 중인 세션마다 `<configDir>/sessions/<pid>.json`을 하나 쓰고 종료 시 지운다
 * (docs: claude-directory). 스키마는 문서화되어 있지 않으므로 pid·sessionId·cwd·name만 읽고,
 * 파일이 남아 있어도 pid가 죽었으면(크래시 잔재) 죽은 것으로 본다.
 */
export function sessionsDir(env = process.env) {
  const base = env.CLAUDE_CONFIG_DIR || path.join(env.HOME || os.homedir(), '.claude');
  return path.join(base, 'sessions');
}

export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/** @returns {Promise<Map<string, {pid:number, cwd:string, name:string, alive:boolean}>>} sessionId → entry */
export async function readRegistry(dir, { isAlive = isPidAlive } = {}) {
  const out = new Map();
  let names = [];
  try { names = await fsp.readdir(dir); } catch { return out; }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    let rec;
    try { rec = JSON.parse(await fsp.readFile(path.join(dir, name), 'utf8')); } catch { continue; }
    if (!rec || typeof rec.sessionId !== 'string') continue;
    const pid = Number.isInteger(rec.pid) ? rec.pid : parseInt(name, 10);
    out.set(rec.sessionId, { pid, cwd: typeof rec.cwd === 'string' ? rec.cwd : '', name: typeof rec.name === 'string' ? rec.name : '', alive: isAlive(pid) });
  }
  return out;
}
