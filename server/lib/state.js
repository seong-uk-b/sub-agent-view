import { EventEmitter } from 'node:events';
import path from 'node:path';
import { classifyTool, toolTarget, cleanTaskText } from './transcript.js';

const SPAWN_TOOLS = new Set(['Agent', 'Task']);
import { displayName, sessionFromTranscriptPath } from './paths.js';

/*
 * 세션/에이전트 상태 저장소.
 * 상태: edit | read | run | wait | done | gone | delegating | idle  (스펙 §3.3, §8-1, §8-7)
 * 입력: 훅 페이로드(applyHook), 트랜스크립트 이벤트(applyAgentEvents/applyMainEvents), meta.json(attachMeta), 시간(tick)
 * 출력: snapshot(), agentLines(), 'patch'(디바운스) / 'line' 이벤트
 */

const MAIN = 'main';
const WORKING = new Set(['edit', 'read', 'run']);
const LIVE = new Set(['edit', 'read', 'run', 'wait']);
const SUMMARY_MAX = 160;
const PROMPT_MAX = 80;
const RECENT_MAX = 3;
const SEEN_MAX = 2000;

export class Store extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.opts = {
      lineCap: 2000, agentCap: 50, sessionCap: 20,
      doneIdleMs: 60_000, goneAfterMs: 600_000, sessionStaleMs: 7_200_000, sessionEndGraceMs: 60_000,
      patchDebounceMs: 20, now: () => Date.now(), ...opts,
    };
    this.sessions = new Map();
    this._patchTimer = null;
  }

  // ───────────────────────── 세션 / 에이전트 생성
  ensureSession(sessionId, info = {}) {
    if (!sessionId) return null;
    let s = this.sessions.get(sessionId);
    const now = this.opts.now();
    if (!s) {
      s = {
        id: sessionId, cwd: null, projectKey: null, transcriptPath: null,
        startedAt: now, lastActivityAt: now, endedAt: null, endedSoft: false, lastPrompt: null,
        agents: new Map(), pendingSpawns: new Map(),
      };
      s.agents.set(MAIN, this.#newAgent(MAIN, sessionId, { name: '메인 세션', type: '오케스트레이터', state: 'idle' }));
      this.sessions.set(sessionId, s);
      this.#schedulePatch();
    }
    if (info.cwd && !s.cwd) s.cwd = info.cwd;
    if (info.transcriptPath && !s.transcriptPath) {
      s.transcriptPath = info.transcriptPath;
      const p = sessionFromTranscriptPath(info.transcriptPath);
      if (p && !s.projectKey) s.projectKey = p.projectKey;
    }
    if (info.projectKey && !s.projectKey) s.projectKey = info.projectKey;
    return s;
  }

  ensureAgent(sessionId, agentId, info = {}) {
    const s = this.ensureSession(sessionId);
    if (!s || !agentId) return null;
    let a = s.agents.get(agentId);
    if (!a) {
      a = this.#newAgent(agentId, sessionId, { state: 'read', ...info });
      s.agents.set(agentId, a);
      this.#schedulePatch();
    } else {
      for (const k of ['name', 'type', 'task', 'depth', 'parentName']) if (info[k] != null) a[k] = info[k];
    }
    return a;
  }

  /**
   * 외부 근거(세션 레지스트리의 pid 사망 등)로 세션이 끝났다고 표시한다. SessionEnd 훅과 달리 '약한' 종료라
   * 이후 활동이 보이면 자동으로 취소된다. 유예(sessionEndGraceMs)가 지나면 tick()이 제거한다.
   */
  endSession(sessionId) {
    const s = this.sessions.get(sessionId);
    if (!s || s.endedAt != null) return;
    s.endedAt = this.opts.now(); s.endedSoft = true;
    this.#schedulePatch();
  }

  #activity(s, ts) {
    s.lastActivityAt = Math.max(s.lastActivityAt, ts);
    if (s.endedSoft) { s.endedAt = null; s.endedSoft = false; }
  }

  #newAgent(id, sessionId, info) {
    const now = this.opts.now();
    return {
      id, sessionId,
      name: info.name || info.type || id.slice(0, 8), type: info.type || '', task: info.task || '',
      state: info.state || 'read', prevState: 'read', tool: '', target: '', model: '',
      startedAt: now, endedAt: null, lastEventAt: now, lastTextAt: 0,
      toolCalls: 0, outputTokens: 0, contextTokens: 0,
      recent: [], waitReason: '', waitDetail: '', summary: '', depth: info.depth || 1, parentName: info.parentName || '',
      lastText: '', touched: false, pendingTools: new Set(), seenTools: new Set(), seenMessages: new Set(),
      lines: [], lineSeq: 0,
    };
  }

  // ───────────────────────── 훅
  applyHook(p) {
    if (!p || typeof p !== 'object' || !p.session_id) return;
    const s = this.ensureSession(p.session_id, { cwd: p.cwd, transcriptPath: p.transcript_path });
    const now = this.opts.now();
    this.#activity(s, now);
    const ev = p.hook_event_name;
    const agentId = p.agent_id || MAIN;

    switch (ev) {
      case 'SessionStart': s.endedAt = null; s.endedSoft = false; break;
      case 'SessionEnd': s.endedAt = now; s.endedSoft = false; break;
      case 'UserPromptSubmit': {
        s.lastPrompt = firstLine(p.prompt) ?? s.lastPrompt;
        const m = s.agents.get(MAIN);
        if (m.state === 'idle') this.#setState(m, 'edit');
        m.tool = ''; m.target = '';
        break;
      }
      case 'SubagentStart':
        this.ensureAgent(s.id, agentId, { type: p.agent_type, name: p.agent_type });
        break;
      case 'SubagentStop': {
        const a = this.ensureAgent(s.id, agentId, { type: p.agent_type });
        this.#finish(a, firstChars(p.last_assistant_message, SUMMARY_MAX));
        break;
      }
      case 'PreToolUse': {
        const a = this.ensureAgent(s.id, agentId);
        this.#toolStart(a, p.tool_use_id, p.tool_name, p.tool_input, now);
        break;
      }
      case 'PostToolUse': {
        const a = this.ensureAgent(s.id, agentId);
        this.#toolEnd(a, p.tool_use_id, now);
        break;
      }
      case 'PermissionRequest': {
        const a = this.ensureAgent(s.id, agentId);
        a.waitReason = `${p.tool_name || '도구'} 실행 권한 요청`;
        a.waitDetail = toolTarget(p.tool_name, p.tool_input);
        this.#setState(a, 'wait');
        this.#touch(a, now);
        break;
      }
      case 'Stop': {
        const m = s.agents.get(MAIN);
        m.pendingTools.clear();
        const alive = [...s.agents.values()].some((a) => a.id !== MAIN && LIVE.has(a.state));
        this.#setState(m, alive ? 'delegating' : 'idle');
        break;
      }
      default: break;
    }
    this.#schedulePatch();
  }

  // ───────────────────────── 트랜스크립트 이벤트
  applyAgentEvents(sessionId, agentId, events) {
    const a = this.ensureAgent(sessionId, agentId);
    if (!a || !Array.isArray(events)) return;
    const s = this.sessions.get(sessionId);
    for (const e of events) {
      if (!e || typeof e !== 'object') continue;
      this.#activity(s, e.ts || 0);
      if (e.ts && e.ts < a.startedAt) a.startedAt = e.ts;
      if (e.ts && e.ts < s.startedAt) s.startedAt = e.ts;
      switch (e.kind) {
        case 'tool_use':
          this.#toolStart(a, e.id, e.name, e.input, e.ts);
          this.#pushLine(a, { kind: 'tool', text: toolTarget(e.name, e.input), tool: e.name, ts: e.ts });
          break;
        case 'tool_result':
          this.#toolEnd(a, e.toolUseId, e.ts, /* fromTranscript */ true);
          this.#pushLine(a, { kind: e.isError ? 'err' : 'out', text: firstChars(e.text, 4000), ts: e.ts });
          break;
        case 'text':
          if (e.role === 'assistant') { a.lastTextAt = e.ts; a.lastText = e.text; this.#touch(a, e.ts); }
          if (e.role === 'user' && e.human) {
            if (a.id === MAIN) s.lastPrompt = firstLine(e.text) ?? s.lastPrompt;
            else if (!a.task) a.task = firstChars(cleanTaskText(e.text), 400);
          }
          this.#pushLine(a, { kind: e.role === 'user' ? 'user' : 'think', text: firstChars(e.text, 4000), ts: e.ts });
          break;
        case 'usage':
          if (e.messageId && a.seenMessages.has(e.messageId)) break;
          if (e.messageId) remember(a.seenMessages, e.messageId);
          a.outputTokens += e.output || 0;
          a.contextTokens = (e.input || 0) + (e.cacheRead || 0) + (e.cacheCreate || 0);
          if (e.model) a.model = e.model;
          break;
        case 'spawn':
          s.pendingSpawns.set(e.toolUseId, { agentType: e.agentType, description: e.description, prompt: e.prompt });
          break;
        default: break;
      }
    }
    this.#schedulePatch();
  }

  applyMainEvents(sessionId, events) {
    this.applyAgentEvents(sessionId, MAIN, events);
  }

  attachMeta(sessionId, agentId, meta) {
    const a = this.ensureAgent(sessionId, agentId);
    if (!a || !meta) return;
    const s = this.sessions.get(sessionId);
    if (meta.description) a.name = meta.description;
    if (meta.agentType) a.type = meta.agentType;
    if (meta.spawnDepth) a.depth = meta.spawnDepth;
    const spawn = s.pendingSpawns.get(meta.toolUseId);
    if (spawn) {
      if (spawn.prompt) a.task = firstChars(cleanTaskText(spawn.prompt), 400);
      if (!a.name && spawn.description) a.name = spawn.description;
    }
    if (meta.finished && LIVE.has(a.state)) this.#finish(a, a.summary, a.lastEventAt);
    this.#schedulePatch();
  }

  // ───────────────────────── 시간 규칙
  tick() {
    const now = this.opts.now();
    const { doneIdleMs, goneAfterMs, sessionStaleMs, sessionEndGraceMs, sessionCap, agentCap } = this.opts;
    for (const s of this.sessions.values()) {
      const main = s.agents.get(MAIN);
      let liveSubs = 0;
      for (const a of s.agents.values()) {
        if (a.id === MAIN) continue;
        if (WORKING.has(a.state) && a.lastTextAt && a.lastTextAt >= a.lastEventAt && now - a.lastEventAt >= doneIdleMs) this.#finish(a, a.summary, a.lastEventAt);
        if (a.state === 'done' && a.endedAt != null && now - a.endedAt >= goneAfterMs) this.#setState(a, 'gone');
        if (LIVE.has(a.state)) liveSubs++;
      }
      if (liveSubs > 0 && WORKING.has(main.state) && main.pendingTools.size === 0) this.#setState(main, 'delegating');
      if (liveSubs === 0 && main.state === 'delegating') this.#setState(main, 'edit');
      // 에이전트 상한: gone → done 순으로 오래된 것부터 제거
      while (s.agents.size - 1 > agentCap) {
        const victim = [...s.agents.values()].filter((a) => a.id !== MAIN && (a.state === 'gone' || a.state === 'done'))
          .sort((x, y) => (x.state === 'gone' ? 0 : 1) - (y.state === 'gone' ? 0 : 1) || (x.endedAt || 0) - (y.endedAt || 0))[0];
        if (!victim) break;
        s.agents.delete(victim.id);
      }
    }
    for (const [id, s] of this.sessions) {
      if ((s.endedAt != null && now - s.endedAt >= sessionEndGraceMs) || now - s.lastActivityAt >= sessionStaleMs) this.#removeSession(id);
    }
    while (this.sessions.size > sessionCap) {
      const oldest = [...this.sessions.values()].sort((x, y) => x.lastActivityAt - y.lastActivityAt)[0];
      this.#removeSession(oldest.id);
    }
    this.#schedulePatch();
  }

  #removeSession(id) {
    if (!this.sessions.delete(id)) return;
    this.emit('session-removed', { sessionId: id, at: this.opts.now() });
  }

  // ───────────────────────── 조회
  snapshot() {
    const now = this.opts.now();
    const sessions = [...this.sessions.values()].map((s) => {
      const main = this.#agentView(s.agents.get(MAIN));
      const agents = [...s.agents.values()].filter((a) => a.id !== MAIN).map((a) => this.#agentView(a));
      const counts = { edit: 0, read: 0, run: 0, wait: 0, done: 0 };
      let working = 0;
      for (const a of agents) {
        if (a.state === 'gone') counts.done++;
        else if (a.state in counts) counts[a.state]++;
        if (LIVE.has(a.state)) working++;
      }
      if (main.state === 'wait') counts.wait++;
      const name = displayName({ cwd: s.cwd, projectKey: s.projectKey }) || s.id.slice(0, 8);
      return {
        id: s.id, name, title: s.lastPrompt || name,
        desc: `서브에이전트 ${agents.length}명 · 일하는 중 ${working} · 완료 ${counts.done}`,
        goal: [s.lastPrompt || '', s.cwd ? path.basename(s.cwd) : name],
        cwd: s.cwd, baseElapsed: Math.max(0, Math.floor((now - s.startedAt) / 1000)),
        main, agents, counts,
      };
    });
    return { sessions };
  }

  /** 지원용 원시 상태(/api/debug). 프롬프트·도구 입력 내용은 포함하지 않는다. */
  debug() {
    return [...this.sessions.values()].map((s) => ({
      id: s.id, name: displayName({ cwd: s.cwd, projectKey: s.projectKey }) || s.id.slice(0, 8),
      cwd: s.cwd, projectKey: s.projectKey, transcriptPath: s.transcriptPath,
      startedAt: s.startedAt, lastActivityAt: s.lastActivityAt, endedAt: s.endedAt, endedSoft: s.endedSoft, hasPrompt: !!s.lastPrompt,
      agents: [...s.agents.values()].map((a) => ({ id: a.id, type: a.type, state: a.state, lines: a.lines.length, toolCalls: a.toolCalls, startedAt: a.startedAt, endedAt: a.endedAt, lastEventAt: a.lastEventAt })),
    }));
  }

  agentLines(sessionId, agentId, after = 0) {
    const a = this.sessions.get(sessionId)?.agents.get(agentId);
    if (!a) return [];
    return a.lines.filter((l) => l.n > after);
  }

  #agentView(a) {
    return {
      id: a.id, name: a.name, type: a.type, task: a.task, state: a.state, tool: a.tool, target: a.target, model: a.model,
      startedAt: a.startedAt, endedAt: a.endedAt, toolCalls: a.toolCalls, outputTokens: a.outputTokens, contextTokens: a.contextTokens,
      recent: a.recent.slice(0, RECENT_MAX), waitReason: a.waitReason, waitDetail: a.waitDetail, summary: a.summary,
      depth: a.depth, parentName: a.parentName, lineCount: a.lineSeq,
    };
  }

  // ───────────────────────── 내부 전이
  #setState(a, next) {
    if (a.state === next) return;
    if (a.state !== 'wait') a.prevState = a.state;
    a.state = next;
    if (next !== 'wait') { a.waitReason = ''; a.waitDetail = ''; }
    this.#schedulePatch();
  }

  #toolStart(a, toolUseId, toolName, toolInput, ts) {
    const id = toolUseId || '';
    const alreadySeen = id && a.seenTools.has(id);
    const spawning = a.id === MAIN && SPAWN_TOOLS.has(toolName);   // Agent/Task 호출은 "자기 도구"로 치지 않는다 (스펙 §8-1)
    if (!alreadySeen) {
      a.toolCalls++;
      if (id) { remember(a.seenTools, id); if (!spawning) a.pendingTools.add(id); }
      a.recent.unshift({ ts, text: `${toolName || ''} ${toolTarget(toolName, toolInput)}`.trim() }); a.recent.length = Math.min(a.recent.length, RECENT_MAX);
    }
    a.tool = toolName || ''; a.target = toolTarget(toolName, toolInput);
    if (a.state === 'done' || a.state === 'gone') a.endedAt = null;
    if (toolName === 'AskUserQuestion') { a.waitReason = '사용자 답변 대기'; a.waitDetail = ''; this.#setState(a, 'wait'); }
    else if (spawning) { if (a.state !== 'wait') this.#setState(a, 'delegating'); }
    else if (a.state !== 'wait' || alreadySeen) this.#setState(a, classifyTool(toolName));
    this.#touch(a, ts);
  }

  #toolEnd(a, toolUseId, ts, fromTranscript = false) {
    const id = toolUseId || '';
    if (id && a.pendingTools.has(id)) a.pendingTools.delete(id);
    else if (id && !a.seenTools.has(id)) { remember(a.seenTools, id); if (!fromTranscript) a.toolCalls++; }
    if (a.state === 'wait') this.#setState(a, WORKING.has(a.prevState) ? a.prevState : 'edit');
    this.#touch(a, ts);
  }

  #finish(a, summary, endedAt = null) {
    a.summary = summary || a.summary || firstChars(a.lastText, SUMMARY_MAX);
    a.endedAt = endedAt ?? this.opts.now();
    a.pendingTools.clear();
    this.#setState(a, 'done');
    this.#pushLine(a, { kind: 'ok', text: a.summary ? `완료 · ${a.summary}` : '완료', ts: a.endedAt });
    a.recent.unshift({ ts: a.endedAt, text: '메인 세션에 결과 보고' }); a.recent.length = Math.min(a.recent.length, RECENT_MAX);
  }

  #touch(a, ts) {
    const t = ts || this.opts.now();
    a.lastEventAt = a.touched ? Math.max(a.lastEventAt, t) : t;   // 첫 이벤트는 과거 시각이어도 그대로
    a.touched = true;
    const s = this.sessions.get(a.sessionId); if (s) this.#activity(s, a.lastEventAt);
  }

  #pushLine(a, line) {
    const l = { n: ++a.lineSeq, ...line };
    a.lines.push(l);
    if (a.lines.length > this.opts.lineCap) a.lines.splice(0, a.lines.length - this.opts.lineCap);
    this.emit('line', { sessionId: a.sessionId, agentId: a.id, line: l });
  }

  #schedulePatch() {
    if (this._patchTimer) return;
    this._patchTimer = setTimeout(() => { this._patchTimer = null; this.emit('patch', this.snapshot()); }, this.opts.patchDebounceMs);
    this._patchTimer.unref?.();
  }
}

/** 프롬프트 첫 줄. '<'로 시작하는 시스템 주입문(<task-notification> 등)은 제목으로 쓰지 않는다. */
function firstLine(text) {
  if (typeof text !== 'string') return null;
  const line = text.trim().split('\n')[0].trim();
  if (!line || line.startsWith('<')) return null;
  return line.slice(0, PROMPT_MAX);
}
function firstChars(text, n) { return typeof text === 'string' ? text.slice(0, n) : ''; }
function remember(set, key) { set.add(key); if (set.size > SEEN_MAX) set.delete(set.values().next().value); }
