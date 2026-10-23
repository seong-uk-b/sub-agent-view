# sub-agent-view 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Claude Code 세션의 서브에이전트들을 실제 훅·트랜스크립트 데이터로 픽셀 사무실에 띄우고, 클릭하면 요약 팝오버와 터미널 드로어를 보여주는 로컬 대시보드.

**Architecture:** Node 내장 모듈만 쓰는 단일 서버가 `~/.claude/projects`를 감시해 JSONL을 tail 하고, Claude Code 훅이 `POST /hook`으로 보내는 이벤트와 합쳐 세션·에이전트 상태 기계를 유지한다. 브라우저는 SSE로 스냅샷과 변경분을 받아 승인된 목업(`mockup/index.html`)과 같은 UI를 그린다. 훅은 비동기 curl이라 Claude Code를 절대 막지 않는다.

**Tech Stack:** Node 20+ (`node:http`, `node:fs`, `node:test`), 바닐라 JS/CSS, SSE, Claude Code hooks. 외부 npm 의존성 0.

**Spec:** `docs/superpowers/specs/2026-10-23-sub-agent-view-design.md` (아래 "스펙 §n"은 이 문서의 절 번호)

## Global Constraints

- Node 20+. `package.json`에 `dependencies`/`devDependencies` 없음. 테스트는 `node --test`.
- 서버는 `127.0.0.1`에만 바인딩. 기본 포트 4711, 환경변수 `SAV_PORT`.
- 서버 로그에 프롬프트·도구 입력 본문을 쓰지 않는다 (`console.log`는 이벤트 이름·ID·개수만).
- 파서는 모르는 필드와 깨진 줄을 무시하고 절대 throw 하지 않는다 (스펙 §3.2).
- 보존 상한: 에이전트당 터미널 줄 2,000 / 세션당 에이전트 50 / 세션 20 / 브라우저 DOM 줄 500 (스펙 §3.3).
- 훅은 `"async": true` + `curl -s -m 1 … || true` (스펙 §3.4, §3.7).
- 상태 이름은 정확히 `edit` `read` `run` `wait` `done` `gone` `delegating` `idle` (스펙 §3.3, §8-1, §8-7).
- UI 문구·색·레이아웃은 목업 `mockup/index.html`을 따른다. 캐릭터 시트는 `mockup/assets/characters/char_0~5.png` 그대로.
- 리눅스(WSL2)·macOS. Windows 네이티브 제외.

## Review Focus

1. **서버가 꺼진 상태에서 Claude Code 사용** → 훅 curl이 1초 안에 실패하고 종료 코드 0이라 세션이 느려지거나 오류가 보이면 안 된다. (Task 7의 설치 형태 테스트로 고정)
2. **JSONL 줄이 쓰이는 도중에 읽힘(부분 줄)** → tailer가 다음 읽기에서 이어 붙여 파싱해야 하고 그 사이 다른 줄을 잃으면 안 된다. (Task 2)
3. **같은 `tool_use_id`의 PostToolUse가 PreToolUse보다 먼저 도착** → 도구 호출 수는 1이어야 하고 상태가 `wait`에 갇히면 안 된다. (Task 4)
4. **트랜스크립트 한 줄이 수백 KB(`api-request-blob`)** → 메인 리더는 그 줄을 JSON 파싱 없이 건너뛰어 CPU·메모리를 쓰지 않아야 한다. (Task 3)
5. **브라우저가 몇 시간 동안 SSE 재접속을 반복** → 재접속마다 스냅샷으로 다시 맞춰지고 캐릭터가 중복 생성되지 않아야 한다. (Task 8)

---

## 파일 구조

```
package.json                  "type":"module", scripts: start/test/install-hooks
server/index.js               CLI 진입점. 인자 파싱, 서버·감시자 기동, --install-hooks/--uninstall-hooks
server/lib/paths.js           경로 규칙 (projects 폴더, 세션 폴더, agent 파일명)
server/lib/jsonl-tail.js      JsonlTailer: 바이트 오프셋 tail, 부분 줄 보존
server/lib/transcript.js      JSONL 레코드 → 정규화 이벤트, meta.json 읽기, 도구 분류
server/lib/state.js           Store: 세션/에이전트 상태 기계, 보존 상한, snapshot/patch 이벤트
server/lib/watcher.js         ProjectsWatcher: 세션·서브에이전트 파일 발견, tailer 연결
server/lib/hooks-install.js   settings.json 훅 병합/제거
server/lib/http.js            HTTP 서버: 정적 파일, /hook, /events(SSE), /api/*
web/index.html                목업 마크업 (데이터 상수 제거)
web/styles.css                목업 CSS 그대로
web/app.js                    SSE 클라이언트, 상태 보관, 렌더 호출
web/office.js                 사무실·캐릭터·탭·상태바·팝오버 렌더 (목업 함수 이식)
web/terminal.js               드로어·터미널 줄 렌더 (DOM 500줄 상한)
web/assets/characters/*.png   char_0~5.png + CREDITS.md (mockup에서 복사)
web/fonts/                    Galmuri11.woff2, PretendardVariable.woff2 + LICENSE
test/*.test.js                node:test
test/fixtures/                실제 스키마를 본뜬 JSONL/meta.json 샘플
```

---

### Task 1: 프로젝트 골격과 경로 규칙

