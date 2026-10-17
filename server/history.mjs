import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { TRASH_DIR, loadSettings, loadSyncState, saveSyncState } from './config.mjs';
import {
  clearIgnoredImport,
  createConversation,
  getConversation,
  getIgnored,
  importedConversationId,
  isIgnoredImport,
  isIgnoredSession,
  listConversations,
  markImported,
  newId,
  pruneImportIndex,
  saveConversation
} from './store.mjs';
import { listHistorySources, resolveSourcePath } from './config.mjs';

const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_ITEMS_PER_SOURCE = 400;

/* ---------- 目录扫描 ---------- */

function walk(dir, depth = 0, out = []) {
  if (depth > 6) return out;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      walk(full, depth + 1, out);
    } else if (/\.(jsonl|json|ndjson|md|txt|zstd)$/i.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function statOf(file) {
  try {
    const s = fs.statSync(file);
    return { mtime: s.mtimeMs, size: s.size };
  } catch {
    return null;
  }
}

/* ---------- 文本清洗 ---------- */

const WRAPPER_BLOCKS = [
  /<environment_context>[\s\S]*?<\/environment_context>/g,
  /<skills_instructions>[\s\S]*?<\/skills_instructions>/g,
  /<user_instructions>[\s\S]*?<\/user_instructions>/g,
  /<system-reminder>[\s\S]*?<\/system-reminder>/g,
  /<multi_agent_mode>[\s\S]*?<\/multi_agent_mode>/g,
  /<collaboration_mode>[\s\S]*?<\/collaboration_mode>/g,
  /<permissions instructions>[\s\S]*?<\/permissions instructions>/g,
  /<app-context>[\s\S]*?<\/app-context>/g
];

export function cleanUserText(text) {
  let out = String(text ?? '');
  for (const re of WRAPPER_BLOCKS) out = out.replace(re, '');
  out = out.trim();
  // 只剩标签残留的整段系统提示，整条丢掉
  if (!out) return null;
  if (/^<[a-z-]+>/.test(out) && out.length < 60) return null;
  return out;
}

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (!block) continue;
    if (typeof block === 'string') parts.push(block);
    else if (block.type === 'text' || block.type === 'input_text' || block.type === 'output_text') parts.push(block.text || '');
    else if (block.type === 'thinking') continue;
  }
  return parts.join('').trim();
}

/* ---------- 各来源的解析器 ---------- */

function parseCodexJsonl(lines, file) {
  const messages = [];
  let cwd = null;
  let sessionId = null;
  let createdAt = null;
  let internal = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let row;
    try {
      row = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const payload = row.payload || row;

    if (row.type === 'session_meta' || payload.type === 'session_meta' || row.type === 'session_meta') {
      const meta = payload.payload || payload;
      sessionId = meta?.session_id || meta?.id || sessionId;
      cwd = meta?.cwd || cwd;
      createdAt = meta?.timestamp || row.timestamp || createdAt;
      // 子代理会话（比如 Codex 内部的「审批裁判」）不是用户对话，整条跳过
      if (meta?.thread_source && meta.thread_source !== 'user') internal = true;
      if (meta?.source && typeof meta.source === 'object' && meta.source.subagent) internal = true;
      continue;
    }

    if (row.type === 'response_item' && payload.type === 'message') {
      const role = payload.role;
      if (role !== 'user' && role !== 'assistant') continue;
      const text = textFromContent(payload.content);
      if (!text) continue;
      if (role === 'user') {
        const cleaned = cleanUserText(text);
        if (!cleaned) continue;
        messages.push({ role: 'user', content: cleaned, createdAt: row.timestamp });
      } else {
        messages.push({ role: 'assistant', content: text, createdAt: row.timestamp });
      }
      continue;
    }

    if (row.type === 'event_msg' && payload.type === 'agent_message' && payload.message) {
      messages.push({ role: 'assistant', content: String(payload.message), createdAt: row.timestamp });
      continue;
    }
    if (row.type === 'event_msg' && payload.type === 'user_message' && payload.message) {
      const cleaned = cleanUserText(payload.message);
      if (cleaned) messages.push({ role: 'user', content: cleaned, createdAt: row.timestamp });
      continue;
    }
    // 有些会话的最终回答只记在 task_complete 里
    if (row.type === 'event_msg' && payload.type === 'task_complete' && payload.last_agent_message) {
      messages.push({ role: 'assistant', content: String(payload.last_agent_message), createdAt: row.timestamp });
    }
  }

  if (internal) return { messages: [], internal: true, cwd, sessionId, createdAt, file };
  return { messages: dedupeConsecutive(messages), cwd, sessionId, createdAt, file };
}

