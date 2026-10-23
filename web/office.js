/*
 * 사무실 렌더링. 순수 함수(assignSeats, sheetFor, tabTone, sortSessions)는 Node 테스트에서도 import 되므로
 * 모듈 최상위에서 document를 건드리지 않는다. DOM을 쓰는 함수는 createOffice() 안에만 있다.
 */
export const STATES = {
  delegating: { label: '분배 중', raw: '#B59CFF', screen: 'on', bubble: '다들 화이팅!' },
  edit:       { label: '코드 작성 중', raw: '#FFC65C', screen: 'on', bubble: '타닥타닥' },
  read:       { label: '읽는 중', raw: '#7FB8FF', screen: 'on', bubble: '읽는 중…' },
  run:        { label: '명령 실행 중', raw: '#5EE0C8', screen: 'on', bubble: '>_ 실행 중' },
  wait:       { label: '허가 대기', raw: '#FF6F61', screen: 'dim', bubble: '!' },
  done:       { label: '완료', raw: '#7FD1A0', screen: 'off', bubble: '다 했다!' },
  gone:       { label: '퇴근', raw: '#7FD1A0', screen: 'off', bubble: '' },
  idle:       { label: '대기 중', raw: '#9A9BAE', screen: 'off', bubble: '검토 기다려요' },
};
export const CHIP_ORDER = ['edit', 'read', 'run', 'wait', 'done'];
export const CHIP_SHORT = { edit: '작성', read: '읽기', run: '실행', wait: '대기', done: '완료' };

/** 탭에 표시할 서브에이전트 수: 사무실을 떠난(gone) 에이전트는 세지 않는다 */
export function liveAgentCount(session) { return session.agents.filter((a) => a.state !== 'gone').length; }

export const MAIN_DESK = { x: 404, y: 150 };
export const DESK_SLOTS = [{ x: 66, y: 312 }, { x: 236, y: 312 }, { x: 406, y: 312 }, { x: 576, y: 312 }];
export const SOFA_SPOTS = [{ x: 800, y: 228 }, { x: 846, y: 228 }, { x: 892, y: 228 }];
export const FLOOR_SPOTS = [{ x: 778, y: 396 }, { x: 824, y: 396 }, { x: 870, y: 396 }, { x: 778, y: 440 }, { x: 824, y: 440 }, { x: 870, y: 440 }];
const FW = 48, FH = 96;
const ACTIVE = new Set(['edit', 'read', 'run', 'wait']);
const WORKING = new Set(['edit', 'read', 'run']);

/** 자리 배정: 활동 중인 에이전트는 시작 순으로 책상 4개, 초과분은 휴게실 바닥. 완료는 소파 3석, 초과분 바닥. gone은 제외. */
export function assignSeats(agents) {
  const active = agents.filter((a) => ACTIVE.has(a.state)).sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
  const done = agents.filter((a) => a.state === 'done').sort((a, b) => (a.endedAt || 0) - (b.endedAt || 0));
  const deskSlots = [null, null, null, null];
  const floor = [];
  active.forEach((a, i) => { if (i < 4) deskSlots[i] = a.id; else floor.push(a.id); });
  const sofa = done.slice(0, 3).map((a) => a.id);
  done.slice(3).forEach((a) => floor.push(a.id));
  return { deskSlots, sofa, floor };
}

/** 같은 ID는 항상 같은 얼굴 (0..5) */
export function sheetFor(id) {
  let h = 5381;
  for (const ch of String(id)) h = ((h * 33) ^ ch.charCodeAt(0)) >>> 0;
  return h % 6;
}

/** 세션 탭 색: wait > 활동 > 완료 > 대기 */
export function tabTone(session) {
  const states = (session.agents || []).map((a) => a.state);
  const main = session.main?.state;
  if (main === 'wait' || states.includes('wait')) return 'wait';
  if (states.some((s) => WORKING.has(s)) || WORKING.has(main) || main === 'delegating') return 'edit';
  if (states.length && states.every((s) => s === 'done' || s === 'gone')) return 'done';
  return 'idle';
}
const TONE_RANK = { wait: 0, edit: 1, done: 2, idle: 3 };
export function sortSessions(sessions) {
  return [...sessions].sort((a, b) => TONE_RANK[tabTone(a)] - TONE_RANK[tabTone(b)] || String(a.name).localeCompare(String(b.name)));
}

