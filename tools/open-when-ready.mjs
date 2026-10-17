/**
 * 等本地服务起来之后再打开浏览器（供 start.cmd 调用）。
 *   node tools/open-when-ready.mjs [url]
 */
import { spawn } from 'node:child_process';

const url = process.argv[2] || 'http://127.0.0.1:4317';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ready() {
  for (let i = 0; i < 120; i += 1) {
    try {
      const res = await fetch(`${url}/api/health`);
      if (res.ok) return true;
    } catch {
      /* 还没起来 */
    }
    await sleep(250);
  }
  return false;
}

const ok = await ready();
if (ok) {
  spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
} else {
  console.error(`\n  [!] 等了 30 秒还没等到服务就绪，请手动打开 ${url}\n`);
}