function parseClaudeJsonl(lines, file) {
  const messages = [];
  let cwd = null;
  let sessionId = null;
  let summary = null;
  let createdAt = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let row;
    try {
      row = JSON.parse(trimmed);
    } catch {
      continue;
    }
    sessionId = row.sessionId || sessionId;
    cwd = row.cwd || cwd;
    createdAt = createdAt || row.timestamp;
    if (row.isSidechain === true) continue; // Claude Code 的子代理记录
    if (row.type === 'summary' && row.summary) {
      summary = summary || row.summary;
      continue;
    }
    if (row.isMeta) continue;
    const role = row.message?.role || row.type;
    if (role !== 'user' && role !== 'assistant') continue;
    const blocks = row.message?.content;
    if (Array.isArray(blocks) && blocks.some((b) => b?.type === 'tool_result')) continue;
    const text = textFromContent(blocks ?? row.message?.content ?? '');
    if (!text) continue;
    if (role === 'user') {
      const cleaned = cleanUserText(text);
      if (!cleaned) continue;
      messages.push({ role: 'user', content: cleaned, createdAt: row.timestamp });
    } else {
      messages.push({ role: 'assistant', content: text, createdAt: row.timestamp });
    }
  }

  return { messages: dedupeConsecutive(messages), cwd, sessionId, summary, createdAt, file };
}

/** DeepSeek Harness（dsh）的事件流：session / user/message / assistant/message / session/title */
function parseDshJsonl(lines, file) {
  const messages = [];
  let cwd = null;
  let sessionId = null;
  let title = null;
  let createdAt = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let row;
    try {
      row = JSON.parse(trimmed);
    } catch {
      continue;
    }

    switch (row.type) {
      case 'session':
        sessionId = row.id || sessionId;
        cwd = row.cwd || cwd;
        createdAt = row.createdAt ? new Date(row.createdAt).toISOString() : createdAt;
        break;
      case 'session/title':
        title = row.data?.title || title;
        break;
      case 'user/message': {
        // source.kind 不是 user 的都是运行时上下文注入，不算用户发言
        if (row.data?.source?.kind && row.data.source.kind !== 'user') break;
        const text = textFromContent(row.data?.content);
        const cleaned = cleanUserText(text);
        if (cleaned) {
          messages.push({ role: 'user', content: cleaned, createdAt: row.time ? new Date(row.time).toISOString() : null });
        }
        break;
      }
      case 'assistant/message': {
        const parts = (row.data?.message?.content || [])
          .filter((block) => block?.type === 'text' && block.text)
          .map((block) => block.text);
        const text = parts.join('').trim();
        if (text) {
          messages.push({ role: 'assistant', content: text, createdAt: row.time ? new Date(row.time).toISOString() : null });
        }
        break;
      }
      default:
        break;
    }
  }

  return { messages: dedupeConsecutive(messages), cwd, sessionId, summary: title, createdAt, file };
}

