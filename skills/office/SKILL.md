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
   echo $! > /tmp/sub-agent-view.pid
   sleep 1 && curl -sf http://127.0.0.1:4711/api/health
   ```

   **윈도우(PowerShell)** 에서는 `nohup` 대신:

   ```powershell
   $p = Start-Process node -ArgumentList "`"$env:CLAUDE_PLUGIN_ROOT\server\index.js`"" -WindowStyle Hidden -PassThru -RedirectStandardOutput "$env:TEMP\sub-agent-view.log" -RedirectStandardError "$env:TEMP\sub-agent-view.err.log"
   $p.Id | Out-File "$env:TEMP\sub-agent-view.pid"
   Start-Sleep 1; curl.exe -sf http://127.0.0.1:4711/api/health
   ```

   포트를 바꾸려면 `SAV_PORT=5000`을 앞에 붙이고, 아래 주소도 그 포트로 안내한다. 단, 플러그인 훅은 4711로 고정되어 있으므로 다른 포트를 쓰면 훅 없이 트랜스크립트 감시만으로 동작한다.

3. 사용자에게 한 줄로 안내한다.

   > 사무실이 열렸습니다: http://127.0.0.1:4711 — 이 세션과 다른 세션의 서브에이전트가 캐릭터로 보입니다. 캐릭터를 클릭하면 요약, "상세히"를 누르면 터미널이 열립니다.

4. 끄고 싶다고 하면 **이 서버의 pid만** 죽인다. 다른 프로젝트의 `server/index.js`를 패턴으로 잡아 죽이면 안 된다. (윈도우: `/api/health`의 pid로 `Stop-Process -Id <pid>`.)

   ```bash
   PID=$(curl -sf http://127.0.0.1:4711/api/health | sed -n 's/.*"pid":\([0-9]*\).*/\1/p')
   [ -n "$PID" ] && kill "$PID" || { [ -f /tmp/sub-agent-view.pid ] && kill "$(cat /tmp/sub-agent-view.pid)"; }
   ```

## 하지 않는 것

- `~/.claude/settings.json`을 수정하지 않는다 (플러그인 훅이 이미 적용되어 있다).
- 트랜스크립트 내용을 요약하거나 외부로 보내지 않는다. 서버는 127.0.0.1에만 바인딩된다.

## 화면이 이상할 때 (탭이 안 사라짐, 터미널이 비어 있음, "연결이 끊겼습니다")

1. 서버 생존 확인: `curl -sf http://127.0.0.1:4711/api/health` (윈도우는 `curl.exe`). 응답이 없으면 서버가 죽은 것이다. 로그(`/tmp/sub-agent-view.log` 또는 `$env:TEMP\sub-agent-view*.log`)의 마지막 줄을 사용자에게 보여 주고 2단계로 다시 띄운다.
2. 살아 있으면 `http://127.0.0.1:4711/api/debug` 를 받아 본다. `hooks.received`가 0이면 훅이 안 들어오는 것(아래 참고), `watcher.registry`가 비어 있으면 `~/.claude/sessions/` 레지스트리를 못 읽는 것, `errors`에 항목이 있으면 그 메시지가 원인이다. 이 JSON에는 프롬프트·코드 내용이 없으므로 그대로 공유해도 된다.

## 윈도우에서 훅이 안 들어올 때

Claude Code는 윈도우에서 명령 훅을 Git Bash로 실행하고, Git Bash가 없으면 PowerShell로 실행한다. 이 플러그인의 훅은 bash 문법이라 PowerShell에서는 조용히 실패한다. 그래도 서버는 트랜스크립트와 `~/.claude/sessions/` 레지스트리만으로 동작하므로 사무실은 보인다. 실시간 반응이 필요하면 Git for Windows 설치를 안내한다.
