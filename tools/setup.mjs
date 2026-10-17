/**
 * 首次安装的探测脚本：找出本机装了的 CLI，并把真实路径写进 config/engines.json。
 *
 *   node tools/setup.mjs
 *
 * - 已经有 config/engines.json 时不会覆盖能用条目的路径，只补探测不到的那个
 * - 找不到的引擎保持裸命令名，工作台里会显示「不可用」，按提示自己填路径即可
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CONFIG_FILE } from '../server/config.mjs';
import { resolveExecutable } from '../server/engines.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const EXAMPLE = path.join(ROOT, 'config', 'engines.example.json');

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

const template = readJson(EXAMPLE);
if (!template) {
  console.error('找不到 config/engines.example.json');
  process.exit(1);
}

const existing = readJson(CONFIG_FILE);
const config = existing ? structuredClone(existing) : structuredClone(template);

// 示例里有的引擎，现有配置里没有就补上
for (const engine of template.engines) {
  if (!config.engines.some((item) => item.id === engine.id)) config.engines.push(engine);
}
for (const source of template.historySources) {
  if (!config.historySources.some((item) => item.id === source.id)) config.historySources.push(source);
}

console.log(`\n扫描本机引擎${existing ? '（保留已配置的路径）' : ''}…\n`);

let ok = 0;
let missing = 0;

for (const engine of config.engines) {
  if (engine.kind !== 'cli') continue;
  const resolved = resolveExecutable(engine);
  if (resolved) {
    engine.command = resolved.command;
    engine.entry = resolved.entry || '';
    ok += 1;
    console.log(`  ✓ ${engine.label.padEnd(22)} ${resolved.entry || resolved.command}`);
  } else {
    missing += 1;
    console.log(`  ✗ ${engine.label.padEnd(22)} 没找到（在配置里手动填 command / entry）`);
  }
}

// 备份旧配置
if (existing && fs.existsSync(CONFIG_FILE)) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.copyFileSync(CONFIG_FILE, `${CONFIG_FILE}.bak-${stamp}`);
  console.log(`\n旧配置已备份到 config/engines.json.bak-${stamp}`);
}

fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');

console.log(`\n完成：${ok} 个 CLI 可用，${missing} 个没找到。`);
console.log(`配置已写入 ${CONFIG_FILE}`);
console.log('\n下一步：node server/index.mjs   然后打开 http://127.0.0.1:4317\n');
