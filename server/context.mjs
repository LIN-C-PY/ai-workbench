import { loadMemory, loadSettings } from './config.mjs';

const SYSTEM_PROMPT = [
  '你是运行在「AI Workbench」里的助手。工作台把多个模型与本地 CLI 智能体统一在同一个界面。',
  '回答直接、可执行，不要复述这些规则。',
  '如果用户要求操作系统或读写文件，优先使用你能调用的工具。'
].join('\n');

function memoryBlock(memory, engine) {
  const notes = (memory.notes || []).filter((n) => n?.text);
  if (!memory.global && notes.length === 0) return '';
  const lines = ['【长期记忆】'];
  if (memory.global) lines.push(memory.global.trim());
  for (const note of notes.slice(-20)) {
    lines.push(`- (${note.tag || '通用'}) ${String(note.text).trim()}`);
  }
  return lines.join('\n');
}

function historyBlock(conv, rounds) {
  const msgs = (conv.messages || []).filter((m) => m.role === 'user' || m.role === 'assistant');
  if (msgs.length === 0) return '';
  const take = msgs.slice(-Math.max(2, rounds * 2));
  const lines = ['【之前的对话】'];
  for (const m of take) {
    const who = m.role === 'user' ? '用户' : '助手';
    const text = String(m.content || '').trim();
    if (!text) continue;
    lines.push(`${who}：${text.length > 4000 ? `${text.slice(0, 4000)}…` : text}`);
  }
  return lines.join('\n\n');
}

/**
 * 给 CLI 引擎准备提示词。
 * 如果这次走原生 resume（CLI 自己记得上下文），就只发增量内容 + 记忆。
 */
export function buildCliPrompt(conv, { prompt, useResume, engine, settings = loadSettings() }) {
  const memory = loadMemory();
  const parts = [];
  const mem = memoryBlock(memory, engine);
  if (mem) parts.push(mem);

  if (!useResume) {
    const history = historyBlock(conv, settings.memoryRounds || 12);
    if (history) parts.push(history);
    parts.push(`【当前工作目录】${conv.cwd || settings.cwd || '(未设置)'}`);
  }

  parts.push(prompt);
  if (parts.length === 1) return prompt;
  return parts.filter(Boolean).join('\n\n---\n\n');
}

/** 给 OpenAI 兼容接口准备 messages 数组。 */
export function buildOpenAIMessages(conv, { prompt, settings = loadSettings() }) {
  const memory = loadMemory();
  const messages = [{ role: 'system', content: SYSTEM_PROMPT }];

  const mem = memoryBlock(memory, null);
  if (mem) messages.push({ role: 'system', content: mem });
  if (conv.cwd) messages.push({ role: 'system', content: `当前工作目录：${conv.cwd}` });

  const history = (conv.messages || []).filter(
    (m) => (m.role === 'user' || m.role === 'assistant') && String(m.content || '').trim() && !m.error
  );
  const rounds = settings.memoryRounds || 12;
  for (const m of history.slice(-rounds * 2)) {
    messages.push({ role: m.role, content: String(m.content) });
  }
  messages.push({ role: 'user', content: prompt });
  return messages;
}
