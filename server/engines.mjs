import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { DATA_DIR, ROOT, expandHome, listEngines, loadSettings } from './config.mjs';
import { ensureEnvCaptured, resolveEngineEnv } from './env.mjs';

/* ---------- 路径工具 ---------- */

export function resolvePath(input) {
  if (!input) return input;
  let out = String(input);
  if (out.startsWith('~')) out = path.join(os.homedir(), out.slice(1).replace(/^[/\\]/, ''));
  out = out.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (m, name) => process.env[name] ?? process.env[name.toUpperCase()] ?? m);
  return path.normalize(out);
}

function which(command) {
  const exts = (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';');
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const hasExt = path.extname(command).length > 0;
  for (const dir of dirs) {
    const base = path.join(dir, command);
    if (!hasExt) {
      for (const ext of exts) {
        const candidate = base + ext;
        if (safeExists(candidate)) return candidate;
      }
    }
    if (safeExists(base)) return base;
  }
  return null;
}

function safeExists(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

/** npm 生成的 .cmd 只是个壳，把里面真正的入口抠出来，避免 Windows 的引号转义问题 */
function parseNpmShim(shimFile) {
  let text;
  try {
    text = fs.readFileSync(shimFile, 'utf8');
  } catch {
    return null;
  }
  const dir = path.dirname(shimFile);
  const expanded = text.replace(/%dp0%/gi, dir);
  const match =
    expanded.match(/"([^"]*node_modules[^"]*\.(?:js|cjs|mjs|exe))"/i) ||
    expanded.match(/([^\s"]*node_modules[^\s"]*\.(?:js|cjs|mjs|exe))/i);
  if (!match) return null;
  const target = path.normalize(match[1].trim());
  if (!safeExists(target)) return null;
  return /\.exe$/i.test(target) ? { command: target, entry: null } : { command: 'node', entry: target };
}

/** npm 全局目录（用来找 codex / claude / qwen / dsh 这类命令） */
function npmGlobalDirs() {
  const dirs = [];
  const push = (dir) => {
    if (dir && safeExists(dir) && !dirs.includes(dir)) dirs.push(dir);
  };
  if (process.env.APPDATA) push(path.join(process.env.APPDATA, 'npm'));
  if (process.env.LOCALAPPDATA) {
    push(path.join(process.env.LOCALAPPDATA, 'pnpm'));
    push(path.join(process.env.LOCALAPPDATA, 'Programs', 'nodejs'));
  }
  push('C:\\Program Files\\nodejs');
  return dirs;
}

/**
 * 找到引擎真正的可执行入口。
 * 顺序：显式 entry → PATH 里的命令 → npm 全局目录里的同名命令。
 * 如果命中的是 .cmd，会解析出里面的 node 脚本 / exe。
 */
export function resolveExecutable(engine) {
  if (!engine) return null;
  if (engine.entry) {
    const entry = resolvePath(engine.entry);
    if (safeExists(entry)) return { command: resolvePath(engine.command || 'node'), entry };
  }

  const raw = engine.command || '';
  const direct = path.isAbsolute(raw) ? resolvePath(raw) : which(raw);
  if (direct && safeExists(direct)) {
    if (/\.(cmd|bat)$/i.test(direct)) {
      const parsed = parseNpmShim(direct);
      if (parsed) return parsed;
    }
    return { command: direct, entry: null };
  }

  for (const dir of npmGlobalDirs()) {
    for (const ext of ['.cmd', '.exe', '']) {
      const candidate = path.join(dir, raw + ext);
      if (!safeExists(candidate)) continue;
      if (/\.(cmd|bat)$/i.test(candidate)) {
        const parsed = parseNpmShim(candidate);
        if (parsed) return parsed;
        continue;
      }
      return { command: candidate, entry: null };
    }
  }
  return null;
}

/* ---------- 引擎探测 ---------- */

export function detectEngine(engine) {
  if (!engine) return { available: false, detail: '未配置' };

  if (engine.kind === 'app' || engine.kind === 'desktop') {
    const target = resolvePath(engine.command);
    if (!target) return { available: false, detail: '未填写程序路径' };
    const ok = safeExists(target);
    return { available: ok, detail: ok ? target : `找不到文件：${target}` };
  }

  if (engine.kind === 'openai') {
    if (!engine.baseUrl) return { available: false, detail: '请先在设置里填写 baseUrl' };
    const settings = loadSettings();
    const key = settings.apiKeys?.[engine.id] || (engine.apiKeyEnv ? process.env[engine.apiKeyEnv] : '') || engine.apiKey || '';
    const isLocal = /127\.0\.0\.1|localhost/.test(engine.baseUrl);
    if (!key && !isLocal) return { available: true, detail: '就绪，但还没填 API Key' };
    return { available: true, detail: isLocal ? `本地服务 ${engine.baseUrl}` : `云端接口 ${engine.baseUrl}` };
  }

  // kind === 'cli'
  const command = engine.command || '';
  const entry = engine.entry ? resolvePath(engine.entry) : null;
  if (entry && !safeExists(entry)) {
    return { available: false, detail: `入口脚本不存在：${entry}` };
  }
  const resolved = resolveExecutable(engine);
  if (resolved) {
    return {
      available: true,
      detail: resolved.entry ? `${resolved.command} + ${resolved.entry}` : resolved.command
    };
  }
  if (path.isAbsolute(command)) {
    const resolved = resolvePath(command);
    return safeExists(resolved)
      ? { available: true, detail: resolved }
      : { available: false, detail: `找不到程序：${resolved}` };
  }
  const found = which(command);
  return found
    ? { available: true, detail: entry ? `${command} + ${entry}` : found }
    : { available: false, detail: `PATH 里找不到 ${command}` };
}

/* ---------- 模型列表 ---------- */

const modelCache = new Map(); // engineId -> {at, models}

export function staticModels(engine, settings) {
  const list = Array.isArray(engine.models) ? [...engine.models] : [];
  const extra = settings?.modelOverrides?.[engine.id];
  if (Array.isArray(extra)) {
    for (const m of extra) if (m && !list.includes(m)) list.push(m);
  }
  return list;
}

/** 引擎这个 key：设置里填的 > 引擎自带 > 环境变量（含 profile 里写的） */
export function engineApiKey(engine, settings = loadSettings()) {
  const fromSettings = settings.apiKeys?.[engine.id];
  if (fromSettings) return fromSettings;
  if (engine.apiKey) return engine.apiKey;
  if (!engine.apiKeyEnv) return '';
  const env = resolveEngineEnv(engine);
  return env[engine.apiKeyEnv] || process.env[engine.apiKeyEnv] || '';
}

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(expandHome(file), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 动态拿模型列表——不去猜。
 *  - CLI：读它自己的配置文件（Codex 有模型目录、Claude 有 env 里写的模型）
 *  - HTTP：直接问接口要 /models
 */
export async function discoverModels(engine, settings = loadSettings()) {
  const fallback = staticModels(engine, settings);

  if (engine.modelsFrom?.type === 'codexCatalog') {
    const catalog = readJsonFile(engine.modelsFrom.path);
    const slugs = (catalog?.models || []).map((model) => model.slug).filter(Boolean);
    let current = null;
    try {
      const toml = fs.readFileSync(expandHome(engine.modelsFrom.configPath), 'utf8');
      const match = toml.match(/^\s*model\s*=\s*"([^"]+)"/m);
      if (match) current = match[1];
    } catch {
      /* 没配 config.toml 就算了 */
    }
    const list = [...new Set([current, ...slugs].filter(Boolean))];
    return list.length ? list : fallback;
  }

  if (engine.modelsFrom?.type === 'claudeEnv') {
    const env = resolveEngineEnv(engine);
    const list = [
      env.ANTHROPIC_MODEL,
      env.ANTHROPIC_DEFAULT_OPUS_MODEL,
      env.ANTHROPIC_DEFAULT_SONNET_MODEL,
      env.ANTHROPIC_DEFAULT_HAIKU_MODEL,
      env.CLAUDE_CODE_SUBAGENT_MODEL
    ].filter(Boolean);
    const unique = [...new Set(list)];
    return unique.length ? unique : fallback;
  }

  return fetchModels(engine, settings);
}

export async function fetchModels(engine, settings = loadSettings()) {
  const base = staticModels(engine, settings);
  // 有 modelsEndpoint 就直接用；否则只要是能拿到 key 的 HTTP 接口，都去问一次 /models
  const endpoint =
    engine.modelsEndpoint ||
    (engine.kind === 'openai' && engine.baseUrl && engineApiKey(engine, settings)
      ? `${String(engine.baseUrl).replace(/\/+$/, '')}/models`
      : null);
  if (!endpoint) return base;

  const cached = modelCache.get(engine.id);
  if (cached && Date.now() - cached.at < 15000) {
    return dedupe([...base, ...cached.models]);
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    const authKey = engineApiKey(engine, settings);
    const res = await fetch(endpoint, {
      signal: controller.signal,
      headers: authKey ? { Authorization: `Bearer ${authKey}` } : {}
    });
    clearTimeout(timer);
    if (!res.ok) return base;
    const data = await res.json();
    const rows = engine.modelsPath ? data?.[engine.modelsPath] : data?.data ?? data;
    const key = engine.modelsNameKey || 'id';
    const models = Array.isArray(rows)
      ? rows.map((row) => (typeof row === 'string' ? row : row?.[key] || row?.id || row?.name)).filter(Boolean)
      : [];
    modelCache.set(engine.id, { at: Date.now(), models });
    return dedupe([...base, ...models]);
  } catch {
    return base;
  }
}

function dedupe(list) {
  return [...new Set(list.filter(Boolean).map(String))];
}

/* ---------- 拼装命令行参数 ---------- */

function renderArgs(template, vars) {
  return (template || []).map((arg) =>
    String(arg).replace(/\{\{(\w+)\}\}/g, (m, name) => (vars[name] === undefined || vars[name] === null ? '' : String(vars[name])))
  );
}

/**
 * 有些 CLI 支持「额外的设置文件」，而且优先级高于它自己的配置。
 * Claude Code 的 ~/.claude/settings.json 里如果写着失效的 token，
 * 单靠环境变量是盖不过去的，得用 --settings 指过去。
 */
const settingsFileCache = new Map();

function writeSettingsFile(engine, env) {
  const file = path.isAbsolute(engine.settingsFile)
    ? engine.settingsFile
    : path.join(DATA_DIR, engine.settingsFile);
  const payload = JSON.stringify({ env }, null, 2);
  const hash = crypto.createHash('sha1').update(payload).digest('hex');
  if (settingsFileCache.get(file) !== hash) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, payload, 'utf8');
      settingsFileCache.set(file, hash);
    } catch {
      return null;
    }
  }
  return file;
}

