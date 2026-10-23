import { STATES, CHIP_ORDER, CHIP_SHORT, createOffice, sortSessions, tabTone, liveAgentCount, sheetFor, fmt, elapsedOf, avatarHTML, esc } from './office.js';
import { createDrawer } from './terminal.js';

const $ = (id) => document.getElementById(id);
const state = { sessions: [], activeId: null, filter: null, selectedId: null, es: null, frame: 0 };

const office = createOffice({ officeEl: $('office'), linksEl: $('links'), onAgentClick: (id, el) => openPop(id, el) });
const drawer = createDrawer({
  doc: document,
  fetchLines: async (sid, aid, after) => { const r = await fetch(`/api/agent/${encodeURIComponent(sid)}/${encodeURIComponent(aid)}/lines?after=${after}`); return (await r.json()).lines; },
  onOpen: (key) => connect(key),
  onClose: () => connect(null),
});

/* ─────────────────────────── 데이터 */
function decorate(sessions) {
  for (const s of sessions) {
    s.main.sheet = sheetFor(s.id);
    for (const a of s.agents) a.sheet = sheetFor(a.id);
  }
  return sortSessions(sessions);
}
const active = () => state.sessions.find((s) => s.id === state.activeId) || null;

function connect(agentKey) {
  state.es?.close();
  const es = new EventSource('/events' + (agentKey ? `?agent=${encodeURIComponent(agentKey)}` : ''));
  state.es = es;
  const onSnap = (e) => { state.sessions = decorate(JSON.parse(e.data).sessions); $('conn').classList.remove('show'); rerender(); };
  es.addEventListener('snapshot', onSnap);
  es.addEventListener('patch', onSnap);
  es.addEventListener('line', (e) => { const d = JSON.parse(e.data); if (`${d.sessionId}/${d.agentId}` === drawer.key()) drawer.appendLines([d.line]); });
  es.onerror = () => $('conn').classList.add('show');
}

/* ─────────────────────────── 렌더 */
function rerender() {
  if (!state.sessions.length) { state.activeId = null; renderTabs(); renderEmpty(); return; }
  if (!active()) state.activeId = state.sessions[0].id;
  const s = active();
  renderTabs(); renderStatus(s);
  $('empty').hidden = true;
  office.build(s); office.position(s, { selectedId: state.selectedId, filter: state.filter }); office.sprites(s, state.frame);
  if (state.selectedId) { const a = agentById(s, state.selectedId); const el = document.getElementById('ag-' + state.selectedId); if (a && el) openPop(state.selectedId, el, true); else closePop(); }
  const dk = drawer.key();
  if (dk) { const [sid, aid] = dk.split('/'); const ss = state.sessions.find((x) => x.id === sid); const a = ss && agentById(ss, aid); if (a) drawer.refresh(ss, a); }
}
const agentById = (s, id) => (id === 'main' ? { ...s.main, id: 'main' } : s.agents.find((a) => a.id === id));

