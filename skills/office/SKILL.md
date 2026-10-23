---
name: office
description: 서브에이전트 픽셀 사무실 대시보드(sub-agent-view) 서버를 띄우고 브라우저 주소를 안내한다. 사용자가 "사무실 열어", "서브에이전트 보여줘", /sub-agent-view:office 라고 할 때.
disable-model-invocation: true
allowed-tools: Bash(node *), Bash(curl *), Bash(nohup *), Bash(pgrep *), Bash(kill *)
---

# sub-agent-view 사무실 열기

이 플러그인은 설치만으로 훅(`hooks/hooks.json`)이 켜져서 Claude Code 이벤트를 `http://127.0.0.1:4711/hook`으로 비동기 전달한다. 서버가 꺼져 있으면 훅은 1초 안에 조용히 실패하므로 세션에 영향이 없다. 이 스킬은 그 서버를 띄우는 일만 한다.

## 절차

1. 서버가 이미 떠 있는지 확인한다.

   ```bash
   curl -sf http://127.0.0.1:4711/api/health
   ```

   응답이 오면 2단계는 건너뛴다.

2. 서버를 백그라운드로 띄운다. 외부 패키지 설치는 없다 (Node 20 이상만 필요).

   ```bash
   nohup node "${CLAUDE_PLUGIN_ROOT}/server/index.js" > /tmp/sub-agent-view.log 2>&1 &
   sleep 1 && curl -sf http://127.0.0.1:4711/api/health
   ```

   포트를 바꾸려면 `SAV_PORT=5000`을 앞에 붙이고, 아래 주소도 그 포트로 안내한다. 단, 플러그인 훅은 4711로 고정되어 있으므로 다른 포트를 쓰면 훅 없이 트랜스크립트 감시만으로 동작한다.

3. 사용자에게 한 줄로 안내한다.

   > 사무실이 열렸습니다: http://127.0.0.1:4711 — 이 세션과 다른 세션의 서브에이전트가 캐릭터로 보입니다. 캐릭터를 클릭하면 요약, "상세히"를 누르면 터미널이 열립니다.

4. 끄고 싶다고 하면:

   ```bash
   pgrep -f "sub-agent-view/server/index.js|server/index.js" | xargs -r kill
   ```

## 하지 않는 것

- `~/.claude/settings.json`을 수정하지 않는다 (플러그인 훅이 이미 적용되어 있다).
- 트랜스크립트 내용을 요약하거나 외부로 보내지 않는다. 서버는 127.0.0.1에만 바인딩된다.