/**
 * 生成 spawn 参数。
 * @returns {{command:string,args:string[],cwd:string,stdin:string|null,display:string}}
 */
export function buildSpawn(engine, { prompt = '', model = '', cwd = '', sessionId = '' } = {}) {
  const useResume = Boolean(sessionId) && Array.isArray(engine.resumeArgs) && engine.resumeArgs.length > 0;
  const template = useResume ? engine.resumeArgs : engine.baseArgs || [];
  const promptMode = (useResume ? engine.resumePromptMode : engine.promptMode) || 'arg';
  const hasPromptSlot = (template || []).some((a) => String(a).includes('{{prompt}}'));
  const vars = { prompt: promptMode === 'arg' ? prompt : '', model, cwd, sessionId };

  const args = renderArgs(template, vars);
  const resolved = resolveExecutable(engine);
  if (resolved?.entry) args.unshift(resolved.entry);

  if (model && Array.isArray(engine.modelFlag) && engine.modelFlag.length) {
    args.push(...renderArgs(engine.modelFlag, vars));
  }
  if (cwd && Array.isArray(engine.cwdFlag) && engine.cwdFlag.length) {
    args.push(...renderArgs(engine.cwdFlag, vars));
  }

  const env = resolveEngineEnv(engine);

  // 需要「额外设置文件」的引擎：把解析好的环境写过去，并用参数指给它
  if (engine.settingsFile) {
    const file = writeSettingsFile(engine, env);
    if (file) args.push('--settings', file);
  }

  // 提示词放最后，选项都在它前面（有些 CLI 对位置参数更挑剔）
  let stdin = null;
  if (promptMode === 'stdin') {
    stdin = prompt;
  } else if (!hasPromptSlot) {
    args.push(prompt);
  }

  const command = resolved?.command || resolvePath(engine.command);
  const display = [command, ...args.map((a) => (a === prompt ? '<prompt>' : a))].join(' ');
  return { command, args, cwd: cwd || process.cwd(), stdin, display, env };
}