/** Qwen / CodeBuddy / dsh 等：先按 JSONL 试，再按整份 JSON 试。 */
function parseGenericJson(content, file, { allowPlainText = false } = {}) {
  const messages = [];
  let cwd = null;
  let sessionId = null;

  const pushMessage = (role, text, createdAt) => {
    if (role !== 'user' && role !== 'assistant') return;
    const value = typeof text === 'string' ? text : textFromContent(text);
    if (!value) return;
    if (role === 'user') {
      const cleaned = cleanUserText(value);
      if (!cleaned) return;
      messages.push({ role: 'user', content: cleaned, createdAt });
    } else {
      messages.push({ role: 'assistant', content: value, createdAt });
    }
  };

  const handleObject = (node) => {
    if (!node || typeof node !== 'object') return;
    cwd = node.cwd || node.workingDirectory || cwd;
    sessionId = node.sessionId || node.session_id || node.id || sessionId;

    const arrayKeys = ['messages', 'history', 'conversation', 'chat', 'turns', 'items'];
    for (const key of arrayKeys) {
      if (Array.isArray(node[key])) {
        for (const item of node[key]) {
          if (!item || typeof item !== 'object') continue;
          const role = item.role || item.type || item.author;
          const text = item.content ?? item.text ?? item.message ?? item.parts;
          pushMessage(role === 'model' ? 'assistant' : role, text, item.createdAt || item.timestamp);
        }
      }
    }
    if (Array.isArray(node.records)) node.records.forEach(handleObject);
  };

  // JSONL
  const lines = content.split('\n').filter((l) => l.trim());
  let parsedLines = 0;
  for (const line of lines) {
    try {
      const row = JSON.parse(line);
      parsedLines += 1;
      if (row.type === 'response_item' || row.type === 'event_msg' || row.type === 'session_meta') {
        // 走 codex 解析路径
        return parseCodexJsonl(lines, file);
      }
      if (row.type === 'user' || row.type === 'assistant' || row.type === 'summary') {
        return parseClaudeJsonl(lines, file);
      }
      if (row.message && (row.message.role || row.type === 'message')) {
        pushMessage(row.message.role || row.role, row.message.content, row.timestamp);
      } else if (row.role) {
        pushMessage(row.role, row.content ?? row.text, row.timestamp || row.createdAt);
      } else {
        handleObject(row);
      }
    } catch {
      /* 单行不是 JSON 就忽略 */
    }
  }

  if (messages.length === 0 && parsedLines < lines.length) {
    try {
      const doc = JSON.parse(content);
      if (Array.isArray(doc)) doc.forEach(handleObject);
      else {
        handleObject(doc);
        if (Array.isArray(doc?.data)) doc.data.forEach(handleObject);
      }
    } catch {
      /* 不是 JSON，当作纯文本 */
    }
  }

  if (messages.length === 0 && allowPlainText && content.trim()) {
    return {
      messages: [{ role: 'user', content: content.trim().slice(0, 20000) }],
      cwd,
      sessionId,
      file,
      plain: true
    };
  }

  return { messages: dedupeConsecutive(messages), cwd, sessionId, file };
}

const ZSTD_MAGIC = 0xfd2fb528; // 磁盘上的 28 B5 2F FD

/**
 * dsh 的会话文件是「多个 zstd 帧首尾相接」写出来的（一次追加一个帧）。
 * Node 的 zstdDecompressSync 只认第一帧，所以这里先把帧切开，再逐帧解压。
 */
function splitZstdFrames(buf) {
  const frames = [];
  let pos = 0;
  while (pos + 4 <= buf.length) {
    if (buf.readUInt32LE(pos) !== ZSTD_MAGIC) {
      // 跳帧（skippable frame）或填充，往后找下一个帧头
      let next = -1;
      for (let i = pos + 1; i + 4 <= buf.length; i += 1) {
        if (buf.readUInt32LE(i) === ZSTD_MAGIC) {
          next = i;
          break;
        }
      }
      if (next < 0) break;
      pos = next;
      continue;
    }

    let p = pos + 4;
    const descriptor = buf[p];
    p += 1;
    const fcsFlag = descriptor >> 6;
    const singleSegment = (descriptor >> 5) & 1;
    const hasChecksum = (descriptor >> 2) & 1;
    const dictIdFlag = descriptor & 3;
    if (!singleSegment) p += 1; // Window Descriptor
    p += [0, 1, 2, 4][dictIdFlag]; // Dictionary ID
    p += (singleSegment ? [1, 2, 4, 8] : [0, 2, 4, 8])[fcsFlag]; // Frame Content Size

    let ok = true;
    for (;;) {
      if (p + 3 > buf.length) {
        ok = false;
        break;
      }
      const header = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16);
      const last = header & 1;
      const type = (header >> 1) & 3;
      const size = header >> 3;
      p += 3;
      if (type === 0) p += size; // Raw
      else if (type === 1) p += 1; // RLE
      else if (type === 2) p += size; // Compressed
      else {
        ok = false; // 保留类型，说明解析跑偏了
        break;
      }
      if (p > buf.length) {
        ok = false;
        break;
      }
      if (last) break;
    }
    if (hasChecksum) p += 4;
    if (!ok || p > buf.length) break;

    frames.push(buf.subarray(pos, p));
    pos = p;
  }
  return frames;
}