export const fmt = (sec) => { sec = Math.max(0, Math.floor(sec)); return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`; };
export const elapsedOf = (a, now = Date.now()) => ((a.endedAt ?? now) - a.startedAt) / 1000;
export const sheetUrl = (n) => `assets/characters/char_${n}.png`;
const ROW = { down: 0, up: 1, right: 2 };
const FRAMES = { idle: [0, 0], walk: [1, 2], type: [3, 4], read: [5, 6] };
const STATE_ANIM = { edit: 'type', run: 'type', delegating: 'type', read: 'read', wait: 'idle', done: 'idle', idle: 'idle', gone: 'idle' };
export function frameStyle(sheet, anim, f, dir = 'down') {
  const col = FRAMES[anim][f % 2], row = ROW[dir];
  return `background-image:url(${sheetUrl(sheet)});background-position:${-col * FW}px ${-row * FH}px`;
}
export const avatarHTML = (agent, cls) => `<div class="${cls}"><div class="spr" style="${frameStyle(agent.sheet, 'idle', 0)}"></div></div>`;
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ─────────────────────────── DOM */
export function createOffice({ officeEl, linksEl, onAgentClick }) {
  const doc = officeEl.ownerDocument;
  let builtFor = null;               // session id
  const seatOf = (deskX, deskY, boss) => ({ x: deskX + (boss ? 96 : 72) - FW / 2, y: deskY - FH + 22 });
  const walk = new Map();            // agentId → {until, dir}

  function deskEl(desk, boss, id, name, empty) {
    const d = doc.createElement('div');
    d.className = 'desk' + (boss ? ' boss' : '') + (empty ? ' empty' : '');
    d.style.left = desk.x + 'px'; d.style.top = desk.y + 'px'; d.dataset.slot = id; d.dataset.screen = 'off';
    d.innerHTML = `<div class="legs"></div><div class="monitor"><div class="screen"></div></div><div class="kb"></div>${empty ? '' : '<div class="mug"></div>'}${boss ? '<div class="lamp"></div>' : ''}<div class="nameplate">${esc(name)}</div>`;
    const c = doc.createElement('div'); c.className = 'chair'; const s = seatOf(desk.x, desk.y, boss); c.style.left = (s.x + 4) + 'px'; c.style.top = (s.y + 16) + 'px';
    officeEl.appendChild(c);
    return d;
  }
  function agentEl(agent) {
    const el = doc.createElement('button');
    el.className = 'agent'; el.id = 'ag-' + agent.id; el.setAttribute('aria-label', agent.name);
    el.innerHTML = `<div class="body"><div class="spr"></div></div><div class="bubble"></div>`;
    el.addEventListener('click', (e) => { e.stopPropagation(); onAgentClick(agent.id, el); });
    return el;
  }

  /** 세션이 바뀌었거나 에이전트 집합이 바뀌면 책상·의자·캐릭터를 다시 만든다 (중복 캐릭터 방지). */
  function build(session) {
    const ids = ['main', ...session.agents.map((a) => a.id)].join(',');
    if (builtFor === session.id + '|' + ids) return;
    builtFor = session.id + '|' + ids;
    officeEl.querySelectorAll('.desk,.chair,.agent').forEach((e) => e.remove());
    walk.clear();
    officeEl.appendChild(deskEl(MAIN_DESK, true, 'main', session.main.name, false));
    DESK_SLOTS.forEach((slot, i) => officeEl.appendChild(deskEl(slot, false, 'slot' + i, '빈 자리', true)));
    officeEl.appendChild(agentEl({ ...session.main, id: 'main' }));
    for (const a of session.agents) officeEl.appendChild(agentEl(a));
  }

  /** 상태에 따라 위치·말풍선·모니터·필터 투명도를 갱신 */
  function position(session, { selectedId = null, filter = null } = {}) {
    const seats = assignSeats(session.agents);
    const placeAgent = (a, p, el) => {
      const prevX = parseFloat(el.style.left);
      if (!Number.isNaN(prevX) && prevX !== p.x) walk.set(a.id, { until: Date.now() + 950, dir: p.x > prevX ? 'right' : 'left' });
      el.style.left = p.x + 'px'; el.style.top = p.y + 'px';
    };
    const decorate = (a, el) => {
      const s = STATES[a.state] || STATES.idle;
      el.dataset.state = a.state; el.classList.toggle('selected', selectedId === a.id);
      el.setAttribute('aria-label', `${a.name} · ${s.label}`);
      const b = el.querySelector('.bubble'); b.textContent = s.bubble; b.className = 'bubble ' + (a.state === 'wait' ? 'wait' : a.state === 'done' ? 'done' : '');
      b.style.display = s.bubble ? '' : 'none';
      el.style.opacity = !filter || a.id === 'main' || a.state === filter || (filter === 'done' && a.state === 'gone') ? 1 : .25;
      el.hidden = a.state === 'gone';
    };
    // 메인
    const mainEl = officeEl.querySelector('#ag-main');
    if (mainEl) { placeAgent({ id: 'main' }, seatOf(MAIN_DESK.x, MAIN_DESK.y, true), mainEl); decorate({ ...session.main, id: 'main' }, mainEl); setScreen('main', session.main.state); }
    // 책상 슬롯
    DESK_SLOTS.forEach((slot, i) => {
      const id = seats.deskSlots[i];
      const desk = officeEl.querySelector(`.desk[data-slot="slot${i}"]`);
      const a = id ? session.agents.find((x) => x.id === id) : null;
      if (desk) { desk.classList.toggle('empty', !a); desk.querySelector('.nameplate').textContent = a ? a.name : '빈 자리'; }
      if (a) { const el = officeEl.querySelector('#ag-' + CSS.escape(a.id)); if (el) placeAgent(a, seatOf(slot.x, slot.y, false), el); setScreen('slot' + i, a.state); } else setScreen('slot' + i, 'idle');
    });
    seats.sofa.forEach((id, i) => { const a = session.agents.find((x) => x.id === id); const el = officeEl.querySelector('#ag-' + CSS.escape(id)); if (a && el) placeAgent(a, SOFA_SPOTS[i], el); });
    seats.floor.forEach((id, i) => { const a = session.agents.find((x) => x.id === id); const el = officeEl.querySelector('#ag-' + CSS.escape(id)); if (a && el) placeAgent(a, FLOOR_SPOTS[i % FLOOR_SPOTS.length], el); });
    for (const a of session.agents) { const el = officeEl.querySelector('#ag-' + CSS.escape(a.id)); if (el) decorate(a, el); }
    drawLinks(session);
  }
  function setScreen(slotId, state) {
    const desk = officeEl.querySelector(`.desk[data-slot="${slotId}"]`); if (!desk) return;
    const s = STATES[state] || STATES.idle; desk.dataset.screen = s.screen; desk.style.setProperty('--sc', s.raw);
  }
  function drawLinks(session) {
    const sx = MAIN_DESK.x + 78, sy = MAIN_DESK.y + 58;
    linksEl.innerHTML = session.agents.filter((a) => a.state !== 'gone').map((a) => {
      const el = officeEl.querySelector('#ag-' + CSS.escape(a.id)); if (!el) return '';
      const ex = parseFloat(el.style.left) + FW / 2, ey = parseFloat(el.style.top) - 26, my = (sy + ey) / 2;
      const cls = a.state === 'done' ? 'done' : a.state === 'wait' ? '' : 'active';
      return `<path class="${cls}" d="M${sx},${sy} C${sx},${my} ${ex},${my} ${ex},${ey}" stroke="${(STATES[a.state] || STATES.idle).raw}"/>`;
    }).join('');
  }
  /** 스프라이트 프레임 갱신 (380ms마다 호출) */
  function sprites(session, frame) {
    const all = [{ ...session.main, id: 'main' }, ...session.agents];
    for (const a of all) {
      const el = officeEl.querySelector('#ag-' + CSS.escape(a.id) + ' .spr'); if (!el) continue;
      const w = walk.get(a.id);
      if (w && Date.now() < w.until) el.style.cssText = frameStyle(a.sheet, 'walk', frame, 'right') + (w.dir === 'left' ? ';transform:scaleX(-1)' : '');
      else el.style.cssText = frameStyle(a.sheet, STATE_ANIM[a.state] || 'idle', frame);
    }
  }
  function reset() { builtFor = null; }
  return { build, position, sprites, reset };
}
