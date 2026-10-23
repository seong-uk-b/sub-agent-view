import { STATES, esc, fmt, elapsedOf, avatarHTML } from './office.js';

export const DOM_LINE_CAP = 500;

/** 기존 줄 뒤에 더 새로운 줄만 붙이고 cap을 넘으면 앞을 버린다. added = 실제로 추가된 줄. */
export function mergeLines(existing, incoming, cap = DOM_LINE_CAP) {
  let last = existing.length ? existing[existing.length - 1].n : 0;
  const added = [];
  for (const l of incoming) if (l.n > last) { added.push(l); last = l.n; }
  const lines = existing.concat(added);
  const dropped = Math.max(0, lines.length - cap);
  return { lines: dropped ? lines.slice(dropped) : lines, added, dropped };
}
/** 서버 lineCount보다 뒤처져 있으면 어디서부터 받아야 하는지 (after 값), 최신이면 null. */
export function missingAfter(lines, lineCount) {
  const last = lines.length ? lines[lines.length - 1].n : 0;
  return lineCount > last ? last : null;
}

/** Edit/Write 대상 파일 집계. 첫 등장 순. 첫 작업이 Write면 A, 아니면 M. */
export function changedFiles(lines) {
  const map = new Map();
  for (const l of lines) {
    if (l.kind !== 'tool' || (l.tool !== 'Edit' && l.tool !== 'Write' && l.tool !== 'NotebookEdit') || !l.text) continue;
    const cur = map.get(l.text);
    if (cur) cur.edits++; else map.set(l.text, { path: l.text, edits: 1, kind: l.tool === 'Write' ? 'A' : 'M' });
  }
  return [...map.values()];
}

export function lineHTML(l, color) {
  const t = esc(l.text);
  switch (l.kind) {
    case 'user': return `<div class="l user">› ${t}</div>`;
    case 'tool': return `<div class="l tool" style="--sc:${color}">● <span class="n">${esc(l.tool)}</span>(${t})</div>`;
    case 'out':  return `<div class="l out">${t}</div>`;
    case 'ok':   return `<div class="l out ok">${t}</div>`;
    case 'err':  return `<div class="l out err">${t}</div>`;
    case 'think':return `<div class="l think">✱ ${t}</div>`;
    default:     return `<div class="l sys">— ${t}</div>`;
  }
}

