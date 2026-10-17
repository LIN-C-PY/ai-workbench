/**
 * 各家 CLI 的流式输出格式都不一样，而且会随版本变化。
 * 这里不做严格的 schema 匹配，而是「尽力提取」：
 *   - 能解析成 JSON 就递归找出文本 / 工具调用 / 会话 id / 错误
 *   - 解析不了就当纯文本（去掉 ANSI 控制符）
 * 原始事件仍然会完整保留在右侧日志面板，方便排查。
 */

const ANSI_RE =
  // eslint-disable-next-line no-control-regex
  /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

export function stripAnsi(input) {
  return String(input ?? '').replace(ANSI_RE, '');
}

const TEXT_KEYS = ['text', 'delta', 'content', 'output', 'result', 'message', 'answer'];

function isPlainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

function collectText(node, depth = 0, bag = []) {
  if (depth > 6 || node == null) return bag;
  if (typeof node === 'string') return bag;
  if (Array.isArray(node)) {
    for (const item of node) collectText(item, depth + 1, bag);
    return bag;
  }
  if (!isPlainObject(node)) return bag;

  // 明确的「非正文」字段直接跳过
  const skip = new Set([
    'signature', 'id', 'uuid', 'session_id', 'sessionId', 'trace_id', 'parent_id',
    'request_id', 'timestamp', 'created', 'model', 'role', 'finish_reason', 'type',
    'subtype', 'usage', 'cost_usd', 'duration_ms', 'cwd', 'command', 'path', 'file'
  ]);

  for (const [key, value] of Object.entries(node)) {
    if (skip.has(key)) continue;
    if (typeof value === 'string') {
      if (TEXT_KEYS.includes(key) && value.length) bag.push({ key, value });
      continue;
    }
    if (Array.isArray(value) || isPlainObject(value)) collectText(value, depth + 1, bag);
  }
  return bag;
}

function extractTool(node) {
  if (!isPlainObject(node)) return null;
  const type = node.type || node.item?.type;
  const name = node.name || node.tool_name || node.toolName || node.item?.name;
  const isTool = TOOL_TYPES.has(type) || Boolean(node.tool_name);
  if (!isTool) return null;
  return {
    name: name || type,
    type,
    input: node.input ?? node.arguments ?? node.args ?? node.item?.input ?? node.item?.command ?? node.item?.arguments ?? null,
    output: node.output ?? node.result ?? node.item?.aggregated_output ?? node.item?.output ?? null
  };
}

/** 这些事件代表「工具调用」，不是助手正文。 */
export const TOOL_TYPES = new Set([
  'tool_use',
  'tool_call',
  'tool_result',
  'function_call',
  'function_call_output',
  'command_execution',
  'local_shell_call',
  'mcp_tool_call',
  'patch_apply',
  'web_search_call'
]);

function findSessionId(node, depth = 0) {
  if (depth > 4 || node == null || typeof node !== 'object') return null;
  if (!Array.isArray(node)) {
    for (const key of ['session_id', 'sessionId', 'conversation_id', 'conversationId']) {
      if (typeof node[key] === 'string' && node[key].length > 6) return node[key];
    }
  }
  for (const value of Object.values(node)) {
    if (value && typeof value === 'object') {
      const hit = findSessionId(value, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * 把一条原始 stdout 行转换成工作台事件。
 * @returns {{kind:'text'|'tool'|'meta'|'error'|'empty', text?:string, tool?:object, sessionId?:string, json?:any, raw:string}}
 */
export function parseLine(rawLine) {
  const raw = String(rawLine ?? '').replace(/\r$/, '');
  const plain = stripAnsi(raw).trimEnd();
  if (!plain.trim()) return { kind: 'empty', raw };

  const trimmed = plain.trim();
  if (!(trimmed.startsWith('{') || trimmed.startsWith('['))) {
    return { kind: 'text', text: plain, raw };
  }

  let json;
  try {
    json = JSON.parse(trimmed);
  } catch {
    return { kind: 'text', text: plain, raw };
  }

  const result = { kind: 'meta', raw, json };
  const sessionId = findSessionId(json);
  if (sessionId) result.sessionId = sessionId;

  // Claude / CodeBuddy 的 stream-json 明确错误
  if (json.type === 'result' && json.is_error) {
    return { ...result, kind: 'error', text: String(json.result || json.error || '执行失败') };
  }

  // 工具类事件只作为工具调用展示，绝不要把命令输出当成正文
  const itemType = json.item?.type || json.type;
  if (TOOL_TYPES.has(itemType)) {
    const tool = extractTool(json) || { name: itemType, type: itemType, input: json.item ?? null, output: null };
    return { ...result, kind: 'tool', tool };
  }

  const tool = extractTool(json) ?? (Array.isArray(json.message?.content) ? json.message.content.map(extractTool).find(Boolean) : null);
  if (tool) {
    return { ...result, kind: 'tool', tool };
  }

  const bag = collectText(json);
  if (bag.length) {
    const seen = new Set();
    const text = bag
      .map((entry) => entry.value)
      .filter((v) => typeof v === 'string' && v.length)
      .filter((v) => (seen.has(v) ? false : (seen.add(v), true)))
      .join('');
    if (text.trim()) {
      const looksFinal = json.type === 'result' || json.type === 'item.completed' || json.type === 'turn.completed';
      return { ...result, kind: 'text', text, final: looksFinal };
    }
  }

  if (json.type === 'error' || json.error) {
    return { ...result, kind: 'error', text: String(json.error?.message || json.message || '未知错误') };
  }

  return result;
}

/**
 * 累积器：把零散事件拼成一条正文，处理三种常见情况
 *   1. 增量 delta（partial messages）
 *   2. 完整消息（每条 assistant message 整体到达）
 *   3. 多条消息分段（工具调用前后各有一条）
 */
export class TextAccumulator {
  constructor() {
    this.emit = '';
  }

  /** @returns {string} 需要追加到 UI 的增量文本 */
  push(text) {
    if (!text) return '';
    if (this.emit && text === this.emit) return '';
    if (this.emit && text.startsWith(this.emit)) {
      const delta = text.slice(this.emit.length);
      this.emit = text;
      return delta;
    }
    if (this.emit && this.emit.endsWith(text)) return '';
    // 新的一段
    const separator = this.emit ? '\n\n' : '';
    this.emit = this.emit ? `${this.emit}\n\n${text}` : text;
    return separator + text;
  }
}

/** 按照 \n 切分一个不断增长的缓冲区，逐行吐出完整行。 */
export class LineBuffer {
  constructor() {
    this.buffer = '';
  }

  feed(chunk) {
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';
    return lines;
  }

  flush() {
    const rest = this.buffer;
    this.buffer = '';
    return rest ? [rest] : [];
  }
}
