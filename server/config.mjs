import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const WEB_DIR = path.join(ROOT, 'web');
export const CONFIG_FILE = process.env.AIWB_CONFIG
  ? path.resolve(process.env.AIWB_CONFIG)
  : path.join(ROOT, 'config', 'engines.json');

export const DATA_DIR = process.env.AIWB_DATA
  ? path.resolve(process.env.AIWB_DATA)
  : path.join(ROOT, 'data');

export const CONV_DIR = path.join(DATA_DIR, 'conversations');
export const RUN_DIR = path.join(DATA_DIR, 'runs');
export const IMPORT_DIR = path.join(DATA_DIR, 'imported');
export const TRASH_DIR = path.join(DATA_DIR, 'trash');
export const FONT_DIR = path.join(DATA_DIR, 'fonts');
export const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
export const MEMORY_FILE = path.join(DATA_DIR, 'memory.json');
export const SYNC_FILE = path.join(DATA_DIR, 'sync-state.json');

export function ensureDirs() {
  for (const dir of [DATA_DIR, CONV_DIR, RUN_DIR, IMPORT_DIR, TRASH_DIR, FONT_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function expandHome(input) {
  if (!input) return input;
  if (input === '~') return os.homedir();
  if (input.startsWith('~/') || input.startsWith('~\\')) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJson(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

export function readText(file, fallback = '') {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return fallback;
  }
}

/** 读取引擎配置文件，带轻量缓存（按 mtime 自动失效）。 */
let cache = { mtime: 0, value: null };
export function loadConfig() {
  let stat;
  try {
    stat = fs.statSync(CONFIG_FILE);
  } catch {
    // 首次运行：没有个人配置时，用可移植的示例自动初始化
    const example = path.join(path.dirname(CONFIG_FILE), 'engines.example.json');
    try {
      if (fs.existsSync(example)) fs.copyFileSync(example, CONFIG_FILE);
      stat = fs.statSync(CONFIG_FILE);
      console.log(`[config] 已根据 engines.example.json 生成 ${CONFIG_FILE}`);
    } catch {
      return { engines: [], historySources: [] };
    }
  }
  if (cache.value && cache.mtime === stat.mtimeMs) return cache.value;
  const value = readJson(CONFIG_FILE, { engines: [], historySources: [] });
  cache = { mtime: stat.mtimeMs, value };
  return value;
}

export function listEngines() {
  return (loadConfig().engines || []).filter((e) => e && e.id);
}

export function findEngine(id) {
  return listEngines().find((e) => e.id === id) || null;
}

export function listHistorySources() {
  return (loadConfig().historySources || []).filter((s) => s && s.id && s.path);
}

export function resolveSourcePath(p) {
  return path.resolve(expandHome(p));
}

export const DEFAULT_SETTINGS = {
  defaultEngineId: 'codex',
  cwd: ROOT,
  memoryRounds: 12,
  autoSync: {
    enabled: true,
    intervalSeconds: 20,
    sources: ['codex', 'codex-archive', 'claude', 'dsh']
  },
  apiKeys: {},
  modelOverrides: {},
  customApps: [],
  globalMemory: '',
  // 报错换模型：按顺序找第一个可用的引擎接手
  fallback: {
    enabled: true,
    engines: ['claude', 'ollama', 'qwen', 'workbuddy', 'doubao', 'kimi'],
    maxAttempts: 2
  },
  // 翻译默认走本地 Ollama（免费、快、不消耗额度），也可以在界面上临时指定
  translation: {
    engineId: 'auto',
    targetLang: '简体中文'
  },
  // 在工作台删掉一个导入进来的对话时，要不要连源软件（Codex/Claude/dsh）里的记录一起移除
  syncDelete: {
    removeSource: true
  },
  // 界面外观
  appearance: {
    mode: 'dark', // dark | light | system
    accent: '#7c9cff',
    font: 'system', // system | yahei | songti | mono
    fontSize: 1 // 字号倍数，1 = 默认
  },
  // 手填的额外环境变量，会注入到所有引擎子进程
  engineEnv: {}
};

export function loadSettings() {
  const saved = readJson(SETTINGS_FILE, {}) || {};
  return {
    ...DEFAULT_SETTINGS,
    ...saved,
    autoSync: { ...DEFAULT_SETTINGS.autoSync, ...(saved.autoSync || {}) },
    fallback: { ...DEFAULT_SETTINGS.fallback, ...(saved.fallback || {}) },
    translation: { ...DEFAULT_SETTINGS.translation, ...(saved.translation || {}) },
    syncDelete: { ...DEFAULT_SETTINGS.syncDelete, ...(saved.syncDelete || {}) },
    appearance: { ...DEFAULT_SETTINGS.appearance, ...(saved.appearance || {}) },
    engineEnv: { ...(saved.engineEnv || {}) },
    apiKeys: { ...(saved.apiKeys || {}) },
    modelOverrides: { ...(saved.modelOverrides || {}) }
  };
}

export function saveSettings(patch) {
  const next = { ...loadSettings(), ...(patch || {}) };
  writeJson(SETTINGS_FILE, next);
  return next;
}

export function loadMemory() {
  const mem = readJson(MEMORY_FILE, {}) || {};
  return { global: mem.global || '', notes: mem.notes || [] };
}

export function saveMemory(patch) {
  const next = { ...loadMemory(), ...(patch || {}) };
  writeJson(MEMORY_FILE, next);
  return next;
}

export function loadSyncState() {
  return readJson(SYNC_FILE, {}) || {};
}

export function saveSyncState(state) {
  writeJson(SYNC_FILE, state);
  return state;
}
