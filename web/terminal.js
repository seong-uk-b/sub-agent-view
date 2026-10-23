import { STATES, esc, fmt, elapsedOf, avatarHTML } from './office.js';

export const DOM_LINE_CAP = 500;

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
  function render() {
    if (!current) return;
    const { session, agent } = current;
    const s = STATES[agent.state] || STATES.idle;
    const live = ['edit', 'read', 'run', 'delegating'].includes(agent.state);
    const more = agent.lineCount > lines.length ? `<span class="more">… 이전 ${agent.lineCount - lines.length}줄은 생략됨 (서버 보존 ${Math.min(agent.lineCount, 2000)}줄)</span>` : '';
    term.innerHTML = `<div class="l sys">— ${esc(agent.id === 'main' ? '메인 세션' : '서브에이전트')} ${esc(agent.id)} · ${esc(agent.type)} · ${esc(agent.model || '')}</div>` + more
      + lines.map((l) => lineHTML(l, s.raw)).join('') + (live ? `<div class="l"><span class="cursor"></span></div>` : `<div class="l sys">— ${agent.state === 'wait' ? '응답 대기 중' : '세션 종료'}</div>`);
    term.scrollTop = term.scrollHeight;
    const files = changedFiles(lines);
    work.innerHTML = files.length ? `<ul>${files.map((f) => `<li><span style="color:${f.kind === 'A' ? 'var(--green)' : 'var(--amber)'}">${f.kind}</span>${esc(f.path)}<span style="color:var(--muted);margin-left:auto">${f.edits}회</span></li>`).join('')}</ul>` : `<p style="color:var(--muted)">아직 수정한 파일이 없습니다.</p>`;
  }

  async function open(session, agent) {
    current = { session, agent };
    header(session, agent);
    setTab('term');
    drawer.classList.add('open'); scrim.classList.add('show');
    lines = [];
    render();
    const got = await fetchLines(session.id, agent.id, 0);
    lines = got.slice(-DOM_LINE_CAP);
    render();
    onOpen?.(`${session.id}/${agent.id}`);
  }
  function close() { if (!current) return; current = null; drawer.classList.remove('open'); scrim.classList.remove('show'); onClose?.(); }
  function appendLines(newLines) {
    if (!current) return;
    for (const l of newLines) if (!lines.length || l.n > lines[lines.length - 1].n) lines.push(l);
    if (lines.length > DOM_LINE_CAP) lines.splice(0, lines.length - DOM_LINE_CAP);
    render();
  }
  /** 스냅샷이 갱신될 때 헤더·통계만 갱신 */
  function refresh(session, agent) { if (!current || current.agent.id !== agent.id) return; current = { session, agent }; header(session, agent); if (!lines.length || lines[lines.length - 1].n < agent.lineCount) { /* 줄은 SSE line 이벤트로 옴 */ } render(); }
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