**Files:**
- Create: `package.json`, `server/lib/paths.js`, `test/paths.test.js`, `.gitignore`

**Interfaces:**
- Produces:
  - `projectsDir(env = process.env): string` → `${env.CLAUDE_CONFIG_DIR ?? ~/.claude}/projects`
  - `sessionFromTranscriptPath(p: string): {projectDir, projectKey, sessionId, sessionDir, subagentsDir} | null` — `p`가 `<projectsDir>/<projectKey>/<sessionId>.jsonl`이 아니면 null. `sessionDir = <projectDir>/<sessionId>`, `subagentsDir = <sessionDir>/subagents`.
  - `agentIdFromFile(name: string): string | null` — `agent-<id>.jsonl`이면 `<id>`, 아니면 null (`.meta.json`은 null).
  - `metaPathFor(jsonlPath: string): string` — 같은 폴더의 `agent-<id>.meta.json`.
  - `displayName({cwd, projectKey}): string` — `cwd`가 있으면 `basename(cwd)`, 없으면 `projectKey`에서 앞의 `-` 제거.

- [ ] **Step 1: `package.json` 작성** — `{"name":"sub-agent-view","private":true,"type":"module","engines":{"node":">=20"},"scripts":{"start":"node server/index.js","test":"node --test test/","install-hooks":"node server/index.js --install-hooks"}}`. 의존성 필드 없음.
- [ ] **Step 2: 실패하는 테스트 작성** `test/paths.test.js`

```js
import test from 'node:test'; import assert from 'node:assert/strict';
import { projectsDir, sessionFromTranscriptPath, agentIdFromFile, metaPathFor, displayName } from '../server/lib/paths.js';
test('projectsDir respects CLAUDE_CONFIG_DIR', () => assert.equal(projectsDir({CLAUDE_CONFIG_DIR:'/x'}), '/x/projects'));
test('sessionFromTranscriptPath parses main transcript', () => {
  const r = sessionFromTranscriptPath('/h/.claude/projects/-home-u-app/30f22d5c.jsonl');
  assert.deepEqual(r, {projectDir:'/h/.claude/projects/-home-u-app', projectKey:'-home-u-app', sessionId:'30f22d5c', sessionDir:'/h/.claude/projects/-home-u-app/30f22d5c', subagentsDir:'/h/.claude/projects/-home-u-app/30f22d5c/subagents'});
});
test('sessionFromTranscriptPath rejects subagent file', () => assert.equal(sessionFromTranscriptPath('/h/.claude/projects/-p/s1/subagents/agent-a.jsonl'), null));
test('agentIdFromFile', () => { assert.equal(agentIdFromFile('agent-a352b6ff.jsonl'), 'a352b6ff'); assert.equal(agentIdFromFile('agent-a352b6ff.meta.json'), null); });
test('metaPathFor', () => assert.equal(metaPathFor('/d/subagents/agent-x.jsonl'), '/d/subagents/agent-x.meta.json'));
test('displayName', () => { assert.equal(displayName({cwd:'/home/u/sub-agent-view'}), 'sub-agent-view'); assert.equal(displayName({projectKey:'-home-u-app'}), 'home-u-app'); });
```

- [ ] **Step 3: 실행해 실패 확인** — `node --test test/paths.test.js` → "Cannot find module … paths.js"
- [ ] **Step 4: `server/lib/paths.js` 구현** — 위 시그니처. `sessionFromTranscriptPath`는 `path.basename(p, '.jsonl')`이 상위 폴더명과 분리되는지, 상위의 상위가 `projects`인지로 판정.
- [ ] **Step 5: 테스트 통과 확인** — `node --test test/paths.test.js` → 6 pass
- [ ] **Step 6: 커밋** — `git add package.json .gitignore server/lib/paths.js test/paths.test.js && git commit -m "feat: project skeleton and transcript path rules"`

---

### Task 2: JSONL tailer

**Files:**
- Create: `server/lib/jsonl-tail.js`, `test/jsonl-tail.test.js`

**Interfaces:**
- Produces: `class JsonlTailer { constructor(filePath: string, {lineFilter?: (rawLine: string) => boolean}); async read(): Promise<object[]>; offset: number }`
  - `read()`는 지난 호출 이후 추가된 바이트만 읽어 완성된 줄만 JSON 파싱해 돌려준다. 마지막 줄이 `\n`으로 끝나지 않으면 보관했다가 다음 read에서 이어 붙인다. 파싱 실패 줄은 건너뛴다. 파일이 사라지거나 `offset`보다 작아지면(잘림) offset 0으로 재시작. `lineFilter`가 false를 돌려주는 줄은 JSON 파싱하지 않는다.
  - 첫 `read()`는 파일 전체를 읽는다 (처음 발견한 에이전트의 과거 줄도 필요).

- [ ] **Step 1: 실패하는 테스트 작성** `test/jsonl-tail.test.js` — 임시 파일을 만들고:
  - `reads existing lines then only new ones`: 2줄 쓰고 read → 2개; 1줄 append 후 read → 1개.
  - `keeps a partial line until newline arrives`: `{"a":1}\n{"b":` 쓰고 read → 1개; `2}\n` append 후 read → `[{b:2}]`.
  - `skips malformed lines`: `not json\n{"ok":true}\n` → `[{ok:true}]`.
  - `restarts when file is truncated`: 3줄 read 후 파일을 1줄로 덮어쓰기 → read → 그 1줄.
  - `lineFilter skips parsing`: filter가 `/"type":"user"/.test(line)`일 때 `{"type":"x"}` 줄은 결과에 없음.
