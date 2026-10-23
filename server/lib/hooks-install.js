import fs from 'node:fs/promises';
import path from 'node:path';

/*
 * ~/.claude/settings.json 의 hooks 에 sub-agent-view 전달 훅을 병합/제거한다.
 * - 각 이벤트에 {hooks:[{type:'command', command, async:true}]} 하나. matcher 없음(모든 도구/에이전트).
 * - 꼬리표 `# sub-agent-view` 로 우리 항목을 식별한다. 다른 훅은 건드리지 않는다.
 */
export const HOOK_EVENTS = ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'SubagentStart', 'SubagentStop', 'Stop'];
export const TAG = '# sub-agent-view';

export function hookCommand(port) {
  return `curl -s -m 1 -X POST -H 'content-type: application/json' --data-binary @- http://127.0.0.1:${port}/hook >/dev/null 2>&1 || true ${TAG}`;
}

const order = (ev) => { const i = HOOK_EVENTS.indexOf(ev); return i === -1 ? HOOK_EVENTS.length : i; };
/** 플러그인 hooks/hooks.json 형식 (settings.json 설치와 같은 항목, 최상위 "hooks" 래퍼). */
export function hooksJson(port = 4711) {
  const hooks = {};
  for (const ev of HOOK_EVENTS) hooks[ev] = [{ hooks: [{ type: 'command', command: hookCommand(port), async: true }] }];
  return { hooks };
}

const isOurs = (entry) => Array.isArray(entry?.hooks) && entry.hooks.some((h) => typeof h?.command === 'string' && h.command.includes(TAG));

export async function installHooks(settingsPath, { port = 4711 } = {}) {
  const settings = await readSettings(settingsPath);
  settings.hooks = settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {};
  const added = [];
  for (const ev of HOOK_EVENTS) {
    const list = Array.isArray(settings.hooks[ev]) ? settings.hooks[ev] : [];
    if (list.some(isOurs)) continue;
    list.push({ hooks: [{ type: 'command', command: hookCommand(port), async: true }] });
    settings.hooks[ev] = list;
    added.push(ev);
  }
  if (added.length) await writeSettings(settingsPath, settings);
  return { added };
}

export async function uninstallHooks(settingsPath) {
  const settings = await readSettings(settingsPath);
  const removed = [];
  if (settings.hooks && typeof settings.hooks === 'object') {
    for (const ev of Object.keys(settings.hooks)) {
      const list = settings.hooks[ev];
      if (!Array.isArray(list)) continue;
      const kept = list.filter((e) => !isOurs(e));
      if (kept.length !== list.length) removed.push(ev);
      if (kept.length) settings.hooks[ev] = kept; else delete settings.hooks[ev];
    }
    if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
  }
  removed.sort((a, b) => order(a) - order(b));
  if (removed.length) await writeSettings(settingsPath, settings);
  return { removed };
}

/** 파일이 없으면 {}. 있는데 파싱이 안 되면 절대 덮어쓰지 않도록 throw. */
async function readSettings(file) {
  let text;
  try { text = await fs.readFile(file, 'utf8'); } catch (err) { if (err.code === 'ENOENT') return {}; throw err; }
  let d;
  try { d = JSON.parse(text); } catch (err) { throw new Error(`settings.json을 파싱할 수 없어 건드리지 않습니다 (${file}): ${err.message}`); }
  if (!d || typeof d !== 'object' || Array.isArray(d)) throw new Error(`settings.json이 객체가 아니라 건드리지 않습니다 (${file})`);
  return d;
}
async function writeSettings(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  try { await fs.copyFile(file, file + '.bak'); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  const tmp = file + '.sav-tmp';
  await fs.writeFile(tmp, JSON.stringify(data, null, 2) + '\n');
  await fs.rename(tmp, file);
}
