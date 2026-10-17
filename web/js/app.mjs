import { api, streamChat, streamPost, streamTranslate, subscribeEvents } from './api.mjs';
import { enhanceCodeBlocks, renderMarkdown } from './markdown.mjs';

/* ==================== 基础工具 ==================== */

const $ = (sel, root = document) => root.querySelector(sel);

function h(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function toast(message, kind = '') {
  const node = h('div', { class: `toast ${kind}`, text: message });
  $('#toasts').append(node);
  setTimeout(() => {
    node.style.opacity = '0';
    node.style.transition = 'opacity .2s';
    setTimeout(() => node.remove(), 220);
  }, kind === 'error' ? 6000 : 3000);
}

/** 带一个操作按钮的提示（用于「撤回删除」这种不给弹窗又要可撤销的场景） */
function toastAction(message, actionLabel, onAction, timeout = 9000) {
  const node = h('div', { class: 'toast action' }, [
    h('span', { text: message }),
    h('button', {
      onclick: async () => {
        node.remove();
        try {
          await onAction();
        } catch (err) {
          toast(err.message, 'error');
        }
      }
    }, actionLabel)
  ]);
  $('#toasts').append(node);
  setTimeout(() => {
    if (!node.isConnected) return;
    node.style.opacity = '0';
    node.style.transition = 'opacity .2s';
    setTimeout(() => node.remove(), 220);
  }, timeout);
}

function relTime(iso) {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diff = Date.now() - then;
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
  if (diff < 7 * 86400000) return `${Math.floor(diff / 86400000)} 天前`;
  return new Date(then).toLocaleDateString('zh-CN');
}

function clockTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

function groupLabel(iso) {
  const then = new Date(iso || Date.now());
  const today = new Date();
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const t = then.getTime();
  if (t >= startOfToday) return '今天';
  if (t >= startOfToday - 86400000) return '昨天';
  if (t >= startOfToday - 7 * 86400000) return '最近 7 天';
  if (t >= startOfToday - 30 * 86400000) return '最近 30 天';
  return '更早';
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制');
  } catch {
    toast('复制失败', 'error');
  }
}

/* ==================== 状态 ==================== */

const state = {
  engines: [],
  conversations: [],
  current: null,
  settings: {},
  hasKeys: {},
  memory: { global: '', notes: [] },
  sync: { enabled: false },
  targetLangs: ['简体中文', '繁體中文', 'English'],
  search: '',
  running: false,
  controller: null,
  live: null,
  translating: false,
  translateController: null
};

/* ==================== 外观（主题 / 主题色 / 字体 / 字号） ==================== */

const APPEARANCE_DEFAULTS = { mode: 'dark', accent: '#7c9cff', font: 'system', fontSize: 1, customFonts: [] };

const FONT_STACKS = {
  system: '"Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, "Microsoft YaHei UI", sans-serif',
  yahei: '"Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", "Noto Sans SC", system-ui, sans-serif',
  songti: '"Source Han Serif SC", "Noto Serif SC", "Songti SC", SimSun, Georgia, serif',
  mono: 'ui-monospace, "Cascadia Code", Consolas, "JetBrains Mono", monospace'
};

const ACCENT_PRESETS = ['#7c9cff', '#4fb8a8', '#a78bfa', '#f472b6', '#fb923c', '#facc15', '#4ade80', '#38bdf8', '#f87171'];
const FONT_SIZE_STEPS = [
  { label: '小', value: 0.92 },
  { label: '中', value: 1 },
  { label: '大', value: 1.08 },
  { label: '特大', value: 1.16 }
];

function hexToRgb(hex) {
  const clean = String(hex || '').replace('#', '').trim();
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean;
  const num = Number.parseInt(full.slice(0, 6), 16);
  if (Number.isNaN(num)) return [124, 156, 255];
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}

const rgbaOf = (hex, alpha) => {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
};

/** 主题色上的文字用黑还是白 */
function inkOn(hex) {
  const [r, g, b] = hexToRgb(hex);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.62 ? '#0a0a0c' : '#ffffff';
}

/** 浅底上的主题色文字：深色主题提亮，浅色主题压暗 */
function accentText(hex, mode) {
  const [r, g, b] = hexToRgb(hex);
  const mix = (channel, target) => Math.round(channel + (target - channel) * 0.45);
  return mode === 'light'
    ? `rgb(${Math.round(r * 0.58)}, ${Math.round(g * 0.58)}, ${Math.round(b * 0.7)})`
    : `rgb(${mix(r, 255)}, ${mix(g, 255)}, ${mix(b, 255)})`;
}