function decodeZstd(buf) {
  const frames = splitZstdFrames(buf);
  if (frames.length <= 1) return zlib.zstdDecompressSync(buf);

  const parts = [];
  for (const frame of frames) {
    try {
      parts.push(zlib.zstdDecompressSync(frame));
    } catch {
      /* 个别帧坏了就跳过，不要把整份历史丢掉 */
    }
  }
  return Buffer.concat(parts);
}

/** 读取文件内容；dsh 之类的会话是 zstd 压缩的，这里一并解压。 */
function readHistoryText(file) {
  const buffer = fs.readFileSync(file);
  if (!/\.zstd$/i.test(file)) return buffer.toString('utf8');
  if (typeof zlib.zstdDecompressSync !== 'function') {
    const err = new Error('当前 Node 版本不支持 zstd（需要 Node 22.15+）');
    err.friendly = true;
    throw err;
  }
  try {
    return decodeZstd(buffer).toString('utf8');
  } catch (err) {
    throw new Error(`zstd 解压失败：${err.message}`);
  }
}

function dedupeConsecutive(messages) {
  const out = [];
  for (const m of messages) {
    const prev = out[out.length - 1];
    if (prev && prev.role === m.role && prev.content === m.content) continue;
    out.push(m);
  }
  return out;
}

function parseFile(kind, file) {
  const content = readHistoryText(file);
  const plainOk = /\.(md|txt)$/i.test(file);
  switch (kind) {
    case 'codex':
      return parseCodexJsonl(content.split('\n'), file);
    case 'claude':
      return parseClaudeJsonl(content.split('\n'), file);
    case 'dsh':
      return parseDshJsonl(content.split('\n'), file);
    default:
      return parseGenericJson(content, file, { allowPlainText: plainOk });
  }
}

function relativeRef(source, file) {
  const root = resolveSourcePath(source.path);
  const rel = path.relative(root, file).split(path.sep).join('/');
  return `${source.id}:${rel}`;
}

/** Codex 桌面版会在 session_index.jsonl 里存自己起的会话名，用它做标题更贴近原样。 */
const titleIndexCache = new Map();

function loadTitleIndex(spec) {
  if (!spec?.path) return null;
  const file = resolveSourcePath(spec.path);
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }
  const cached = titleIndexCache.get(file);
  if (cached && cached.mtime === stat.mtimeMs) return cached.map;

  const map = new Map();
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        const id = row[spec.idField || 'id'];
        const name = row[spec.nameField || 'thread_name'];
        if (id && name) map.set(id, String(name));
      } catch {
        /* 单行坏了就算了 */
      }
    }
  } catch {
    return null;
  }
  titleIndexCache.set(file, { mtime: stat.mtimeMs, map });
  return map;
}

function titleFor(parsed, source, file) {
  if (parsed.sessionId && source.titleIndex) {
    const named = loadTitleIndex(source.titleIndex)?.get(parsed.sessionId);
    if (named) return named.length > 60 ? `${named.slice(0, 60)}…` : named;
  }
  if (parsed.summary) return String(parsed.summary).slice(0, 60);
  const firstUser = parsed.messages.find((m) => m.role === 'user');
  if (firstUser) {
    const clean = firstUser.content.replace(/\s+/g, ' ').trim();
    return clean.length > 40 ? `${clean.slice(0, 40)}…` : clean;
  }
  return `${source.label} · ${path.basename(file, path.extname(file)).slice(0, 24)}`;
}

/* ---------- 对外接口 ---------- */