- [ ] **Step 2: 실행해 실패 확인** — `node --test test/jsonl-tail.test.js`
- [ ] **Step 3: 구현** — `fs.promises.open` + `read(buffer, 0, size, offset)`; `Buffer` 누적 후 `indexOf(10)`로 분리. 부분 줄은 `this.partial`에 보관.
- [ ] **Step 4: 통과 확인** — 5 pass
- [ ] **Step 5: 커밋** — `git commit -m "feat: byte-offset JSONL tailer"`

---

### Task 3: 트랜스크립트 정규화와 meta.json

**Files:**
- Create: `server/lib/transcript.js`, `test/transcript.test.js`, `test/fixtures/subagent.jsonl`, `test/fixtures/main.jsonl`, `test/fixtures/agent-x.meta.json`

**Interfaces:**
- Consumes: 없음 (순수 함수)
- Produces:
  - `type Event = {kind:'tool_use', id, name, input, ts} | {kind:'tool_result', toolUseId, text, isError, ts} | {kind:'text', role:'user'|'assistant', text, ts} | {kind:'usage', output, input, cacheRead, cacheCreate, ts} | {kind:'spawn', toolUseId, agentType, description, prompt, ts}`
  - `normalizeRecord(rec: object): Event[]` — `rec.type`이 `assistant`면 content 블록을 돌며 `tool_use`→`tool_use`, `text`→`text`, `rec.message.usage`→`usage` 하나; `tool_use.name`이 `Agent` 또는 `Task`이면 `spawn`도 추가. `rec.type`이 `user`면 content가 문자열이면 `text(user)`, 배열이면 `tool_result`(content가 배열이면 text 블록을 합침, `is_error`→`isError`). 그 외 type은 `[]`. `ts = Date.parse(rec.timestamp) || Date.now()`.
  - `MAIN_LINE_FILTER(rawLine: string): boolean` — 줄 앞 120자에 `"type":"user"`, `"type":"assistant"`, `"type":"system"` 중 하나가 있을 때만 true (스펙 §8-3).
  - `readMeta(metaPath: string): Promise<{agentType, description, toolUseId, finished, spawnDepth} | null>` — 파일 없음/깨짐이면 null.
  - `classifyTool(name: string): 'edit'|'read'|'run'` — `Edit Write NotebookEdit`→edit, `Read Grep Glob WebFetch WebSearch`→read, `Bash`→run, 그 외 edit (스펙 §3.3-3).
  - `toolTarget(name, input): string` — Edit/Write/Read는 `input.file_path`, Grep은 `input.pattern`, Glob은 `input.pattern`, Bash는 `input.command` 앞 80자, Agent는 `input.description`, 그 외 첫 문자열 값 앞 80자.

- [ ] **Step 1: 픽스처 작성** — 이 머신에서 확인한 스키마대로 (`agentId`, `sessionId`, `isSidechain`, `type`, `timestamp`, `message.role/content/usage`). `subagent.jsonl`: user 프롬프트 줄, attachment 줄(`hookName:"SubagentStart"`), assistant 줄(tool_use Grep + usage), user 줄(tool_result), assistant 줄(text). `main.jsonl`: assistant 줄(tool_use Agent `{subagent_type:'Explore', description:'탐색-auth', prompt:'…'}`), `api-request-blob` 200KB 가짜 줄, user 줄(tool_result "Async agent launched… agentId: x"). `agent-x.meta.json`: `{"agentType":"Explore","description":"탐색-auth","toolUseId":"toolu_01","spawnDepth":1,"finished":false}`.
- [ ] **Step 2: 실패하는 테스트 작성** `test/transcript.test.js`
  - `normalizeRecord assistant with tool_use yields tool_use+usage` (Grep → `{kind:'tool_use', name:'Grep', input:{pattern:'refreshToken'}}`, usage `{output:120, input:3000, cacheRead:2500, cacheCreate:0}`)
  - `normalizeRecord Agent tool_use yields spawn` (`agentType:'Explore', description:'탐색-auth'`)
  - `normalizeRecord user string content yields text(user)`; `user tool_result yields tool_result with text joined`
  - `normalizeRecord ignores unknown type` (`{type:'api-request-blob'}` → `[]`) and never throws on `{}`/`null`
  - `MAIN_LINE_FILTER skips blob line without parsing` — 200KB 줄에 대해 false, user 줄에 true
  - `readMeta returns fields`, `readMeta missing file returns null`
  - `classifyTool`/`toolTarget` 표 테스트 (Bash command 80자 절단 포함)
- [ ] **Step 3: 실패 확인** — `node --test test/transcript.test.js`
- [ ] **Step 4: 구현** `server/lib/transcript.js`
- [ ] **Step 5: 통과 확인**
- [ ] **Step 6: 커밋** — `git commit -m "feat: transcript record normalization and agent meta reader"`

---

### Task 4: 상태 저장소 (상태 기계·보존 상한·스냅샷)

**Files:**
- Create: `server/lib/state.js`, `test/state.test.js`