function resolveThemeMode(mode) {
  if (mode !== 'system') return mode === 'light' ? 'light' : 'dark';
  return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

/** 导入的字体用 @font-face 注册进来，家族名固定成 AIWB-<id> */
function registerCustomFonts(customFonts) {
  let style = document.getElementById('custom-fonts');
  if (!style) {
    style = document.createElement('style');
    style.id = 'custom-fonts';
    document.head.append(style);
  }
  style.textContent = (customFonts || [])
    .filter((font) => font?.id && font?.file)
    .map(
      (font) =>
        `@font-face{font-family:"AIWB-${font.id}";src:url("/api/fonts/${encodeURIComponent(font.file)}");font-display:swap;}`
    )
    .join('\n');
}

/** 字体 id → CSS font-family */
function fontFamilyFor(fontId, customFonts) {
  const id = String(fontId || '');
  if (id.startsWith('custom:')) {
    const key = id.slice('custom:'.length);
    if ((customFonts || []).some((font) => font.id === key)) return `"AIWB-${key}", ${FONT_STACKS.system}`;
  }
  return FONT_STACKS[id] || FONT_STACKS.system;
}

/** 把外观设置写进 CSS 变量，立即生效 */
function applyAppearance(raw, { persistCache = true } = {}) {
  const appearance = { ...APPEARANCE_DEFAULTS, ...(raw || {}) };
  state.appearance = appearance;
  const mode = resolveThemeMode(appearance.mode);
  const root = document.documentElement;

  root.dataset.theme = mode;
  root.style.setProperty('--accent', appearance.accent);
  root.style.setProperty('--accent-soft', rgbaOf(appearance.accent, 0.14));
  root.style.setProperty('--accent-soft-faint', rgbaOf(appearance.accent, 0.06));
  root.style.setProperty('--accent-border', rgbaOf(appearance.accent, 0.3));
  root.style.setProperty('--accent-border-strong', rgbaOf(appearance.accent, 0.5));
  root.style.setProperty('--accent-text', accentText(appearance.accent, mode));
  root.style.setProperty('--accent-ink', inkOn(appearance.accent));
  root.style.setProperty('--fs-unit', `${appearance.fontSize}px`);
  registerCustomFonts(appearance.customFonts);
  root.style.setProperty('--sans', fontFamilyFor(appearance.font, appearance.customFonts));

  if (persistCache) {
    try {
      localStorage.setItem('aiwb-appearance', JSON.stringify(appearance));
    } catch {
      /* 隐私模式下写不了，忽略 */
    }
  }
  return appearance;
}

// 首屏先用本地缓存渲染，避免浅色主题闪一下黑
try {
  const cached = JSON.parse(localStorage.getItem('aiwb-appearance') || 'null');
  if (cached) applyAppearance(cached, { persistCache: false });
} catch {
  /* ignore */
}

// 跟随系统时，系统切换深浅色要立刻跟上
window.matchMedia?.('(prefers-color-scheme: light)').addEventListener?.('change', () => {
  if (state.appearance?.mode === 'system') applyAppearance(state.appearance);
});

const engineById = (id) => state.engines.find((e) => e.id === id) || null;
const chatEngines = () => state.engines.filter((e) => e.kind !== 'app');
const appEngines = () => state.engines.filter((e) => e.kind === 'app');

/* ==================== 弹窗 ==================== */

function openModal({ title, body, footer, wide = false, onClose }) {
  const root = $('#modal-root');
  root.style.pointerEvents = 'auto';
  const content = h('div', { class: `modal${wide ? ' wide' : ''}` });
  const close = () => {
    mask.remove();
    if (!root.children.length) root.style.pointerEvents = 'none';
    if (onClose) onClose();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (event) => {
    if (event.key === 'Escape') close();
  };
  const head = h('div', { class: 'modal-head' }, [
    h('h3', { text: title }),
    h('button', { class: 'icon-btn', title: '关闭', onclick: close }, '✕')
  ]);
  const bodyNode = h('div', { class: 'modal-body' }, body);
  const children = [head, bodyNode];
  if (footer) children.push(h('div', { class: 'modal-foot' }, footer));
  content.append(...children);
  const mask = h('div', { class: 'modal-mask', onclick: (e) => e.target === mask && close() }, [content]);
  root.append(mask);
  document.addEventListener('keydown', onKey);
  return { close, content, body: bodyNode };
}

/* ==================== 侧栏 ==================== */

function renderConversations() {
  const list = $('#conv-list');
  list.innerHTML = '';
  const items = state.conversations;
  if (!items.length) {
    list.append(h('div', { class: 'empty-hint', text: state.search ? '没有匹配的对话' : '还没有对话，点「新建对话」开始' }));
    return;
  }
  let bucket = null;
  for (const conv of items) {
    const label = groupLabel(conv.updatedAt);
    if (label !== bucket) {
      bucket = label;
      list.append(h('div', { class: 'conv-group', text: label }));
    }
    const engine = engineById(conv.engineId);
    const busy = runs.has(conv.id);
    const node = h('div', {
      class: `conv-item${state.current?.id === conv.id ? ' active' : ''}`,
      role: 'button',
      tabindex: '0',
      title: conv.title || '',
      onclick: () => selectConversation(conv.id),
      onkeydown: (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          selectConversation(conv.id);
        }
      },
      oncontextmenu: (event) => {
        event.preventDefault();
        openConversationMenu(conv);
      }
    }, [
      h('div', { class: 'conv-title', text: conv.title || '未命名' }),
      h('div', { class: 'conv-meta' }, [
        h('span', { class: 'badge-dot', style: `background:${engine?.accent || '#555'}` }),
        h('span', { class: 'meta-engine', title: engine?.label || conv.engineId || '', text: engine?.label || conv.engineId || '—' }),
        h('span', { text: '·' }),
        busy ? h('span', { class: 'conv-busy', text: '生成中…' }) : h('span', { text: `${conv.messageCount} 条` }),
        busy ? null : h('span', { text: '·' }),
        busy ? null : h('span', { text: relTime(conv.updatedAt) }),
        conv.source !== 'local' ? h('span', { title: `来自 ${conv.sourceLabel || '导入'}`, text: '· ⇪' }) : null
      ]),
      conv.pinned ? h('span', { class: 'conv-pin', text: '★' }) : null,
      h('button', {
        class: 'conv-del',
        title: '删除这个对话',
        'aria-label': '删除这个对话',
        onclick: async (event) => {
          event.stopPropagation();
          await deleteConversationFlow(conv);
        }
      }, '✕')
    ]);
    list.append(node);
  }
}

async function deleteConversationFlow(conv) {
  try {
    // 直接删，不弹确认框
    const result = await api.deleteConversation(conv.id);
    if (state.current?.id === conv.id) {
      state.current = null;
      history.replaceState(null, '', location.pathname);
    }
    await refreshConversations();
    renderThread();

    const removed = result?.removedSource;
    if (removed?.ok) {
      toastAction(
        `已删除「${conv.title || '未命名'}」，源软件里的记录也一起移除了`,
        '撤回',
        async () => {
          const back = await api.trashUndo(removed.to, result.sourceRef);
          await refreshConversations();
          if (back?.imported?.[0]?.conversationId) await selectConversation(back.imported[0].conversationId);
          toast('已恢复到原位', 'ok');
        }
      );
    } else if (removed?.reason === 'active') {
      toast('已删除。这个会话还在被 CLI 写入，源文件先留着，避免弄坏正在进行的会话');
    } else if (removed?.reason === 'missing') {
      toast('已删除');
    } else if (removed?.reason === 'error') {
      toast(`已删除，但源文件移除失败：${removed.message}`, 'error');
    } else {
      toast('已删除' + (conv.sourceRef ? '，同步不会把它拉回来' : ''));
    }
  } catch (err) {
    toast(err.message, 'error');
  }
}

function openConversationMenu(conv) {
  openModal({
    title: conv.title || '对话操作',
    body: h('div', { class: 'entry-list' }, [
      h('button', { class: 'btn', onclick: () => { close(); renameConversation(conv); } }, '重命名'),
      h('button', { class: 'btn', onclick: () => { close(); togglePin(conv); } }, conv.pinned ? '取消置顶' : '置顶'),
      h('button', { class: 'btn', onclick: () => { close(); exportConversation(conv, 'md'); } }, '导出 Markdown'),
      h('button', { class: 'btn', onclick: () => { close(); exportConversation(conv, 'json'); } }, '导出 JSON'),
      h('button', {
        class: 'btn',
        onclick: async () => {
          close();
          if (state.current?.id !== conv.id) await selectConversation(conv.id);
          openTranslateDialog(null);
        }
      }, '翻译整个对话'),
      h('button', {
        class: 'btn danger',
        onclick: () => {
          close();
          deleteConversationFlow(conv);
        }
      }, '删除对话')
    ])
  });
  function close() {
    const mask = $('#modal-root .modal-mask');
    if (mask) mask.remove();
    $('#modal-root').style.pointerEvents = 'none';
  }
}

async function renameConversation(conv) {
  const value = prompt('新的对话标题', conv.title || '');
  if (value === null) return;
  await api.updateConversation(conv.id, { title: value.trim() || '未命名' });
  await refreshConversations();
}

async function togglePin(conv) {
  await api.updateConversation(conv.id, { pinned: !conv.pinned });
  await refreshConversations();
}

async function exportConversation(conv, format) {
  const full = await api.conversation(conv.id);
  const c = full.conversation;
  let content;
  let name;
  if (format === 'json') {
    content = JSON.stringify(c, null, 2);
    name = `${sanitize(c.title)}.json`;
  } else {
    content = [
      `# ${c.title}`,
      '',
      `- 引擎：${c.engineId || '—'}`,
      `- 模型：${c.model || '默认'}`,
      `- 目录：${c.cwd || '—'}`,
      `- 导出时间：${new Date().toLocaleString('zh-CN')}`,
      '',
      ...c.messages.map((m) => `## ${m.role === 'user' ? '用户' : '助手'}（${clockTime(m.createdAt)}）\n\n${m.content}\n`)
    ].join('\n');
    name = `${sanitize(c.title)}.md`;
  }
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const link = h('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(link);
  link.click();
  link.remove();
  toast('已导出');
}

const sanitize = (name) => String(name || 'conversation').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);

/* ==================== 线程渲染 ==================== */

function renderThread() {
  const container = $('#messages');
  container.innerHTML = '';
  if (!state.current) {
    container.append(welcomeNode());
    return;
  }
  const thread = h('div', { class: 'thread' });
  const messages = state.current.messages || [];
  if (!messages.length) {
    thread.append(h('div', { class: 'empty-hint', text: '这个对话还没有消息，直接在下面输入即可。' }));
  }
  for (const msg of messages) thread.append(messageNode(msg));
  // 这个对话如果有正在跑的任务，把实时输出接回线程里
  const activeRun = currentRun();
  if (activeRun) attachRunNode(activeRun, thread);
  container.append(thread);
  requestAnimationFrame(() => container.scrollTop = container.scrollHeight);
}

function messageNode(msg) {
  const isUser = msg.role === 'user';
  const isSystem = msg.role === 'system';
  const engine = engineById(msg.engineId || state.current?.engineId);
  const actions = h('div', { class: 'msg-actions' });

  if (isUser) {
    actions.append(
      h('button', { onclick: () => copyText(msg.content) }, '复制'),
      h('button', {
        onclick: async () => {
          const value = prompt('编辑后重新发送', msg.content);
          if (value === null || !value.trim()) return;
          await api.updateMessage(state.current.id, msg.id, { content: value });
          state.current = (await api.conversation(state.current.id)).conversation;
          await send(value, { replayMessageId: msg.id });
        }
      }, '编辑重发'),
      h('button', { onclick: () => openReplayPicker(msg) }, '换个模型回答'),
      h('button', { onclick: () => openTranslateDialog([msg.id]) }, '翻译')
    );
  } else if (!isSystem) {
    actions.append(
      h('button', { onclick: () => copyText(msg.content) }, '复制'),
      h('button', { onclick: () => openTranslateDialog([msg.id]) }, '翻译'),
      h('button', { onclick: () => regenerate(msg) }, '重新生成'),
      h('button', {
        onclick: async () => {
          await api.deleteMessage(state.current.id, msg.id);
          state.current = (await api.conversation(state.current.id)).conversation;
          renderThread();
        }
      }, '删除')
    );
  }

  const bubble = h('div', { class: 'bubble' });
  if (msg.error) {
    bubble.textContent = msg.error;
  } else if (isUser) {
    bubble.textContent = msg.content;
  } else if (isSystem) {
    bubble.append(h('div', { text: msg.content }));
  } else {
    const { html, codes } = renderMarkdown(msg.content);
    bubble.classList.add('md');
    bubble.innerHTML = html;
    enhanceCodeBlocks(bubble, codes);
  }

  // 失败了就给出「用其他模型处理」的入口
  const failure = msg.meta?.failure;
  // 只在「失败报告」那条上给按钮；修复开始/结束的提示不用再挂一遍
  if (isSystem && failure && !msg.meta?.repair) {
    bubble.append(
      h('div', { class: 'retry-row' }, [
        h('button', { onclick: () => retryWithOtherEngine(msg) }, '⇄ 用其他模型处理'),
        h('button', { onclick: () => repairWithModel(msg) }, '🛠 修复这个报错'),
        failure.kind ? h('span', { class: 'conv-meta', text: `错误类型：${failure.kind}` }) : null
      ])
    );
  }
  // 发到桌面客户端的那条：给个把回复贴回来的入口
  if (msg.meta?.desktop) {
    bubble.append(
      h('div', { class: 'retry-row' }, [
        h('button', { onclick: () => pasteBackReply(msg) }, '📋 把回复贴回来')
      ])
    );
  }
  if (msg.meta?.repairTarget && !failure) {
    bubble.append(
      h('div', { class: 'retry-row' }, [
        h('button', {
          onclick: async () => {
            const engine = engineById(msg.meta.repairTarget);
            if (!engine) return;
            const user = findOwningUserMessage(msg);
            if (!user) return;
            await send(user.content, { engineId: engine.id, replayMessageId: user.id });
          }
        }, `↻ 用「${engineById(msg.meta.repairTarget)?.label || msg.meta.repairTarget}」重试`)
      ])
    );
  }

  const node = h('div', {
    class: `msg ${isUser ? 'user' : isSystem ? 'system' : 'assistant'}${msg.error ? ' error' : ''}`,
    'data-id': msg.id
  }, [
    h('div', { class: 'msg-head' }, [
      h('span', { class: 'who', text: isUser ? '你' : isSystem ? '系统' : engine?.label || '助手' }),
      msg.model ? h('span', { class: 'msg-badge', text: msg.model }) : null,
      h('span', { text: clockTime(msg.createdAt) }),
      msg.meta?.imported ? h('span', { class: 'msg-badge', text: '导入' }) : null,
      msg.meta?.fallbackFrom ? h('span', { class: 'msg-badge', text: '接手回答' }) : null,
      actions
    ]),
    bubble
  ]);

  const translation = msg.meta?.translation;
  if (translation?.text) node.append(translationBlock(msg, translation));
  return node;
}

function translationBlock(msg, translation) {
  const body = h('div', { class: 'tr-body md' });
  const { html, codes } = renderMarkdown(translation.text);
  body.innerHTML = html;
  enhanceCodeBlocks(body, codes);

  const wrap = h('div', { class: 'translation' }, [
    h('div', { class: 'tr-head' }, [
      h('span', { class: 'tr-tag', text: `译文 · ${translation.lang}` }),
      h('span', { class: 'tr-meta', text: [engineById(translation.engineId)?.label, relTime(translation.at)].filter(Boolean).join(' · ') }),
      h('div', { style: 'flex:1' }),
      h('button', { onclick: () => copyText(translation.text) }, '复制'),
      h('button', { onclick: () => openTranslateDialog([msg.id], { force: true }) }, '重新翻译'),
      h('button', {
        onclick: async () => {
          const latest = await api.conversation(state.current.id);
          const target = latest.conversation.messages.find((m) => m.id === msg.id);
          if (target) {
            target.meta = { ...(target.meta || {}) };
            delete target.meta.translation;
            await api.updateMessage(state.current.id, msg.id, { meta: { translation: null } });
            state.current = (await api.conversation(state.current.id)).conversation;
            renderThread();
          }
        }
      }, '删除译文'),
      h('button', {
        onclick: (event) => {
          wrap.classList.toggle('collapsed');
          event.target.textContent = wrap.classList.contains('collapsed') ? '展开' : '收起';
        }
      }, '收起')
    ]),
    body
  ]);
  return wrap;
}

/* ---------- 翻译 ---------- */

function progressPill(initial, onCancel) {
  const label = h('span', { text: initial });
  const node = h('div', { class: 'toast progress' }, [h('span', { class: 'spinner' }), label]);
  if (onCancel) node.append(h('button', { onclick: onCancel }, '取消'));
  $('#toasts').append(node);
  return {
    text(value) {
      label.textContent = value;
    },
    remove() {
      node.remove();
    }
  };
}

function openTranslateDialog(messageIds, { force = false } = {}) {
  if (!state.current) {
    toast('先打开一个对话', 'error');
    return;
  }
  const langs = state.targetLangs?.length ? state.targetLangs : ['简体中文', '繁體中文', 'English'];
  const current = state.settings.translation?.targetLang || '简体中文';
  const langSelect = h(
    'select',
    {},
    langs.map((lang) => h('option', { value: lang, selected: lang === current }, lang))
  );

  const engineSelect = h('select', {});
  engineSelect.append(h('option', { value: '' }, '自动（优先本机 Ollama）'));
  for (const engine of chatEngines()) {
    engineSelect.append(
      h('option', { value: engine.id, selected: engine.id === state.settings.translation?.engineId }, engine.label)
    );
  }

  // 模型列表跟着引擎变，自动档=挑参数最小的那个（本机推理快）
  const modelSelect = h('select', {});
  const renderModels = () => {
    modelSelect.innerHTML = '';
    modelSelect.append(h('option', { value: '' }, '自动（挑最小的模型）'));
    const engine = engineById(engineSelect.value || 'ollama') || engineById(state.settings.translation?.engineId);
    for (const model of engine?.models || []) {
      modelSelect.append(h('option', { value: model }, model));
    }
    if (state.settings.translation?.model) {
      modelSelect.append(
        h('option', { value: state.settings.translation.model, selected: true }, `记住的：${state.settings.translation.model}`)
      );
    }
  };
  engineSelect.addEventListener('change', renderModels);
  renderModels();

  const scope = messageIds?.length
    ? `${messageIds.length} 条消息`
    : `整个对话（只翻还没译过的，单次最多 40 条）`;

  const modal = openModal({
    title: '翻译',
    body: h('div', {}, [
      h('div', { class: 'field' }, [h('label', { text: '目标语言' }), langSelect]),
      h('div', { class: 'field' }, [
        h('label', { text: '用哪个引擎翻译' }),
        engineSelect,
        h('div', { class: 'desc', text: '默认走本机 Ollama：免费、不消耗额度。用 CLI 引擎也能翻，但每条消息都要起一次进程，比较慢。' })
      ]),
      h('div', { class: 'field' }, [
        h('label', { text: '模型' }),
        modelSelect,
        h('div', { class: 'desc', text: '纯 CPU 跑大模型会很慢（14B 比 7B 慢好几倍），翻译建议用小的那个。单条超过 90 秒会自动跳过。' })
      ]),
      h('div', { class: 'field' }, [h('label', { text: '范围' }), h('div', { class: 'desc', text: scope })]),
      force ? h('div', { class: 'desc', text: '会覆盖已有的译文。' }) : null
    ]),
    footer: [
      h('button', { class: 'btn', onclick: () => modal.close() }, '取消'),
      h('button', {
        class: 'btn primary',
        onclick: () => {
          const targetLang = langSelect.value;
          const engineId = engineSelect.value || undefined;
          const model = modelSelect.value || undefined;
          modal.close();
          translateMessages({ messageIds, targetLang, engineId, model });
        }
      }, '开始翻译')
    ]
  });
}

function applyTranslation(event) {
  const message = (state.current?.messages || []).find((m) => m.id === event.messageId);
  if (!message) return;
  message.meta = {
    ...(message.meta || {}),
    translation: { lang: event.lang, text: event.text, engineId: event.engineId, at: new Date().toISOString() }
  };
  const old = document.querySelector(`.msg[data-id="${message.id}"]`);
  if (old) old.replaceWith(messageNode(message));
}

async function translateMessages({ messageIds = null, targetLang, engineId, model } = {}) {
  if (!state.current) return;
  if (state.translating) {
    toast('还有翻译任务在跑，先等它结束或者点取消');
    return;
  }
  state.translating = true;
  const controller = new AbortController();
  state.translateController = controller;
  const pill = progressPill('准备翻译…', () => controller.abort());
  let lang = targetLang || state.settings.translation?.targetLang || '简体中文';

  try {
    await streamTranslate(
      {
        conversationId: state.current.id,
        messageIds: messageIds || undefined,
        targetLang: lang,
        engineId,
        model,
        onlyMissing: true,
        limit: messageIds?.length ? messageIds.length : 40
      },
      (event) => {
        switch (event.type) {
          case 'translate-start':
            lang = event.targetLang;
            if (!event.total) {
              pill.text('没有需要翻译的内容');
              toast('这个对话里没有待翻译的消息');
              break;
            }
            pill.text(`翻译 ${event.total} 条 → ${lang}（${event.engineLabel}）`);
            logLine(
              `翻译：共 ${event.total} 条，引擎 ${event.engineLabel}${event.model ? ` · ${event.model}` : ''}${event.skipped ? `，超上限跳过 ${event.skipped} 条` : ''}`,
              'sys'
            );
            break;
          case 'translate-progress':
            pill.text(`翻译中 ${Math.min(event.done + 1, event.total)}/${event.total} → ${lang}`);
            break;
          case 'translated':
            applyTranslation(event);
            break;
          case 'translate-error':
            logLine(`翻译失败：${event.message}`, 'err');
            break;
          case 'translate-done':
            pill.text(`翻译完成：成功 ${event.done} 条${event.failed ? `，失败 ${event.failed} 条` : ''}`);
            if (event.done) toast(`翻译完成，成功 ${event.done} 条`, 'ok');
            if (event.failed) toast(`${event.failed} 条翻译失败，详见右侧运行日志`, 'error');
            break;
          default:
            break;
        }
      },
      controller.signal
    );
  } catch (err) {
    if (err.name !== 'AbortError') toast(err.message, 'error');
  } finally {
    state.translating = false;
    state.translateController = null;
    setTimeout(() => pill.remove(), 3500);
  }
}

/* ---------- 报错的两种处理：接手 / 修复 ---------- */

function findOwningUserMessage(msg) {
  const messages = state.current?.messages || [];
  const index = messages.findIndex((m) => m.id === msg.id);
  for (let i = index; i >= 0; i -= 1) {
    if (messages[i].role === 'user') return messages[i];
  }
  return null;
}

function retryWithOtherEngine(msg) {
  const user = findOwningUserMessage(msg);
  if (!user) {
    toast('找不到对应的用户消息', 'error');
    return;
  }
  const failure = msg.meta?.failure || {};
  openEnginePicker(
    (engine) => {
      send(user.content, {
        engineId: engine.id,
        replayMessageId: user.id,
        errorContext: {
          fromLabel: msg.meta?.engineLabel || '上一个引擎',
          kind: failure.kind,
          message: failure.message,
          hint: failure.hint
        }
      });
    },
    { title: '用哪个模型接手？', filter: (engine) => engine.kind !== 'app' }
  );
}

function repairWithModel(msg) {
  const user = findOwningUserMessage(msg);
  const failure = msg.meta?.failure || {};
  openEnginePicker(
    async (engine) => {
      await runRepair(engine, msg, user);
    },
    {
      title: '用哪个模型来修这个报错？',
      filter: (engine) => engine.kind !== 'app' && engine.available
    }
  );
}

async function runRepair(repairEngine, failureMsg, userMsg) {
  if (currentRun()) {
    toast('这条对话还在生成中，等它跑完再修');
    return;
  }

  const run = {
    conversationId: state.current.id,
    engine: repairEngine,
    text: '',
    tools: [],
    error: null,
    controller: new AbortController(),
    node: null,
    textNode: null,
    bubble: null,
    typing: null,
    frame: null,
    startedAt: Date.now(),
    repair: true
  };
  runs.set(run.conversationId, run);
  const thread = $('#messages .thread') || $('#messages');
  attachRunNode(run, thread);
  setRunning();

  try {
    await streamPost(
      '/api/repair',
      {
        conversationId: state.current.id,
        engineId: failureMsg.meta?.engineId || state.current.engineId,
        failure: failureMsg.meta?.failure || null,
        request: userMsg?.content || '',
        repairEngineId: repairEngine.id
      },
      (event) => handleEvent(event, run),
      run.controller.signal
    );
  } catch (err) {
    if (err.name !== 'AbortError') {
      run.error = err.message;
      logLine(err.message, 'err');
      toast(err.message, 'error');
    }
  } finally {
    runs.delete(run.conversationId);
    setRunning();
    try {
      if (state.current?.id === run.conversationId) {
        state.current = (await api.conversation(run.conversationId)).conversation;
        renderThread();
      }
    } catch {
      /* ignore */
    }
    await refreshConversations();
  }
}

function openReplayPicker(msg) {
  openEnginePicker(async (engine) => {
    state.current = (await api.conversation(state.current.id)).conversation;
    await send(msg.content, { engineId: engine.id, replayMessageId: msg.id });
  }, { title: '选择回答这条消息的引擎', filter: (engine) => engine.kind !== 'app' });
}

async function regenerate(assistantMsg) {
  const messages = state.current.messages || [];
  const idx = messages.findIndex((m) => m.id === assistantMsg.id);
  let user = null;
  for (let i = idx; i >= 0; i -= 1) {
    if (messages[i].role === 'user') {
      user = messages[i];
      break;
    }
  }
  if (!user) {
    toast('找不到对应的用户消息', 'error');
    return;
  }
  await api.deleteMessage(state.current.id, assistantMsg.id);
  state.current = (await api.conversation(state.current.id)).conversation;
  await send(user.content, { replayMessageId: user.id });
}

/* ==================== 欢迎页 ==================== */

function welcomeNode() {
  const box = h('div', { class: 'welcome' });
  box.append(
    h('h1', { text: '今天想用哪个引擎？' }),
    h('p', { class: 'sub', text: '选一个引擎开始新对话。对话过程中随时可以切换模型或引擎，历史记录会自动保存在本地。' })
  );

  const groups = new Map();
  for (const engine of chatEngines()) {
    if (!groups.has(engine.group)) groups.set(engine.group, []);
    groups.get(engine.group).push(engine);
  }
  for (const [group, engines] of groups) {
    box.append(h('h2', { text: group }));
    const grid = h('div', { class: 'engine-grid' });
    for (const engine of engines) grid.append(engineCard(engine));
    box.append(grid);
  }

  const apps = appEngines();
  if (apps.length) {
    box.append(h('h2', { text: '本地程序（一键启动）' }));
    const grid = h('div', { class: 'engine-grid' });
    for (const app of apps) {
      grid.append(
        h('button', {
          class: 'engine-card',
          onclick: async () => {
            try {
              await api.launchApp(app.id);
              toast(`已启动 ${app.label}`, 'ok');
            } catch (err) {
              toast(err.message, 'error');
            }
          }
        }, [
          h('div', { class: 'row1' }, [
            h('span', { class: 'badge', style: `background:${app.accent}` }, app.badge),
            h('span', { class: 'name', text: app.label })
          ]),
          h('div', { class: 'desc', text: app.available ? '点击启动本机程序' : app.detail || '未找到程序' }),
          h('div', { class: `status ${app.available ? 'ok' : 'bad'}`, text: app.available ? '● 已安装' : '○ 不可用' })
        ])
      );
    }
    box.append(grid);
  }

  box.append(h('h2', { text: '快速开始' }));
  const quick = h('div', { class: 'quick-prompts' });
  const prompts = [
    '帮我看一下当前目录下的项目结构，给出改进建议',
    '写一个 PowerShell 脚本，把目录里所有图片按日期重命名',
    '解释这段代码做了什么，并指出潜在 bug',
    '总结我今天导入的对话，列出待办事项'
  ];
  for (const text of prompts) {
    quick.append(h('button', { onclick: () => { $('#input').value = text; autoGrow($('#input')); $('#input').focus(); } }, text));
  }
  box.append(quick);
  return box;
}

function engineCard(engine) {
  const active = state.current?.engineId === engine.id;
  return h('button', {
    class: `engine-card${active ? ' active' : ''}${engine.available ? '' : ' empty'}`,
    onclick: () => newConversation(engine.id)
  }, [
    h('div', { class: 'row1' }, [
      h('span', { class: 'badge', style: `background:${engine.accent}` }, engine.badge),
      h('span', { class: 'name', text: engine.label })
    ]),
    h('div', { class: 'desc', text: engine.description || engine.detail || '' }),
    h('div', {
      class: `status ${engine.available ? 'ok' : 'bad'}`,
      text: engine.available ? `● ${engine.kind === 'cli' ? 'CLI 就绪' : engine.kind === 'openai' ? '接口已配置' : '可用'}` : `○ ${engine.detail || '未就绪'}`
    })
  ]);
}

/* ==================== 引擎 / 模型 / 目录选择 ==================== */

function openEnginePicker(onPick, { title = '选择引擎', filter = () => true } = {}) {
  const list = h('div', { class: 'engine-picker' });
  const groups = new Map();
  for (const engine of state.engines.filter(filter)) {
    if (!groups.has(engine.group)) groups.set(engine.group, []);
    groups.get(engine.group).push(engine);
  }
  for (const [group, engines] of groups) {
    list.append(h('div', { class: 'picker-group', text: group }));
    for (const engine of engines) {
      list.append(
        h('button', {
          class: `picker-item${state.current?.engineId === engine.id ? ' active' : ''}`,
          onclick: () => {
            modal.close();
            onPick(engine);
          }
        }, [
          h('span', { class: 'badge', style: `background:${engine.accent}` }, engine.badge),
          h('span', { class: 'meta' }, [
            h('div', { class: 'n', text: engine.label }),
            h('div', { class: 'd', text: engine.description || engine.detail || `${engine.models?.length || 0} 个模型` })
          ]),
          h('span', { class: 'mark', text: engine.available ? '● 就绪' : '○ 未就绪' })
        ])
      );
    }
  }
  const modal = openModal({ title, body: list });
}

function openModelPicker(engine, onPick) {
  const models = engine.models || [];
  const body = h('div', { class: 'engine-picker' });
  body.append(
    h('button', {
      class: 'picker-item',
      onclick: () => {
        modal.close();
        onPick('');
      }
    }, [h('span', { class: 'meta' }, [h('div', { class: 'n', text: '使用引擎默认模型' })])])
  );
  for (const model of models) {
    body.append(
      h('button', {
        class: `picker-item${state.current?.model === model ? ' active' : ''}`,
        onclick: () => {
          modal.close();
          onPick(model);
        }
      }, [h('span', { class: 'meta' }, [h('div', { class: 'n', text: model })])])
    );
  }
  const custom = h('div', { class: 'field', style: 'margin-top:12px' }, [
    h('label', { text: '手动输入模型名' }),
    h('div', { class: 'row' }, [
      h('input', { type: 'text', id: 'custom-model', placeholder: engine.supportsCustomModel ? '例如 qwen3:14b / ep-xxxx' : '该引擎不支持自定义模型' }),
      h('button', {
        class: 'btn',
        onclick: () => {
          const value = $('#custom-model').value.trim();
          modal.close();
          onPick(value);
        }
      }, '使用')
    ])
  ]);
  if (engine.supportsCustomModel) body.append(custom);
  const modal = openModal({ title: `${engine.label} · 选择模型`, body });
}

async function openDirPicker(initial, onPick) {
  let current = initial || state.settings.cwd || '';
  const info = h('div', { class: 'source-path', text: current });
  const list = h('div', { class: 'engine-picker' });
  const hint = h('div', { class: 'desc', text: '找不到合适的目录？点「＋ 新建文件夹」在这里建一个，然后点「使用这个目录」。' });

  const load = async (target) => {
    try {
      const data = await api.listDirs(target);
      current = data.path;
      info.textContent = data.path;
      list.innerHTML = '';
      list.append(
        h('button', { class: 'picker-item', onclick: () => load(data.parent) }, [
          h('span', { class: 'meta' }, [h('div', { class: 'n', text: '⬆ 上一级' })])
        ])
      );
      for (const entry of data.entries) {
        list.append(
          h('button', { class: 'picker-item', onclick: () => load(entry.path) }, [
            h('span', { class: 'meta' }, [h('div', { class: 'n', text: entry.name })])
          ])
        );
      }
      if (!data.entries.length) list.append(h('div', { class: 'empty-hint', text: '没有子目录' }));
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  const modal = openModal({
    title: '选择工作目录',
    body: h('div', {}, [info, hint, list]),
    footer: [
      h('button', {
        class: 'btn',
        onclick: async () => {
          const name = prompt(`在下面这个目录里新建文件夹：\n${current}\n\n文件夹名称：`);
          if (!name || !name.trim()) return;
          try {
            const created = await api.mkdir(current, name.trim());
            toast(`已创建 ${created.path}`, 'ok');
            await load(created.path);
          } catch (err) {
            toast(err.message, 'error');
          }
        }
      }, '＋ 新建文件夹'),
      h('div', { style: 'flex:1' }),
      h('button', { class: 'btn', onclick: () => modal.close() }, '取消'),
      h('button', {
        class: 'btn primary',
        onclick: () => {
          modal.close();
          onPick(current);
        }
      }, '使用这个目录')
    ]
  });
  await load(current);
}

/* ==================== 对话操作 ==================== */

async function refreshConversations() {
  const data = await api.conversations(state.search);
  state.conversations = data.conversations;
  renderConversations();
}

async function selectConversation(id) {
  const data = await api.conversation(id);
  state.current = data.conversation;
  if (location.hash !== `#/c/${id}`) history.replaceState(null, '', `#/c/${id}`);
  renderThread();
  renderProjections();
  renderConversations();
}

async function newConversation(engineId) {
  const targetEngine = engineId || state.current?.engineId || state.settings.defaultEngineId;
  const target = engineById(targetEngine);

  // 本地程序类引擎不能对话，点它就当成「启动这个程序」
  if (target?.kind === 'app') {
    try {
      await api.launchApp(target.id);
      toast(`已启动 ${target.label}`, 'ok');
    } catch (err) {
      toast(err.message, 'error');
    }
    return;
  }

  // 已经有一个同引擎的空会话就直接复用，避免反复点击堆出一堆空对话
  const blank = state.conversations.find(
    (c) => c.messageCount === 0 && c.engineId === targetEngine && (c.source || 'local') === 'local'
  );
  if (blank) {
    await selectConversation(blank.id);
  } else {
    const data = await api.createConversation({
      engineId: targetEngine,
      model: state.current?.model || '',
      cwd: state.settings.cwd
    });
    state.current = data.conversation;
    history.replaceState(null, '', `#/c/${data.conversation.id}`);
    await refreshConversations();
    renderThread();
    renderProjections();
  }
  $('#input').focus();
}

function renderProjections() {
  const engine = engineById(state.current?.engineId || state.settings.defaultEngineId);
  const health = engine ? state.health?.[engine.id] : null;
  const dot = !engine?.available ? 'bad' : health && !health.ok ? 'warn' : 'ok';
  $('#chip-engine').innerHTML = `<span class="dot ${dot}"></span><span class="chip-label">${engine?.label || '选择引擎'}</span>`;
  $('#chip-engine').title = health && !health.ok
    ? `检查没过：\n${health.checks.filter((check) => !check.ok).map((check) => `· ${check.name}：${check.detail}`).join('\n')}`
    : engine?.label || '';
  $('#chip-model').textContent = `模型：${state.current?.model || '默认'}`;
  const cwd = state.current?.cwd || state.settings.cwd || '未设置';
  $('#chip-cwd').textContent = `📁 ${cwd.length > 34 ? `…${cwd.slice(-32)}` : cwd}`;
  $('#composer-engine').textContent = engine?.label || '引擎';
  $('#composer-model').textContent = state.current?.model || '默认模型';
  $('#composer-cwd').textContent = cwd.length > 24 ? `…${cwd.slice(-22)}` : cwd;
  $('#composer-hint').textContent = currentRun() ? '生成中…' : state.current ? '' : '先选择引擎';
}

/* ==================== 发送 / 流式 ==================== */

/* ---------- 每个对话各自独立的生成任务 ---------- */
// 生成中的内容跟着「对话」走，而不是跟着界面走：
// 切到别的对话时任务照常跑，切回来还能看到实时输出；不同对话可以同时各跑各的。

const runs = new Map(); // conversationId -> run

function currentRun() {
  return state.current ? runs.get(state.current.id) || null : null;
}

function setRunning() {
  const run = currentRun();
  $('#btn-send').hidden = Boolean(run);
  $('#btn-stop').hidden = !run;
  const others = [...runs.keys()].filter((id) => id !== state.current?.id).length;
  $('#run-status').innerHTML = runs.size
    ? `<span class="pulse"></span>${run ? '正在生成' : `${others} 个对话在生成`}`
    : '';
  renderProjections();
}

function logLine(text, cls = '') {
  const body = $('#drawer-body');
  const empty = body.querySelector('.log-empty');
  if (empty) empty.remove();
  body.append(h('div', { class: `log-line ${cls}`, text }));
  body.scrollTop = body.scrollHeight;
}

async function send(text, options = {}) {
  const content = String(text ?? '').trim();
  if (!content) return;

  if (!state.current) await newConversation(options.engineId);

  const engineId = options.engineId || state.current.engineId || state.settings.defaultEngineId;
  const engine = engineById(engineId);
  if (!engine) {
    toast('请先选择一个引擎', 'error');
    return;
  }
  if (engine.kind === 'app') {
    toast(`${engine.label} 是本地程序，不能对话；可以在首页或「本地程序」里一键启动它。`, 'error');
    return;
  }
  if (currentRun()) {
    toast('这条对话还在生成中——可以切到别的对话继续用，或者先点停止');
    return;
  }
  if (options.cwd) {
    await api.updateConversation(state.current.id, { cwd: options.cwd });
    state.current.cwd = options.cwd;
  }

  // 桌面客户端：不是聊天，是把消息送到客户端里去
  if (engine.kind === 'desktop') {
    await sendToDesktop(engine, content);
    return;
  }

  const optimistic = {
    id: `local-${Date.now()}`,
    role: 'user',
    content,
    createdAt: new Date().toISOString(),
    engineId
  };
  state.current.messages = [...(state.current.messages || []), optimistic];
  renderThread();
  $('#input').value = '';
  autoGrow($('#input'));

  const run = {
    conversationId: state.current.id,
    engine,
    text: '',
    tools: [],
    error: null,
    controller: new AbortController(),
    node: null,
    textNode: null,
    bubble: null,
    typing: null,
    frame: null,
    startedAt: Date.now()
  };
  runs.set(run.conversationId, run);
  // 任务挂到当前线程上
  const thread = $('#messages .thread') || $('#messages');
  attachRunNode(run, thread);
  setRunning();
  refreshConversations().catch(() => {});

  try {
    await streamChat(
      {
        conversationId: state.current.id,
        content,
        engineId,
        model: state.current.model || options.model || '',
        cwd: state.current.cwd || state.settings.cwd,
        replayMessageId: options.replayMessageId || null,
        errorContext: options.errorContext || null
      },
      (event) => handleEvent(event, run),
      run.controller.signal
    );
  } catch (err) {
    if (err.name !== 'AbortError') {
      logLine(err.message, 'err');
      // 体检没过：不是「报错」，是提前拦住，给用户可操作的选项
      if (err.payload?.preflight) {
        showPreflightProblem(run.engine || engine, err.payload.preflight, content);
        run.error = '这个引擎现在用不了';
      } else {
        run.error = err.message;
        toast(err.message, 'error');
      }
      if (run.bubble?.isConnected && !run.text) {
        run.textNode.classList.remove('cursor');
        run.bubble.classList.add('error');
        run.textNode.textContent = `✕ ${run.error}`;
      }
    }
  } finally {
    runs.delete(run.conversationId);
    setRunning();
    // 只有还停在同一个对话上才需要重画；在别的对话里就只刷新侧栏
    try {
      if (state.current?.id === run.conversationId) {
        state.current = (await api.conversation(run.conversationId)).conversation;
        renderThread();
      }
    } catch {
      /* ignore */
    }
    await refreshConversations();
  }
}

function toolRowElement(tool) {
  const arg = typeof tool.input === 'string' ? tool.input : tool.input ? JSON.stringify(tool.input).slice(0, 200) : '';
  return h('div', { class: 'tool-row' }, [
    h('span', { class: 'tname', text: tool.name }),
    h('span', { class: 'targ', text: arg })
  ]);
}

/* ---------- 用之前先体检：不合格就拦住 / 换引擎，别让它报错 ---------- */

async function refreshEngineHealth(engineId, force = false) {
  if (!engineId) return null;
  try {
    const result = await api.preflight(engineId, force);
    state.health = { ...(state.health || {}), [engineId]: result };
    renderProjections();
    return result;
  } catch {
    return null;
  }
}

/** 引擎不可用时的处理面板：说清楚哪儿不对，并给一条能继续走的路 */
function showPreflightProblem(engine, preflightResult, content) {
  const failed = (preflightResult?.checks || []).filter((check) => !check.ok);
  const modal = openModal({
    title: `${engine.label || engine.id} 现在用不了`,
    body: h('div', {}, [
      h('div', { class: 'desc', text: '消息还没有发出去——发送前先做了检查，下面这些没过：' }),
      h(
        'div',
        { class: 'entry-list', style: 'margin-top:12px' },
        (failed.length ? failed : [{ name: '未知问题', detail: '检查没通过' }]).map((check) =>
          h('div', { class: 'source-card' }, [
            h('div', { class: 'source-head' }, [h('span', { class: 'msg-badge', text: '✕' }), h('strong', { text: check.name })]),
            h('div', { class: 'desc', text: check.detail })
          ])
        )
      ),
      h('div', { class: 'desc', style: 'margin-top:12px', text: '换个能用的引擎就能继续，不用先去修它。' })
    ]),
    footer: [
      h('button', { class: 'btn', onclick: () => modal.close() }, '先不发'),
      h('button', {
        class: 'btn',
        onclick: async () => {
          modal.close();
          toast('正在重新检测…');
          const result = await refreshEngineHealth(engine.id, true);
          if (result?.ok) {
            toast('现在可以用了，这就发', 'ok');
            send(content, { engineId: engine.id });
          } else {
            toast('还是不行，去「设置 → API Key / 引擎诊断」看看', 'error');
          }
        }
      }, '重新检测'),
      h('button', {
        class: 'btn primary',
        onclick: () => {
          modal.close();
          openEnginePicker((picked) => send(content, { engineId: picked.id }), {
            title: '换个能用的引擎发送',
            filter: (item) => item.kind !== 'app' && item.id !== engine.id
          });
        }
      }, '换个引擎发送')
    ]
  });
}

/* ---------- 桌面客户端：把消息送进去，回复手动贴回来 ---------- */

async function sendToDesktop(engine, content) {
  await api.addMessages(state.current.id, [{ role: 'user', content, engineId: engine.id }]);
  state.current = (await api.conversation(state.current.id)).conversation;
  renderThread();

  try {
    await api.desktopSend(engine.id, content);
    await api.addMessages(state.current.id, [
      {
        role: 'system',
        content: `已打开并聚焦「${engine.label}」客户端，消息也已经放进剪贴板。如果输入框里没有自动出现内容，按一下 Ctrl+V 再回车即可。\n\n客户端不会把回复送回来——拿到答案后点下面的「把回复贴回来」。`,
        meta: { desktop: true, engineId: engine.id, engineLabel: engine.label }
      }
    ]);
    toast(`已发到「${engine.label}」，消息在剪贴板里`, 'ok');
  } catch (err) {
    if (err.payload?.preflight) {
      showPreflightProblem(engine, err.payload.preflight, content);
    } else {
      toast(err.message, 'error');
    }
    await api.addMessages(state.current.id, [
      {
        role: 'system',
        content: `发送到客户端失败：${err.message}`,
        meta: {
          failure: {
            kind: 'desktop',
            message: err.message,
            hint: '确认客户端已经启动、窗口没有缩到托盘里，然后重试。'
          },
          engineId: engine.id,
          engineLabel: engine.label
        }
      }
    ]);
  }

  state.current = (await api.conversation(state.current.id)).conversation;
  renderThread();
  await refreshConversations();
}

function pasteBackReply(msg) {
  const area = h('textarea', { placeholder: '把客户端里的回答粘贴到这里…', style: 'min-height:170px' });
  const modal = openModal({
    title: '把客户端的回复贴回来',
    body: h('div', {}, [
      h('div', { class: 'desc', text: '粘贴后会把这段内容作为助手消息存进这个对话，之后可以照常回看、复制、翻译。' }),
      h('div', { class: 'field', style: 'margin-top:10px' }, [area])
    ]),
    footer: [
      h('button', { class: 'btn', onclick: () => modal.close() }, '取消'),
      h('button', {
        class: 'btn primary',
        onclick: async () => {
          const text = area.value.trim();
          if (!text) {
            toast('还没粘贴内容', 'error');
            return;
          }
          modal.close();
          await api.addMessages(state.current.id, [
            { role: 'assistant', content: text, engineId: msg.meta?.engineId || null, meta: { fromDesktop: true } }
          ]);
          state.current = (await api.conversation(state.current.id)).conversation;
          renderThread();
          toast('已补进对话', 'ok');
        }
      }, '保存')
    ]
  });
  setTimeout(() => area.focus(), 50);
}

/** 把任务的状态画到它的节点上（节点可能已经不在页面上，那就只更新数据） */
function paintRun(run, { instant = false } = {}) {
  const work = () => {
    run.frame = null;
    if (!run.node?.isConnected) return;
    run.typing?.remove();
    run.typing = null;
    const { html, codes } = renderMarkdown(run.text);
    run.textNode.innerHTML = run.text ? html : '';
    run.codes = codes;
    const container = $('#messages');
    const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 240;
    if (nearBottom) container.scrollTop = container.scrollHeight;
  };
  if (instant) {
    work();
    return;
  }
  if (run.frame) return; // 每帧最多重绘一次
  run.frame = requestAnimationFrame(work);
}

/** 把任务挂到当前对话的线程里（切回来时重建节点，已有内容一次性画出来） */
function attachRunNode(run, thread) {
  const typing = h('div', { class: 'typing' }, [h('i'), h('i'), h('i')]);
  const textNode = h('div', { class: 'md cursor' });
  const bubble = h('div', { class: 'bubble' }, [typing, textNode]);
  run.typing = typing;
  run.textNode = textNode;
  run.bubble = bubble;
  run.node = h('div', { class: 'msg assistant', 'data-run': run.conversationId }, [
    h('div', { class: 'msg-head' }, [
      h('span', { class: 'who', text: run.engine?.label || '助手' }),
      h('span', { class: 'msg-badge', text: '生成中' })
    ]),
    bubble
  ]);
  for (const tool of run.tools) bubble.insertBefore(toolRowElement(tool), textNode);
  if (run.error && !run.text) {
    textNode.classList.remove('cursor');
    bubble.classList.add('error');
    textNode.textContent = `✕ ${run.error}`;
  } else if (run.error) {
    textNode.classList.remove('cursor');
  }
  thread.append(run.node);
  paintRun(run, { instant: true });
  const container = $('#messages');
  container.scrollTop = container.scrollHeight;
  return run.node;
}

/** 把一个引擎事件应用到某个任务上：任务属于哪个对话，就只更新哪个对话 */
function handleEvent(event, run) {
  const banner = (nodes) => {
    if (run.bubble?.isConnected) run.bubble.prepend(h('div', { class: 'fallback-banner' }, nodes));
  };

  switch (event.type) {
    case 'start': {
      if (event.conversationId && event.conversationId !== run.conversationId) {
        runs.delete(run.conversationId);
        run.conversationId = event.conversationId;
        runs.set(event.conversationId, run);
      }
      if (event.engineId) run.engine = engineById(event.engineId) || run.engine;
      if (event.engineId && run.node?.isConnected) {
        const who = run.node.querySelector('.msg-head .who');
        if (who) who.textContent = run.engine?.label || '助手';
      }
      if (event.preflightFallback) {
        const info = event.preflightFallback;
        const failed = (info.preflight?.checks || []).filter((check) => !check.ok).map((check) => check.detail);
        logLine(`体检没过：「${info.fromLabel}」${failed[0] ? `（${failed[0]}）` : ''}，改用 ${info.toLabel}`, 'err');
        toast(`「${info.fromLabel}」现在用不了，已改用「${info.toLabel}」`, 'error');
        banner(
          [
            h('span', { text: '这个引擎用不了：' }),
            h('b', { text: info.fromLabel }),
            failed[0] ? h('span', { text: `（${failed[0]}）` }) : null,
            h('span', { text: ' → 已改用 ' }),
            h('b', { text: info.toLabel })
          ].filter(Boolean)
        );
      }
      if (event.repair) {
        logLine(`🛠 修复任务：${event.engineId} 处理 ${event.targetEngine || ''} 的报错`, 'sys');
        banner([
          h('span', { text: '正在修复报错：' }),
          h('b', { text: engineById(event.targetEngine)?.label || event.targetEngine || '上一个引擎' }),
          h('span', { text: `报错（${event.failure?.kind || 'engine'}）交给 ` }),
          h('b', { text: engineById(event.engineId)?.label || event.engineId })
        ]);
      } else if (!event.preflightFallback) {
        logLine(`▶ 引擎 ${event.engineId}${event.model ? ` · ${event.model}` : ''}`, 'sys');
      }
      break;
    }
    case 'fallback':
      logLine(`⚠ ${event.fromLabel} 报错（${event.failure?.kind}：${event.failure?.message}），改用 ${event.toLabel} 接手`, 'err');
      toast(`「${event.fromLabel}」报错，已交给「${event.toLabel}」接手`, 'error');
      // 换了模型，节点标题也要跟着变，不然会写成上一个引擎
      run.engine = engineById(event.to) || run.engine;
      if (run.node?.isConnected) {
        const who = run.node.querySelector('.msg-head .who');
        if (who) who.textContent = run.engine?.label || '助手';
      }
      banner([
        h('span', { text: '上一个引擎报错：' }),
        h('b', { text: event.fromLabel }),
        h('span', { text: `（${event.failure?.kind || 'engine'}）` }),
        h('span', { text: '→ 已交给 ' }),
        h('b', { text: event.toLabel }),
        h('span', { text: ' 接手' })
      ]);
      break;
    case 'command':
      logLine(`$ ${event.command}`, 'cmd');
      if (event.cwd) logLine(`  cwd: ${event.cwd}`, 'sys');
      break;
    case 'delta':
      run.text += event.text;
      paintRun(run);
      break;
    case 'reasoning':
      // 推理模型的思考过程：只进日志，不混进回答
      run.reasoning = (run.reasoning || '') + event.text;
      break;
    case 'tool': {
      const arg = typeof event.input === 'string' ? event.input : event.input ? JSON.stringify(event.input).slice(0, 200) : '';
      run.tools.push({ name: event.name, input: event.input });
      if (run.bubble?.isConnected) {
        run.bubble.insertBefore(toolRowElement({ name: event.name, input: event.input }), run.textNode);
      }
      logLine(`⚙ ${event.name} ${arg}`, 'tool');
      break;
    }
    case 'log':
      logLine(event.line, event.stream === 'stderr' ? 'err' : 'sys');
      break;
    case 'raw':
      logLine(JSON.stringify(event.json).slice(0, 600), 'raw');
      break;
    case 'session':
      logLine(`会话 ID：${event.sessionId}`, 'sys');
      break;
    case 'error':
      run.error = event.message;
      logLine(`✕ ${event.message}`, 'err');
      if (!run.text && run.bubble?.isConnected) {
        run.textNode.classList.remove('cursor');
        run.bubble.classList.add('error');
        run.textNode.textContent = `✕ ${event.message}`;
      }
      break;
    case 'done':
      run.textNode?.classList.remove('cursor');
      if (event.empty) logLine(event.message || '没有输出', 'sys');
      break;
    default:
      break;
  }
}

/* ==================== 导入 / 同步 ==================== */

function openImportModal() {
  const tabs = h('div', { class: 'tabs' });
  const body = h('div', {});
  const defs = [
    { id: 'local', label: '本机 CLI 历史' },
    { id: 'file', label: '从文件导入' },
    { id: 'paste', label: '粘贴导入' }
  ];
  let active = 'local';

  const render = () => {
    tabs.innerHTML = '';
    for (const def of defs) {
      tabs.append(
        h('button', {
          class: `tab${active === def.id ? ' active' : ''}`,
          onclick: () => {
            active = def.id;
            render();
          }
        }, def.label)
      );
    }
    body.innerHTML = '';
    if (active === 'local') body.append(localTab());
    if (active === 'file') body.append(fileTab());
    if (active === 'paste') body.append(pasteTab());
  };

  function syncRow() {
    const toggle = h('input', {
      type: 'checkbox',
      checked: state.sync.enabled,
      onchange: async (e) => {
        await api.syncConfig({ enabled: e.target.checked, autoSync: { intervalSeconds: state.sync.intervalSeconds || 20 } });
        await loadSync();
        render();
      }
    });
    return h('div', { class: 'field' }, [
      h('label', { class: 'switch' }, [toggle, '开启自动同步（后台定时把新记录导入工作台）']),
      h('div', { class: 'desc', text: '默认只同步 Codex 的历史，可在「设置 → 通用」里勾选 Claude Code 等来源。' })
    ]);
  }

  function localTab() {
    const wrap = h('div', {});
    wrap.append(syncRow());
    const list = h('div', { class: 'source-list' });
    wrap.append(list);
    list.append(h('div', { class: 'empty-hint', text: '正在扫描本机历史…' }));

    api.historySources().then(({ sources }) => {
      list.innerHTML = '';
      if (!sources.length) {
        list.append(h('div', { class: 'empty-hint', text: '没有配置任何历史来源' }));
        return;
      }
      for (const item of sources) {
        const card = h('div', { class: 'source-card' }, [
          h('div', { class: 'source-head' }, [
            h('strong', { text: item.source.label }),
            h('span', { class: 'msg-badge', text: `${item.items?.length || 0} 个会话` }),
            h('span', { class: 'chip', style: 'margin-left:auto;cursor:pointer', onclick: () => scan(card, item.source.id) }, '扫描 / 刷新'),
            h('button', { class: 'btn small', onclick: () => importSelected(card, item.source.id) }, '导入选中')
          ]),
          h('div', { class: 'source-path', text: item.source.path || '' }),
          h('div', { class: 'source-items', 'data-items': '1' })
        ]);
        if (!item.source.exists) card.append(h('div', { class: 'desc', text: '目录不存在，跳过' }));
        else card.append(h('div', { class: 'empty-hint', text: '点击「扫描 / 刷新」查看可导入的会话' }));
        list.append(card);
      }
    });
    return wrap;
  }

  async function scan(card, sourceId) {
    const box = card.querySelector('[data-items]');
    box.innerHTML = '<div class="empty-hint">扫描中…</div>';
    try {
      const data = await api.scanSource(sourceId);
      box.innerHTML = '';
      if (!data.items?.length) {
        box.append(h('div', { class: 'empty-hint', text: data.error || '没有找到可导入的对话' }));
        return;
      }
      for (const item of data.items) {
        box.append(
          h('label', { class: 'source-item' }, [
            h('input', { type: 'checkbox', value: item.ref, checked: !item.imported && !item.ignored }),
            h('span', { class: 't' }, [
              h('div', { class: 'title', text: item.title }),
              h('div', {
                class: 'sub',
                text: `${item.messageCount} 条消息 · ${relTime(item.updatedAt)}${item.imported ? ' · 已导入' : ''}${item.ignored ? ' · 你删过它（勾选可重新导入）' : ''}`
              })
            ])
          ])
        );
      }
    } catch (err) {
      box.innerHTML = '';
      box.append(h('div', { class: 'empty-hint', text: err.message }));
    }
  }

  async function importSelected(card, sourceId) {
    const refs = [...card.querySelectorAll('input[type=checkbox]:checked')].map((i) => i.value);
    if (!refs.length) {
      toast('先扫描并勾选要导入的会话', 'error');
      return;
    }
    const { results } = await api.importRefs(sourceId, refs);
    const ok = results.filter((r) => r.ok).length;
    toast(`导入完成：${ok} 个会话`, ok ? 'ok' : 'error');
    await refreshConversations();
  }

  function fileTab() {
    const input = h('input', { type: 'file', accept: '.json,.jsonl,.ndjson,.md,.txt', style: 'display:none' });
    const name = h('div', { class: 'desc' });
    input.addEventListener('change', () => {
      name.textContent = input.files?.[0]?.name || '';
    });
    return h('div', {}, [
      h('div', { class: 'field' }, [
        h('label', { text: '选择文件' }),
        h('div', { class: 'row' }, [
          h('button', { class: 'btn', onclick: () => input.click() }, '浏览…'),
          name,
          input
        ]),
        h('div', { class: 'desc', text: '支持 OpenAI / Claude / Codex 导出的 JSON、JSONL，以及 Markdown、纯文本。' })
      ]),
      h('button', {
        class: 'btn primary',
        onclick: async () => {
          const file = input.files?.[0];
          if (!file) {
            toast('请先选择文件', 'error');
            return;
          }
          const content = await file.text();
          const data = await api.uploadImport(file.name, content);
          toast(`已导入：${data.conversation.title}`, 'ok');
          await refreshConversations();
          await selectConversation(data.conversation.id);
        }
      }, '导入这个文件')
    ]);
  }

  function pasteTab() {
    const textarea = h('textarea', { placeholder: '把对话内容粘贴到这里（纯文本或 JSON 都可以）' });
    return h('div', {}, [
      h('div', { class: 'field' }, [h('label', { text: '对话内容' }), textarea]),
      h('button', {
        class: 'btn primary',
        onclick: async () => {
          const value = textarea.value.trim();
          if (!value) {
            toast('内容为空', 'error');
            return;
          }
          const data = await api.uploadImport(`粘贴-${Date.now()}.md`, value);
          toast('已导入', 'ok');
          await refreshConversations();
          await selectConversation(data.conversation.id);
        }
      }, '导入粘贴内容')
    ]);
  }

  render();
  openModal({ title: '导入对话 / 自动同步', body: h('div', {}, [tabs, body]), wide: true });
}

async function loadSync() {
  const status = await api.syncStatus();
  state.sync = { ...state.sync, ...status };
  const pill = $('#sync-pill');
  pill.textContent = status.enabled
    ? `同步：开（每 ${status.intervalSeconds}s）${status.lastSyncAt ? ` · 上次 ${relTime(status.lastSyncAt)}` : ''}`
    : '同步：关（点一下开启）';
  pill.classList.toggle('on', Boolean(status.enabled));
  pill.classList.remove('busy');

  const badge = $('#sync-badge');
  if (!status.enabled) {
    badge.textContent = '同步已关闭';
    badge.classList.remove('on');
    badge.classList.add('off');
  } else {
    const parts = ['已同步'];
    if (status.lastSyncAt) parts.push(relTime(status.lastSyncAt));
    if (status.lastImported) parts.push(`新导入 ${status.lastImported}`);
    badge.textContent = parts.join(' · ');
    badge.classList.add('on');
    badge.classList.remove('off');
  }
}

/* ==================== 设置 ==================== */

function openSettingsModal() {
  const tabs = h('div', { class: 'tabs' });
  const body = h('div', {});
  const defs = [
    { id: 'general', label: '通用' },
    { id: 'appearance', label: '外观' },
    { id: 'keys', label: 'API Key' },
    { id: 'fallback', label: '翻译 & 容错' },
    { id: 'env', label: '环境变量' },
    { id: 'memory', label: '记忆' },
    { id: 'apps', label: '本地程序' },
    { id: 'diag', label: '引擎诊断' }
  ];
  let active = 'general';

  const render = () => {
    tabs.innerHTML = '';
    for (const def of defs) {
      tabs.append(
        h('button', {
          class: `tab${active === def.id ? ' active' : ''}`,
          onclick: () => {
            active = def.id;
            render();
          }
        }, def.label)
      );
    }
    body.innerHTML = '';
    body.append(
      {
        general: generalTab,
        appearance: appearanceTab,
        keys: keysTab,
        fallback: fallbackTab,
        env: envTab,
        memory: memoryTab,
        apps: appsTab,
        diag: diagTab
      }[active]()
    );
  };

  function generalTab() {
    const engineSelect = h('select', {});
    for (const engine of chatEngines()) {
      engineSelect.append(h('option', { value: engine.id, selected: state.settings.defaultEngineId === engine.id }, engine.label));
    }
    const cwdInput = h('input', { type: 'text', value: state.settings.cwd || '' });
    const rounds = h('input', { type: 'number', min: '2', max: '60', value: state.settings.memoryRounds || 12 });
    const autoToggle = h('input', { type: 'checkbox', checked: state.sync.enabled });
    const interval = h('input', { type: 'number', min: '5', max: '600', value: state.sync.intervalSeconds || 20 });
    const sourceBoxes = {};

    return h('div', {}, [
      h('div', { class: 'field' }, [
        h('label', { text: '默认引擎' }),
        engineSelect
      ]),
      h('div', { class: 'field' }, [
        h('label', { text: '默认工作目录' }),
        h('div', { class: 'row' }, [
          cwdInput,
          h('button', { class: 'btn', onclick: () => openDirPicker(cwdInput.value, (p) => { cwdInput.value = p; }) }, '浏览…')
        ]),
        h('div', { class: 'desc', text: 'CLI 引擎会在这个目录里运行（Codex 用 --cd 传入，Claude 用进程工作目录）。' })
      ]),
      h('div', { class: 'field' }, [
        h('label', { text: '记忆轮数（发送给 CLI 的历史条数上限）' }),
        rounds
      ]),
      h('div', { class: 'field' }, [
        h('label', { class: 'switch' }, [autoToggle, '开启自动同步']),
        h('div', { class: 'row', style: 'margin-top:8px' }, [
          h('span', { class: 'desc', text: '扫描间隔（秒）' }),
          interval
        ])
      ]),
      h('div', { class: 'field' }, [
        h('label', { text: '自动同步的来源' }),
        ...['codex', 'claude', 'qwen', 'codebuddy', 'dsh'].map((id) => {
          const label = {
            codex: 'Codex',
            'codex-archive': 'Codex 桌面版（归档）',
            claude: 'Claude Code',
            qwen: 'Qwen Code',
            codebuddy: 'CodeBuddy / WorkBuddy',
            dsh: 'DeepSeek Harness'
          }[id];
          const box = h('input', { type: 'checkbox', checked: (state.sync.sources || []).includes(id) });
          sourceBoxes[id] = box;
          return h('label', { class: 'switch', style: 'margin-bottom:6px' }, [box, label]);
        })
      ]),
      h('button', {
        class: 'btn primary',
        onclick: async () => {
          const sources = Object.entries(sourceBoxes).filter(([, box]) => box.checked).map(([id]) => id);
          await api.saveSettings({
            defaultEngineId: engineSelect.value,
            cwd: cwdInput.value.trim(),
            memoryRounds: Number(rounds.value) || 12
          });
          await api.syncConfig({
            enabled: autoToggle.checked,
            autoSync: { intervalSeconds: Number(interval.value) || 20, sources }
          });
          await Promise.all([loadSettings(), loadSync()]);
          toast('已保存', 'ok');
        }
      }, '保存通用设置')
    ]);
  }

  function appearanceTab() {
    const draft = { ...APPEARANCE_DEFAULTS, ...(state.settings.appearance || {}) };
    let saveTimer = null;

    // 改动立刻预览，顺手防抖存到服务端
    const commit = () => {
      applyAppearance(draft);
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        api.saveSettings({ appearance: draft }).catch(() => {});
      }, 400);
    };

    /* 深浅色 */
    const modeButtons = h('div', { class: 'seg' });
    const renderModes = () => {
      modeButtons.innerHTML = '';
      for (const item of [
        { id: 'dark', label: '🌙 深色' },
        { id: 'light', label: '☀️ 浅色' },
        { id: 'system', label: '🖥 跟随系统' }
      ]) {
        modeButtons.append(
          h('button', {
            class: `seg-item${draft.mode === item.id ? ' active' : ''}`,
            onclick: () => {
              draft.mode = item.id;
              commit();
              renderModes();
            }
          }, item.label)
        );
      }
    };
    renderModes();

    /* 主题色 */
    const swatches = h('div', { class: 'swatches' });
    const renderSwatches = () => {
      swatches.innerHTML = '';
      for (const color of ACCENT_PRESETS) {
        swatches.append(
          h('button', {
            class: `swatch${draft.accent.toLowerCase() === color ? ' active' : ''}`,
            style: `background:${color}`,
            title: color,
            onclick: () => {
              draft.accent = color;
              commit();
              renderSwatches();
              colorInput.value = color;
            }
          })
        );
      }
    };
    const colorInput = h('input', {
      type: 'color',
      value: draft.accent,
      class: 'color-input',
      oninput: (event) => {
        draft.accent = event.target.value;
        commit();
        renderSwatches();
      }
    });
    renderSwatches();

    /* 字体 */
    const fontSelect = h('select', {
      onchange: (event) => {
        draft.font = event.target.value;
        commit();
      }
    });
    const fontList = h('div', { class: 'font-list' });
    const fontInput = h('input', {
      type: 'file',
      accept: '.ttf,.otf,.woff,.woff2',
      style: 'display:none'
    });
    const renderFonts = () => {
      fontSelect.innerHTML = '';
      for (const [id, label] of [
        ['system', '系统默认'],
        ['yahei', '微软雅黑 / 苹方'],
        ['songti', '衬线（宋体 / 思源宋体）'],
        ['mono', '等宽字体（全界面）']
      ]) {
        fontSelect.append(h('option', { value: id, selected: draft.font === id }, label));
      }
      for (const font of draft.customFonts || []) {
        fontSelect.append(
          h('option', { value: `custom:${font.id}`, selected: draft.font === `custom:${font.id}` }, `导入：${font.name}`)
        );
      }

      fontList.innerHTML = '';
      const list = draft.customFonts || [];
      if (!list.length) {
        fontList.append(
          h('div', { class: 'empty-hint', text: '还没有导入字体。支持 .ttf / .otf / .woff / .woff2，单个上限 12MB。' })
        );
        return;
      }
      for (const font of list) {
        fontList.append(
          h('div', { class: 'font-item' }, [
            h('span', { class: 'font-name', style: `font-family:"AIWB-${font.id}", var(--sans)`, text: font.name }),
            h('span', { class: 'font-meta', text: `${Math.round((font.size || 0) / 1024)} KB` }),
            h('div', { style: 'flex:1' }),
            h('button', {
              class: 'link-btn',
              onclick: () => {
                draft.font = `custom:${font.id}`;
                commit();
                renderFonts();
              }
            }, '用这个'),
            h('button', {
              class: 'link-btn',
              onclick: async () => {
                try {
                  await api.deleteFont(font.file);
                } catch {
                  /* 文件可能已经没了，继续清理设置 */
                }
                draft.customFonts = (draft.customFonts || []).filter((item) => item.id !== font.id);
                if (draft.font === `custom:${font.id}`) draft.font = 'system';
                commit();
                renderFonts();
                toast(`已删除字体：${font.name}`);
              }
            }, '删除')
          ])
        );
      }
    };

    fontInput.addEventListener('change', async () => {
      const file = fontInput.files?.[0];
      if (!file) return;
      try {
        const dataUrl = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(new Error('读取字体文件失败'));
          reader.readAsDataURL(file);
        });
        const uploaded = await api.uploadFont(file.name, dataUrl);
        draft.customFonts = [...(draft.customFonts || []), uploaded.font];
        draft.font = `custom:${uploaded.font.id}`;
        commit();
        renderFonts();
        toast(`已导入字体：${uploaded.font.name}`, 'ok');
      } catch (err) {
        toast(err.message, 'error');
      } finally {
        fontInput.value = '';
      }
    });
    renderFonts();

    /* 字号 */
    const sizeButtons = h('div', { class: 'seg' });
    const renderSizes = () => {
      sizeButtons.innerHTML = '';
      for (const step of FONT_SIZE_STEPS) {
        sizeButtons.append(
          h('button', {
            class: `seg-item${Math.abs(draft.fontSize - step.value) < 0.001 ? ' active' : ''}`,
            onclick: () => {
              draft.fontSize = step.value;
              commit();
              renderSizes();
            }
          }, step.label)
        );
      }
    };
    renderSizes();

    return h('div', {}, [
      h('div', { class: 'field' }, [
        h('label', { text: '主题' }),
        modeButtons,
        h('div', { class: 'desc', text: '「跟随系统」会跟着 Windows 的深浅色设置走。' })
      ]),
      h('div', { class: 'field' }, [
        h('label', { text: '主题色' }),
        h('div', { class: 'row' }, [swatches, colorInput]),
        h('div', { class: 'desc', text: '影响按钮、选中态、链接、译文标记等。也可以点右边取色器自定义任意颜色。' })
      ]),
      h('div', { class: 'field' }, [h('label', { text: '字体' }), fontSelect]),
      h('div', { class: 'field' }, [
        h('label', { text: '导入的字体' }),
        fontList,
        h('div', { class: 'row', style: 'margin-top:8px' }, [
          h('button', { class: 'btn', onclick: () => fontInput.click() }, '＋ 导入字体文件'),
          fontInput
        ]),
        h('div', { class: 'desc', text: '字体文件会存到 data\\fonts，跟着工作台走；换电脑时把整个 data 目录拷过去就行。' })
      ]),
      h('div', { class: 'field' }, [h('label', { text: '字号' }), sizeButtons]),
      h('div', { class: 'field' }, [
        h('div', {
          class: 'desc',
          text: '改动会立即生效并自动保存。下面是一段预览文字，可以直接看到效果。'
        })
      ]),
      h('div', { class: 'preview-box' }, [
        h('div', { class: 'pv-title', text: '示例对话标题' }),
        h('div', { class: 'pv-body md', html: '<p>正文文字看起来是这样的，<strong>重点内容</strong>会更粗，<code>行内代码</code>用等宽字体。</p>' }),
        h('div', { class: 'row', style: 'margin-top:10px' }, [
          h('button', { class: 'btn primary' }, '主要按钮'),
          h('button', { class: 'btn' }, '次要按钮'),
          h('span', { class: 'msg-badge', text: '标签' }),
          h('span', { class: 'status ok', text: '● 就绪' })
        ])
      ]),
      h('div', { class: 'row', style: 'margin-top:14px' }, [
        h('button', {
          class: 'btn',
          onclick: () => {
            Object.assign(draft, APPEARANCE_DEFAULTS);
            commit();
            renderModes();
            renderSwatches();
            renderSizes();
            fontSelect.value = draft.font;
            colorInput.value = draft.accent;
            toast('已恢复默认外观', 'ok');
          }
        }, '恢复默认')
      ])
    ]);
  }

  function keysTab() {
    const wrap = h('div', {});
    const cloud = state.engines.filter((e) => e.kind === 'openai');
    if (!cloud.length) wrap.append(h('div', { class: 'empty-hint', text: '没有 OpenAI 兼容引擎' }));
    const inputs = {};
    for (const engine of cloud) {
      const input = h('input', {
        type: 'password',
        placeholder: state.hasKeys?.[engine.id] ? '已保存，留空则不修改' : '粘贴 API Key',
        autocomplete: 'off'
      });
      inputs[engine.id] = input;
      wrap.append(
        h('div', { class: 'field' }, [
          h('label', { text: engine.label }),
          h('div', { class: 'row' }, [
            input,
            h('button', {
              class: 'btn',
              onclick: async () => {
                try {
                  const result = await api.probeEngine(engine.id);
                  toast(`${engine.label}：${result.probe?.ok ? '连接成功' : `失败 ${result.probe?.error || result.probe?.status || ''}`}`, result.probe?.ok ? 'ok' : 'error');
                } catch (err) {
                  toast(err.message, 'error');
                }
              }
            }, '测试连接')
          ]),
          h('div', { class: 'desc', text: `${engine.baseUrl || '未配置 baseUrl'}${engine.needsApiKey ? '' : '（本地服务，通常不需要 Key）'}` })
        ])
      );
    }
    wrap.append(
      h('button', {
        class: 'btn primary',
        onclick: async () => {
          const apiKeys = {};
          for (const [id, input] of Object.entries(inputs)) {
            if (input.value.trim()) apiKeys[id] = input.value.trim();
          }
          if (Object.keys(apiKeys).length) await api.saveSettings({ apiKeys });
          await loadSettings();
          await loadEngines();
          toast('已保存密钥', 'ok');
        }
      }, '保存密钥')
    );
    return wrap;
  }

  function fallbackTab() {
    const fallback = { ...(state.settings.fallback || {}) };
    let order = Array.isArray(fallback.engines) ? [...fallback.engines] : [];
    const enabled = h('input', { type: 'checkbox', checked: fallback.enabled !== false });
    const attempts = h('input', { type: 'number', min: '1', max: '4', value: fallback.maxAttempts ?? 2 });
    const deleteSourceToggle = h('input', {
      type: 'checkbox',
      checked: state.settings.syncDelete?.removeSource !== false
    });
    const orderBox = h('div', { class: 'entry-list' });

    const renderOrder = () => {
      orderBox.innerHTML = '';
      if (!order.length) orderBox.append(h('div', { class: 'empty-hint', text: '还没有配置接手引擎' }));
      order.forEach((id, index) => {
        const engine = engineById(id);
        orderBox.append(
          h('div', { class: 'source-card' }, [
            h('div', { class: 'source-head' }, [
              h('span', { class: 'msg-badge', text: `第 ${index + 1} 顺位` }),
              h('strong', { text: engine?.label || id }),
              h('span', {
                class: `status ${engine?.available ? 'ok' : 'bad'}`,
                text: engine?.available ? '● 可用' : '○ 当前不可用'
              }),
              h('div', { style: 'flex:1' }),
              h('button', {
                class: 'link-btn',
                onclick: () => {
                  if (index === 0) return;
                  [order[index - 1], order[index]] = [order[index], order[index - 1]];
                  renderOrder();
                }
              }, '↑'),
              h('button', {
                class: 'link-btn',
                onclick: () => {
                  if (index === order.length - 1) return;
                  [order[index + 1], order[index]] = [order[index], order[index + 1]];
                  renderOrder();
                }
              }, '↓'),
              h('button', {
                class: 'link-btn',
                onclick: () => {
                  order = order.filter((x) => x !== id);
                  renderOrder();
                  renderAdd();
                }
              }, '移除')
            ])
          ])
        );
      });
    };

    const addSelect = h('select', {});
    const renderAdd = () => {
      addSelect.innerHTML = '';
      const rest = chatEngines().filter((engine) => !order.includes(engine.id));
      for (const engine of rest) addSelect.append(h('option', { value: engine.id }, engine.label));
      if (!rest.length) addSelect.append(h('option', { value: '' }, '（没有可添加的引擎了）'));
    };

    const langSelect = h(
      'select',
      {},
      (state.targetLangs || []).map((lang) =>
        h('option', { value: lang, selected: lang === (state.settings.translation?.targetLang || '简体中文') }, lang)
      )
    );
    const translateEngine = h('select', {});
    translateEngine.append(h('option', { value: 'auto' }, '自动（优先本机 Ollama）'));
    for (const engine of chatEngines()) {
      translateEngine.append(
        h('option', { value: engine.id, selected: engine.id === state.settings.translation?.engineId }, engine.label)
      );
    }

    renderOrder();
    renderAdd();

    return h('div', {}, [
      h('div', { class: 'field' }, [
        h('label', { class: 'switch' }, [enabled, '报错时自动换模型接手']),
        h('div', {
          class: 'desc',
          text: '引擎报错（登录失效、限流、网络不通…）时，按下面的顺序找第一个能用的模型接着完成你的请求，并在对话里留下记录。'
        })
      ]),
      h('div', { class: 'field' }, [
        h('label', { text: '最多换几次' }),
        attempts,
        h('div', { class: 'desc', text: '一次请求里最多连续接手几次，避免无限重试。' })
      ]),
      h('div', { class: 'field' }, [
        h('label', { text: '接手顺序' }),
        orderBox,
        h('div', { class: 'row', style: 'margin-top:8px' }, [
          addSelect,
          h('button', {
            class: 'btn',
            onclick: () => {
              if (!addSelect.value) return;
              order = [...order, addSelect.value];
              renderOrder();
              renderAdd();
            }
          }, '添加')
        ])
      ]),
      h('hr', { style: 'border:none;border-top:1px solid var(--border-soft);margin:18px 0' }),
      h('div', { class: 'field' }, [h('label', { text: '翻译默认目标语言' }), langSelect]),
      h('div', { class: 'field' }, [
        h('label', { text: '翻译默认引擎' }),
        translateEngine,
        h('div', { class: 'desc', text: '建议用本机 Ollama：翻译量大时不消耗额度，也不受网络影响。' })
      ]),
      h('div', { class: 'field' }, [
        h('div', { class: 'desc', text: '报错后除了自动接手，也可以在报错那条消息上点「🛠 修复这个报错」：工作台会按错误类型挑一个能读写本机文件的模型，让它去查日志、改配置、把问题真正修好。' })
      ]),
      h('hr', { style: 'border:none;border-top:1px solid var(--border-soft);margin:18px 0' }),
      h('div', { class: 'field' }, [
        h('label', { class: 'switch' }, [
          deleteSourceToggle,
          '删除导入的对话时，同时从源软件移除'
        ]),
        h('div', {
          class: 'desc',
          text: '开着的话，你在工作台删掉一个从 Codex / Claude Code / dsh 导入的对话，源软件里的记录也会被移走（不是硬删除，是移到 data\\trash，删除后 9 秒内的提示里能一键撤回）。关掉就只删工作台里的副本。'
        })
      ]),
      h('button', {
        class: 'btn primary',
        onclick: async () => {
          await api.saveSettings({
            fallback: {
              enabled: enabled.checked,
              engines: order,
              maxAttempts: Number(attempts.value) || 2
            },
            translation: {
              engineId: translateEngine.value || 'auto',
              targetLang: langSelect.value
            },
            syncDelete: {
              removeSource: deleteSourceToggle.checked
            }
          });
          await loadSettings();
          toast('已保存', 'ok');
        }
      }, '保存翻译与容错设置')
    ]);
  }

  function memoryTab() {
    const global = h('textarea', { placeholder: '写给所有模型的长期记忆，例如：我是前端工程师，项目用 pnpm…' });
    global.value = state.memory.global || '';
    const tagInput = h('input', { type: 'text', placeholder: '标签，例如：项目A' });
    const noteInput = h('textarea', { placeholder: '一条记忆内容' });
    const list = h('div', { class: 'entry-list' });

    const renderNotes = () => {
      list.innerHTML = '';
      const notes = state.memory.notes || [];
      if (!notes.length) list.append(h('div', { class: 'empty-hint', text: '还没有记忆条目' }));
      notes.forEach((note, index) => {
        list.append(
          h('div', { class: 'source-card' }, [
            h('div', { class: 'source-head' }, [
              h('span', { class: 'msg-badge', text: note.tag || '通用' }),
              h('div', { style: 'flex:1' }),
              h('button', {
                class: 'link-btn',
                onclick: async () => {
                  state.memory.notes.splice(index, 1);
                  await api.saveMemory({ notes: state.memory.notes });
                  renderNotes();
                }
              }, '删除')
            ]),
            h('div', { class: 'desc', text: note.text })
          ])
        );
      });
    };
    renderNotes();

    return h('div', {}, [
      h('div', { class: 'field' }, [h('label', { text: '全局记忆（每次对话都会带上）' }), global]),
      h('div', { class: 'field' }, [
        h('label', { text: '新增记忆条目' }),
        h('div', { class: 'row' }, [tagInput, h('button', {
          class: 'btn',
          onclick: async () => {
            const text = noteInput.value.trim();
            if (!text) return;
            state.memory.notes = [...(state.memory.notes || []), { tag: tagInput.value.trim() || '通用', text, at: new Date().toISOString() }];
            await api.saveMemory({ notes: state.memory.notes });
            noteInput.value = '';
            renderNotes();
          }
        }, '添加')])
      ]),
      noteInput,
      h('div', { style: 'height:12px' }),
      list,
      h('div', { style: 'height:12px' }),
      h('button', {
        class: 'btn primary',
        onclick: async () => {
          state.memory.global = global.value;
          state.memory = await api.saveMemory({ global: global.value, notes: state.memory.notes || [] });
          toast('记忆已保存', 'ok');
        }
      }, '保存全局记忆')
    ]);
  }

  function appsTab() {
    const pathInput = h('input', { type: 'text', placeholder: 'C:\\Path\\to\\program.exe' });
    const labelInput = h('input', { type: 'text', placeholder: '显示名称（可留空）' });
    const list = h('div', { class: 'entry-list' });

    const renderApps = () => {
      list.innerHTML = '';
      for (const engine of appEngines()) {
        list.append(
          h('div', { class: 'source-card' }, [
            h('div', { class: 'source-head' }, [
              h('strong', { text: engine.label }),
              h('span', { class: `status ${engine.available ? 'ok' : 'bad'}`, text: engine.available ? '● 可用' : '○ 未找到' }),
              h('div', { style: 'flex:1' }),
              h('button', {
                class: 'link-btn',
                onclick: async () => {
                  try {
                    await api.launchApp(engine.id);
                    toast(`已启动 ${engine.label}`, 'ok');
                  } catch (err) {
                    toast(err.message, 'error');
                  }
                }
              }, '启动')
            ]),
            h('div', { class: 'source-path', text: engine.detail || engine.command || '' })
          ])
        );
      }
    };
    renderApps();

    return h('div', {}, [
      h('div', { class: 'desc', text: '把任意本地 exe（比如千问桌面版、Kimi、Cherry Studio）加进来，就能在工作台里一键启动。' }),
      h('div', { style: 'height:12px' }),
      list,
      h('div', { style: 'height:12px' }),
      h('div', { class: 'field' }, [h('label', { text: '程序路径' }), pathInput]),
      h('div', { class: 'field' }, [h('label', { text: '显示名称' }), labelInput]),
      h('button', {
        class: 'btn primary',
        onclick: async () => {
          const command = pathInput.value.trim();
          if (!command) {
            toast('请填写程序路径', 'error');
            return;
          }
          const customApps = [...(state.settings.customApps || [])];
          customApps.push({ id: `app-${Date.now()}`, label: labelInput.value.trim() || command.split(/[\\/]/).pop(), command });
          await api.saveSettings({ customApps });
          await Promise.all([loadSettings(), loadEngines()]);
          pathInput.value = '';
          labelInput.value = '';
          renderApps();
          toast('已添加', 'ok');
        }
      }, '添加本地程序')
    ]);
  }

  function envTab() {
    const wrap = h('div', {});
    const statusBox = h('div', { class: 'entry-list' });
    const resolvedBox = h('div', { class: 'source-items', style: 'max-height:220px' });
    const editor = h('textarea', {
      placeholder: 'KEY=VALUE，一行一个。例如：\nHTTPS_PROXY=http://127.0.0.1:7890\nANTHROPIC_MODEL=deepseek-flash[1m]',
      style: 'min-height:110px'
    });
    editor.value = Object.entries(state.settings.engineEnv || {})
      .map(([key, value]) => `${key}=${value}`)
      .join('\n');

    const load = async () => {
      statusBox.innerHTML = '<div class="empty-hint">正在读取…</div>';
      resolvedBox.innerHTML = '';
      try {
        const info = await api.env();
        state.envInfo = info;
        statusBox.innerHTML = '';
        statusBox.append(
          h('div', { class: 'source-card' }, [
            h('div', { class: 'source-head' }, [
              h('span', { class: 'msg-badge', text: '终端环境' }),
              h('strong', { text: `${info.captured || 0} 个变量` }),
              h('span', { class: `status ${info.error ? 'bad' : 'ok'}`, text: info.error ? `✕ ${info.error}` : '● 已同步' })
            ]),
            h('div', { class: 'desc', text: info.at ? `最近同步：${relTime(info.at)}` : '还没同步' })
          ]),
          h('div', { class: 'source-card' }, [
            h('div', { class: 'source-head' }, [
              h('span', { class: 'msg-badge', text: 'profile 文件' }),
              h('strong', { text: `${info.profileVars || 0} 个变量` })
            ]),
            h('div', {
              class: 'desc',
              text: (info.profileFiles || []).length
                ? `从 ${info.profileFiles.map((f) => f.file.split('\\').pop()).join('、')} 里直接读出来的（就算执行策略禁止脚本运行也能生效）`
                : '没找到带环境变量的 profile 文件'
            })
          ])
        );
        for (const item of info.resolved || []) {
          resolvedBox.append(
            h('div', { class: 'source-item' }, [
              h('span', { class: 't' }, [
                h('div', { class: 'title', text: item.key }),
                h('div', { class: 'sub', text: item.value })
              ])
            ])
          );
        }
      } catch (err) {
        statusBox.innerHTML = '';
        statusBox.append(h('div', { class: 'empty-hint', text: err.message }));
      }
    };
    load();

    return h('div', {}, [
      h('div', { class: 'desc', text: '命令行引擎（Codex / Claude Code / 千问 …）是从工作台启动的，默认拿不到你在终端里设的环境变量——很多「终端里能用、工作台里报错」都是这个原因。这里会把它们同步过来。' }),
      h('div', { style: 'height:12px' }),
      statusBox,
      h('div', { class: 'row', style: 'margin:10px 0' }, [
        h('button', {
          class: 'btn',
          onclick: async () => {
            await api.refreshEnv();
            await load();
            toast('已重新同步环境变量', 'ok');
          }
        }, '重新同步'),
        h('span', { class: 'desc', text: '改动 profile 之后点一下这里' })
      ]),
      h('div', { class: 'field' }, [
        h('label', { text: '当前生效的关键变量' }),
        resolvedBox
      ]),
      h('hr', { style: 'border:none;border-top:1px solid var(--border-soft);margin:18px 0' }),
      h('div', { class: 'field' }, [
        h('label', { text: '额外环境变量（会注入所有引擎）' }),
        editor,
        h('div', { class: 'desc', text: '需要手动覆盖时写在这里，优先级高于 profile 和系统环境。密钥这类东西只保存在本机 data\\settings.json。' })
      ]),
      h('button', {
        class: 'btn primary',
        onclick: async () => {
          const engineEnv = {};
          for (const line of editor.value.split('\n')) {
            const text = line.trim();
            if (!text || text.startsWith('#')) continue;
            const idx = text.indexOf('=');
            if (idx < 1) continue;
            engineEnv[text.slice(0, idx).trim()] = text.slice(idx + 1).trim();
          }
          await api.saveSettings({ engineEnv });
          await loadSettings();
          await loadEngines();
          await load();
          toast(`已保存 ${Object.keys(engineEnv).length} 个环境变量`, 'ok');
        }
      }, '保存环境变量')
    ]);
  }

  function diagTab() {
    const list = h('div', { class: 'entry-list' });
    const renderDiag = () => {
      list.innerHTML = '';
      for (const engine of state.engines) {
        list.append(
          h('div', { class: 'source-card' }, [
            h('div', { class: 'source-head' }, [
              h('span', { class: 'badge', style: `background:${engine.accent};width:22px;height:22px;border-radius:6px;display:grid;place-items:center;font-size:10px;font-weight:700;color:#0c0c0f`, text: engine.badge }),
              h('strong', { text: engine.label }),
              h('span', { class: `status ${engine.available ? 'ok' : 'bad'}`, text: engine.available ? '● 就绪' : '○ 未就绪' }),
              h('div', { style: 'flex:1' }),
              h('button', {
                class: 'link-btn',
                onclick: async () => {
                  try {
                    const result = await api.probeEngine(engine.id);
                    const detail = result.probe?.output || result.probe?.error || (result.probe?.ok === false ? '失败' : '正常');
                    alert(`${engine.label}\n\n状态：${result.probe?.ok ? '正常' : '失败'}\n${detail}`);
                  } catch (err) {
                    alert(err.message);
                  }
                }
              }, '探测')
            ]),
            h('div', { class: 'source-path', text: `${engine.detail || ''}` }),
            engine.models?.length ? h('div', { class: 'desc', text: `模型：${engine.models.slice(0, 8).join(' / ')}${engine.models.length > 8 ? ' …' : ''}` }) : null,
            engine.notes ? h('div', { class: 'desc', text: engine.notes }) : null
          ])
        );
      }
    };
    renderDiag();
    return h('div', {}, [
      h('div', { class: 'desc', text: `引擎定义文件：${state.paths?.root || ''}\\config\\engines.json —— 改完刷新页面即可生效。` }),
      h('div', { style: 'height:12px' }),
      h('div', { class: 'row', style: 'margin-bottom:12px' }, [
        h('button', { class: 'btn', onclick: async () => { await loadEngines(); renderDiag(); toast('已重新探测', 'ok'); } }, '重新探测全部引擎')
      ]),
      list
    ]);
  }

  render();
  openModal({ title: '设置', body: h('div', {}, [tabs, body]), wide: true });
}