/* ---------- OpenAI 兼容接口 ---------- */

export function resolveOpenAI(engine, model) {
  const settings = loadSettings();
  // 走统一的取 key 逻辑：设置里填的 → 引擎自带 → 环境变量（含 profile 里写的）
  const apiKey = engineApiKey(engine, settings);
  const baseUrl = String(engine.baseUrl || '').replace(/\/+$/, '');
  return {
    baseUrl,
    apiKey,
    model: model || staticModels(engine, settings)[0] || '',
    extraBody: engine.extraBody || {},
    headers: engine.headers || {}
  };
}

/* ---------- 启动本地程序 ---------- */

export function launchApp(engine) {
  const target = resolvePath(engine.command);
  if (!target || !safeExists(target)) {
    const err = new Error(`找不到可执行文件：${target}`);
    err.statusCode = 400;
    throw err;
  }
  const child = spawn(target, engine.appArgs || [], {
    cwd: path.dirname(target),
    detached: true,
    stdio: 'ignore',
    shell: false
  });
  child.unref();
  return { ok: true, target, pid: child.pid };
}

/* ---------- 给前端的引擎卡片 ---------- */

/* ---------- 用之前先体检：宁可拦住，也别让它报一堆错 ---------- */

const preflightCache = new Map(); // engineId -> { at, result }

