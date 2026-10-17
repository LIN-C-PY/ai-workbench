import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { URL } from 'node:url';

import {
  CONFIG_FILE,
  DATA_DIR,
  FONT_DIR,
  ROOT,
  RUN_DIR,
  WEB_DIR,
  ensureDirs,
  findEngine,
  listEngines,
  listHistorySources,
  loadMemory,
  loadSettings,
  saveMemory,
  saveSettings
} from './config.mjs';
import {
  buildSpawn,
  canRun,
  detectEngine,
  discoverModels,
  engineApiKey,
  engineCards,
  fetchModels,
  findEngineAny,
  launchApp,
  preflight,
  resolvePath,
  staticModels
} from './engines.mjs';
import { buildCliPrompt, buildOpenAIMessages } from './context.mjs';
import { runCli, runOpenAI } from './run.mjs';
import { classifyFailure, fallbackPrompt, repairCandidateOrder, repairPrompt } from './health.mjs';
import { captureUserEnvironment, ensureEnvCaptured, envStatus, resolveEngineEnv } from './env.mjs';
import { TARGET_LANGS, cleanTranslation, translationPrompt } from './translate.mjs';
import {
  describeRef,
  forgetSyncRef,
  importFile,
  importRefs,
  removeSourceFile,
  restoreFromTrash,
  scanAllSources,
  scanSource,
  startSyncLoop,
  stopSyncLoop,
  syncOnce,
  syncStatus
} from './history.mjs';
import {
  appendMessage,
  clearImportedMarks,
  createConversation,
  deleteConversation,
  getConversation,
  listConversations,
  markIgnoredImport,
  newId,
  saveConversation,
  searchConversations,
  updateConversation
} from './store.mjs';

const PORT = Number(process.env.PORT || 4317);
const HOST = process.env.HOST || '127.0.0.1';

ensureDirs();

/* ---------- 全局事件广播（同步提醒、启动通知） ---------- */
const eventClients = new Set();
function broadcast(payload) {
  const chunk = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of eventClients) {
    try {
      res.write(chunk);
    } catch {
      eventClients.delete(res);
    }
  }
}

/* ---------- 工具函数 ---------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

/** 给界面看的时候把密钥遮掉 */
function maskSecret(key, value) {
  const text = String(value ?? '');
  if (!text) return '';
  if (/TOKEN|KEY|SECRET|PASSWORD/i.test(key)) {
    return text.length > 10 ? `${text.slice(0, 6)}…${text.slice(-4)}` : '已设置';
  }
  return text.length > 140 ? `${text.slice(0, 140)}…` : text;
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body ?? null);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store'
  });
  res.end(payload);
}

async function readBody(req, limit = 32 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('请求体过大');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('请求体不是合法 JSON');
  }
}