**Interfaces:**
- Consumes: Task 3의 `Event`, `classifyTool`, `toolTarget`
- Produces: `class Store extends EventEmitter`
  - 생성자 옵션(기본값): `{lineCap:2000, agentCap:50, sessionCap:20, doneIdleMs:60000, goneAfterMs:600000, sessionStaleMs:7200000, sessionEndGraceMs:60000, now:()=>Date.now()}`
  - `ensureSession(sessionId, {cwd?, transcriptPath?, projectKey?}): Session`
  - `ensureAgent(sessionId, agentId, {name?, type?, task?, depth?, parentName?}): Agent`
  - `applyHook(payload: object): void` — `hook_event_name`별 처리(스펙 §3.7). `agent_id`가 있으면 그 에이전트, 없으면 세션의 메인(`agentId === 'main'`).
    - SessionStart→ensureSession; SessionEnd→`session.endedAt=now`; UserPromptSubmit→`session.lastPrompt`(80자 첫 줄), 메인 `idle→delegating|edit` 판정은 tick에서; PreToolUse→상태 `classifyTool`(단 `tool_name === 'AskUserQuestion'`이면 `wait`, `waitReason='사용자 답변 대기'`), `tool/target`, `pendingTools.add(tool_use_id)`, toolCalls+1, recent 추가; PostToolUse→`pendingTools.delete`(없던 id면 toolCalls+1), wait였으면 직전 상태로; PermissionRequest→`wait`, `waitReason = "<tool_name> 실행 권한 요청"`, `waitDetail = toolTarget`; SubagentStart→ensureAgent(type=agent_type); SubagentStop→`done`, `summary = last_assistant_message` 앞 160자, `endedAt`; Stop→메인 `idle`.
  - `applyAgentEvents(sessionId, agentId, events: Event[]): void` — tool_use→PreToolUse와 같은 전이(훅과 중복이면 `tool_use_id`로 한 번만 집계), tool_result→터미널 줄, text→줄(+ assistant text면 `lastTextAt`), usage→`outputTokens += output`, `contextTokens = input+cacheRead+cacheCreate`. 모든 이벤트가 터미널 줄을 만든다(아래 줄 형식).
  - `applyMainEvents(sessionId, events: Event[]): void` — `spawn`→`pendingSpawns.set(toolUseId, {…})`; 나머지는 메인 에이전트에 `applyAgentEvents`와 동일.
  - `attachMeta(sessionId, agentId, meta): void` — `toolUseId`로 `pendingSpawns`에서 prompt를 찾아 `task`로, `description`→`name`, `agentType`→`type`, `spawnDepth`→`depth`, `finished`→`done`.
  - `tick(): void` — 시간 규칙: 활동 중 에이전트가 `doneIdleMs` 동안 이벤트 없고 마지막 이벤트가 assistant text면 `done`; `done`+`goneAfterMs`→`gone`; 메인: 살아있는 서브에이전트가 있고 자기 도구 없음→`delegating`; `endedAt+sessionEndGraceMs` 또는 `lastActivityAt+sessionStaleMs` 지나면 세션 제거; 세션 20 초과면 가장 오래된 것 제거; 에이전트 50 초과면 `gone` 중 가장 오래된 것 제거.
  - `snapshot(): {sessions: SessionView[]}`; `agentLines(sessionId, agentId, after: number): Line[]`
  - 이벤트: `'patch'` (`snapshot()`과 같은 형태, 변경 후 20ms 디바운스), `'line'` (`{sessionId, agentId, line}`)
  - `Line = {n, kind:'user'|'tool'|'out'|'ok'|'err'|'think'|'sys', text, tool?, ts}` — 목업 `lineHTML`의 kind와 같다. tool_use→`tool`(text=toolTarget, tool=name), tool_result→`out`(isError면 `err`), assistant text→`think`, user text→`user`, 훅 SubagentStop→`ok`.
  - `SessionView = {id, name, title, desc, goal:[string,string], cwd, baseElapsed, main: AgentView, agents: AgentView[], counts:{edit,read,run,wait,done}}`; `title = session.aiTitle ?? lastPrompt ?? name`; `desc = "서브에이전트 N명 · 일하는 중 M · 완료 K"`; `goal = [lastPrompt 80자, basename(cwd)]` (스펙 §8-6).
  - `AgentView = {id, name, type, task, state, tool, target, startedAt, endedAt, toolCalls, outputTokens, contextTokens, recent:[{ts,text}](최근 3), waitReason, waitDetail, summary, depth, parentName, lineCount}`

- [ ] **Step 1: 실패하는 테스트 작성** `test/state.test.js` (가짜 `now`를 주입)
  - `PreToolUse Edit sets edit state and target`
  - `PermissionRequest sets wait and PostToolUse restores previous state`
  - `PreToolUse AskUserQuestion sets wait with reason 사용자 답변 대기`
  - `PostToolUse before PreToolUse counts one call and does not stay in wait` (Review Focus 3)
  - `SubagentStop marks done with summary; later tool_use revives to run` (스펙 §8-2)
  - `attachMeta links task from main spawn by toolUseId`
  - `main becomes delegating when subagent alive and idle after Stop`; `main PermissionRequest counts as wait in counts`
  - `tick turns done into gone after 10 min and gone still counted in done`
  - `tick removes session 60s after SessionEnd and after 2h stale without hooks`
  - `line cap keeps last 2000`; `agentLines after=n returns only newer`
  - `snapshot desc and goal strings` (정확한 문자열 `"서브에이전트 2명 · 일하는 중 1 · 완료 1"`)
  - `patch is emitted once for burst of 5 events` (디바운스)
