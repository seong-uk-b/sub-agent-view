# sub-agent-view 설계 문서

작성일 2026-10-23. 승인된 목업: `mockup/index.html` (스크린샷 `mockup/screenshots/`).

## 1. 의도

Claude Code 세션이 서브에이전트(Agent 도구)를 여러 개 띄워 일할 때, 지금 누가 무엇을 하는지 한눈에 보고 싶다. 터미널 한 장에는 메인 세션 출력만 흐르고 서브에이전트 내부는 보이지 않는다. 이 도구는 각 서브에이전트를 픽셀 사무실의 캐릭터로 보여주고, 캐릭터를 클릭하면 요약을, "상세히"를 누르면 그 서브에이전트의 터미널(트랜스크립트)을 보여준다.

사용자는 혼자 쓰는 로컬 개발자. 브라우저 탭 하나를 두 번째 모니터나 터미널 옆에 띄워 두는 용도.

## 2. 목표 / 비목표 / 반목표

목표
- 세션별 사무실. 상단 탭으로 세션을 오간다. 탭에 세션 상태 점과 서브에이전트 수.
- 서브에이전트 상태 6종을 캐릭터 동작과 말풍선으로 표현: 코드 작성, 읽기, 명령 실행, 허가 대기, 완료, (메인 전용) 사용자 입력 대기.
- 캐릭터 클릭 → 팝오버: 맡은 일, 지금 쓰는 도구와 대상, 경과 시간, 도구 호출 수, 토큰, 최근 활동 3건.
- "상세히" → 오른쪽 드로어에 그 서브에이전트의 트랜스크립트를 Claude Code 출력 형식(● 도구 / └ 결과)으로 스트리밍.
- 데이터는 사용자의 실제 Claude Code에서 자동으로 온다. 수동 입력 없음.
- 상태바 한 줄: 세션 이름·작업 제목·설명 / 상태 칩(범례 겸 필터) / 경과 시간.

비목표 (이번 범위 아님)
- 팝오버에서 허가 요청을 허용/거부하기. 목업에는 있지만 1차 구현은 표시만 한다 (3.6 참고).
- 서브에이전트에게 메시지 보내기, 중지하기. 드로어 하단 입력창은 1차에서 제거.
- 원격 접속, 다중 사용자, 인증.
- 사무실 레이아웃 편집기, 펫, 사운드.
- Claude Code 외 다른 에이전트(Codex, Gemini) 지원.

반목표 (이렇게 되면 실패)
- Claude Code를 느리게 만들면 안 된다. 훅은 수십 ms 안에 끝나야 하고, 서버가 죽어 있어도 Claude Code는 영향이 없어야 한다.
- 사용자의 트랜스크립트(코드, 프롬프트)를 localhost 밖으로 내보내면 안 된다.
- 하루 종일 켜 두어도 메모리가 계속 자라면 안 된다.

## 3. 어떻게 만드는가 (결정 사항)

### 3.1 전체 구조

```
Claude Code ──hooks(HTTP POST)──▶ ┌──────────────┐ ──SSE──▶ 브라우저 (사무실 UI)
~/.claude/projects/**.jsonl ─watch─▶│ Node 서버    │
                                    │ localhost:4711│ ◀─GET /api/* ─ 브라우저
                                    └──────────────┘
```

- 서버: Node 20+ 단일 프로세스. 외부 의존성 없이 내장 `http`, `fs`, `path`만 사용. (근거: 사용자 머신 Node 24. 설치 마찰을 없애기 위해 `npm install` 없이 `node server/index.js`로 뜨게 한다.) 내 결정.
- 프런트: 목업과 같은 바닐라 JS + CSS. 프레임워크 없음. DOM 노드 300개 미만이라 충분. 목업의 CSS와 사무실 마크업을 그대로 옮긴다.
- 브라우저 ↔ 서버: 서버→브라우저는 SSE(`/events`), 브라우저→서버는 일반 GET. WebSocket 불필요.
- 포트 4711 기본, 환경변수 `SAV_PORT`로 변경.

### 3.2 데이터 소스 (이 머신에서 검증한 사실)