function openSse(req, res, onClose) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write(': connected\n\n');
  const keepAlive = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      /* ignore */
    }
  }, 20000);
  if (keepAlive.unref) keepAlive.unref();
  const cleanup = () => {
    clearInterval(keepAlive);
    if (onClose) onClose();
  };
  req.on('close', cleanup);
  res.on('close', cleanup);
  return {
    send(event) {
      if (res.writableEnded || res.destroyed) return;
      try {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch {
        /* 客户端已经断开 */
      }
    },
    close() {
      cleanup();
      try {
        res.end();
      } catch {
        /* ignore */
      }
    }
  };
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const target = path.join(WEB_DIR, path.normalize(rel).replace(/^([/\\])+/, ''));
  if (!target.startsWith(WEB_DIR)) {
    sendJson(res, 403, { error: 'forbidden' });
    return;
  }
  fs.readFile(target, (err, data) => {
    if (err) {
      // 单页应用回退
      if (!path.extname(target)) {
        fs.readFile(path.join(WEB_DIR, 'index.html'), (err2, html) => {
          if (err2) sendJson(res, 404, { error: 'not found' });
          else {
            res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' });
            res.end(html);
          }
        });
        return;
      }
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    // 本地开发，宁可每次都重新校验，避免改了前端却拿到旧缓存
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(data);
  });
}

/* ---------- 会话引擎状态 ---------- */

function rememberSession(conv, engineId, sessionId) {
  if (!sessionId) return;
  conv.sessions = { ...(conv.sessions || {}), [engineId]: sessionId };
  saveConversation(conv);
}

/* ---------- 单次提问（翻译等场景复用） ---------- */

async function runEnginePrompt(engine, prompt, { cwd, signal, model = '', runId = newId() } = {}) {
  if (engine.kind === 'openai') {
    return runOpenAI({
      engine,
      model,
      messages: [{ role: 'user', content: prompt }],
      onEvent: () => {},
      signal,
      runId
    });
  }
  const spec = buildSpawn(engine, { prompt, model, cwd, sessionId: '' });
  return runCli({ engine, spec, runId, onEvent: () => {}, signal, timeoutMs: 5 * 60 * 1000 });
}

async function probeReachable(engine) {
  const url =
    engine.modelsEndpoint || (engine.baseUrl ? `${String(engine.baseUrl).replace(/\/+$/, '')}/models` : null);
  if (!url) return true;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

/** 挑翻译用的引擎：优先本机 Ollama（免费、快），其次当前会话引擎。 */
async function pickTranslationEngine(requestedId, conv, settings) {
  const ordered = [];
  const push = (engine) => {
    if (engine && !ordered.some((e) => e.id === engine.id)) ordered.push(engine);
  };
  if (requestedId) push(findEngine(requestedId));
  const configured = settings.translation?.engineId;
  if (configured && configured !== 'auto') push(findEngine(configured));
  push(findEngine('ollama'));
  push(findEngine(conv.engineId));
      for (const id of settings.fallback?.engines || []) push(findEngine(id));

  for (const engine of ordered) {
    if (!canRun(engine)) continue;
    if (engine.kind === 'openai') {
      if (await probeReachable(engine)) return engine;
      continue;
    }
    return engine;
  }
  return ordered.find((engine) => canRun(engine)) || null;
}

/**
 * 自动挑模型：本机模型从名字里读参数量，挑最小的那个。
 * （CPU 上跑 14B 会比 7B 慢好几倍，翻译没必要用大模型。）
 */
function autoModelFor(engine, settings) {
  if (!engine || engine.kind !== 'openai') return '';
  const models = staticModels(engine, settings);
  if (!models.length) return '';
  const paramSize = (name) => {
    const match = String(name).match(/(\d+(?:\.\d+)?)\s*b(?![\w])/i);
    return match ? Number(match[1]) : 9999;
  };
  return [...models].sort((a, b) => paramSize(a) - paramSize(b))[0];
}

/* ---------- 跑一个引擎并把事件转成 SSE（对话 / 翻译 / 修复共用） ---------- */

async function runEngineStreaming(engine, prompt, {
  conv,
  settings,
  sse,
  signal,
  runId,
  withHistory = true,
  sessionId = '',
  model = ''
}) {
  if (engine.kind === 'openai') {
    const messages = withHistory
      ? buildOpenAIMessages(conv, { prompt, settings })
      : [
          { role: 'system', content: '你是排障工程师，可以直接读写本机的文件和执行命令。只输出必要的说明与结论。' },
          { role: 'user', content: prompt }
        ];
    return runOpenAI({
      engine,
      model: model || conv?.model || '',
      messages,
      onEvent: (event) => sse.send(event),
      signal,
      runId
    });
  }

  const useResume = Boolean(sessionId) && Array.isArray(engine.resumeArgs) && engine.resumeArgs.length > 0;
  const cliPrompt = withHistory
    ? buildCliPrompt(conv, { prompt, useResume, engine, settings })
    : prompt;
  const spec = buildSpawn(engine, {
    prompt: cliPrompt,
    model: model || conv?.model || '',
    cwd: conv?.cwd || settings.cwd,
    sessionId: useResume ? sessionId : ''
  });
  return runCli({ engine, spec, runId, onEvent: (event) => sse.send(event), signal });
}

/* ---------- 报错修复：挑一个匹配的模型去把问题修好 ---------- */

/**
 * 换一个「体检合格」的引擎。
 * 和报错接手的区别：这是在**动手之前**就把不可用的挡掉，所以用户根本看不到报错。
 */
async function pickWorkingFallback(settings, failedId, extraIds = []) {
  const ids = [...new Set([...(extraIds || []), ...(settings.fallback?.engines || [])])];
  for (const id of ids) {
    if (!id || id === failedId) continue;
    const candidate = findEngine(id);
    if (!candidate || !canRun(candidate)) continue;
    const check = await preflight(candidate);
    if (check.ok) return candidate;
  }
  return null;
}

async function handleRepair(req, res) {
  const body = await readBody(req);
  const settings = loadSettings();
  let conv = body.conversationId ? getConversation(body.conversationId) : null;
  if (!conv) {
    sendJson(res, 400, { error: '会话不存在' });
    return;
  }

  const failure = {
    kind: body.failure?.kind || 'engine',
    message: body.failure?.message || '未知错误',
    hint: body.failure?.hint || ''
  };
  const failedEngine = findEngine(body.engineId || conv.engineId) || null;

  // 按错误类型匹配候选，再挑第一个真的能跑的
  let repairEngine = body.repairEngineId ? findEngine(body.repairEngineId) : null;
  let matchedFrom = repairEngine ? 'manual' : null;
  if (!repairEngine || !canRun(repairEngine)) {
    const candidates = repairCandidateOrder(failure, settings);
    const picked = candidates
      .filter((id) => id !== failedEngine?.id)
      .map((id) => findEngine(id))
      .find((candidate) => candidate && canRun(candidate));
    if (picked) {
      repairEngine = picked;
      matchedFrom = 'matched';
    }
  }

  if (!repairEngine) {
    sendJson(res, 400, { error: '找不到可用的修复模型：先在「设置 → API Key」配一个，或启动 Ollama。' });
    return;
  }

  const targetLabel = failedEngine?.label || body.engineId || '未知引擎';
  appendMessage(conv.id, {
    role: 'system',
    content: `开始用「${repairEngine.label || repairEngine.id}」修复「${targetLabel}」的报错（${failure.kind}：${failure.message}）。`,
    meta: { repair: true, repairWith: repairEngine.id, target: failedEngine?.id || body.engineId, failure }
  });
  conv = getConversation(conv.id);

  const spec = failedEngine
    ? buildSpawn(failedEngine, { prompt: '<prompt>', model: conv.model, cwd: conv.cwd || settings.cwd })
    : null;
  const prompt = repairPrompt({
    engine: failedEngine || { id: body.engineId, label: targetLabel },
    spec,
    failure,
    request: body.request || '',
    paths: { cwd: conv.cwd || settings.cwd, config: CONFIG_FILE, runDir: RUN_DIR, dataDir: DATA_DIR }
  });

  const runId = newId();
  const controller = new AbortController();
  const sse = openSse(req, res, () => controller.abort());
  sse.send({
    type: 'start',
    runId,
    conversationId: conv.id,
    engineId: repairEngine.id,
    repair: true,
    matchedFrom,
    targetEngine: failedEngine?.id || body.engineId || null,
    failure
  });

  let result = { text: '', errors: [] };
  try {
    result = await runEngineStreaming(repairEngine, prompt, {
      conv,
      settings,
      sse,
      signal: controller.signal,
      runId,
      withHistory: false
    });
  } catch (err) {
    sse.send({ type: 'error', message: err?.message || String(err) });
  }

  const text = String(result.text || '').trim();
  const failureAfter = classifyFailure(result);
  if (text) {
    appendMessage(conv.id, {
      role: 'assistant',
      content: text,
      engineId: repairEngine.id,
      model: conv.model,
      runId,
      meta: {
        repair: true,
        repairTarget: failedEngine?.id || body.engineId || null,
        sessionId: result.sessionId || null,
        failure: failureAfter ? { kind: failureAfter.kind, message: failureAfter.message, hint: failureAfter.hint } : null
      }
    });
  } else {
    appendMessage(conv.id, {
      role: 'system',
      content: `「${repairEngine.label}」也没跑出结果（${failureAfter?.message || '没有输出'}）。可以换一个模型再试。`,
      meta: { repair: true, repairWith: repairEngine.id, target: failedEngine?.id || body.engineId || null, failure: failureAfter }
    });
  }
  if (result.sessionId) {
    rememberSession(getConversation(conv.id), repairEngine.id, result.sessionId);
  }

  sse.send({
    type: 'done',
    runId,
    text,
    engineId: repairEngine.id,
    repair: true,
    targetEngine: failedEngine?.id || body.engineId || null,
    empty: !text
  });
  sse.close();
}

/* ---------- 翻译 ---------- */

/* ---------- 桌面客户端：直接调本机装的软件 ---------- */

/**
 * 把消息送到桌面客户端的输入框里（打开/聚焦窗口 → 粘贴 → 回车）。
 * 客户端不会把回复吐回来，所以前端会提供一个「把回复贴回来」的补录入口。
 */
async function handleDesktopSend(req, res) {
  const body = await readBody(req);
  const engine = findEngine(body.engineId);
  if (!engine || engine.kind !== 'desktop') {
    sendJson(res, 400, { error: '这个引擎不是桌面客户端' });
    return;
  }

  const text = String(body.text || '').trim();
  if (!text) {
    sendJson(res, 400, { error: '消息内容为空' });
    return;
  }

  // 动手之前先确认客户端在不在
  const check = await preflight(engine);
  if (!check.ok) {
    sendJson(res, 409, { error: `${engine.label || engine.id} 现在用不了`, preflight: check });
    return;
  }

  const target = resolvePath(engine.command);
  if (!fs.existsSync(target)) {
    sendJson(res, 400, { error: `找不到客户端：${target}` });
    return;
  }

  const tmpDir = path.join(DATA_DIR, 'tmp');
  fs.mkdirSync(tmpDir, { recursive: true });
  const tmpFile = path.join(tmpDir, `desktop-${Date.now()}.txt`);
  fs.writeFileSync(tmpFile, text, 'utf8');

  const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;
  const processName = path.basename(target, path.extname(target));
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$exe = ${quote(target)}`,
    `$name = ${quote(processName)}`,
    `$tmp = ${quote(tmpFile)}`,
    'function Find-Window { Get-Process -Name $name -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1 }',
    '$proc = Find-Window',
    'if (-not $proc) {',
    '  Start-Process -FilePath $exe',
    '  for ($i = 0; $i -lt 40; $i++) { Start-Sleep -Milliseconds 500; $proc = Find-Window; if ($proc) { break } }',
    '}',
    "if (-not $proc) { Write-Output 'NOWINDOW'; exit 3 }",
    '$shell = New-Object -ComObject WScript.Shell',
    '$focused = $false',
    'for ($i = 0; $i -lt 6; $i++) {',
    '  $focused = $shell.AppActivate($proc.Id)',
    '  Start-Sleep -Milliseconds 450',
    '  if ($focused) { break }',
    '}',
    "if (-not $focused) { Write-Output 'NOFOCUS'; exit 4 }",
    'Start-Sleep -Milliseconds 700',
    'Set-Clipboard -Value (Get-Content -Raw -LiteralPath $tmp)',
    'Start-Sleep -Milliseconds 400',
    "$shell.SendKeys('^v')",
    'Start-Sleep -Milliseconds 900',
    "$shell.SendKeys('{ENTER}')",
    'Start-Sleep -Milliseconds 1200',
    "Write-Output 'OK'"
  ].join('\n');

  const output = await new Promise((resolve) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true }
    );
    let out = '';
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      resolve('TIMEOUT');
    }, 45000);
    child.stdout.on('data', (d) => {
      out += d.toString();
    });
    child.stderr.on('data', (d) => {
      out += d.toString();
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve(`ERROR ${err.message}`);
    });
    child.on('close', () => {
      clearTimeout(timer);
      resolve(out.trim());
    });
  });

  try {
    fs.rmSync(tmpFile, { force: true });
  } catch {
    /* ignore */
  }

  if (output.includes('OK')) {
    sendJson(res, 200, { ok: true, processName, target });
    return;
  }
  const reason = output.includes('NOWINDOW')
    ? '客户端启动了但没找到窗口（可能被最小化到托盘了），手动打开一下再试'
    : output.includes('NOFOCUS')
      ? '窗口没能切到前台（可能被别的窗口挡住或没抢到焦点），把客户端点到最前面再试一次'
    : output.includes('TIMEOUT')
      ? '发送超时'
      : output.split('\n').slice(-2).join(' ').slice(0, 200) || '发送失败';
  sendJson(res, 500, { error: reason, raw: output.slice(0, 400) });
}

async function handleTranslate(req, res) {
  const body = await readBody(req);
  const settings = loadSettings();
  const conv = body.conversationId ? getConversation(body.conversationId) : null;
  if (!conv) {
    sendJson(res, 400, { error: '会话不存在' });
    return;
  }

  const targetLang = String(body.targetLang || settings.translation?.targetLang || '简体中文');
  const engine = await pickTranslationEngine(body.engineId, conv, settings);
  if (!engine) {
    sendJson(res, 400, { error: '没有可用的翻译引擎。请先启动 Ollama，或在「设置 → API Key」里配一个模型。' });
    return;
  }
  const model = String(body.model || settings.translation?.model || autoModelFor(engine, settings) || '');
  const timeoutMs = Math.min(Math.max(Number(body.timeoutMs) || 90000, 10000), 600000);

  const translatable = (conv.messages || []).filter(
    (m) => (m.role === 'user' || m.role === 'assistant') && String(m.content || '').trim()
  );
  const requested = Array.isArray(body.messageIds) && body.messageIds.length
    ? translatable.filter((m) => body.messageIds.includes(m.id))
    : translatable.filter((m) => body.onlyMissing !== false ? !m.meta?.translation : true);

  const limit = Math.min(Math.max(Number(body.limit) || 40, 1), 200);
  const queue = requested.slice(0, limit);

  const controller = new AbortController();
  const sse = openSse(req, res, () => controller.abort());
  sse.send({
    type: 'translate-start',
    total: queue.length,
    skipped: Math.max(0, requested.length - queue.length),
    targetLang,
    engineId: engine.id,
    engineLabel: engine.label || engine.id,
    model: model || null,
    conversationId: conv.id
  });

  let done = 0;
  let failed = 0;

  for (const target of queue) {
    if (controller.signal.aborted) break;
    const current = getConversation(conv.id);
    const message = (current.messages || []).find((m) => m.id === target.id);
    const text = String(message?.content || '').trim();
    if (!text) continue;

    sse.send({ type: 'translate-progress', messageId: target.id, done, total: queue.length });
    try {
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]);
      const result = await runEnginePrompt(engine, translationPrompt(text, targetLang), {
        cwd: conv.cwd || settings.cwd,
        signal,
        model
      });
      const translated = cleanTranslation(result.text);
      if (!translated) {
        failed += 1;
        sse.send({
          type: 'translate-error',
          messageId: target.id,
          message: result.errors?.[0] || (result.signalled ? '超时或已取消' : '引擎没有返回译文')
        });
        continue;
      }

      const latest = getConversation(conv.id);
      const idx = (latest.messages || []).findIndex((m) => m.id === target.id);
      if (idx >= 0) {
        latest.messages[idx].meta = {
          ...(latest.messages[idx].meta || {}),
          translation: {
            lang: targetLang,
            text: translated,
            engineId: engine.id,
            at: new Date().toISOString()
          }
        };
        saveConversation(latest);
      }
      done += 1;
      sse.send({ type: 'translated', messageId: target.id, lang: targetLang, text: translated, engineId: engine.id });
    } catch (err) {
      failed += 1;
      sse.send({ type: 'translate-error', messageId: target.id, message: err?.message || String(err) });
    }
  }

  sse.send({ type: 'translate-done', total: queue.length, done, failed, aborted: controller.signal.aborted });
  sse.close();
}

/* ---------- 聊天（SSE） ---------- */

async function handleChat(req, res) {
  const body = await readBody(req);
  const settings = loadSettings();

  let conv = body.conversationId ? getConversation(body.conversationId) : null;
  const engineId = body.engineId || conv?.engineId || settings.defaultEngineId;
  const engine = findEngine(engineId);

  if (!conv) {
    conv = createConversation({
      title: '新对话',
      engineId,
      model: body.model || settings.modelOverrides?.[engineId]?.[0] || null,
      cwd: body.cwd || settings.cwd || ROOT
    });
  }

  if (!engine) {
    sendJson(res, 400, { error: `未知引擎：${engineId}` });
    return;
  }
  if (engine.kind === 'app') {
    sendJson(res, 400, { error: '本地程序类引擎不支持对话，请在左侧「本地程序」里一键启动。' });
    return;
  }

  const prompt = String(body.content ?? '').trim();
  if (!prompt) {
    sendJson(res, 400, { error: '消息内容为空' });
    return;
  }

  /* ---------- 动手之前先体检 ---------- */
  let runEngine = engine;
  let preflightFallback = null;
  if (body.skipPreflight !== true) {
    const check = await preflight(engine);
    if (!check.ok) {
      const alternative =
        settings.fallback?.enabled !== false
          ? await pickWorkingFallback(settings, engine.id, body.fallbackEngines)
          : null;
      if (alternative) {
        runEngine = alternative;
        preflightFallback = {
          from: engine.id,
          fromLabel: engine.label || engine.id,
          to: alternative.id,
          toLabel: alternative.label || alternative.id,
          preflight: check
        };
      } else {
        // 没有能顶上的就明确拦住，别让它跑一半再报错
        sendJson(res, 409, { error: `${engine.label || engine.id} 现在用不了`, preflight: check });
        return;
      }
    }
  }
  const runEngineId = runEngine.id;

  // 会话上记的模型如果在这个引擎的可用列表里不存在（比如换了 provider），就别硬塞给它
  let runModel = conv.model || '';
  let modelNote = null;
  if (runModel) {
    const known = await discoverModels(runEngine, settings);
    if (known.length && !known.includes(runModel)) {
      modelNote = `会话里记的模型「${runModel}」不在 ${runEngine.label || runEngine.id} 的可用列表里，这次用引擎默认模型`;
      runModel = '';
    }
  }

  if (conv.engineId !== engineId) conv.engineId = engineId;
  if (body.model !== undefined) conv.model = body.model;
  if (body.cwd) conv.cwd = body.cwd;

  if (body.replayMessageId) {
    const idx = (conv.messages || []).findIndex((m) => m.id === body.replayMessageId);
    if (idx >= 0) conv.messages = conv.messages.slice(0, idx);
  }
  saveConversation(conv);

  const userMessage = appendMessage(conv.id, {
    role: 'user',
    content: prompt,
    engineId,
    model: conv.model,
    meta: body.replayMessageId ? { replay: true } : {}
  });
  conv = getConversation(conv.id);

  const runId = newId();
  const controller = new AbortController();
  const sse = openSse(req, res, () => controller.abort());
  sse.send({
    type: 'start',
    runId,
    conversationId: conv.id,
    engineId: runEngineId,
    requestedEngineId: engineId,
    model: runModel,
    cwd: conv.cwd,
    userMessageId: userMessage.id,
    preflightFallback
  });
  if (modelNote) sse.send({ type: 'log', stream: 'system', line: modelNote });

  const startedAt = Date.now();
  const signal = controller.signal;

  /** 跑一次，不落库，只把结果和失败判定交回来 */
  const runOnce = async (targetEngine, attemptPrompt, { sessionId = '', allowResume = true } = {}) => {
    const useResume =
      allowResume &&
      body.useResume !== false &&
      Boolean(sessionId) &&
      Array.isArray(targetEngine.resumeArgs) &&
      targetEngine.resumeArgs.length > 0;

    const result = await runEngineStreaming(targetEngine, attemptPrompt, {
      conv,
      settings,
      sse,
      signal,
      runId,
      withHistory: true,
      sessionId: useResume ? sessionId : '',
      model: runModel
    });
    return { engine: targetEngine, result, failure: classifyFailure(result) };
  };

  // 手动「用其他模型处理报错」时，把错误上下文一起交给接手的模型
  let firstPrompt = prompt;
  if (body.errorContext?.message) {
    firstPrompt = fallbackPrompt({
      engineLabel: body.errorContext.fromLabel || '上一个引擎',
      model: conv.model,
      request: prompt,
      failure: {
        kind: body.errorContext.kind || 'engine',
        message: body.errorContext.message,
        hint: body.errorContext.hint || ''
      }
    });
  }

  let attempt = { engine: runEngine, result: { text: '', sessionId: null }, failure: null };
  try {
    attempt = await runOnce(runEngine, firstPrompt, {
      sessionId: conv.sessions?.[runEngineId],
      allowResume: !body.errorContext
    });
  } catch (err) {
    const message = err?.message || String(err);
    sse.send({ type: 'error', message });
    attempt.failure = { kind: 'engine', message, hint: '运行过程中抛了异常。', retryable: true };
  }

  /* ---------- 检测到报错就换个模型接手 ---------- */
  const fallbackSettings = settings.fallback || {};
  const maxAttempts = Math.max(0, Number(fallbackSettings.maxAttempts ?? 2));
  const tried = new Set([runEngineId]);
  let fallbackCount = 0;

  while (
    attempt.failure &&
    body.autoFallback !== false &&
    fallbackSettings.enabled !== false &&
    !signal.aborted &&
    fallbackCount < maxAttempts
  ) {
    const next = (fallbackSettings.engines || [])
      .map((id) => findEngine(id))
      .find((candidate) => candidate && !tried.has(candidate.id) && canRun(candidate));
    if (!next) break;

    tried.add(next.id);
    fallbackCount += 1;
    const failedEngine = attempt.engine;
    const failure = attempt.failure;

    sse.send({
      type: 'fallback',
      from: failedEngine.id,
      fromLabel: failedEngine.label || failedEngine.id,
      to: next.id,
      toLabel: next.label || next.id,
      failure
    });

    appendMessage(conv.id, {
      role: 'system',
      content: `「${failedEngine.label || failedEngine.id}」执行失败（${failure.kind}：${failure.message}），已自动改用「${next.label || next.id}」接手。`,
      meta: { fallback: true, from: failedEngine.id, to: next.id, failure }
    });
    conv = getConversation(conv.id);

    const handoff = fallbackPrompt({
      engineLabel: failedEngine.label || failedEngine.id,
      model: conv.model,
      request: prompt,
      failure
    });

    try {
      attempt = await runOnce(next, handoff, { sessionId: conv.sessions?.[next.id] });
    } catch (err) {
      const message = err?.message || String(err);
      sse.send({ type: 'error', message });
      attempt = {
        engine: next,
        result: { text: '', sessionId: null },
        failure: { kind: 'engine', message, hint: '运行过程中抛了异常。', retryable: true }
      };
    }
  }

  const durationMs = Date.now() - startedAt;
  const text = String(attempt.result.text || '').trim();
  const usedEngine = attempt.engine;
  const fresh = getConversation(conv.id);
  const failureInfo = attempt.failure
    ? { kind: attempt.failure.kind, message: attempt.failure.message, hint: attempt.failure.hint }
    : null;

  if (text) {
    const assistantMessage = appendMessage(conv.id, {
      role: 'assistant',
      content: text,
      engineId: usedEngine.id,
      model: conv.model,
      runId,
      meta: {
        durationMs,
        usage: attempt.result.usage || null,
        sessionId: attempt.result.sessionId || null,
        fallbackFrom: usedEngine.id === engineId ? null : engineId,
        failure: failureInfo
      }
    });
    if (attempt.result.sessionId) rememberSession(getConversation(conv.id), usedEngine.id, attempt.result.sessionId);
    sse.send({
      type: 'done',
      runId,
      messageId: assistantMessage.id,
      text,
      sessionId: attempt.result.sessionId || null,
      durationMs,
      engineId: usedEngine.id,
      fallback: usedEngine.id !== engine.id,
      failure: failureInfo
    });
  } else {
    // 彻底失败：留一条系统消息，界面上可以直接「用其他模型处理」或「修复报错」
    appendMessage(conv.id, {
      role: 'system',
      content: `「${usedEngine.label || usedEngine.id}」执行失败（${(failureInfo || {}).kind || 'engine'}：${(failureInfo || {}).message || '没有输出'}）`,
      meta: {
        fallback: true,
        failure: failureInfo || { kind: 'empty', message: '没有任何输出', hint: '引擎这次什么都没返回。' },
        engineId: usedEngine.id,
        engineLabel: usedEngine.label || usedEngine.id
      }
    });
    sse.send({
      type: 'done',
      runId,
      text: '',
      empty: true,
      durationMs,
      engineId: usedEngine.id,
      fallback: usedEngine.id !== engine.id,
      failure: failureInfo || { kind: 'empty', message: '没有任何输出', hint: '引擎这次什么都没返回。' },
      message: '本次没有产生任何输出，可展开右侧日志查看命令行和原始输出。'
    });
  }

  if (fresh && (!fresh.title || fresh.title === '新对话')) updateConversation(conv.id, { autoTitle: true });
  sse.close();
}

/* ---------- 路由 ---------- */

async function handleApi(req, res, url) {
  const { pathname, searchParams } = url;
  const method = req.method || 'GET';

  if (pathname === '/api/health') {
    sendJson(res, 200, { ok: true, root: ROOT, dataDir: DATA_DIR, port: PORT });
    return true;
  }

  if (pathname === '/api/engines' && method === 'GET') {
    sendJson(res, 200, { engines: await engineCards() });
    return true;
  }

  if (pathname.startsWith('/api/engines/') && pathname.endsWith('/models') && method === 'GET') {
    const id = decodeURIComponent(pathname.slice('/api/engines/'.length, -'/models'.length));
    const engine = findEngine(id);
    if (!engine) {
      sendJson(res, 404, { error: '引擎不存在' });
      return true;
    }
    sendJson(res, 200, { models: await fetchModels(engine) });
    return true;
  }

  // 用之前先体检：文件在不在、密钥有没有、服务通不通、能不能真的启动
  if (pathname.startsWith('/api/engines/') && pathname.endsWith('/preflight') && method === 'GET') {
    const id = decodeURIComponent(pathname.slice('/api/engines/'.length, -'/preflight'.length));
    const engine = findEngineAny(id);
    if (!engine) {
      sendJson(res, 404, { error: '引擎不存在' });
      return true;
    }
    sendJson(res, 200, await preflight(engine, { force: searchParams.get('force') === '1' }));
    return true;
  }

  if (pathname.startsWith('/api/engines/') && pathname.endsWith('/probe') && method === 'POST') {
    const id = decodeURIComponent(pathname.slice('/api/engines/'.length, -'/probe'.length));
    const engine = findEngine(id);
    if (!engine) {
      sendJson(res, 404, { error: '引擎不存在' });
      return true;
    }
    const detection = detectEngine(engine);
    let extra = null;
    if (engine.kind === 'openai' && engine.baseUrl) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5000);
        const probeRes = await fetch(`${engine.baseUrl.replace(/\/+$/, '')}/models`, {
          headers: (() => {
            const key = engineApiKey(engine);
            return key ? { Authorization: `Bearer ${key}` } : {};
          })(),
          signal: controller.signal
        });
        clearTimeout(timer);
        extra = { status: probeRes.status, ok: probeRes.ok };
      } catch (err) {
        extra = { ok: false, error: err.message };
      }
    }
    if (engine.kind === 'cli') {
      try {
        const spec = buildSpawn(engine, { prompt: '', model: '', cwd: ROOT });
        const args = [...spec.args.filter((a) => a !== ''), '--version'];
        extra = await new Promise((resolve) => {
          const child = spawn(spec.command, args, { windowsHide: true, shell: false });
          let output = '';
          const timer = setTimeout(() => {
            child.kill();
            resolve({ ok: false, error: '探测超时' });
          }, 8000);
          child.stdout.on('data', (d) => {
            output += d.toString();
          });
          child.stderr.on('data', (d) => {
            output += d.toString();
          });
          child.on('error', (err) => {
            clearTimeout(timer);
            resolve({ ok: false, error: err.message });
          });
          child.on('close', (code) => {
            clearTimeout(timer);
            resolve({ ok: code === 0, code, output: output.split('\n').slice(0, 6).join('\n').trim() });
          });
        });
      } catch (err) {
        extra = { ok: false, error: err.message };
      }
    }
    sendJson(res, 200, { id, detection, probe: extra });
    return true;
  }

  if (pathname === '/api/chat' && method === 'POST') {
    await handleChat(req, res);
    return true;
  }

  if (pathname === '/api/translate' && method === 'POST') {
    await handleTranslate(req, res);
    return true;
  }

  if (pathname === '/api/desktop/send' && method === 'POST') {
    await handleDesktopSend(req, res);
    return true;
  }

  if (pathname === '/api/repair' && method === 'POST') {
    await handleRepair(req, res);
    return true;
  }

  if (pathname === '/api/conversations' && method === 'GET') {
    const items = searchConversations(searchParams.get('q'), listConversations());
    sendJson(res, 200, { conversations: items });
    return true;
  }

  if (pathname === '/api/conversations' && method === 'POST') {
    const body = await readBody(req);
    const settings = loadSettings();
    const conv = createConversation({
      title: body.title || '新对话',
      engineId: body.engineId || settings.defaultEngineId,
      model: body.model || null,
      cwd: body.cwd || settings.cwd || ROOT
    });
    sendJson(res, 200, { conversation: conv });
    return true;
  }

  const convMatch = pathname.match(/^\/api\/conversations\/([^/]+)(\/messages)?(?:\/([^/]+))?$/);
  if (convMatch) {
    const id = decodeURIComponent(convMatch[1]);
    const isMessages = Boolean(convMatch[2]);
    const messageId = convMatch[3] ? decodeURIComponent(convMatch[3]) : null;

    if (!isMessages && method === 'GET') {
      const conv = getConversation(id);
      if (!conv) {
        sendJson(res, 404, { error: '会话不存在' });
        return true;
      }
      sendJson(res, 200, { conversation: conv });
      return true;
    }

    if (!isMessages && method === 'PATCH') {
      const body = await readBody(req);
      const conv = updateConversation(id, body);
      if (!conv) {
        sendJson(res, 404, { error: '会话不存在' });
        return true;
      }
      sendJson(res, 200, { conversation: conv });
      return true;
    }

    if (!isMessages && method === 'DELETE') {
      const before = getConversation(id);
      let tombstoned = false;
      let removedSource = null;

      // 先写删除记录，写不成就干脆不删——免得删了之后又被同步拉回来
      if (before?.sourceRef) {
        try {
          const info = describeRef(before.sourceRef);
          markIgnoredImport(before.sourceRef, {
            sessionId: before.sourceSessionId || info?.sessionId || null,
            title: before.title || null,
            sourceLabel: before.sourceLabel || null
          });
          tombstoned = true;
        } catch (err) {
          sendJson(res, 500, { error: `删除记录写不进去，为免它复活，这次没有删除：${err.message}` });
          return true;
        }
      }

      const ok = deleteConversation(id);
      if (ok && before?.sourceRef) {
        clearImportedMarks([before.sourceRef]);
        forgetSyncRef(before.sourceRef);

        // 再把源软件里的这条也移除（移到工作台回收站，可撤回）。
        // 这一步失败也没关系：上面已经落了删除记录。
        const settings = loadSettings();
        if (settings.syncDelete?.removeSource !== false) {
          removedSource = removeSourceFile(before.sourceRef);
          broadcast({ type: 'conversations-changed', reason: 'delete' });
        }
      }
      sendJson(res, 200, {
        ok,
        tombstoned,
        sourceRef: before?.sourceRef || null,
        removedSource
      });
      return true;
    }

    if (isMessages && method === 'POST') {
      const body = await readBody(req);
      const rows = Array.isArray(body.messages) ? body.messages : [body];
      const added = [];
      for (const row of rows) {
        const msg = appendMessage(id, row);
        if (msg) added.push(msg);
      }
      sendJson(res, 200, { added });
      return true;
    }

    if (isMessages && method === 'DELETE' && messageId) {
      const conv = getConversation(id);
      if (!conv) {
        sendJson(res, 404, { error: '会话不存在' });
        return true;
      }
      conv.messages = (conv.messages || []).filter((m) => m.id !== messageId);
      saveConversation(conv);
      sendJson(res, 200, { ok: true, conversation: conv });
      return true;
    }

    if (isMessages && method === 'PATCH' && messageId) {
      const body = await readBody(req);
      const conv = getConversation(id);
      if (!conv) {
        sendJson(res, 404, { error: '会话不存在' });
        return true;
      }
      const idx = (conv.messages || []).findIndex((m) => m.id === messageId);
      if (idx < 0) {
        sendJson(res, 404, { error: '消息不存在' });
        return true;
      }
      if (body.content !== undefined) conv.messages[idx].content = String(body.content);
      if (body.meta !== undefined) {
        conv.messages[idx].meta = { ...(conv.messages[idx].meta || {}), ...body.meta };
      }
      saveConversation(conv);
      sendJson(res, 200, { message: conv.messages[idx] });
      return true;
    }
  }

  if (pathname === '/api/history/sources' && method === 'GET') {
    sendJson(res, 200, { sources: scanAllSources() });
    return true;
  }

  if (pathname === '/api/history/scan' && method === 'GET') {
    const sourceId = searchParams.get('source');
    if (!sourceId) {
      sendJson(res, 400, { error: '缺少 source 参数' });
      return true;
    }
    sendJson(res, 200, scanSource(sourceId));
    return true;
  }

  if (pathname === '/api/history/import' && method === 'POST') {
    const body = await readBody(req);
    const refs = Array.isArray(body.refs) ? body.refs : [];
    // 用户在导入面板里明确勾选的，就是要重新导入：不受删除记录影响
    const results = importRefs(body.source, refs, { respectTombstone: false });
    broadcast({ type: 'conversations-changed', reason: 'import' });
    sendJson(res, 200, { results });
    return true;
  }

  if (pathname === '/api/import/file' && method === 'POST') {
    const body = await readBody(req);
    try {
      const conv = importFile(body.path);
      broadcast({ type: 'conversations-changed', reason: 'import-file' });
      sendJson(res, 200, { conversation: conv });
    } catch (err) {
      sendJson(res, 400, { error: err.message });
    }
    return true;
  }

  if (pathname === '/api/import/upload' && method === 'POST') {
    const body = await readBody(req);
    const name = String(body.name || 'import.md').replace(/[\\/:*?"<>|]/g, '_');
    const dir = path.join(DATA_DIR, 'uploads');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${Date.now()}-${name}`);
    fs.writeFileSync(file, String(body.content || ''), 'utf8');
    try {
      const conv = importFile(file);
      broadcast({ type: 'conversations-changed', reason: 'upload' });
      sendJson(res, 200, { conversation: conv });
    } catch (err) {
      sendJson(res, 400, { error: err.message });
    }
    return true;
  }

  if (pathname === '/api/sync/status' && method === 'GET') {
    sendJson(res, 200, syncStatus());
    return true;
  }

  if (pathname === '/api/trash/undo' && method === 'POST') {
    const body = await readBody(req);
    const ref = String(body.ref || '');
    const trashPath = String(body.trashPath || '');
    if (!ref || !trashPath) {
      sendJson(res, 400, { error: '缺少 ref 或 trashPath' });
      return true;
    }
    const result = restoreFromTrash(trashPath, ref);
    if (result.ok) {
      const imported = importRefs(ref.split(':')[0], [ref], { respectTombstone: false });
      broadcast({ type: 'conversations-changed', reason: 'restore' });
      sendJson(res, 200, { ...result, imported });
    } else {
      sendJson(res, 400, result);
    }
    return true;
  }

  if (pathname === '/api/sync/now' && method === 'POST') {
    const report = syncOnce((event) => broadcast(event));
    broadcast({ type: 'conversations-changed', reason: 'sync' });
    sendJson(res, 200, report);
    return true;
  }

  if (pathname === '/api/sync/config' && method === 'POST') {
    const body = await readBody(req);
    const settings = saveSettings({
      autoSync: {
        ...loadSettings().autoSync,
        ...(body.autoSync || {}),
        enabled: body.enabled !== undefined ? body.enabled : body.autoSync?.enabled ?? loadSettings().autoSync.enabled
      }
    });
    const status = settings.autoSync.enabled ? startSyncLoop((event) => broadcast(event)) : (stopSyncLoop(), { running: false });
    sendJson(res, 200, { autoSync: settings.autoSync, status });
    return true;
  }

  if (pathname === '/api/events' && method === 'GET') {
    const sse = openSse(req, res, () => eventClients.delete(res));
    eventClients.add(res);
    sse.send({ type: 'hello', sync: syncStatus() });
    return true;
  }

  if (pathname === '/api/settings' && method === 'GET') {
    const settings = loadSettings();
    const masked = { ...settings, apiKeys: Object.fromEntries(Object.entries(settings.apiKeys || {}).map(([k, v]) => [k, v ? `已保存（${String(v).slice(0, 4)}…）` : ''])) };
    sendJson(res, 200, {
      settings: masked,
      hasKeys: Object.fromEntries(Object.entries(settings.apiKeys || {}).map(([k, v]) => [k, Boolean(v)])),
      targetLangs: TARGET_LANGS
    });
    return true;
  }

  if (pathname === '/api/settings' && method === 'PATCH') {
    const body = await readBody(req);
    const patch = { ...body };
    if (body.apiKeys) {
      const current = loadSettings().apiKeys || {};
      patch.apiKeys = { ...current };
      for (const [key, value] of Object.entries(body.apiKeys)) {
        if (value === null || value === '') delete patch.apiKeys[key];
        else if (typeof value === 'string' && value.startsWith('已保存')) continue;
        else patch.apiKeys[key] = value;
      }
    }
    const settings = saveSettings(patch);
    if (body.autoSync) {
      if (settings.autoSync.enabled) startSyncLoop((event) => broadcast(event));
      else stopSyncLoop();
    }
    sendJson(res, 200, { ok: true, settings: { ...settings, apiKeys: undefined } });
    return true;
  }

  if (pathname === '/api/memory' && method === 'GET') {
    sendJson(res, 200, loadMemory());
    return true;
  }

  if (pathname === '/api/memory' && method === 'PATCH') {
    const body = await readBody(req);
    sendJson(res, 200, saveMemory(body));
    return true;
  }

  if (pathname === '/api/apps/launch' && method === 'POST') {
    const body = await readBody(req);
    const engine = findEngineAny(body.id);
    if (!engine) {
      sendJson(res, 404, { error: '程序未配置' });
      return true;
    }
    try {
      sendJson(res, 200, launchApp(engine));
    } catch (err) {
      sendJson(res, err.statusCode || 500, { error: err.message });
    }
    return true;
  }

  if (pathname === '/api/shell/reveal' && method === 'POST') {
    const body = await readBody(req);
    const target = String(body.path || '').trim();
    if (!target) {
      sendJson(res, 400, { error: '缺少路径' });
      return true;
    }
    const abs = path.resolve(target);
    const args = fs.existsSync(abs) && fs.statSync(abs).isDirectory() ? [abs] : [`/select,${abs}`];
    const child = spawn('explorer.exe', args, { detached: true, stdio: 'ignore' });
    child.unref();
    sendJson(res, 200, { ok: true, path: abs });
    return true;
  }

  if (pathname === '/api/fs/list' && method === 'GET') {
    const target = path.resolve(searchParams.get('path') || ROOT);
    try {
      const entries = fs
        .readdirSync(target, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .slice(0, 300)
        .map((e) => ({ name: e.name, path: path.join(target, e.name) }));
      sendJson(res, 200, { path: target, parent: path.dirname(target), entries });
    } catch (err) {
      sendJson(res, 400, { error: err.message, path: target });
    }
    return true;
  }

  if (pathname === '/api/fs/mkdir' && method === 'POST') {
    const body = await readBody(req);
    const parent = path.resolve(String(body.parent || ROOT));
    const name = String(body.name || '').trim();
    if (!name) {
      sendJson(res, 400, { error: '请填写文件夹名称' });
      return true;
    }
    if (/[\\/:*?"<>|]/.test(name) || name === '.' || name === '..') {
      sendJson(res, 400, { error: '文件夹名称不能包含 \\ / : * ? " < > | 这些字符' });
      return true;
    }
    try {
      if (!fs.statSync(parent).isDirectory()) throw new Error('父目录不是一个文件夹');
    } catch (err) {
      sendJson(res, 400, { error: `父目录不可用：${err.message}` });
      return true;
    }
    const target = path.join(parent, name);
    try {
      if (fs.existsSync(target)) {
        sendJson(res, 409, { error: `已经存在同名文件夹：${target}` });
        return true;
      }
      fs.mkdirSync(target);
      sendJson(res, 200, { ok: true, path: target });
    } catch (err) {
      sendJson(res, 500, { error: `创建失败：${err.message}` });
    }
    return true;
  }

  /* ---------- 导入的字体文件 ---------- */

  if (pathname === '/api/fonts' && method === 'GET') {
    let files = [];
    try {
      files = fs.readdirSync(FONT_DIR);
    } catch {
      files = [];
    }
    sendJson(res, 200, {
      fonts: files.map((file) => ({
        id: file.replace(/\.[^.]+$/, ''),
        file,
        size: (() => {
          try {
            return fs.statSync(path.join(FONT_DIR, file)).size;
          } catch {
            return 0;
          }
        })()
      }))
    });
    return true;
  }

  if (pathname === '/api/fonts' && method === 'POST') {
    const body = await readBody(req, 40 * 1024 * 1024);
    const rawName = String(body.name || 'font');
    const ext = path.extname(rawName).toLowerCase();
    if (!['.ttf', '.otf', '.woff', '.woff2'].includes(ext)) {
      sendJson(res, 400, { error: '只支持 .ttf / .otf / .woff / .woff2 字体文件' });
      return true;
    }
    const data = String(body.data || '');
    const base64 = data.includes(',') ? data.slice(data.indexOf(',') + 1) : data;
    let buffer;
    try {
      buffer = Buffer.from(base64, 'base64');
    } catch {
      sendJson(res, 400, { error: '字体数据解析失败' });
      return true;
    }
    if (!buffer.length) {
      sendJson(res, 400, { error: '字体文件是空的' });
      return true;
    }
    if (buffer.length > 12 * 1024 * 1024) {
      sendJson(res, 400, { error: '字体文件超过 12MB，换个小一点的吧' });
      return true;
    }
    const safe = `${Date.now()}-${path.basename(rawName).replace(/[^\w.-]+/g, '_')}`;
    fs.mkdirSync(FONT_DIR, { recursive: true });
    fs.writeFileSync(path.join(FONT_DIR, safe), buffer);
    const id = safe.replace(/\.[^.]+$/, '');
    sendJson(res, 200, {
      ok: true,
      font: { id, file: safe, name: path.basename(rawName, ext), size: buffer.length }
    });
    return true;
  }

  if (pathname.startsWith('/api/fonts/')) {
    const file = decodeURIComponent(pathname.slice('/api/fonts/'.length));
    if (!/^[\w.-]+$/.test(file)) {
      sendJson(res, 400, { error: '字体文件名不合法' });
      return true;
    }
    const target = path.join(FONT_DIR, file);
    if (!fs.existsSync(target)) {
      sendJson(res, 404, { error: '字体不存在' });
      return true;
    }
    if (method === 'DELETE') {
      fs.rmSync(target, { force: true });
      sendJson(res, 200, { ok: true });
      return true;
    }
    if (method === 'GET') {
      const ext = path.extname(target).toLowerCase();
      const mime =
        { '.ttf': 'font/ttf', '.otf': 'font/otf', '.woff': 'font/woff', '.woff2': 'font/woff2' }[ext] ||
        'application/octet-stream';
      res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'public, max-age=31536000' });
      fs.createReadStream(target).pipe(res);
      return true;
    }
  }

  /* ---------- 环境变量（CLI 靠这个才能像在终端里一样工作） ---------- */

  if (pathname === '/api/env' && method === 'GET') {
    const settings = loadSettings();
    const status = envStatus();
    // 给界面看的时候把值脱敏
    const claudeEngine = findEngine('claude');
    const resolved = claudeEngine ? resolveEngineEnv(claudeEngine) : {};
    const interesting = Object.keys(resolved)
      .filter((key) => /ANTHROPIC|CLAUDE_CODE|DEEPSEEK|ARK|DASHSCOPE|MOONSHOT|OPENAI|CODEX_HOME|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|HOME$/i.test(key))
      .sort()
      .map((key) => ({ key, value: maskSecret(key, resolved[key]) }));
    sendJson(res, 200, { ...status, engineEnv: settings.engineEnv || {}, resolved: interesting });
    return true;
  }

  if (pathname === '/api/env/refresh' && method === 'POST') {
    await captureUserEnvironment({ force: true });
    sendJson(res, 200, envStatus());
    return true;
  }

  if (pathname === '/api/paths' && method === 'GET') {
    const settings = loadSettings();
    sendJson(res, 200, {
      root: ROOT,
      dataDir: DATA_DIR,
      cwd: settings.cwd,
      home: process.env.USERPROFILE || process.env.HOME,
      historySources: listHistorySources().map((s) => ({ id: s.id, label: s.label, path: s.path })),
      engines: listEngines().length
    });
    return true;
  }

  return false;
}

/* ---------- 服务器 ---------- */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || `${HOST}:${PORT}`}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      const handled = await handleApi(req, res, url);
      if (!handled) sendJson(res, 404, { error: `未知接口 ${url.pathname}` });
      return;
    }
    serveStatic(req, res, url.pathname);
  } catch (err) {
    if (!res.headersSent) sendJson(res, 500, { error: err?.message || String(err) });
    else res.end();
  }
});

server.listen(PORT, HOST, () => {
  const settings = loadSettings();
  // 后台抓一次用户终端的环境变量（profile 里的，比如 ANTHROPIC_*）
  captureUserEnvironment().catch(() => {});
  if (settings.autoSync?.enabled) startSyncLoop((event) => broadcast(event));
  const banner = [
    '',
    '  AI Workbench 已启动',
    `  界面地址   http://${HOST}:${PORT}`,
    `  工作目录   ${settings.cwd || ROOT}`,
    `  数据目录   ${DATA_DIR}`,
    `  引擎数量   ${listEngines().length}`,
    '',
    '  按 Ctrl+C 退出',
    ''
  ].join('\n');
  console.log(banner);
});

process.on('SIGINT', () => {
  stopSyncLoop();
  server.close(() => process.exit(0));
});
