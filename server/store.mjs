import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CONV_DIR, IMPORT_DIR, ensureDirs, readJson, writeJson } from './config.mjs';

const summaryCache = new Map(); // id -> { mtime, summary }
const importIndexFile = path.join(IMPORT_DIR, 'index.json');
const ignoredFile = path.join(IMPORT_DIR, 'ignored.json');
let importIndex = null;
let ignoredIndex = null;

export function newId() {
  return crypto.randomUUID();
}

function conversationFile(id) {
  return path.join(CONV_DIR, `${id}.json`);
}

function summarise(conv) {
  const last = [...(conv.messages || [])].reverse().find((m) => m.role === 'user' || m.role === 'assistant');
  return {
    id: conv.id,
    title: conv.title,
    engineId: conv.engineId,
    model: conv.model || null,
    cwd: conv.cwd || null,
    pinned: Boolean(conv.pinned),
    source: conv.source || 'local',
    sourceLabel: conv.sourceLabel || null,
    sourceRef: conv.sourceRef || null,
    sourceSessionId: conv.sourceSessionId || null,
    createdAt: conv.createdAt,
    updatedAt: conv.updatedAt,
    messageCount: (conv.messages || []).length,
    preview: last ? String(last.content || '').replace(/\s+/g, ' ').slice(0, 120) : ''
  };
}

export function listConversations() {
  ensureDirs();
  const files = fs.readdirSync(CONV_DIR).filter((f) => f.endsWith('.json'));
  const alive = new Set();
  const out = [];

  for (const file of files) {
    const full = path.join(CONV_DIR, file);
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    const id = file.replace(/\.json$/, '');
    alive.add(id);
    const cached = summaryCache.get(id);
    if (cached && cached.mtime === stat.mtimeMs) {
      out.push(cached.summary);
      continue;
    }
    const conv = readJson(full, null);
    if (!conv) continue;
    const summary = summarise(conv);
    summaryCache.set(id, { mtime: stat.mtimeMs, summary });
    out.push(summary);
  }

  for (const id of [...summaryCache.keys()]) {
    if (!alive.has(id)) summaryCache.delete(id);
  }

  out.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
  });
  return out;
}

export function getConversation(id) {
  if (!id || id.includes('/') || id.includes('\\')) return null;
  return readJson(conversationFile(id), null);
}

export function saveConversation(conv) {
  conv.updatedAt = new Date().toISOString();
  writeJson(conversationFile(conv.id), conv);
  summaryCache.delete(conv.id);
  return conv;
}

export function createConversation(input = {}) {
  const now = new Date().toISOString();
  const conv = {
    id: input.id || newId(),
    title: input.title || '新对话',
    engineId: input.engineId || null,
    model: input.model || null,
    cwd: input.cwd || null,
    pinned: Boolean(input.pinned),
    source: input.source || 'local',
    sourceLabel: input.sourceLabel || null,
    sourceRef: input.sourceRef || null,
    sourceSessionId: input.sourceSessionId || null,
    createdAt: input.createdAt || now,
    updatedAt: input.updatedAt || now,
    messages: input.messages || []
  };
  return saveConversation(conv);
}

export function updateConversation(id, patch = {}) {
  const conv = getConversation(id);
  if (!conv) return null;
  for (const key of ['title', 'engineId', 'model', 'cwd', 'pinned', 'source', 'sourceLabel', 'sourceRef', 'sourceSessionId']) {
    if (patch[key] !== undefined) conv[key] = patch[key];
  }
  if (patch.title === undefined && patch.autoTitle) {
    conv.title = deriveTitle(conv);
  }
  return saveConversation(conv);
}

export function deleteConversation(id) {
  const file = conversationFile(id);
  if (!fs.existsSync(file)) return false;
  fs.rmSync(file, { force: true });
  summaryCache.delete(id);
  return true;
}

