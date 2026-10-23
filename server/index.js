#!/usr/bin/env node
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { projectsDir } from './lib/paths.js';
import { Store } from './lib/state.js';
import { ProjectsWatcher } from './lib/watcher.js';
import { createServer } from './lib/http.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = parseArgs(process.argv.slice(2));
const port = Number(args.port ?? process.env.SAV_PORT ?? 4711);
const settingsPath = args.settings ?? path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'settings.json');

if (args['install-hooks'] || args['uninstall-hooks']) {
  const { installHooks, uninstallHooks } = await import('./lib/hooks-install.js');
  if (args['install-hooks']) {
    const { added } = await installHooks(settingsPath, { port });
    console.log(added.length ? `훅 추가: ${added.join(', ')}` : '추가할 훅 없음 (이미 설치됨)');
    console.log(`설정 파일: ${settingsPath}\nClaude Code를 다시 시작하면 적용됩니다.`);
  } else {
    const { removed } = await uninstallHooks(settingsPath);
    console.log(removed.length ? `훅 제거: ${removed.join(', ')}` : '제거할 훅 없음');
  }
  process.exit(0);
}

const root = args.root ?? projectsDir();
const store = new Store();
const watcher = new ProjectsWatcher({ root, store });
const errors = [];   // 최근 예외 20건 (/api/debug). 대시보드가 조용히 죽지 않도록 기록만 하고 계속 돈다.
const recordError = (kind, err) => { errors.push({ at: Date.now(), kind, message: String(err?.stack || err).slice(0, 600) }); if (errors.length > 20) errors.shift(); console.error(new Date().toISOString(), kind, err?.stack || err); };
process.on('uncaughtException', (e) => recordError('uncaughtException', e));
process.on('unhandledRejection', (e) => recordError('unhandledRejection', e));
const server = createServer({
  store, webDir: path.join(HERE, '..', 'web'),
  log: (...a) => { if (a[0] === 'error') recordError('request', a[1]); if (args.verbose) console.log(new Date().toISOString(), ...a); },
  debugInfo: () => ({ errors, watcher: watcher.debug(), argv: process.argv.slice(2) }),
});

await watcher.start();
server.listen(port, '127.0.0.1', () => {
  console.log(`sub-agent-view http://127.0.0.1:${server.address().port}  (감시: ${root})`);
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { watcher.stop(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 500).unref(); });

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) { out[key] = next; i++; } else out[key] = true;
  }
  return out;
}
