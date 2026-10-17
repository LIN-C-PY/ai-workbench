async function request(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const err = new Error(data?.error || `${res.status} ${res.statusText}`);
    err.status = res.status;
    err.payload = data; // 体检失败时带上详细检查项
    throw err;
  }
  return data;
}

export const api = {
  health: () => request('GET', '/api/health'),
  engines: () => request('GET', '/api/engines'),
  probeEngine: (id) => request('POST', `/api/engines/${encodeURIComponent(id)}/probe`, {}),
  preflight: (id, force = false) =>
    request('GET', `/api/engines/${encodeURIComponent(id)}/preflight${force ? '?force=1' : ''}`),
  desktopSend: (engineId, text) => request('POST', '/api/desktop/send', { engineId, text }),
  engineModels: (id) => request('GET', `/api/engines/${encodeURIComponent(id)}/models`),

  conversations: (q = '') => request('GET', `/api/conversations${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  conversation: (id) => request('GET', `/api/conversations/${encodeURIComponent(id)}`),
  createConversation: (payload) => request('POST', '/api/conversations', payload),
  updateConversation: (id, patch) => request('PATCH', `/api/conversations/${encodeURIComponent(id)}`, patch),
  deleteConversation: (id) => request('DELETE', `/api/conversations/${encodeURIComponent(id)}`),
  addMessages: (id, messages) => request('POST', `/api/conversations/${encodeURIComponent(id)}/messages`, { messages }),
  updateMessage: (id, messageId, patch) =>
    request('PATCH', `/api/conversations/${encodeURIComponent(id)}/messages/${encodeURIComponent(messageId)}`, patch),
  deleteMessage: (id, messageId) =>
    request('DELETE', `/api/conversations/${encodeURIComponent(id)}/messages/${encodeURIComponent(messageId)}`),

  historySources: () => request('GET', '/api/history/sources'),
  scanSource: (id) => request('GET', `/api/history/scan?source=${encodeURIComponent(id)}`),
  importRefs: (source, refs) => request('POST', '/api/history/import', { source, refs }),
  importFile: (path) => request('POST', '/api/import/file', { path }),
  uploadImport: (name, content) => request('POST', '/api/import/upload', { name, content }),

  syncStatus: () => request('GET', '/api/sync/status'),
  syncNow: () => request('POST', '/api/sync/now', {}),
  syncConfig: (payload) => request('POST', '/api/sync/config', payload),
  trashUndo: (trashPath, ref) => request('POST', '/api/trash/undo', { trashPath, ref }),
  fonts: () => request('GET', '/api/fonts'),
  uploadFont: (name, data) => request('POST', '/api/fonts', { name, data }),
  deleteFont: (file) => request('DELETE', `/api/fonts/${encodeURIComponent(file)}`),
  env: () => request('GET', '/api/env'),
  refreshEnv: () => request('POST', '/api/env/refresh', {}),

  settings: () => request('GET', '/api/settings'),
  saveSettings: (patch) => request('PATCH', '/api/settings', patch),
  memory: () => request('GET', '/api/memory'),
  saveMemory: (patch) => request('PATCH', '/api/memory', patch),

  launchApp: (id) => request('POST', '/api/apps/launch', { id }),
  reveal: (path) => request('POST', '/api/shell/reveal', { path }),
  listDirs: (path) => request('GET', `/api/fs/list?path=${encodeURIComponent(path || '')}`),
  mkdir: (parent, name) => request('POST', '/api/fs/mkdir', { parent, name }),
  paths: () => request('GET', '/api/paths')
};

/**
 * 发起一次对话，按 SSE 逐条回调。
 * @param {object} payload
 * @param {(event:object)=>void} onEvent
 * @param {AbortSignal} signal
 */
/** 发一个会产生 SSE 流的事件请求，逐条回调。 */
export async function streamPost(path, payload, onEvent, signal) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal
  });

  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => '');
    let parsed = null;
    try {
      parsed = detail ? JSON.parse(detail) : null;
    } catch {
      parsed = null;
    }
    const err = new Error(parsed?.error || detail || `请求失败：${res.status}`);
    err.status = res.status;
    err.payload = parsed;
    throw err;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';
    for (const frame of frames) {
      const line = frame.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;
      try {
        onEvent(JSON.parse(line.slice(5).trim()));
      } catch {
        /* 忽略无法解析的帧 */
      }
    }
  }
}

export const streamChat = (payload, onEvent, signal) => streamPost('/api/chat', payload, onEvent, signal);
export const streamTranslate = (payload, onEvent, signal) => streamPost('/api/translate', payload, onEvent, signal);

/** 订阅服务端事件（同步完成、导入完成等）。 */
export function subscribeEvents(onEvent) {
  const source = new EventSource('/api/events');
  source.onmessage = (message) => {
    try {
      onEvent(JSON.parse(message.data));
    } catch {
      /* ignore */
    }
  };
  source.onerror = () => {
    /* 浏览器会自动重连 */
  };
  return source;
}
