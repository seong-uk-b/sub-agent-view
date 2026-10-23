#!/usr/bin/env bash
# 픽스처 projects 루트로 서버를 띄워 스냅샷을 확인한다. CHROME 환경변수가 있으면 스크린샷도 찍는다.
set -u
cd "$(dirname "$0")/.."
PORT=${SAV_SMOKE_PORT:-4797}
ROOT=test/fixtures/projects
find "$ROOT" -name '*.jsonl' -exec touch {} +          # stale 판정 회피
node server/index.js --port $PORT --root "$ROOT" >/tmp/sav-smoke.log 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null' EXIT
for i in $(seq 1 30); do curl -sf "http://127.0.0.1:$PORT/api/health" >/dev/null && break; sleep 0.2; done
if grep -q EADDRINUSE /tmp/sav-smoke.log; then echo "FAIL: port $PORT already in use (set SAV_SMOKE_PORT)"; exit 1; fi
if ! kill -0 $PID 2>/dev/null; then echo "FAIL: server exited"; cat /tmp/sav-smoke.log; exit 1; fi
SNAP=$(curl -sf "http://127.0.0.1:$PORT/api/snapshot") || { echo "FAIL: server not responding"; cat /tmp/sav-smoke.log; exit 1; }
RESULT=$(printf '%s' "$SNAP" | node -e '
  let d=""; process.stdin.on("data",c=>d+=c).on("end",()=>{ const s=JSON.parse(d).sessions; const n=s.length, a=s.reduce((x,y)=>x+y.agents.length,0);
    const ok = n===1 && a===2 && s[0].agents.some(x=>x.name==="탐색-auth") && s[0].agents.some(x=>x.state==="edit");
    console.log(`${ok?"OK":"FAIL"} sessions=${n} agents=${a} states=${s[0]?s[0].agents.map(x=>x.state).join(","):"-"}`); process.exit(ok?0:1); });')
STATUS=$?
echo "$RESULT"
if [ -n "${CHROME:-}" ]; then
  mkdir -p docs/screenshots
  "$CHROME" --headless --no-sandbox --disable-gpu --hide-scrollbars --window-size=1440,860 --timeout=5000 --screenshot=docs/screenshots/office.png "http://127.0.0.1:$PORT/#screenshot=1" >/dev/null 2>&1 && echo "screenshot: docs/screenshots/office.png"
fi
exit $STATUS
