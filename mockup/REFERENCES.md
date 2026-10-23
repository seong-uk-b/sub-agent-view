# 참고한 GitHub 프로젝트

| 프로젝트 | 핵심 아이디어 | 데이터 소스 | 스택 |
|---|---|---|---|
| [pablodelucca/pixel-agents](https://github.com/pablodelucca/pixel-agents) | Claude Code 세션마다 픽셀 캐릭터. 편집=타이핑, 검색=읽기, 명령=실행 애니메이션. 권한 요청 시 말풍선. 서브에이전트는 별도 캐릭터 | Claude Code hooks (기본) + `~/.claude/projects` JSONL 트랜스크립트 (폴백) | React 19, Canvas 2D, Fastify. VS Code 확장 + `npx pixel-agents` 브라우저 모드 |
| [paulrobello/claude-office](https://github.com/paulrobello/claude-office) | 메인 세션=사장, 서브에이전트=직원. 세션을 "확인 필요/작업 중/완료/종료" 열로 정렬. 컨텍스트 커질수록 휴지통이 차오름 | hooks → FastAPI → WebSocket | Next.js, PixiJS, Zustand |
| [gukosowa/agents-in-the-office](https://github.com/gukosowa/agents-in-the-office) | 서브에이전트 NPC에 배지 + 부모와 연결선. 권한 대기 시 카메라 이동과 빨간 비네트. 클릭하면 해당 터미널 창을 앞으로(macOS) | hooks가 JSON 이벤트 파일 기록 → Rust 파일 감시 | Vue 3, Tauri 2 |
| [ringhyacinth/star-office-ui](https://github.com/ringhyacinth/star-office-ui) | 상태 6종(idle/writing/researching/executing/syncing/error)을 휴게/업무/버그 구역으로 매핑 | `state.json` + HTTP push | Flask, Phaser |

## 이 목업에 반영한 것
- 메인 세션 책상(상단)에서 서브에이전트 책상으로 **연결선** (agents-in-the-office)
- 상태별 **애니메이션 + 모니터 화면 글로우** (pixel-agents)
- 완료된 에이전트는 **휴게 공간으로 이동** (star-office-ui의 구역 개념)
- 권한 대기 시 **빨간 "!" 말풍선**과 팝오버 안에서 **허용/거부** (pixel-agents, claude-office)
- 터미널은 Claude Code 트랜스크립트 포맷(`● Tool(...)` / `⎿ 결과`)을 그대로 흉내

## 실제 연결 시 데이터 소스 후보
1. Claude Code hooks: `SubagentStart`, `SubagentStop`, `PreToolUse`, `PostToolUse`, `PermissionRequest`, `Stop`
2. `~/.claude/projects/<proj>/<session>.jsonl` 트랜스크립트 감시 (서브에이전트는 `subagents/` 아래 별도 JSONL)

## 2차 수정 (캐릭터·사무실 리디자인)
- 캐릭터는 pixel-agents가 쓰는 JIK-A-4 Metro City 팩의 비율(머리 큰 치비, 2톤 음영, 짙은 외곽선)을 참고해 16×23 그리드로 직접 그렸습니다. 에셋 라이선스 문제가 없도록 외부 이미지는 쓰지 않았습니다.
- 사무실은 pixel-agents 데모 화면의 구조(나무 바닥, 짙은 남색 벽 + 책장 + 야경 창, 칸막이로 나뉜 파란 카펫 휴게실, 러그 위 책상)를 따랐습니다.
- 메인 세션 책상은 claude-office처럼 붉은 러그 위에 두어 "팀장" 자리임을 드러냈습니다.
- (4차에서 자작 스프라이트는 Metro City 시트로 교체되어 `sprites/` 폴더는 제거했습니다.)

## 3차 수정 (세션 탭 + 상태바 통합)
- 상단 바: 로고 + 세션 탭. 탭마다 상태 점(빨강=허가 대기, 노랑=작업 중, 초록=모두 완료, 회색=대기)과 서브에이전트 수 배지. 대기 중인 세션의 점은 깜빡임. 오른쪽 끝에 전체 요약(세션 수·서브에이전트 수·확인 필요 수).
- 상태바: 사무실 창 위에 붙는 한 줄. 세션 이름 → 작업 제목 → 설명 / 상태 칩(범례 겸 필터, 개수 포함) / 세션 경과 시간. 바닥에 흩어져 있던 범례·안내 문구 제거.
- 세션은 `SESSIONS` 배열. 전환 시 책상·의자·캐릭터를 다시 짓고, 서브에이전트가 4명보다 적으면 "빈 자리" 책상이 보임. 화이트보드 문구도 세션별.
- 데모용 해시: `#session=s2`, `#pop=a4`, `#drawer=a2`.

## 4차 수정 (캐릭터를 pixel-agents 시트로 교체)
- pixel-agents(pixel-agents-hq 미러)가 쓰는 캐릭터 6종을 그대로 사용. 원작은 JIK-A-4의 Metro City 팩(CC0)이고 시트 파일은 pixel-agents 저장소(MIT)의 것. 출처는 `assets/characters/CREDITS.md`.
- 16×32 프레임을 3배로 키워 CSS `background-position`으로 그림. 상태 → 프레임: 작성/실행/분배 = 타이핑 2장, 읽기 = 읽기 2장, 대기/완료 = 서 있기. 자리를 옮길 때 0.95초 동안 걷기 프레임 재생(왼쪽 이동은 좌우 반전).
- 에이전트마다 `sheet: 0~5`로 캐릭터를 고름. 더 많은 캐릭터가 필요하면 pixel-agents처럼 색조(hue) 변환을 얹거나 Metro City 팩의 다른 조합을 시트로 추가하면 됨.