Claude Code 2.1.309 기준으로 확인:
- 세션 트랜스크립트: `~/.claude/projects/<cwd를 '-'로 치환한 이름>/<session-id>.jsonl`.
- 서브에이전트 트랜스크립트: `~/.claude/projects/<proj>/<session-id>/subagents/agent-<agentId>.jsonl`. (`/tmp/claude-<uid>/<proj>/<session-id>/tasks/<agentId>.output`가 이 파일로 심볼릭 링크됨.)
- 서브에이전트 JSONL의 각 줄: `agentId`, `sessionId`, `isSidechain: true`, `type`(user / assistant / attachment / api-request…), `timestamp`, `message.content[]`(assistant 줄에 `tool_use` 블록: `name`, `input`, `id`; user 줄에 `tool_result` 블록).
- 메인 트랜스크립트의 assistant 줄에 `tool_use` `name: "Agent"`, `input: {subagent_type, description, prompt}`가 있고, 그 `tool_result` 텍스트에 `agentId`가 들어 있다. 이것으로 "메인 세션 → 서브에이전트" 연결과 서브에이전트의 이름(description)·종류(subagent_type)·맡은 일(prompt)을 얻는다.
- 서브에이전트 JSONL 두 번째 줄에 `attachment.hookName: "SubagentStart"`가 기록됨 → SubagentStart 훅이 실제로 발화한다.
- 같은 폴더의 `agent-<agentId>.meta.json` (이 머신에서 확인한 실제 내용):
  `{"agentType":"claude-code-guide","description":"…","toolUseId":"toolu_…","spawnDepth":1,"requestShape":"background","requestNonInteractive":true,"launchedWithDefaults":true,"finished":true}`
  → **부모 연결은 `toolUseId`로 한다.** 메인 트랜스크립트의 Agent `tool_use.id`와 같다. 이름은 `description`, 종류는 `agentType`, 맡은 일은 메인 트랜스크립트의 같은 tool_use `input.prompt`. `finished`가 true면 완료. 공식 문서는 이 파일의 존재만 말하고 스키마는 말하지 않으므로, 필드가 없을 때는 트랜스크립트 추정으로 폴백한다.
- 주의: 공식 문서는 JSONL 형식이 "내부 형식이며 버전마다 바뀔 수 있다"고 명시한다. 파서는 모르는 필드와 줄을 무시하고 절대 throw 하지 않는다.

두 소스의 역할
- 훅(1차 신호): 상태 전이를 즉시 알린다. 도구 시작/끝, 허가 요청, 서브에이전트 시작/종료, 세션 시작/종료.
- 트랜스크립트 감시(2차 신호 + 내용): 터미널 드로어에 보여줄 본문, 서브에이전트 이름과 맡은 일, 토큰 수. 훅이 설치되지 않았거나 서버가 늦게 떴어도 트랜스크립트만으로 동작한다(상태는 마지막 tool_use로 추정).

훅 이벤트와 페이로드 필드는 공식 문서로 확인해 3.7에 적는다.

### 3.3 서버 책임

1. `~/.claude/projects/` 아래를 감시(`fs.watch` 재귀, 리눅스에서 미지원이면 1초 폴링 폴백)해 세션 목록을 만든다. 세션 = 최근 30분 안에 갱신된 `.jsonl`. 세션 이름은 프로젝트 폴더 이름의 마지막 조각(`-home-seonguk-sub-agent-view` → `sub-agent-view`)과 트랜스크립트의 `ai-title`/첫 사용자 프롬프트.
2. 각 세션의 `subagents/*.jsonl`을 tail 한다. 파일 끝에서부터 읽고 새 바이트만 파싱한다(전체 재파싱 금지, 160KB짜리 20줄 파일이 흔함).
3. 각 서브에이전트의 상태 기계를 유지한다:
   - `edit`: 마지막 tool_use가 Edit/Write/NotebookEdit
   - `read`: Read/Grep/Glob/WebFetch/WebSearch
   - `run`: Bash
   - `wait`: PermissionRequest 훅 수신 후 PostToolUse/거부 전까지
   - `done`: SubagentStop 훅 또는 트랜스크립트에 최종 assistant 텍스트가 오고 60초 동안 갱신 없음
   - 그 외 도구(Agent, Skill 등)는 `edit`로 분류. 메인 세션은 `delegating`(살아있는 서브에이전트가 있을 때) / `idle`(Stop 이후 사용자 입력 대기).