/* ─────────────────────────── 드로어 DOM */
export function createDrawer({ doc, fetchLines, onOpen, onClose }) {
  const $ = (id) => doc.getElementById(id);
  const drawer = $('drawer'), term = $('term'), work = $('work'), scrim = $('scrim');
  let current = null;        // {session, agent}
  let lines = [];            // 현재 에이전트의 줄 (DOM_LINE_CAP까지)
  let tab = 'term';

  function header(session, agent) {
    const s = STATES[agent.state] || STATES.idle;
    $('d-avatar').innerHTML = avatarHTML(agent, '').replace(/^<div class="">|<\/div>$/g, '');
    $('d-name').textContent = agent.name;
    $('d-sub').innerHTML = `<span style="color:${s.raw}">${s.label}</span> · ${esc(agent.task || session.title)}`;
    stats(agent);
  }
  function stats(agent) {
    $('d-tools').textContent = agent.toolCalls;
    $('d-tokens').textContent = (agent.outputTokens / 1000).toFixed(1) + 'k';
    $('d-ctx').textContent = agent.contextTokens >= 1000 ? (agent.contextTokens / 1000).toFixed(1) + 'k' : agent.contextTokens;
    $('d-model').textContent = agent.model || '—';
    $('d-elapsed').textContent = fmt(elapsedOf(agent));
  }
  const color = () => (STATES[current?.agent.state] || STATES.idle).raw;
  const nearBottom = () => term.scrollHeight - term.scrollTop - term.clientHeight < 40;
  const headHTML = (agent) => `<div class="l sys" data-head>— ${esc(agent.id === 'main' ? '메인 세션' : '서브에이전트')} ${esc(agent.id)} · ${esc(agent.type)} · ${esc(agent.model || '')}</div>`;
  const moreHTML = (agent) => agent.lineCount > lines.length ? `<span class="more" data-more>… 이전 ${agent.lineCount - lines.length}줄은 화면에 없음 (서버 보존 최대 2,000줄)</span>` : '';
  const tailHTML = (agent) => ['edit', 'read', 'run', 'delegating'].includes(agent.state) ? `<div class="l" data-tail><span class="cursor"></span></div>` : `<div class="l sys" data-tail>— ${agent.state === 'wait' ? '응답 대기 중' : '세션 종료'}</div>`;

  /** 전체 다시 그리기: 열 때와 앞쪽 줄을 버렸을 때만 */
  function renderAll() {
    if (!current) return;
    const { agent } = current;
    term.innerHTML = headHTML(agent) + moreHTML(agent) + lines.map((l) => lineHTML(l, color())).join('') + tailHTML(agent);
    term.scrollTop = term.scrollHeight;
    renderFiles();
  }
  /** 증분: 새 줄만 꼬리 앞에 삽입. 바닥 근처에 있을 때만 자동 스크롤 */
  function renderAdded(added) {
    if (!current || !added.length) return;
    const stick = nearBottom();
    const tail = term.querySelector('[data-tail]');
    const html = added.map((l) => lineHTML(l, color())).join('');
    if (tail) tail.insertAdjacentHTML('beforebegin', html); else term.insertAdjacentHTML('beforeend', html);
    if (stick) term.scrollTop = term.scrollHeight;
    renderFiles();
  }
  function renderTail() {
    if (!current) return;
    const tail = term.querySelector('[data-tail]'); if (tail) tail.outerHTML = tailHTML(current.agent);
    const more = term.querySelector('[data-more]'); const want = moreHTML(current.agent);
    if (more && !want) more.remove(); else if (more) more.outerHTML = want; else if (want) term.querySelector('[data-head]')?.insertAdjacentHTML('afterend', want);
  }
  function renderFiles() {
    const files = changedFiles(lines);
    work.innerHTML = files.length ? `<ul>${files.map((f) => `<li><span style="color:${f.kind === 'A' ? 'var(--green)' : 'var(--amber)'}">${f.kind}</span>${esc(f.path)}<span style="color:var(--muted);margin-left:auto">${f.edits}회</span></li>`).join('')}</ul>` : `<p style="color:var(--muted)">아직 수정한 파일이 없습니다.</p>`;
  }

  let fetching = false;
  /** 서버가 더 가진 줄을 after=로 받아 붙인다 (재접속·열기 직후 공백 메우기) */
  async function catchUp() {
    if (!current || fetching) return;
    const after = missingAfter(lines, current.agent.lineCount);
    if (after === null) return;
    fetching = true;
    try {
      const got = await fetchLines(current.session.id, current.agent.id, after);
      appendLines(got);
    } finally { fetching = false; }
  }

  async function open(session, agent) {
    current = { session, agent };
    header(session, agent);
    setTab('term');
    drawer.classList.add('open'); scrim.classList.add('show');
    lines = [];
    renderAll();
    const got = await fetchLines(session.id, agent.id, 0);
    if (!current || current.agent.id !== agent.id) return;
    lines = got.slice(-DOM_LINE_CAP);
    renderAll();
    onOpen?.(`${session.id}/${agent.id}`);
  }
  function close() { if (!current) return; current = null; drawer.classList.remove('open'); scrim.classList.remove('show'); onClose?.(); }
  function appendLines(newLines) {
    if (!current) return;
    const r = mergeLines(lines, newLines, DOM_LINE_CAP);
    lines = r.lines;
    if (r.dropped) renderAll(); else renderAdded(r.added);
  }
  /** 스냅샷이 갱신될 때: 헤더·통계·꼬리만 갱신하고, 뒤처진 줄은 API로 메운다 */
  function refresh(session, agent) {
    if (!current || current.agent.id !== agent.id) return;
    current = { session, agent }; header(session, agent); renderTail();
    catchUp();
  }
  function tickClock() { if (current) $('d-elapsed').textContent = fmt(elapsedOf(current.agent)); }
  function setTab(t) {
    tab = t;
    doc.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-selected', b.dataset.tab === t));
    term.classList.toggle('hidden', t !== 'term'); work.classList.toggle('show', t !== 'term');
  }
  doc.querySelector('.tabs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setTab(b.dataset.tab); });
  $('d-close').onclick = close; scrim.onclick = close;
  const key = () => (current ? `${current.session.id}/${current.agent.id}` : null);
  return { open, close, appendLines, refresh, tickClock, key };
}