/** 跑一次 `<cmd> --version`，确认这个 CLI 真的能起来 */
export function probeVersion(engine, timeoutMs = 8000) {
  return new Promise((resolve) => {
    let spec;
    try {
      spec = buildSpawn(engine, { prompt: '', model: '', cwd: ROOT });
    } catch (err) {
      resolve({ ok: false, detail: err.message });
      return;
    }
    const args = [...spec.args.filter((a) => a !== ''), '--version'];
    let child;
    try {
      child = spawn(spec.command, args, { windowsHide: true, shell: false, cwd: ROOT, env: spec.env });
    } catch (err) {
      resolve({ ok: false, detail: err.message });
      return;
    }
    let output = '';
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      resolve({ ok: false, detail: `探测超时（${Math.round(timeoutMs / 1000)} 秒没响应）` });
    }, timeoutMs);
    // 有些程序（比如读 stdin 的脚本）不关输入就会一直等，探测会假超时
    try {
      child.stdin.end();
    } catch {
      /* ignore */
    }
    child.stdout.on('data', (d) => {
      output += d.toString();
    });
    child.stderr.on('data', (d) => {
      output += d.toString();
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, detail: err.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const line = output.split('\n').map((s) => s.trim()).filter(Boolean).pop() || '';
      resolve({ ok: code === 0, detail: line.slice(0, 120) || `退出码 ${code}`, code });
    });
  });
}

/** HTTP 接口能不能连上 */
export async function probeReachable(engine, timeoutMs = 2500) {
  const url =
    engine.modelsEndpoint || (engine.baseUrl ? `${String(engine.baseUrl).replace(/\/+$/, '')}/models` : null);
  if (!url) return false;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: (() => {
        const key = engineApiKey(engine);
        return key ? { Authorization: `Bearer ${key}` } : {};
      })()
    });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * 全面体检查：文件在不在、密钥有没有、服务通不通、能不能真的启动。
 * @returns {{id:string,label:string,kind:string,ok:boolean,checks:{name:string,ok:boolean,detail:string}[],at:string}}
 */
