import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { sessionFromTranscriptPath, agentIdFromFile, metaPathFor } from './paths.js';
import { JsonlTailer } from './jsonl-tail.js';
import { normalizeRecord, MAIN_LINE_FILTER, readMeta } from './transcript.js';

/*
 * ~/.claude/projects 를 감시해 세션·서브에이전트 트랜스크립트를 Store에 흘린다.
 * - scan(): 최근 staleMs 안에 수정된 `<proj>/<session>.jsonl`과 그 `subagents/agent-*.jsonl`, `.meta.json`을 등록
 * - start(): 첫 scan 후 fs.watch(recursive)로 바뀐 파일만 읽음. watch 불가(또는 usePolling)면 pollMs 간격 폴링.
 *   어느 경우든 scanMs마다 scan()과 store.tick().
 */
export class ProjectsWatcher {
  constructor({ root, store, pollMs = 1000, scanMs = 10_000, staleMs = 7_200_000, usePolling = false }) {
    this.root = root; this.store = store;
    this.pollMs = pollMs; this.scanMs = scanMs; this.staleMs = staleMs; this.usePolling = usePolling;
    this.tailers = new Map();   // filePath → {tailer, sessionId, agentId}
    this.metaMtimes = new Map(); // metaPath → mtimeMs
    this.removedAt = new Map();  // sessionId → 제거 시각(ms). 그 뒤 파일이 바뀌기 전엔 재등록하지 않는다
    this.timers = []; this.watcher = null; this._reading = new Set(); this._dirty = new Set();
    this.store.on('session-removed', ({ sessionId }) => this.#forgetSession(sessionId));
  }

  /** 파일 mtime과 비교해야 하므로 Store의 (주입 가능한) 시계가 아니라 실제 시각을 쓴다. */
  #forgetSession(sessionId) {
    this.removedAt.set(sessionId, Date.now());
    for (const [file, t] of this.tailers) if (t.sessionId === sessionId) { this.tailers.delete(file); this._dirty.delete(file); }
    for (const metaPath of [...this.metaMtimes.keys()]) if (metaPath.includes(`${path.sep}${sessionId}${path.sep}`)) this.metaMtimes.delete(metaPath);
  }

  async scan() {
    const now = Date.now();
    let projects = [];
    try { projects = await fsp.readdir(this.root, { withFileTypes: true }); } catch { return; }
    for (const p of projects) {
      if (!p.isDirectory()) continue;
      const projectDir = path.join(this.root, p.name);
      let entries = [];
      try { entries = await fsp.readdir(projectDir); } catch { continue; }
      for (const name of entries) {
        if (!name.endsWith('.jsonl')) continue;
        const file = path.join(projectDir, name);
        const info = sessionFromTranscriptPath(file);
        if (!info) continue;
        let st; try { st = await fsp.stat(file); } catch { continue; }
        if (now - st.mtimeMs > this.staleMs) continue;
        const removed = this.removedAt.get(info.sessionId);
        if (removed != null) { if (st.mtimeMs <= removed) continue; this.removedAt.delete(info.sessionId); }
        await this.#registerSession(info, file);
      }
    }
  }

  async #registerSession(info, file) {
    const { sessionId, subagentsDir, projectKey } = info;
    this.store.ensureSession(sessionId, { transcriptPath: file, projectKey });
    if (!this.tailers.has(file)) {
      this.tailers.set(file, { tailer: new JsonlTailer(file, { lineFilter: MAIN_LINE_FILTER }), sessionId, agentId: 'main' });
      await this.#read(file);
    }
    let subs = [];
    try { subs = await fsp.readdir(subagentsDir); } catch { return; }
    for (const name of subs) {
      const agentId = agentIdFromFile(name);
      if (!agentId) continue;
      const sub = path.join(subagentsDir, name);
      if (!this.tailers.has(sub)) {
        this.store.ensureAgent(sessionId, agentId);
        this.tailers.set(sub, { tailer: new JsonlTailer(sub), sessionId, agentId });
        await this.#read(sub);
      }
      await this.#readMetaIfChanged(metaPathFor(sub), sessionId, agentId);
    }
  }

  async #readMetaIfChanged(metaPath, sessionId, agentId) {
    let st; try { st = await fsp.stat(metaPath); } catch { return; }
    if (this.metaMtimes.get(metaPath) === st.mtimeMs) return;
    this.metaMtimes.set(metaPath, st.mtimeMs);
    const meta = await readMeta(metaPath);
    if (meta) this.store.attachMeta(sessionId, agentId, meta);
  }

  async #read(file) {
    const t = this.tailers.get(file);
    if (!t) return;
    if (this._reading.has(file)) { this._dirty.add(file); return; }   // 읽는 중 온 변경은 끝난 뒤 한 번 더 읽는다
    this._reading.add(file);
    try {
      const recs = await t.tailer.read();
      if (!recs.length) return;
      const events = [];
      for (const rec of recs) {
        if (rec && typeof rec === 'object' && rec.cwd && t.agentId === 'main') this.store.ensureSession(t.sessionId, { cwd: rec.cwd });
        events.push(...normalizeRecord(rec));
      }
      if (t.agentId === 'main') this.store.applyMainEvents(t.sessionId, events);
      else this.store.applyAgentEvents(t.sessionId, t.agentId, events);
    } finally {
      this._reading.delete(file);
      if (this._dirty.delete(file)) await this.#read(file);
    }
  }

  async #readAll() { for (const file of this.tailers.keys()) await this.#read(file); }

  async start() {
    await this.scan();
    let watching = false;
    if (!this.usePolling) {
      try {
        this.watcher = fs.watch(this.root, { recursive: true }, (_ev, rel) => {
          if (!rel) return;
          const file = path.join(this.root, rel.toString());
          if (this.tailers.has(file)) this.#read(file);
          else if (file.endsWith('.jsonl') || file.endsWith('.meta.json')) this.scan();
        });
        this.watcher.on('error', () => { this.#fallbackToPolling(); });
        watching = true;
      } catch { watching = false; }
    }
    if (!watching) this.#fallbackToPolling();
    this.timers.push(setInterval(() => { this.scan(); this.store.tick(); }, this.scanMs).unref());
  }

  #fallbackToPolling() {
    if (this._polling) return;
    this._polling = true;
    this.timers.push(setInterval(() => this.#readAll(), this.pollMs).unref());
  }

  stop() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.watcher?.close(); this.watcher = null;
  }
}