- [ ] **Step 2: 실패 확인**
- [ ] **Step 3: 구현** `server/lib/state.js` — 에이전트 내부 필드: `state, prevState, pendingTools:Set, lastEventAt, lastTextAt, lines:[], lineSeq`. 상태 전이 함수 하나(`setState(agent, next)`)에서 `prevState` 기록과 `patch` 예약을 모두 처리.
- [ ] **Step 4: 통과 확인**
- [ ] **Step 5: 커밋** — `git commit -m "feat: session/agent state store with retention caps"`

---

### Task 5: 프로젝트 감시자

**Files:**
- Create: `server/lib/watcher.js`, `test/watcher.test.js`

**Interfaces:**
- Consumes: Task 1 `paths.js`, Task 2 `JsonlTailer`, Task 3 `normalizeRecord/MAIN_LINE_FILTER/readMeta`, Task 4 `Store`
- Produces: `class ProjectsWatcher { constructor({root, store, pollMs=1000, staleMs=7200000}); async start(): Promise<void>; stop(): void; async scan(): Promise<void> }`
  - `scan()`: `root/*/*.jsonl` 중 mtime이 `staleMs` 이내인 것마다 `store.ensureSession` + 메인 tailer(`lineFilter: MAIN_LINE_FILTER`); 그 세션의 `subagents/agent-*.jsonl`마다 `store.ensureAgent` + tailer; `.meta.json`은 mtime이 바뀔 때마다 `readMeta`→`store.attachMeta`.
  - `start()`: 첫 `scan()` 후 `fs.watch(root, {recursive:true})`로 변경된 경로의 tailer만 `read()`; watch가 실패하면 `pollMs`마다 모든 tailer `read()` + 10초마다 `scan()`. 어느 경우든 10초마다 `scan()`과 `store.tick()`.
  - tailer 결과는 메인이면 `store.applyMainEvents`, 서브면 `store.applyAgentEvents`로 흘린다.

- [ ] **Step 1: 실패하는 테스트 작성** — 임시 `root`를 만들고 픽스처를 복사:
  - `scan discovers session and subagent and attaches meta` (snapshot에 세션 1, 에이전트 이름 '탐색-auth', task는 main.jsonl의 prompt)
  - `appending a line to subagent jsonl updates state` (Edit tool_use 줄 append → `pollMs` 뒤 state `edit`)
  - `stale transcripts are ignored` (mtime을 3시간 전으로 `utimes`)
  - `new subagent file appearing after start is picked up`
- [ ] **Step 2: 실패 확인**
- [ ] **Step 3: 구현** — 테스트에서는 `fs.watch` 대신 폴링을 강제할 수 있게 옵션 `{usePolling:true}` 추가.
- [ ] **Step 4: 통과 확인**
- [ ] **Step 5: 커밋** — `git commit -m "feat: watch ~/.claude/projects and feed transcripts into store"`

---

### Task 6: HTTP 서버 (정적·훅·SSE·API)

**Files:**
- Create: `server/lib/http.js`, `test/http.test.js`, `server/index.js`

**Interfaces:**
- Consumes: Task 4 `Store`, Task 5 `ProjectsWatcher`
- Produces: `createServer({store, webDir}): http.Server` (listen은 호출자가), 라우트:
  - `GET /` 및 정적 파일 (`webDir` 아래, `..` 차단, MIME: html/js/css/png/woff2/json)
  - `POST /hook` — body JSON → `store.applyHook`; 본문이 깨져도 200 `{}`; `transcript_path`가 있으면 `store.ensureSession(session_id, {cwd, transcriptPath, projectKey})`
  - `GET /events?agent=<sessionId>/<agentId>` — SSE. 접속 즉시 `event: snapshot`, 이후 `event: patch`, 쿼리의 에이전트에 한해 `event: line`. 15초마다 `: ping`.
  - `GET /api/snapshot` — `store.snapshot()`
  - `GET /api/agent/<sessionId>/<agentId>/lines?after=<n>` — `store.agentLines`
  - `server/index.js`: `--port`/`SAV_PORT`, `--root`(기본 `projectsDir()`), `--install-hooks`, `--uninstall-hooks`(Task 7). `listen(port, '127.0.0.1')` 후 `sub-agent-view http://127.0.0.1:<port>` 한 줄 출력.

- [ ] **Step 1: 실패하는 테스트 작성** `test/http.test.js` — 포트 0으로 띄워:
  - `POST /hook feeds store and returns 200 even for bad JSON`
  - `GET /events sends snapshot first then patch after a hook` (raw `http.get`으로 첫 두 이벤트 읽기)
  - `GET /events?agent=… streams line events for that agent only`
  - `GET /api/agent/.../lines?after=2 returns newer lines`
  - `static serving blocks path traversal` (`/../package.json` → 404)
  - `server only listens on 127.0.0.1` (`server.address().address === '127.0.0.1'`)