export function scanSource(sourceId) {
  const source = listHistorySources().find((s) => s.id === sourceId);
  if (!source) return { error: `未知来源：${sourceId}` };
  const root = resolveSourcePath(source.path);
  if (!fs.existsSync(root)) {
    return { source: describeSource(source, root), items: [], error: `目录不存在：${root}` };
  }

  const files = walk(root)
    .map((file) => ({ file, stat: statOf(file) }))
    .filter((row) => row.stat && row.stat.size > 0 && row.stat.size < MAX_FILE_BYTES)
    .sort((a, b) => b.stat.mtime - a.stat.mtime)
    .slice(0, MAX_ITEMS_PER_SOURCE);

  const items = [];
  for (const { file, stat } of files) {
    const ref = relativeRef(source, file);
    let parsed = { messages: [] };
    try {
      parsed = parseFile(source.kind, file);
    } catch {
      continue;
    }
    if (!parsed.messages?.length) continue;
    const ignored = isIgnoredImport(ref) || isIgnoredSession(parsed.sessionId);
    items.push({
      ref,
      title: titleFor(parsed, source, file),
      cwd: parsed.cwd || null,
      messageCount: parsed.messages.length,
      updatedAt: new Date(stat.mtime).toISOString(),
      size: stat.size,
      imported: Boolean(importedConversationId(ref)),
      ignored,
      file
    });
  }

  return { source: describeSource(source, root), items };
}

function describeSource(source, root) {
  return {
    id: source.id,
    label: source.label,
    kind: source.kind,
    path: root,
    exists: fs.existsSync(root),
    autoSync: Boolean(source.autoSync)
  };
}

export function scanAllSources() {
  return listHistorySources().map((source) => scanSource(source.id));
}

export function importRefs(sourceId, refs, { respectTombstone = true } = {}) {
  const source = listHistorySources().find((s) => s.id === sourceId);
  if (!source) throw new Error(`未知来源：${sourceId}`);
  const root = resolveSourcePath(source.path);
  const results = [];

  for (const ref of refs) {
    const rel = String(ref).slice(sourceId.length + 1);
    const file = path.join(root, ...rel.split('/'));
    if (!fs.existsSync(file)) {
      results.push({ ref, ok: false, error: '文件不存在' });
      continue;
    }
    try {
      const parsed = parseFile(source.kind, file);
      if (!parsed.messages?.length) {
        results.push({ ref, ok: false, skipped: true, error: '没有解析出对话内容' });
        continue;
      }
      // 用户删掉过的会话不再自动回来（sessions / archived 改名搬家也认得）
      if (respectTombstone && (isIgnoredImport(ref) || isIgnoredSession(parsed.sessionId))) {
        results.push({ ref, ok: false, skipped: true, reason: 'ignored' });
        continue;
      }
      // 用户明确要求导入，就取消之前的「已删除」墓碑
      clearIgnoredImport(ref);
      const stat = statOf(file);
      const existing = importedConversationId(ref);
      const payload = {
        title: titleFor(parsed, source, file),
        engineId: source.kind === 'codex' ? 'codex' : source.kind === 'claude' ? 'claude' : source.kind === 'qwen' ? 'qwen' : source.kind === 'codebuddy' ? 'workbuddy' : 'deepseek-harness',
        cwd: parsed.cwd || null,
        source: 'import',
        sourceLabel: source.label,
        sourceRef: ref,
        sourceSessionId: parsed.sessionId || null,
        createdAt: parsed.createdAt || new Date(stat.mtime).toISOString(),
        messages: parsed.messages.map((m) => ({
          id: newId(),
          role: m.role,
          content: m.content,
          createdAt: m.createdAt || null,
          engineId: null,
          meta: { imported: true }
        }))
      };

      if (existing && getConversation(existing)) {
        const conv = getConversation(existing);
        // 重新导入时保留原有的消息元数据（译文、备注等），否则源文件一更新就全没了
        const metaByKey = new Map();
        for (const message of conv.messages || []) {
          if (!message.meta || Object.keys(message.meta).length === 0) continue;
          metaByKey.set(`${message.role}\u0000${String(message.content).slice(0, 300)}`, message.meta);
        }
        conv.messages = payload.messages.map((message) => {
          const kept = metaByKey.get(`${message.role}\u0000${String(message.content).slice(0, 300)}`);
          return kept ? { ...message, meta: { ...kept, ...(message.meta || {}) } } : message;
        });
        conv.title = payload.title;
        conv.cwd = payload.cwd || conv.cwd;
        saveConversation(conv);
        results.push({ ref, ok: true, conversationId: existing, updated: true });
      } else {
        const conv = createConversation(payload);
        markImported(ref, conv.id);
        results.push({ ref, ok: true, conversationId: conv.id });
      }
    } catch (err) {
      results.push({ ref, ok: false, error: err.message });
    }
  }

  return results;
}