function renderEmpty() {
  $('empty').hidden = false;
  $('empty').innerHTML = `<div><b>아직 보이는 세션이 없습니다</b>Claude Code를 열고 작업을 시작하면 여기에 사무실이 생깁니다.<br>훅을 아직 설치하지 않았다면 <code>node server/index.js --install-hooks</code></div>`;
  $('sb-name').textContent = ''; $('sb-title').textContent = '세션 없음'; $('sb-desc').textContent = ''; $('chips').innerHTML = ''; $('board-1').textContent = ''; $('board-2').textContent = '';
  office.reset(); $('office').querySelectorAll('.desk,.chair,.agent').forEach((e) => e.remove()); $('links').innerHTML = '';
}
function renderTabs() {
  $('stabs').innerHTML = state.sessions.map((s) => { const tone = tabTone(s);
    return `<button class="stab" role="tab" data-s="${esc(s.id)}" aria-selected="${s.id === state.activeId}"><span class="sdot ${tone === 'wait' ? 'wait' : ''}" style="background:${STATES[tone].raw}"></span>${esc(s.name)}<span class="scount">${liveAgentCount(s)}</span></button>`; }).join('');
  const total = state.sessions.reduce((n, s) => n + liveAgentCount(s), 0), waiting = state.sessions.filter((s) => tabTone(s) === 'wait').length;
  $('total-agents').textContent = state.sessions.length ? `세션 ${state.sessions.length} · 서브에이전트 ${total}` + (waiting ? ` · 확인 필요 ${waiting}` : '') : '';
}
function renderStatus(s) {
  $('chips').innerHTML = CHIP_ORDER.map((k) => { const st = STATES[k], n = s.counts[k] || 0;
    return `<button class="chip ${n ? '' : 'zero'}" data-f="${k}" aria-pressed="${state.filter === k}" title="${st.label}만 보기"><span class="dot" style="background:${st.raw}"></span>${CHIP_SHORT[k]} <b>${n}</b></button>`; }).join('');
  $('sb-name').textContent = s.name; $('sb-title').textContent = s.title; $('sb-desc').textContent = s.desc;
  $('board-1').textContent = s.goal[0]; $('board-2').textContent = s.goal[1];
  $('clock').textContent = fmt(s.baseElapsed);
}
$('chips').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; state.filter = state.filter === b.dataset.f ? null : b.dataset.f; rerender(); });
$('stabs').addEventListener('click', (e) => { const b = e.target.closest('.stab'); if (!b) return; closePop(); drawer.close(); state.activeId = b.dataset.s; state.filter = null; rerender(); });