export async function preflight(engine, { force = false } = {}) {
  const cached = preflightCache.get(engine.id);
  if (!force && cached && Date.now() - cached.at < 30000) return cached.result;

  // 跑引擎之前先把用户终端那套环境变量准备好
  await ensureEnvCaptured();

  const checks = [];
  const add = (name, ok, detail = '') => checks.push({ name, ok: Boolean(ok), detail: String(detail || '') });

  if (engine.kind === 'openai') {
    const { baseUrl, apiKey } = resolveOpenAI(engine);
    const isLocal = /127\.0\.0\.1|localhost/.test(baseUrl || '');
    add('接口地址', Boolean(baseUrl), baseUrl || '还没填 baseUrl');
    if (baseUrl) {
      add('密钥', Boolean(apiKey) || isLocal, apiKey ? '已配置' : isLocal ? '本地服务，不需要' : '还没填 API Key');
      const reachable = await probeReachable(engine);
      add('服务可达', reachable, reachable ? '连接正常' : '连不上：检查服务是否启动 / 网络 / 代理');
    }
  } else if (engine.kind === 'desktop' || engine.kind === 'app') {
    const target = resolvePath(engine.command);
    const exists = safeExists(target);
    add(engine.kind === 'desktop' ? '客户端已安装' : '程序已安装', exists, exists ? target : `找不到：${target}`);
  } else {
    const command = engine.command || '';
    const entry = engine.entry ? resolvePath(engine.entry) : null;
    const commandOk = path.isAbsolute(command) ? safeExists(resolvePath(command)) : Boolean(which(command));
    add('命令行程序', commandOk, commandOk ? resolvePath(command) || command : `PATH 里找不到 ${command}`);
    if (entry) add('入口文件', safeExists(entry), entry);
    if (commandOk && (!entry || safeExists(entry))) {
      const version = await probeVersion(engine);
      add('能正常启动', version.ok, version.detail);
    }
  }

  const result = {
    id: engine.id,
    label: engine.label || engine.id,
    kind: engine.kind,
    ok: checks.every((check) => check.ok),
    checks,
    at: new Date().toISOString()
  };
  preflightCache.set(engine.id, { at: Date.now(), result });
  return result;
}

export function clearPreflightCache(engineId) {
  if (engineId) preflightCache.delete(engineId);
  else preflightCache.clear();
}

/** 能不能真的跑起来：光探测到还不够，云端引擎得有密钥。 */
export function canRun(engine) {
  if (!engine || engine.kind === 'app') return false;
  if (engine.kind === 'desktop') return detectEngine(engine).available;
  if (!detectEngine(engine).available) return false;
  if (engine.kind !== 'openai') return true;
  const settings = loadSettings();
  const key =
    settings.apiKeys?.[engine.id] || (engine.apiKeyEnv ? process.env[engine.apiKeyEnv] : '') || engine.apiKey || '';
  const isLocal = /127\.0\.0\.1|localhost/.test(engine.baseUrl || '');
  return Boolean(key) || isLocal;
}

/** 配置文件里的引擎 + 设置里添加的自定义程序，一起查。 */
export function findEngineAny(id) {
  const fromConfig = listEngines().find((e) => e.id === id);
  if (fromConfig) return fromConfig;
  const custom = (loadSettings().customApps || []).find((app) => app.id === id);
  if (!custom) return null;
  return {
    id: custom.id,
    label: custom.label || custom.command,
    kind: 'app',
    group: '本地程序',
    badge: 'EX',
    accent: '#8ab4f8',
    command: custom.command,
    custom: true
  };
}

export async function engineCards() {
  const settings = loadSettings();
  const custom = (settings.customApps || []).map((app) => ({
    id: app.id,
    label: app.label || path.basename(app.command || '自定义程序'),
    kind: 'app',
    group: '本地程序',
    badge: 'EX',
    accent: '#8ab4f8',
    command: app.command,
    custom: true
  }));

  const all = [...listEngines(), ...custom];
  return Promise.all(
    all.map(async (engine) => {
      const detection = detectEngine(engine);
      const models = await discoverModels(engine, settings);
      return {
        id: engine.id,
        label: engine.label || engine.id,
        kind: engine.kind,
        group: engine.group || '其他',
        badge: engine.badge || engine.id.slice(0, 2).toUpperCase(),
        accent: engine.accent || '#8ab4f8',
        description: engine.description || '',
        notes: engine.notes || '',
        models,
        supportsCustomModel: Boolean(engine.supportsCustomModel),
        canResume: Array.isArray(engine.resumeArgs) && engine.resumeArgs.length > 0,
        historySource: engine.historySource || null,
        baseUrl: engine.baseUrl || null,
        needsApiKey: engine.kind === 'openai' && !/127\.0\.0\.1|localhost/.test(engine.baseUrl || ''),
        hasApiKey: Boolean(
          settings.apiKeys?.[engine.id] || engine.apiKey || (engine.apiKeyEnv ? process.env[engine.apiKeyEnv] : '')
        ),
        available: detection.available,
        detail: detection.detail
      };
    })
  );
}