/** 导入一个外部文件（JSON / Markdown / 纯文本），路径可以是任意位置。 */
export function importFile(filePath) {
  const file = path.resolve(filePath);
  if (!fs.existsSync(file)) throw new Error(`文件不存在：${file}`);
  const ext = path.extname(file).toLowerCase();
  const parsed =
    ext === '.jsonl' || ext === '.ndjson' || ext === '.json' || ext === '.zstd'
      ? parseGenericJson(readHistoryText(file), file)
      : parseGenericJson(fs.readFileSync(file, 'utf8'), file, { allowPlainText: true });

  const conv = createConversation({
    title: titleFor(parsed, { label: '导入文件' }, file),
    cwd: parsed.cwd || null,
    source: 'import-file',
    sourceLabel: path.basename(file),
    sourceRef: `file:${file}`,
    messages: parsed.messages.map((m) => ({
      id: newId(),
      role: m.role,
      content: m.content,
      createdAt: m.createdAt || null,
      meta: { imported: true }
    }))
  });
  return conv;
}

/** 增量同步：只处理新增或被修改过的文件。 */
export function syncOnce(onEvent = () => {}) {
  const settings = loadSettings();
  const enabled = settings.autoSync?.sources || [];
  const state = loadSyncState();
  const report = { checkedAt: new Date().toISOString(), imported: 0, updated: 0, skipped: 0, sources: [] };

  for (const source of listHistorySources()) {
    if (!enabled.includes(source.id)) continue;
    const root = resolveSourcePath(source.path);
    if (!fs.existsSync(root)) {
      report.sources.push({ id: source.id, label: source.label, error: '目录不存在' });
      continue;
    }

    const files = walk(root)
      .map((file) => ({ file, stat: statOf(file) }))
      .filter((row) => row.stat && row.stat.size > 0 && row.stat.size < MAX_FILE_BYTES)
      .sort((a, b) => b.stat.mtime - a.stat.mtime)
      .slice(0, MAX_ITEMS_PER_SOURCE);

    let sourceImported = 0;
    let sourceUpdated = 0;
    for (const { file, stat } of files) {
      const ref = relativeRef(source, file);
      const prev = state[ref];
      if (prev && prev.mtime === stat.mtime && prev.size === stat.size) {
        report.skipped += 1;
        continue;
      }
      // 正在写入的文件先跳过，下一轮再处理
      if (Date.now() - stat.mtime < 3000) {
        report.skipped += 1;
        continue;
      }
      const results = importRefs(source.id, [ref]);
      const hit = results[0];
      if (!hit?.ok) {
        report.skipped += 1;
        continue;
      }
      state[ref] = { mtime: stat.mtime, size: stat.size, conversationId: hit.conversationId };
      if (hit.updated) sourceUpdated += 1;
      else sourceImported += 1;
    }

    report.imported += sourceImported;
    report.updated += sourceUpdated;
    report.sources.push({ id: source.id, label: source.label, imported: sourceImported, updated: sourceUpdated });
    if (sourceImported || sourceUpdated) {
      onEvent({ type: 'sync', source: source.id, imported: sourceImported, updated: sourceUpdated });
    }
  }

  state.__meta = {
    lastSyncAt: report.checkedAt,
    imported: report.imported,
    updated: report.updated
  };
  for (const removed of pruneImportIndex((id) => Boolean(getConversation(id)))) {
    report.skipped += 1;
    void removed;
  }
  saveSyncState(state);

  if (report.imported || report.updated) {
    onEvent({ type: 'conversations-changed', reason: 'sync', imported: report.imported, updated: report.updated });
  }
  return report;
}

let syncTimer = null;

export function startSyncLoop(onEvent) {
  stopSyncLoop();
  const settings = loadSettings();
  if (!settings.autoSync?.enabled) return { running: false };
  const interval = Math.max(5, Number(settings.autoSync.intervalSeconds) || 20) * 1000;
  const tick = () => {
    try {
      syncOnce(onEvent);
    } catch (err) {
      onEvent({ type: 'sync-error', message: err.message });
    }
  };
  tick();
  syncTimer = setInterval(tick, interval);
  if (syncTimer.unref) syncTimer.unref();
  return { running: true, intervalSeconds: interval / 1000 };
}