export function appendMessage(id, message) {
  const conv = getConversation(id);
  if (!conv) return null;
  const msg = {
    id: message.id || newId(),
    role: message.role || 'user',
    content: String(message.content ?? ''),
    createdAt: message.createdAt || new Date().toISOString(),
    engineId: message.engineId ?? conv.engineId ?? null,
    model: message.model ?? conv.model ?? null,
    runId: message.runId || null,
    meta: message.meta || {},
    error: message.error || null
  };
  conv.messages = conv.messages || [];
  conv.messages.push(msg);
  if (!conv.title || conv.title === '新对话') conv.title = deriveTitle(conv);
  saveConversation(conv);
  return msg;
}

export function replaceMessage(conversationId, messageId, patch) {
  const conv = getConversation(conversationId);
  if (!conv) return null;
  const idx = (conv.messages || []).findIndex((m) => m.id === messageId);
  if (idx < 0) return null;
  conv.messages[idx] = { ...conv.messages[idx], ...patch };
  saveConversation(conv);
  return conv.messages[idx];
}

export function deriveTitle(conv) {
  const firstUser = (conv.messages || []).find((m) => m.role === 'user' && String(m.content || '').trim());
  if (!firstUser) return conv.title && conv.title !== '新对话' ? conv.title : '新对话';
  const clean = String(firstUser.content).replace(/\s+/g, ' ').trim();
  return clean.length > 28 ? `${clean.slice(0, 28)}…` : clean;
}

/* ---------- 导入去重索引 ---------- */

function loadImportIndex() {
  if (!importIndex) importIndex = readJson(importIndexFile, {}) || {};
  return importIndex;
}

export function importedConversationId(sourceRef) {
  return loadImportIndex()[sourceRef] || null;
}

export function markImported(sourceRef, conversationId) {
  const index = loadImportIndex();
  index[sourceRef] = conversationId;
  writeJson(importIndexFile, index);
}

export function clearImportedMarks(ids) {
  const index = loadImportIndex();
  for (const id of ids) delete index[id];
  writeJson(importIndexFile, index);
}

/* ---------- 删除过的导入会话（墓碑，避免同步又把它拉回来） ---------- */

function loadIgnored() {
  if (!ignoredIndex) ignoredIndex = readJson(ignoredFile, {}) || {};
  return ignoredIndex;
}

export function isIgnoredImport(ref) {
  return Boolean(ref && loadIgnored()[ref]);
}

export function getIgnored(ref) {
  return ref ? loadIgnored()[ref] || null : null;
}

/** 同一个会话可能在 sessions / archived_sessions 之间搬过家，所以也按 sessionId 记住 */
export function isIgnoredSession(sessionId) {
  if (!sessionId) return false;
  return Object.values(loadIgnored()).some((entry) => entry?.sessionId === sessionId);
}

export function markIgnoredImport(ref, extra = {}) {
  if (!ref) return;
  const index = loadIgnored();
  index[ref] = { at: new Date().toISOString(), ...extra };
  writeJson(ignoredFile, index);
}

export function clearIgnoredImport(ref) {
  if (!ref) return;
  const index = loadIgnored();
  if (!(ref in index)) return;
  delete index[ref];
  writeJson(ignoredFile, index);
}

export function listIgnoredImports() {
  return Object.keys(loadIgnored());
}

/** 会话文件已经不在了，把对应的导入记录清掉 */
export function pruneImportIndex(exists) {
  const index = loadImportIndex();
  const removed = [];
  for (const [ref, id] of Object.entries(index)) {
    if (!exists(id)) {
      delete index[ref];
      removed.push(ref);
    }
  }
  if (removed.length) writeJson(importIndexFile, index);
  return removed;
}

export function searchConversations(query, items) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return items;
  return items.filter((item) => {
    if (String(item.title || '').toLowerCase().includes(q)) return true;
    if (String(item.preview || '').toLowerCase().includes(q)) return true;
    return false;
  });
}
