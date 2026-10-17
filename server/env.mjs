import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expandHome, loadSettings } from './config.mjs';

/**
 * 工作台是从桌面快捷方式启动的，环境变量往往只有注册表里那几个；
 * 而用户平时在终端里能正常用的 CLI，靠的是 PowerShell profile 里设的东西
 * （比如 ANTHROPIC_BASE_URL / 代理 / PATH 追加）。
 *
 * 所以启动时跑一次「带 profile 的 PowerShell」，把它的环境变量抓回来，
 * 之后所有引擎子进程都用这份环境，行为就和用户在终端里跑一模一样。
 */

const START = '<<<AIWB_ENV_START>>>';
const END = '<<<AIWB_ENV_END>>>';

let cache = { at: 0, env: {}, source: 'none', error: null };
let capturing = null;

function psScript() {
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `Write-Output '${START}'`,
    '$bag = [ordered]@{}',
    'foreach ($item in Get-ChildItem env:) { $bag[$item.Name] = $item.Value }',
    '$bag | ConvertTo-Json -Compress -Depth 3',
    `Write-Output '${END}'`
  ].join('\n');
}

function runPowerShell(args, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('powershell.exe', args, { windowsHide: true });
    } catch (err) {
      resolve({ output: '', error: err.message });
      return;
    }
    let output = '';
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      resolve({ output, error: '超时' });
    }, timeoutMs);
    child.stdout.on('data', (d) => {
      output += d.toString();
    });
    child.stderr.on('data', (d) => {
      output += d.toString();
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ output, error: err.message });
    });
    child.on('close', () => {
      clearTimeout(timer);
      resolve({ output });
    });
  });
}

/** 抓一份「用户终端里的」环境变量（带 profile），默认 5 分钟内复用 */
export async function captureUserEnvironment({ force = false, ttlMs = 5 * 60 * 1000 } = {}) {
  if (!force && cache.at && Date.now() - cache.at < ttlMs) return cache;
  if (capturing) return capturing;

  capturing = (async () => {
    const { output, error } = await runPowerShell(['-Command', psScript()], 25000);
    const start = output.indexOf(START);
    const end = output.indexOf(END);
    if (start < 0 || end < 0) {
      cache = { ...cache, at: Date.now(), error: error || '没能拿到环境变量' };
      capturing = null;
      return cache;
    }
    const json = output.slice(start + START.length, end).trim();
    let env = {};
    try {
      env = JSON.parse(json);
    } catch (err) {
      cache = { ...cache, at: Date.now(), error: `解析失败：${err.message}` };
      capturing = null;
      return cache;
    }
    for (const key of Object.keys(env)) {
      if (env[key] === null || env[key] === undefined || env[key] === '') delete env[key];
    }
    cache = { at: Date.now(), env, source: 'powershell-profile', error: null };
    capturing = null;
    return cache;
  })();

  return capturing;
}

export async function ensureEnvCaptured() {
  if (cache.at) return cache;
  return captureUserEnvironment();
}

/**
 * 直接读 PowerShell profile 文件里的 `$env:XXX = "值"`。
 *
 * 为什么需要这一步：很多机器的执行策略是 Restricted，profile 根本不会被执行
 * （启动时会报「禁止运行脚本」），但里面写的变量恰恰是用户想要的配置。
 * 读文件不依赖执行策略，所以照样能拿到。
 */
function parseProfileEnv() {
  const files = [
    path.join(os.homedir(), 'Documents', 'WindowsPowerShell', 'Microsoft.PowerShell_profile.ps1'),
    path.join(os.homedir(), 'Documents', 'WindowsPowerShell', 'profile.ps1'),
    path.join(os.homedir(), 'Documents', 'PowerShell', 'Microsoft.PowerShell_profile.ps1'),
    path.join(os.homedir(), 'Documents', 'PowerShell', 'profile.ps1'),
    path.join(os.homedir(), '.config', 'powershell', 'Microsoft.PowerShell_profile.ps1')
  ];
  const out = {};
  const found = [];
  for (const file of files) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    let hit = 0;
    for (const match of text.matchAll(/^\s*\$env:([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(['"])(.*?)\2\s*$/gim)) {
      if (match[3]) {
        out[match[1]] = match[3];
        hit += 1;
      }
    }
    if (hit) found.push({ file, count: hit });
  }
  return { env: out, files: found };
}

let profileCache = null;

export function profileEnv({ force = false } = {}) {
  if (!force && profileCache) return profileCache;
  profileCache = parseProfileEnv();
  return profileCache;
}

/** 合并 PATH：两边都保留，去重 */
function mergePath(a, b) {
  const parts = [];
  for (const source of [a, b]) {
    for (const item of String(source || '').split(path.delimiter)) {
      const value = item.trim();
      if (value && !parts.includes(value)) parts.push(value);
    }
  }
  return parts.join(path.delimiter);
}

/** Claude Code 自己的 settings.json 里可能写了 env（很多人就是这么配的） */
function claudeSettingsEnv() {
  const file = path.join(os.homedir(), '.claude', 'settings.json');
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data?.env && typeof data.env === 'object' ? data.env : {};
  } catch {
    return {};
  }
}

/**
 * 给某个引擎算出最终的环境变量。
 * 优先级：用户终端环境（低） → 工作台进程环境 → 引擎自己的 env（高）
 */
export function resolveEngineEnv(engine) {
  const settings = loadSettings();
  const base = {};

  for (const [key, value] of Object.entries(cache.env || {})) {
    if (value) base[key] = value;
  }
  for (const [key, value] of Object.entries(process.env)) {
    if (value) base[key] = value;
  }
  // profile 里写的（即使执行策略禁止它运行，也要生效）
  for (const [key, value] of Object.entries(profileEnv().env)) {
    if (value) base[key] = value;
  }
  if (engine?.id === 'claude' || String(engine?.command || '').includes('claude')) {
    Object.assign(base, claudeSettingsEnv());
  }
  // 让 Codex 不用去猜 home 目录（猜不到就直接报「找不到 home 目录」）
  if (engine?.id === 'codex' || String(engine?.entry || '').includes('@openai/codex')) {
    if (!base.CODEX_HOME) base.CODEX_HOME = path.join(os.homedir(), '.codex');
  }
  base.PATH = mergePath(base.PATH, process.env.PATH);

  // 设置里手填的环境变量
  for (const [key, value] of Object.entries(settings.engineEnv || {})) {
    if (value) base[key] = value;
  }
  // 引擎配置里的 env 优先级最高
  for (const [key, value] of Object.entries(engine?.env || {})) {
    base[key] = expandHome(String(value));
  }

  if (!base.HOME && (base.USERPROFILE || os.homedir())) base.HOME = base.USERPROFILE || os.homedir();
  return base;
}

export function envStatus() {
  const profile = profileEnv();
  return {
    captured: Object.keys(cache.env || {}).length,
    at: cache.at ? new Date(cache.at).toISOString() : null,
    source: cache.source,
    error: cache.error,
    profileFiles: profile.files,
    profileVars: Object.keys(profile.env).length
  };
}