export function stopSyncLoop() {
  if (syncTimer) clearInterval(syncTimer);
  syncTimer = null;
}

/** 用户删掉一个导入来的会话时，把同步进度里的这条也忘掉。 */
export function forgetSyncRef(ref) {
  if (!ref) return;
  const state = loadSyncState();
  if (ref in state) {
    delete state[ref];
    saveSyncState(state);
  }
}

/** 看一条 ref 对应的源文件还在不在、它的 sessionId 是什么（老数据可能没存过 sessionId） */
export function describeRef(ref) {
  const source = listHistorySources().find((s) => ref?.startsWith(`${s.id}:`));
  if (!source) return null;
  const root = resolveSourcePath(source.path);
  const file = path.join(root, ...String(ref).slice(source.id.length + 1).split('/'));
  if (!fs.existsSync(file)) return { source, file, exists: false, sessionId: null };
  try {
    const parsed = parseFile(source.kind, file);
    return { source, file, exists: true, sessionId: parsed.sessionId || null };
  } catch {
    return { source, file, exists: true, sessionId: null };
  }
}

/** 从任意一个会话文件里读出它的 sessionId（补老数据、或者从回收站里认人时用） */
export function sessionIdOfFile(kind, file) {
  try {
    const parsed = parseFile(kind, file);
    return parsed?.sessionId || null;
  } catch {
    return null;
  }
}

/**
 * 把源软件里的这个会话「拿掉」——不是硬删除，而是移到工作台的回收站，
 * 这样 Codex / Claude Code / dsh 那边也看不到了，反悔还能一键撤回。
 */
export function removeSourceFile(ref, { activeWriteSeconds = 120 } = {}) {
  const source = listHistorySources().find((s) => ref?.startsWith(`${s.id}:`));
  if (!source) return { ok: false, reason: 'no-source' };

  const root = resolveSourcePath(source.path);
  const file = path.join(root, ...String(ref).slice(source.id.length + 1).split('/'));
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return { ok: false, reason: 'missing' };
  }

  // 还在被 CLI 写着的会话（比如你正在用的那个）不动它的源文件，避免弄坏正在进行的会话
  if (Date.now() - stat.mtime < activeWriteSeconds * 1000) {
    return { ok: false, reason: 'active', mtime: stat.mtime };
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = path.join(TRASH_DIR, stamp, ...String(ref).slice(source.id.length + 1).split('/'));
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    try {
      fs.renameSync(file, target);
    } catch {
      fs.copyFileSync(file, target);
      fs.rmSync(file, { force: true });
    }
    return { ok: true, from: file, to: target, sourceId: source.id };
  } catch (err) {
    return { ok: false, reason: 'error', message: err.message };
  }
}

/** 撤回：把回收站里的文件放回原处，并清掉墓碑 */
export function restoreFromTrash(trashPath, ref) {
  const source = listHistorySources().find((s) => ref?.startsWith(`${s.id}:`));
  if (!source) return { ok: false, reason: 'no-source' };
  const root = resolveSourcePath(source.path);
  const target = path.join(root, ...String(ref).slice(source.id.length + 1).split('/'));
  try {
    if (!fs.existsSync(trashPath)) return { ok: false, reason: 'missing' };
    if (fs.existsSync(target)) return { ok: false, reason: 'already-there' };
    fs.mkdirSync(path.dirname(target), { recursive: true });
    try {
      fs.renameSync(trashPath, target);
    } catch {
      fs.copyFileSync(trashPath, target);
      fs.rmSync(trashPath, { force: true });
    }
    clearIgnoredImport(ref);
    return { ok: true, restored: target };
  } catch (err) {
    return { ok: false, reason: 'error', message: err.message };
  }
}

export function syncStatus() {
  const settings = loadSettings();
  const meta = loadSyncState().__meta || null;
  return {
    enabled: Boolean(settings.autoSync?.enabled),
    running: Boolean(syncTimer),
    intervalSeconds: settings.autoSync?.intervalSeconds || 20,
    sources: settings.autoSync?.sources || [],
    conversationCount: listConversations().length,
    lastSyncAt: meta?.lastSyncAt || null,
    lastImported: meta?.imported ?? null,
    lastUpdated: meta?.updated ?? null
  };
}