/* ─────────────────────────── 팝오버 */
const pop = $('pop');
function openPop(id, el, refresh = false) {
  const s = active(); if (!s) return;
  const a = agentById(s, id); if (!a) return;
  state.selectedId = id; office.position(s, { selectedId: id, filter: state.filter });
  const st = STATES[a.state] || STATES.idle;
  const now = a.state === 'done' || a.state === 'gone'
    ? `<div class="now" style="--sc:${st.raw}"><div><div class="tool">보고 완료</div><div class="target">${esc(a.summary || '결과 요약 없음')}</div></div></div>`
    : a.state === 'idle' ? `<div class="now" style="--sc:${st.raw}"><div><div class="tool">사용자 입력 대기</div><div class="target">${esc(a.summary || '터미널에서 다음 지시를 기다리는 중')}</div></div></div>`
    : `<div class="now" style="--sc:${st.raw}"><div><div class="tool">${esc(a.tool || (a.state === 'delegating' ? 'Agent' : '…'))}</div><div class="target">${esc(a.target || (a.state === 'delegating' ? `서브에이전트 ${s.agents.filter((x) => ['edit', 'read', 'run', 'wait'].includes(x.state)).length}개 진행 중` : '생각 중'))}</div></div></div>`;
  const warn = a.state === 'wait' ? `<div class="warn"><b>${esc(a.waitReason)}</b>${esc(a.waitDetail || '')}</div><div class="note">Claude Code 터미널에서 응답하세요. 이 화면에서는 허용/거부할 수 없습니다.</div>` : '';
  const parent = a.depth >= 2 ? `<div class="parent">부모: ${esc(a.parentName || '다른 서브에이전트')} · 깊이 ${a.depth}</div>` : '';
  pop.innerHTML = `
    <header>${avatarHTML(a, 'avatar')}<div><h2>${esc(a.name)}</h2><div class="meta"><span class="state" style="color:${st.raw}">${st.label}</span><span>${esc(a.type)}</span>${a.model ? `<span>·</span><span>${esc(a.model)}</span>` : ''}</div>${parent}</div></header>
    <div class="section"><div class="k">맡은 일</div><div class="v">${esc(a.task || s.title)}</div></div>
    <div class="section"><div class="k">${a.state === 'done' ? '결과' : '지금 하는 일'}</div>${now}</div>
    ${warn}
    <div class="section stats"><div><div class="n elapsed">${fmt(elapsedOf(a))}</div><div class="k">경과</div></div><div><div class="n">${a.toolCalls}</div><div class="k">도구 호출</div></div><div><div class="n">${(a.outputTokens / 1000).toFixed(1)}k</div><div class="k">토큰</div></div></div>
    <div class="section"><div class="k">최근 활동</div>${a.recent.length ? `<ul class="recent">${a.recent.map((r) => `<li><span>${ago(r.ts)}</span><span>${esc(r.text)}</span></li>`).join('')}</ul>` : '<div class="v" style="color:var(--muted)">아직 없음</div>'}</div>
    <footer><button class="btn primary" data-act="detail">상세히 · 터미널 열기</button></footer>`;
  pop.className = 'pop show' + (refresh ? ' still' : '');
  const r = el.getBoundingClientRect(), W = 320, H = pop.offsetHeight, vw = window.innerWidth, vh = window.innerHeight;
  let left, top;
  if (r.bottom + 14 + H <= vh - 12) top = r.bottom + 14;
  else if (r.top - 14 - H >= 12) { top = r.top - 14 - H; pop.classList.add('flip'); }
  else { pop.classList.add('side'); top = Math.max(12, Math.min(vh - H - 12, r.top + r.height / 2 - 60)); if (r.right + 16 + W <= vw - 12) left = r.right + 16; else { left = r.left - 16 - W; pop.classList.add('leftside'); } pop.style.setProperty('--ay', (r.top + r.height / 2 - top) + 'px'); }
  if (left === undefined) { left = Math.max(12, Math.min(vw - W - 12, r.left + r.width / 2 - W / 2)); pop.style.setProperty('--ax', (r.left + r.width / 2 - left) + 'px'); }
  pop.style.left = left + 'px'; pop.style.top = top + 'px';
  pop.onclick = (e) => { if (e.target.closest('[data-act="detail"]')) { drawer.open(s, a); closePop(); } };
}
function closePop() { pop.classList.remove('show'); if (state.selectedId) { state.selectedId = null; const s = active(); if (s) office.position(s, { filter: state.filter }); } }
function ago(ts) { const d = Math.max(0, (Date.now() - ts) / 1000); return d < 60 ? `-${Math.floor(d)}초` : d < 3600 ? `-${Math.floor(d / 60)}분` : `-${Math.floor(d / 3600)}시간`; }
document.addEventListener('click', (e) => { if (!pop.contains(e.target)) closePop(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closePop(); drawer.close(); } });

/* ─────────────────────────── 시계·애니메이션 */
setInterval(() => { const s = active(); if (s) { s.baseElapsed++; $('clock').textContent = fmt(s.baseElapsed); } const e = pop.querySelector('.elapsed'); if (e && state.selectedId && s) { const a = agentById(s, state.selectedId); if (a) e.textContent = fmt(elapsedOf(a)); } drawer.tickClock(); }, 1000);
setInterval(() => { const s = active(); if (s) office.sprites(s, state.frame++); }, 380);

connect(null);

// 스크린샷·데모용: #pop=<agentId> / #drawer=<agentId> / #session=<id>
const demo = new URLSearchParams(location.hash.slice(1));
if (demo.has('screenshot')) document.body.classList.add('no-anim');
if ([...demo.keys()].length) {
  let done = false;
  const once = () => {
    if (done || !state.sessions.length) return; done = true;
    if (demo.get('session')) { state.activeId = demo.get('session'); rerender(); }
    const s = active(); if (!s) return;
    if (demo.get('pop')) { const el = document.getElementById('ag-' + demo.get('pop')); if (el) openPop(demo.get('pop'), el); }
    if (demo.get('drawer')) { const a = agentById(s, demo.get('drawer')); if (a) drawer.open(s, a); }
  };
  const iv = setInterval(() => { once(); if (done) clearInterval(iv); }, 100);
}
