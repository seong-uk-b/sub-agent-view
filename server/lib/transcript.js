import fs from 'node:fs/promises';

/*
 * Claude Code JSONL 레코드 → 정규화 이벤트.
 * JSONL 형식은 Claude Code 내부 형식이라 버전마다 바뀔 수 있다. 여기서는 모르는 것은 모두 무시하고 절대 throw 하지 않는다.
 *
 * Event =
 *  | {kind:'tool_use', id, name, input, ts}
 *  | {kind:'tool_result', toolUseId, text, isError, ts}
 *  | {kind:'text', role:'user'|'assistant', text, ts}
 *  | {kind:'usage', messageId, output, input, cacheRead, cacheCreate, model, ts}
 *  | {kind:'spawn', toolUseId, agentType, description, prompt, ts}
 */

const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch']);
const SPAWN_TOOLS = new Set(['Agent', 'Task']);
const TARGET_MAX = 80;

export function normalizeRecord(rec) {
  if (!rec || typeof rec !== 'object') return [];
  const ts = Date.parse(rec.timestamp) || Date.now();
  const msg = rec.message;
  if (!msg || typeof msg !== 'object') return [];
  const out = [];

  if (rec.type === 'assistant') {
    if (!Array.isArray(msg.content)) return [];
    for (const block of msg.content) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'tool_use') {
        const input = block.input && typeof block.input === 'object' ? block.input : {};
        out.push({ kind: 'tool_use', id: String(block.id ?? ''), name: String(block.name ?? ''), input, ts });
        if (SPAWN_TOOLS.has(block.name)) {
          out.push({ kind: 'spawn', toolUseId: String(block.id ?? ''), agentType: str(input.subagent_type), description: str(input.description), prompt: str(input.prompt), ts });
        }
      } else if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        out.push({ kind: 'text', role: 'assistant', text: block.text, ts });
      }
    }
    const u = msg.usage;
    if (u && typeof u === 'object') {
      out.push({ kind: 'usage', messageId: str(msg.id), output: num(u.output_tokens), input: num(u.input_tokens), cacheRead: num(u.cache_read_input_tokens), cacheCreate: num(u.cache_creation_input_tokens), model: str(msg.model), ts });
    }
    return out;
  }

  if (rec.type === 'user') {
    const human = rec.isMeta !== true && (rec.turnOrigin === 'human' || rec.promptSource === 'typed' || rec.parentUuid == null);
    if (typeof msg.content === 'string') {
      return msg.content.trim() ? [{ kind: 'text', role: 'user', text: msg.content, human, ts }] : [];
    }
    if (!Array.isArray(msg.content)) return [];
    for (const block of msg.content) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'tool_result') {
        out.push({ kind: 'tool_result', toolUseId: String(block.tool_use_id ?? ''), text: resultText(block.content), isError: block.is_error === true, ts });
      } else if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        out.push({ kind: 'text', role: 'user', text: block.text, human, ts });
      }
    }
    return out;
  }
  return [];
}

function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter((c) => c && c.type === 'text' && typeof c.text === 'string').map((c) => c.text).join('\n');
  return '';
}
const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/**
 * 메인 트랜스크립트용 사전 필터: type이 user/assistant/system인 줄만 JSON 파싱 대상.
 * 실측(2.1.309): user/system 줄은 최상위 type이 앞 ~130B 안에, assistant 줄은 뒤 ~420B 안에 있다
 * (message 객체가 먼저 오고 type이 마지막). 그래서 앞 400자 또는 뒤 500자를 본다.
 */
const MAIN_TYPE_RE = /"type"\s*:\s*"(user|assistant|system)"/;
const HEAD = 400, TAIL = 500;
export function MAIN_LINE_FILTER(rawLine) {
  if (MAIN_TYPE_RE.test(rawLine.slice(0, HEAD))) return true;
  return rawLine.length > HEAD && MAIN_TYPE_RE.test(rawLine.slice(-TAIL));
}

/** agent-<id>.meta.json → 필요한 필드만. 없거나 깨지면 null. */
export async function readMeta(metaPath) {
  try {
    const d = JSON.parse(await fs.readFile(metaPath, 'utf8'));
    if (!d || typeof d !== 'object') return null;
    return { agentType: str(d.agentType), description: str(d.description), toolUseId: str(d.toolUseId), finished: d.finished === true, spawnDepth: num(d.spawnDepth) || 1 };
  } catch {
    return null;
  }
}

export function classifyTool(name) {
  if (EDIT_TOOLS.has(name)) return 'edit';
  if (READ_TOOLS.has(name)) return 'read';
  if (name === 'Bash') return 'run';
  return 'edit';
}

/** 팝오버 "지금 하는 일"에 보여줄 대상 문자열 (최대 80자). */
export function toolTarget(name, input) {
  if (!input || typeof input !== 'object') return '';
  let v;
  switch (name) {
    case 'Edit': case 'Write': case 'Read': case 'NotebookEdit': v = input.file_path; break;
    case 'Grep': case 'Glob': v = input.pattern; break;
    case 'Bash': v = input.command; break;
    case 'Agent': case 'Task': v = input.description; break;
    default: v = Object.values(input).find((x) => typeof x === 'string');
  }
  return str(v).replace(/\s+/g, ' ').slice(0, TARGET_MAX);
}
