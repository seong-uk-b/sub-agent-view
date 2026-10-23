import fs from 'node:fs';
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

/** Linux: /proc/<pid>/stat의 22번째 필드(프로세스 시작 시각, 클럭 틱). 레지스트리의 procStart와 같은 값이다. 못 읽으면 null. */
export function procStartOf(pid) {
  if (process.platform !== 'linux') return null;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');   // comm 뒤부터: state=rest[0], starttime=rest[19]
    if (rest[0] === 'Z') return 'zombie';
    return rest[19] ?? null;
  } catch { return null; }
}

/**
 * pid가 살아 있는가. Linux에서 procStart가 주어지면 /proc의 시작 시각과 대조해 pid 재사용·좀비를 죽은 것으로 본다.
 * 그 밖에는 signal 0 (EPERM은 살아 있음).
 */
export function isPidAlive(pid, { procStart } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (process.platform === 'linux') {
    const start = procStartOf(pid);
    if (start === 'zombie') return false;
    if (start != null && procStart != null && String(start) !== String(procStart)) return false;
  }
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
    out.set(rec.sessionId, { pid, cwd: typeof rec.cwd === 'string' ? rec.cwd : '', name: typeof rec.name === 'string' ? rec.name : '', alive: isAlive(pid, { procStart: rec.procStart != null ? String(rec.procStart) : undefined }) });
  }
  return out;
}