- [ ] **Step 2: 실패 확인**
- [ ] **Step 3: 구현** — 순수 `node:http`. SSE 쓰기는 `res.write('event: x\ndata: …\n\n')`. `patch` 리스너는 접속마다 등록하고 `close`에서 해제(누수 방지).
- [ ] **Step 4: 통과 확인**
- [ ] **Step 5: 커밋** — `git commit -m "feat: http server with hook intake, SSE, and line API"`

---

### Task 7: 훅 설치/제거

**Files:**
- Create: `server/lib/hooks-install.js`, `test/hooks-install.test.js`
- Modify: `server/index.js` (플래그 연결)

**Interfaces:**
- Produces:
  - `HOOK_EVENTS = ['SessionStart','SessionEnd','UserPromptSubmit','PreToolUse','PostToolUse','PermissionRequest','SubagentStart','SubagentStop','Stop']`
  - `hookCommand(port): string` → `curl -s -m 1 -X POST -H 'content-type: application/json' --data-binary @- http://127.0.0.1:<port>/hook >/dev/null 2>&1 || true # sub-agent-view`
  - `installHooks(settingsPath, {port}): Promise<{added: string[]}>` — 파일 없으면 `{}`로 시작. 각 이벤트의 `hooks` 배열에 `{hooks:[{type:'command', command, async:true}]}` 추가(matcher 없음). 이미 `# sub-agent-view` 꼬리표가 있는 항목이 있으면 그 이벤트는 건너뜀. 다른 훅은 그대로 둔다.
  - `uninstallHooks(settingsPath): Promise<{removed: string[]}>` — 꼬리표 달린 항목만 제거, 빈 배열이 되면 키 삭제.

- [ ] **Step 0: http 훅 실험(10분 제한)** — `~/.claude/settings.json`을 건드리지 않고 `--settings /tmp/sav-test.json`으로 `type:"http"` 훅을 하나 넣어 `claude -p "hi"`를 실행해 `/hook`에 요청이 오는지 본다. 페이로드가 command 훅의 stdin JSON과 같으면 `hookCommand` 대신 `{type:'http', url, async:true}`를 쓰도록 아래 인터페이스를 바꾸고 테스트도 그에 맞춘다. 10분 안에 확인되지 않으면 curl로 간다(스펙 §3.7).
- [ ] **Step 1: 실패하는 테스트 작성** — 임시 settings.json으로:
  - `install adds 9 events with async command and keeps existing hooks` (기존 `UserPromptSubmit` 항목 1개 있는 파일 → 설치 후 2개, 다른 것은 그대로)
  - `install is idempotent` (두 번 설치해도 개수 동일)
  - `uninstall removes only tagged entries`
  - `hookCommand exits 0 when server is down` — `child_process.execSync(hookCommand(1), {input:'{}', shell:'/bin/sh'})`가 throw 하지 않고 1.5초 안에 끝남 (Review Focus 1)
- [ ] **Step 2: 실패 확인**
- [ ] **Step 3: 구현**; `server/index.js`에 `--install-hooks`/`--uninstall-hooks` 연결(기본 `~/.claude/settings.json`, `--settings` 옵션). 설치 후 추가된 이벤트 이름을 출력하고 "Claude Code를 다시 시작하면 적용됩니다" 안내.
- [ ] **Step 4: 통과 확인**
- [ ] **Step 5: 커밋** — `git commit -m "feat: install/uninstall async forwarding hooks in settings.json"`

---

### Task 8: 프런트엔드 — 목업을 실데이터로 연결

**Files:**
- Create: `web/index.html`, `web/styles.css`, `web/app.js`, `web/office.js`, `web/terminal.js`, `web/assets/characters/` (mockup에서 복사), `test/web.test.js`
- 참고: `mockup/index.html` (복사 원본)

**Interfaces:**
- Consumes: Task 6의 SSE 이벤트(`snapshot`/`patch`/`line`)와 `/api/agent/.../lines`
- Produces (브라우저 모듈):
  - `web/office.js`: `renderTabs(sessions, activeId)` (정렬: `tabTone`이 wait → edit → done → idle 순, 같은 톤 안에서는 세션 이름순, 스펙 §3.5), `renderStatus(session, filter)`, `buildOffice(session)`, `positionAgents(session, {selectedId, filter})`, `drawLinks(session)`, `drawSprites(session, frame)`, `openPop(agent, el)`, `closePop()` — 목업의 같은 이름 함수를 이식하되 입력을 `SessionView`/`AgentView`로 바꾼다. `sheet = hash(agentId) % 6` (메인은 `hash(sessionId) % 6`). `STATE_ANIM`에 `gone`은 없음(그리지 않음). 자리: 서브에이전트 중 `state ∉ {done,gone}` 순서대로 책상 슬롯 4개, 초과분은 휴게실 바닥 `idle` 프레임; `done`은 소파 3석, 초과분 바닥 (스펙 §8-7).
  - `web/terminal.js`: `openDrawer(session, agent)`, `closeDrawer()`, `appendLines(lines)` — DOM에 최근 500줄만 유지(`term.children.length > 500`이면 앞에서 제거). 드로어 하단 입력창·중지 버튼 없음(스펙 §3.5). 스트립에 `컨텍스트` 항목 추가(스펙 §8-5). "작업 목록" 탭은 숨김, "변경 파일" 탭은 `tool`이 Edit/Write인 줄의 target 집계.
  - `web/app.js`: `connect(agentKey|null)` — `EventSource('/events?agent=…')`; `snapshot`이면 세션 전체 교체 후 `rerender()`, `patch`도 동일, `line`이면 `appendLines`. `error`시 EventSource가 재접속하면 다음 `snapshot`으로 다시 맞춤(Review Focus 5: `buildOffice`는 세션의 DOM을 지우고 다시 만들기 때문에 중복 캐릭터가 생기지 않는다). 드로어가 열리면 `connect(agentKey)`로 재접속하고 `/api/.../lines?after=0`으로 초기 줄을 채운다.
  - 팝오버: 허용/거부 버튼 대신 `wait`일 때 "터미널에서 응답하세요" 문구 (스펙 §3.5). `depth ≥ 2`면 "부모: <parentName>" 줄 추가 (스펙 §8-2).
  - 메인 캐릭터 말풍선: `delegating`→"다들 화이팅!", `idle`→"검토 기다려요", 그 외 상태는 서브에이전트와 같음 (스펙 §8-1).