/* ==================== 初始化 ==================== */

function autoGrow(textarea) {
  textarea.style.height = 'auto';
  textarea.style.height = `${Math.min(textarea.scrollHeight, 260)}px`;
}

async function loadEngines() {
  const data = await api.engines();
  state.engines = data.engines;
  renderConversations();
  renderProjections();
  if (!state.current) renderThread();
  // 顺手体检当前引擎，这样点发送的时候不用等
  refreshEngineHealth(state.current?.engineId || state.settings.defaultEngineId).catch(() => {});
}

async function loadSettings() {
  const data = await api.settings();
  state.settings = data.settings;
  state.hasKeys = data.hasKeys;
  if (Array.isArray(data.targetLangs) && data.targetLangs.length) state.targetLangs = data.targetLangs;
  applyAppearance(data.settings.appearance);
  state.memory = await api.memory();
  renderProjections();
}

function bindUi() {
  $('#btn-new').addEventListener('click', () => newConversation());
  $('#btn-import').addEventListener('click', openImportModal);
  $('#btn-settings').addEventListener('click', openSettingsModal);
  $('#btn-apps').addEventListener('click', () => {
    const apps = appEngines();
    if (!apps.length) {
      toast('没有配置本地程序，去「设置 → 本地程序」添加', 'error');
      return;
    }
    openModal({
      title: '启动本地程序',
      body: h('div', { class: 'entry-list' }, apps.map((app) =>
        h('button', {
          class: 'picker-item',
          onclick: async () => {
            try {
              await api.launchApp(app.id);
              toast(`已启动 ${app.label}`, 'ok');
            } catch (err) {
              toast(err.message, 'error');
            }
          }
        }, [
          h('span', { class: 'badge', style: `background:${app.accent}` }, app.badge),
          h('span', { class: 'meta' }, [h('div', { class: 'n', text: app.label }), h('div', { class: 'd', text: app.detail || '' })]),
          h('span', { class: 'mark', text: app.available ? '●' : '○' })
        ])
      ))
    });
  });

  $('#btn-toggle-sidebar').addEventListener('click', () => $('#app').classList.toggle('collapsed'));
  $('#btn-toggle-drawer').addEventListener('click', () => $('#app').classList.toggle('drawer-open'));
  $('#btn-close-drawer').addEventListener('click', () => $('#app').classList.remove('drawer-open'));
  $('#btn-clear-log').addEventListener('click', () => {
    $('#drawer-body').innerHTML = '<div class="log-empty">已清空。发送消息后会显示新的日志。</div>';
  });
  $('#btn-refresh-engines').addEventListener('click', async () => {
    await loadEngines();
    toast('引擎状态已刷新', 'ok');
  });

  $('#search-input').addEventListener('input', (event) => {
    state.search = event.target.value.trim();
    refreshConversations();
  });

  $('#chip-engine').addEventListener('click', () =>
    openEnginePicker(async (engine) => {
      if (!state.current) {
        await newConversation(engine.id);
        return;
      }
      const id = state.current.id;
      await api.updateConversation(id, { engineId: engine.id });
      state.current.engineId = engine.id;
      await refreshConversations();
      renderProjections();
      renderThread();
      refreshEngineHealth(engine.id).catch(() => {});
      toast(`下一条消息将由 ${engine.label} 回答`, 'ok');
    }, { filter: (engine) => engine.kind !== 'app' })
  );

  $('#chip-model').addEventListener('click', () => {
    const engine = engineById(state.current?.engineId || state.settings.defaultEngineId);
    if (!engine) return;
    openModelPicker(engine, async (model) => {
      if (state.current) {
        await api.updateConversation(state.current.id, { model });
        state.current.model = model;
      }
      renderProjections();
    });
  });

  const changeCwd = () =>
    openDirPicker(state.current?.cwd || state.settings.cwd, async (dir) => {
      if (state.current) {
        await api.updateConversation(state.current.id, { cwd: dir });
        state.current.cwd = dir;
      }
      await api.saveSettings({ cwd: dir });
      state.settings.cwd = dir;
      renderProjections();
      toast('工作目录已更新', 'ok');
    });
  $('#chip-cwd').addEventListener('click', changeCwd);
  $('#composer-cwd').addEventListener('click', changeCwd);
  $('#composer-engine').addEventListener('click', () => $('#chip-engine').click());
  $('#composer-model').addEventListener('click', () => $('#chip-model').click());

  $('#sync-pill').addEventListener('click', async () => {
    const next = !state.sync.enabled;
    await api.syncConfig({ enabled: next, autoSync: { intervalSeconds: state.sync.intervalSeconds || 20 } });
    await loadSync();
    if (next) {
      $('#sync-pill').classList.add('busy');
      const report = await api.syncNow();
      await loadSync();
      await refreshConversations();
      toast(`自动同步已开启，本次导入 ${report.imported} 个、更新 ${report.updated} 个会话`, 'ok');
    } else {
      toast('自动同步已关闭');
    }
  });

  const input = $('#input');
  input.addEventListener('input', () => autoGrow(input));
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      send(input.value);
    }
  });
  $('#btn-send').addEventListener('click', () => send(input.value));
  $('#btn-stop').addEventListener('click', () => {
    const run = currentRun();
    if (run) {
      run.controller.abort();
      logLine('已请求停止', 'sys');
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.ctrlKey && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      $('#search-input').focus();
    }
    if (event.ctrlKey && event.key.toLowerCase() === 'n') {
      event.preventDefault();
      newConversation();
    }
  });
}

async function boot() {
  bindUi();
  await loadSettings();
  state.paths = await api.paths();
  await Promise.all([loadEngines(), refreshConversations(), loadSync()]);

  const match = location.hash.match(/^#\/c\/([\w-]+)$/);
  const target = match && state.conversations.some((c) => c.id === match[1]) ? match[1] : null;
  if (target) await selectConversation(target);
  else renderThread();

  subscribeEvents((event) => {
    if (event.type === 'conversations-changed') {
      refreshConversations();
      if (event.reason === 'sync') loadSync().catch(() => {});
    }
    if (event.type === 'sync') {
      logLine(`同步：${event.source} 新增 ${event.imported} / 更新 ${event.updated}`, 'sys');
      toast(`自动同步：「${event.source}」新增 ${event.imported} 个、更新 ${event.updated} 个会话`, 'ok');
      loadSync().catch(() => {});
      refreshConversations();
    }
  });

  setInterval(() => {
    refreshConversations().catch(() => {});
    loadSync().catch(() => {});
  }, 20000);
}

boot().catch((err) => {
  console.error(err);
  toast(`初始化失败：${err.message}`, 'error');
});