4. 브라우저에 `/events`(SSE)로 `snapshot`(접속 시 전체 상태)과 `patch`(변경분)를 보낸다. 터미널 줄은 `/api/agent/<id>/lines?after=<n>`로 가져오고, 열려 있는 드로어에 한해 SSE `line` 이벤트로 스트리밍한다.
5. `/hook` POST를 받는다. 훅 스크립트가 보낸 JSON을 상태 기계에 넣는다. 응답은 항상 200 즉시.
6. 정적 파일 `web/` 서빙.

보존 상한(메모리 측정 결과에서 나온 결정): 서버는 서브에이전트당 터미널 줄 최근 2,000개, 세션당 서브에이전트 최근 50개, 세션 20개까지만 유지. 브라우저는 열린 드로어의 줄 500개까지만 DOM에 두고 위는 버린다(스크롤 올리면 `/api/.../lines`로 더 받음).

### 3.4 훅 설치

`node server/index.js --install-hooks`가 `~/.claude/settings.json`의 `hooks`에 아래를 병합한다 (기존 훅은 보존, 같은 명령이 있으면 중복 추가 안 함):
- 이벤트: SessionStart, SessionEnd, UserPromptSubmit, PreToolUse, PostToolUse, PermissionRequest, SubagentStart, SubagentStop, Stop (모두 공식 문서에 있는 이름, 3.7).
- 각 훅은 `"async": true`. 명령: `curl -s -m 1 -X POST -H 'content-type: application/json' --data-binary @- http://127.0.0.1:4711/hook >/dev/null 2>&1 || true`
  - 비동기 + 1초 타임아웃 + 실패해도 종료 코드 0. 서버가 꺼져 있어도 Claude Code는 영향 없음(반목표 1).
- `--uninstall-hooks`로 제거.

### 3.5 프런트 책임

- 목업 `index.html`의 CSS, 사무실 마크업, 캐릭터 스프라이트(`assets/characters/char_0~5.png`, CC0)를 그대로 가져온다. 바꾸는 것은 데이터 소스뿐: `SESSIONS` 상수 대신 `/events`에서 받은 상태.
- 세션 탭 순서: 확인 필요(wait) 세션 먼저, 다음 활동 중, 다음 완료/대기. 새 세션이 생기면 탭이 추가되고 사라지면(30분 무활동) 탭이 빠진다.
- 책상 슬롯 4개. 서브에이전트가 4개를 넘으면 5번째부터는 책상 없이 휴게실에 서 있고(idle 프레임), 책상이 비면 가장 오래 기다린 에이전트가 앉는다. 완료된 에이전트는 소파로 이동(걷기 프레임), 소파가 차면 휴게실 바닥에 선다.
- 캐릭터 시트 배정: 서브에이전트 agentId의 해시 % 6. 같은 에이전트는 항상 같은 얼굴.
- 팝오버의 "허용/거부" 버튼은 1차에서 없앤다. 대신 "터미널에서 응답하세요" 안내 문구.
- 드로어 하단 입력창과 "중지" 버튼 제거. "작업 목록" 탭은 서브에이전트 트랜스크립트에 TodoWrite가 있을 때만 그 내용으로 채우고, 없으면 탭을 숨긴다. "변경 파일" 탭은 Edit/Write 대상 파일을 집계해서 채운다.
- 폰트: Galmuri11, Pretendard를 `web/fonts/`에 동봉(오프라인 동작). 라이선스 둘 다 OFL.

### 3.6 허가 요청 처리에 대한 결정

목업에서는 팝오버에서 허용/거부가 됐다. 실제로 이것을 하려면 PermissionRequest 훅이 서버의 응답을 기다려야 하고(훅 타임아웃 안에 사용자가 클릭해야 함), 잘못되면 Claude Code가 멈춘다. 반목표 1과 충돌하므로 1차에서는 **표시만** 한다. 2차 후보로 문서 끝에 남긴다.

### 3.7 훅 이벤트 사양 (공식 문서 확인 결과, 2026-10-23)

출처: code.claude.com/docs/en/hooks.md, sessions.md, sub-agents.md.