- [ ] **Step 1: 목업 복사** — `mockup/index.html`의 `<style>`을 `web/styles.css`로, 마크업을 `web/index.html`로(`SESSIONS`/`S1~S3`/시뮬레이션 코드는 가져오지 않음), `assets/characters/`와 `CREDITS.md` 복사.
- [ ] **Step 2: 실패하는 테스트 작성** `test/web.test.js` — DOM 없이 검사할 수 있는 순수 함수만 분리해 테스트: `web/office.js`에서 `export function assignSeats(agents): {deskSlots: (id|null)[], sofa: id[], floor: id[]}`, `export function sheetFor(id): 0..5`, `export function tabTone(session): 'wait'|'edit'|'done'|'idle'`; `web/terminal.js`에서 `export function changedFiles(lines): [{path, edits}]`.
  - `assignSeats puts 4 active at desks, 5th on floor, done on sofa up to 3`
  - `assignSeats skips gone agents`
  - `sheetFor is stable and in range`
  - `tabTone prefers wait, then active, then done, main wait counts` (스펙 §8-1)
  - `changedFiles aggregates Edit/Write targets`
- [ ] **Step 3: 실패 확인** — `node --test test/web.test.js`
- [ ] **Step 4: 구현** `web/office.js`, `web/terminal.js`, `web/app.js` — 목업 함수 이식. `index.html`은 `<script type="module" src="app.js">`.
- [ ] **Step 5: 통과 확인**
- [ ] **Step 6: 수동 확인** — `node server/index.js --root test/fixtures/projects`(Task 9에서 만드는 픽스처 루트가 없으면 임시로 `~/.claude/projects`)로 띄우고 브라우저에서: 탭에 세션이 보이고, 캐릭터 클릭 → 팝오버, 상세히 → 드로어 줄이 보인다. 헤드리스 캡처는 Task 9.
- [ ] **Step 7: 커밋** — `git commit -m "feat: web UI driven by live session snapshots and SSE"`

---

### Task 9: 폰트 동봉, 픽스처 루트, 스모크 스크립트, README

**Files:**
- Create: `web/fonts/Galmuri11.woff2`, `web/fonts/PretendardVariable.woff2`, `web/fonts/LICENSE.md`, `test/fixtures/projects/` (세션 1개 + 서브에이전트 2개 + meta), `scripts/smoke.sh`, `README.md`
- Modify: `web/styles.css` (`@font-face`로 교체, CDN `<link>` 제거)

**Interfaces:**
- Consumes: Task 6 서버, Task 8 UI
- Produces: `scripts/smoke.sh` — 서버를 픽스처 루트로 띄우고 `curl /api/snapshot`에 세션 1개·에이전트 2개가 있는지 확인, `CHROME` 환경변수가 있으면 헤드리스 스크린샷 `docs/screenshots/office.png` 저장. 종료 코드로 성공/실패.

- [ ] **Step 1: 폰트 내려받기** — Galmuri11.woff2는 jsdelivr `galmuri` 패키지 `dist/`에서, Pretendard는 `orioncactus/pretendard` 릴리스의 `PretendardVariable.woff2`. 둘 다 OFL. `LICENSE.md`에 출처·라이선스 기재. `styles.css`의 `--pixel`/`--body` 폰트 스택은 유지하고 `@font-face` 두 개 추가, `index.html`의 CDN `<link>` 두 줄 삭제.
- [ ] **Step 2: 픽스처 루트 작성** — `test/fixtures/projects/-home-u-demo/s1.jsonl` + `s1/subagents/agent-a1.jsonl`, `agent-a1.meta.json`, `agent-a2.jsonl`, `agent-a2.meta.json`. 스모크에서 mtime을 `touch`로 갱신한다(stale 판정 회피).
- [ ] **Step 3: `scripts/smoke.sh` 작성** — 위 명세. 서버는 `--port 0`이 아니라 `--port 4799` 고정, 끝나면 `kill`.
- [ ] **Step 4: 스모크 실행** — `bash scripts/smoke.sh` → `OK sessions=1 agents=2` 출력, 종료 0. `CHROME=~/.cache/ms-playwright/chromium_headless_shell-1208/chrome-headless-shell-linux64/chrome-headless-shell LD_LIBRARY_PATH=/tmp/chromelibs/root/usr/lib/x86_64-linux-gnu bash scripts/smoke.sh`로 스크린샷까지 확인(이 머신 전용 경로, README에 적지 않음).
- [ ] **Step 5: README.md** — 설치 3줄(`git clone`, `node server/index.js --install-hooks`, `node server/index.js` 후 브라우저 열기), 훅 제거, 포트 변경, 데이터가 localhost 밖으로 안 나간다는 설명, 캐릭터 출처(CC0)와 pixel-agents 참고.
- [ ] **Step 6: 전체 테스트** — `npm test` → 전부 pass
- [ ] **Step 7: 커밋** — `git commit -m "feat: bundle fonts, fixture root, smoke script, README"`

