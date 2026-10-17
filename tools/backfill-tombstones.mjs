/**
 * 给早期写的「删除记录」补 sessionId。
 *
 * 背景：最早的删除记录只记了文件路径。如果源软件把这条会话改名 / 搬家，
 * 只认路径的记录就失效了，会话会复活。这个脚本从 data/trash 里的备份文件
 * 读出 sessionId 补进记录里，之后改名搬家也认得。
 *
 * 用法：node tools/backfill-tombstones.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DATA_DIR, listHistorySources, resolveSourcePath } from '../server/config.mjs';
import { sessionIdOfFile } from '../server/history.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ignoredFile = path.join(DATA_DIR, 'imported', 'ignored.json');
const trashDir = path.join(DATA_DIR, 'trash');

if (!fs.existsSync(ignoredFile)) {
  console.log('没有删除记录，不用补');
  process.exit(0);
}

const ignored = JSON.parse(fs.readFileSync(ignoredFile, 'utf8'));
const sources = listHistorySources();
const kindOf = new Map(sources.map((source) => [source.id, source.kind]));
const rootOf = new Map(sources.map((source) => [source.id, resolveSourcePath(source.path)]));

/** data/trash/<时间戳>/<相对路径> */
function findTrashCopies(relPath) {
  if (!fs.existsSync(trashDir)) return [];
  const out = [];
  for (const stamp of fs.readdirSync(trashDir)) {
    const candidate = path.join(trashDir, stamp, ...relPath.split('/'));
    if (fs.existsSync(candidate)) out.push(candidate);
  }
  return out;
}

let filled = 0;
let skipped = 0;
let missing = 0;

for (const [ref, entry] of Object.entries(ignored)) {
  const normalized = typeof entry === 'object' && entry !== null ? entry : { at: entry };
  if (normalized.sessionId) {
    skipped += 1;
    continue;
  }

  const sourceId = ref.split(':')[0];
  const kind = kindOf.get(sourceId);
  const relPath = ref.slice(sourceId.length + 1);
  const copies = kind ? findTrashCopies(relPath) : [];
  // 回收站里没有就找源目录里还在的原件（早期删除没有搬走文件）
  const live = rootOf.has(sourceId) ? path.join(rootOf.get(sourceId), ...relPath.split('/')) : null;
  const target = copies[0] || (live && fs.existsSync(live) ? live : null);
  if (!target) {
    missing += 1;
    ignored[ref] = normalized;
    continue;
  }

  const sessionId = sessionIdOfFile(kind, target);
  if (sessionId) {
    normalized.sessionId = sessionId;
    filled += 1;
  } else {
    missing += 1;
  }
  ignored[ref] = normalized;
}

fs.writeFileSync(ignoredFile, JSON.stringify(ignored, null, 2), 'utf8');
console.log(`删除记录共 ${Object.keys(ignored).length} 条`);
console.log(`  本次补上 sessionId：${filled} 条`);
console.log(`  本来就有，跳过：${skipped} 条`);
console.log(`  回收站里找不到备份，只能按路径认：${missing} 条`);