사용할 이벤트와 쓰는 필드
| 이벤트 | 공통 필드 외에 쓰는 것 | 용도 |
|---|---|---|
| SessionStart / SessionEnd | `session_id`, `transcript_path`, `cwd` (End: `reason`) | 세션 탭 생성/제거 |
| UserPromptSubmit | `prompt` | 상태바 작업 제목 갱신, 메인 idle→delegating |
| SubagentStart | `agent_id`, `agent_type` | 캐릭터 등장. 트랜스크립트 경로는 `transcript_path`의 세션 폴더 + `subagents/agent-<agent_id>.jsonl`로 만든다 |
| SubagentStop | `agent_id`, `agent_transcript_path`, `last_assistant_message` | 완료 처리, 팝오버 "결과" 문구 |
| PreToolUse | `tool_name`, `tool_input`, `tool_use_id`, 서브에이전트 안이면 `agent_id` | 상태 edit/read/run 전이, "지금 하는 일" |
| PostToolUse | `tool_name`, `tool_use_id`, `duration_ms`, `agent_id` | 도구 호출 수 집계, wait 해제 |
| PermissionRequest | `tool_name`, `tool_input`, `agent_id` (tool_use_id 없음) | wait 상태 + "!" 말풍선 |
| Stop | `last_assistant_message` | 메인 세션 idle(사용자 입력 대기) |

공통 필드: `session_id`, `transcript_path`, `cwd`, `hook_event_name`, `permission_mode`. 서브에이전트 안에서 발화한 훅은 `agent_id`, `agent_type`가 추가된다(문서화됨). 서브에이전트 안의 `session_id`가 부모와 같은지는 문서에 없다 → 서버는 `agent_id`를 1차 키로 쓰고 `transcript_path`로 세션을 찾는다.

설치 형태
- `type: "command"` + `"async": true`. 비동기 훅은 Claude Code를 기다리게 하지 않고 타임아웃도 적용되지 않는다(문서화됨). 명령은 `curl -s -m 1 … || true`.
- 문서에 `type: "http"` 훅이 있지만 페이로드 형식 설명을 이번 조사에서 확보하지 못했다. 빌더는 구현 첫 단계에서 http 훅을 실험해 보고, 동작하면 curl 대신 그것을 쓴다(의존성 하나 제거). 안 되면 command+curl.
- matcher: PreToolUse/PostToolUse는 matcher 생략(모든 도구). SubagentStart/Stop의 matcher는 `agent_type`에 대응하므로 생략.
- 훅은 같은 이벤트끼리 병렬 실행된다. 서버는 이벤트 순서를 `timestamp`가 아니라 수신 순서로 다루되, PostToolUse가 PreToolUse보다 먼저 올 수 있음을 허용한다(`tool_use_id`로 짝 맞춤).

문서에 없는 것(설계가 기대지 않는 것): 훅 호출 빈도 제한, `isSidechain` 필드, `parent_session_id`.

## 4. 제약

- Linux(WSL2 포함)와 macOS. Windows 네이티브는 훅 명령이 `curl` 의존이라 1차 범위 밖.
- Node 20+. 외부 npm 의존성 0. 테스트는 Node 내장 `node:test`.
- 서버 RSS 목표 60MB 이하, 브라우저 렌더러 150MB 이하(목업 측정 142MB 기준).
- 트랜스크립트는 민감 정보를 담는다. 서버는 `127.0.0.1`에만 바인딩. 로그에 프롬프트 본문을 남기지 않는다.

## 5. 메모리 측정 (목업 기준, 2026-10-23)

헤드리스 크로미엄 1440×860, `--enable-precise-memory-info`.

| 항목 | 값 |
|---|---|
| JS 힙 사용량 | 0.7–1.5 MB (GC 톱니, 5분 동안 증가 없음) |
| DOM 노드 | 206개 (드로어 열고 60초 스트리밍 시 295개) |
| 렌더러 프로세스 RSS | 142 MB (크로미엄 기본 오버헤드 포함) |
| 브라우저 전체 프로세스 합계 | 445 MB (브라우저·GPU·유틸리티 포함, 탭 하나) |
| 페이지 자산 | HTML 59 KB + 캐릭터 PNG 6장 30 KB + CDN 폰트 CSS 56 KB (폰트 파일 별도) |

해석: 페이지 자체는 가볍고 누수가 없다. RSS 142MB는 거의 크로미엄 고정 비용이라 UI를 더 줄여도 크게 안 내려간다. 유일한 증가 요인은 터미널 줄이 무한히 쌓이는 것이라 3.3의 상한을 둔다.