---

### Task 10: 실사용 검증 (이 머신)

**Files:** 없음 (검증 절차). 문제가 나오면 해당 Task의 코드로 돌아가 수정하고 테스트 추가.

- [ ] **Step 1: 훅 설치** — `node server/index.js --install-hooks` → 9개 이벤트 추가 출력. `~/.claude/settings.json`의 기존 Orca 훅이 그대로 있는지 `grep -c orca` 전후 비교.
- [ ] **Step 2: 서버 기동** — `node server/index.js`, 브라우저 `http://127.0.0.1:4711`.
- [ ] **Step 3: 새 터미널에서 Claude Code 세션을 열고 서브에이전트를 2개 띄우는 프롬프트 실행** (예: "Explore 에이전트 둘로 src와 test 구조를 각각 조사해줘").
- [ ] **Step 4: 확인 항목** — 탭이 생기는가, 캐릭터 2명이 책상에 앉아 읽기 프레임인가, 팝오버의 이름이 Agent 호출의 description과 같은가, 드로어 줄이 실시간으로 늘어나는가, 서브에이전트가 끝나면 소파로 가는가, Claude Code 터미널 쪽 체감 지연이 없는가(훅 디버그 줄 `Hooks: … finished with status 0 (Nms)`에서 N < 100).
- [ ] **Step 5: 서버를 끈 채 Claude Code를 써서 오류·지연이 없는지 확인** (Review Focus 1).
- [ ] **Step 5b: 브라우저를 연 채 서버를 껐다 켠다** — 재접속 뒤 캐릭터가 중복되지 않고 탭·상태가 스냅샷대로 복구되는지 확인 (Review Focus 5).
- [ ] **Step 6: 메모리** — 1시간 사용 후 `ps -o rss= -p <server pid>`가 60MB 이하, 브라우저 탭 작업 관리자 150MB 이하. 결과를 스펙 §5 아래에 "실측" 표로 추가해 커밋.

---

### Task 11: Claude Code 플러그인 패키징 (사용자 추가 요청, 2026-10-23)

근거(공식 문서 확인): 플러그인은 `.claude-plugin/plugin.json`(필수 `name`, kebab-case) + 루트의 `hooks/hooks.json`(최상위 `"hooks"` 래퍼 필수) + `skills/<name>/SKILL.md`. 플러그인이 켜지면 훅이 사용자·프로젝트 훅과 병합되어 settings.json 수정 없이 동작. 설치는 `/plugin marketplace add <owner>/<repo>` → `/plugin install sub-agent-view@<marketplace>`. 같은 저장소가 마켓플레이스가 되려면 `.claude-plugin/marketplace.json`에 `{"name","owner":{"name"},"plugins":[{"name","source":"."}]}`. 플러그인 스킬은 `/sub-agent-view:<skill>`로 호출. 설치 시 `npm install`은 lockfile이 있을 때만 실행되며 우리는 의존성이 없으므로 아무것도 실행되지 않음. `${CLAUDE_PLUGIN_ROOT}`는 훅 명령과 스킬 본문에서 치환됨.

**Files:**
- Create: `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `hooks/hooks.json`, `skills/office/SKILL.md`, `test/plugin.test.js`
- Modify: `README.md` (플러그인 설치 절), `server/lib/hooks-install.js` (`hooksJson(port)` export)

**Interfaces:**
- Produces: `hooksJson(port): {hooks: Record<event, [{hooks:[{type:'command', command, async:true}]}]>}` — settings.json 설치와 같은 항목을 플러그인 형식으로.

- [ ] **Step 1: 실패하는 테스트** `test/plugin.test.js`
  - `plugin.json has a valid kebab-case name and version`
  - `hooks/hooks.json wraps the 9 events under "hooks" with async curl commands equal to hooksJson(4711)`
  - `marketplace.json lists the plugin with source "."`
  - `SKILL.md has name and description frontmatter`
- [ ] **Step 2: 실패 확인** — `node --test test/plugin.test.js`
- [ ] **Step 3: 구현** — `hooksJson` export; 파일 4개 작성. SKILL.md: `/sub-agent-view:office` 호출 시 서버가 떠 있는지 `/api/health`로 확인하고, 없으면 `node ${CLAUDE_PLUGIN_ROOT}/server/index.js`를 백그라운드로 띄운 뒤 `http://127.0.0.1:4711`을 안내. `disable-model-invocation: true`(사용자가 부를 때만).
- [ ] **Step 4: 통과 확인**; README에 "플러그인으로 설치" 절 추가.
- [ ] **Step 5: 커밋** — `git commit -m "feat: package as a Claude Code plugin with bundled hooks and skill"`