## 6. 빌더에게 맡기는 것

- 서버 파일 구성, 모듈 경계, 테스트 구조.
- JSONL tail 구현 방식(바이트 오프셋 유지 등).
- SSE 재접속·재동기화 방식(접속 시 snapshot을 다시 보내면 충분).
- 사무실 안 자리 배정 알고리즘 세부.
- 상태 추정의 세부 임계값(예: done 판정 60초)은 조정 가능.

## 7. 2차 후보 (이번에 안 함)

- 팝오버에서 허가 허용/거부 (PermissionRequest 훅 long-poll).
- 서브에이전트에게 메시지, 중지.
- 세션 간 연결선(한 세션이 다른 세션을 띄운 경우).
- 레이아웃 편집, 캐릭터 색조 변주(6명 초과 시).

## 8. 빌더 검토 후 결정 (2026-10-23, 작성자의 결정)

빌더 관점 검토에서 나온 질문 7개에 대한 답. 모두 작성자가 정한 기본값이며 사용자가 바꿀 수 있다.

1. **메인 세션의 상태.** 메인도 서브에이전트와 같은 상태 집합을 가진다: `edit` / `read` / `run` / `wait`(PermissionRequest 또는 AskUserQuestion 도구 호출) / `delegating`(살아있는 서브에이전트가 있고 자기 도구 호출은 없음) / `idle`(Stop 이후 사용자 입력 대기). 탭의 빨간 점과 "확인 필요" 집계는 메인의 `wait`도 포함한다. 메인 캐릭터의 말풍선은 상태에 따라 바뀌되 `delegating`이면 "다들 화이팅!", `idle`이면 "검토 기다려요".
2. **중첩·재개된 서브에이전트.** 데이터 모델은 세션 → 에이전트 목록(평면). `spawnDepth ≥ 2`인 에이전트도 같은 목록에 들어가고 연결선은 메인 책상에서 긋는다. 팝오버에 "부모: <이름>"을 한 줄 표시한다. `done`은 종단 상태가 아니다. 완료된 에이전트에 새 tool_use가 오면 `edit/read/run`으로 돌아가고 빈 책상이 있으면 다시 앉는다.
3. **메인 세션의 팝오버·드로어.** 둘 다 1차 범위. 메인 트랜스크립트 리더는 `type`이 `user` / `assistant` / `system`인 줄만 파싱하고 나머지 줄(`api-request-blob`, `file-history-snapshot`, `attachment` 등)은 JSON 파싱조차 하지 않고 건너뛴다(줄 앞 80바이트에서 `"type":"…"`를 정규식으로 봄). 줄 보존 상한은 서브에이전트와 같다.
4. **세션 수명.** 훅 우선, 파일 폴백. SessionStart로 생기거나 트랜스크립트가 발견되면 탭 생성. SessionEnd 수신 60초 뒤 제거. 훅이 없을 때는 트랜스크립트 마지막 수정 후 2시간 무활동이면 제거(30분은 너무 짧다 — 사용자가 답을 안 한 idle 세션은 남아 있어야 한다). `claude -p`나 외부 도구가 띄운 세션도 구분하지 않고 탭이 된다.
5. **토큰 정의.** 팝오버·드로어의 "토큰" = 그 에이전트의 `message.usage.output_tokens` 누적(에이전트가 생산한 양). 드로어 상단 스트립에 "컨텍스트" 항목을 추가해 마지막 assistant 턴의 `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`를 보여준다.
6. **상태바 설명과 화이트보드 출처.** 상태바 설명은 서버가 만든 요약 문장: "서브에이전트 N명 · 일하는 중 M · 완료 K". 화이트보드 1줄은 마지막 사용자 프롬프트의 첫 줄(80자에서 자름), 2줄은 세션 cwd의 마지막 폴더 이름. 프롬프트는 메모리에만 두고 서버 로그에는 쓰지 않는다.
7. **완료 에이전트 퇴장.** `done` 상태로 10분이 지나면 `gone`으로 바뀌어 사무실에서 사라진다(문 쪽으로 걸어 나가는 연출은 선택). `gone`도 "완료" 칩 개수에는 포함한다. 소파 3석이 차면 완료 에이전트는 휴게실 바닥에 서 있는다(idle 프레임).
