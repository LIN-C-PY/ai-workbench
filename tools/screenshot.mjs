/**
 * 给界面截图 / 做界面自检。
 *
 * 走 Chrome 的 DevTools 协议「管道」传输（--remote-debugging-pipe，fd 3/4），
 * 不用 WebSocket —— 在受限环境里 WebSocket 握手会被 Chrome 以 1006 拒绝。
 *
 * 用法：
 *   node tools/screenshot.mjs <url> <out.png> [--width=1500] [--height=940]
 *        [--wait=2500] [--click=选择器] [--script=JS] [--eval=JS(打印返回值)]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const [, , url, outFile, ...rest] = process.argv;
if (!url || !outFile) {
  console.error('用法: node tools/screenshot.mjs <url> <out.png> [--width=1500] [--height=940] [--wait=2500] [--click=sel] [--script=js] [--eval=js]');
  process.exit(1);
}

const opt = Object.fromEntries(
  rest
    .filter((a) => a.startsWith('--'))
    .map((a) => {
      const idx = a.indexOf('=');
      return idx < 0 ? [a.slice(2), 'true'] : [a.slice(2, idx), a.slice(idx + 1)];
    })
);

const CANDIDATES = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
].filter(Boolean);

const chromePath = CANDIDATES.find((p) => {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
});
if (!chromePath) {
  console.error('找不到 Chrome / Edge，可用 CHROME_PATH 指定路径');
  process.exit(1);
}

const width = Number(opt.width || 1500);
const height = Number(opt.height || 940);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwb-shot-'));

const chrome = spawn(
  chromePath,
  [
    '--headless=new',
    '--disable-gpu',
    '--in-process-gpu',
    '--disable-gpu-sandbox',
    '--disable-software-rasterizer',
    '--disable-dev-shm-usage',
    '--no-sandbox',
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    '--remote-debugging-pipe',
    `--user-data-dir=${profile}`,
    `--window-size=${width},${height}`,
    'about:blank'
  ],
  { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'], windowsHide: true }
);

let chromeErr = '';
chrome.stderr.on('data', (d) => {
  chromeErr += d.toString();
});

const pipeIn = chrome.stdio[3];
const pipeOut = chrome.stdio[4];

let nextId = 0;
const pending = new Map();
let buffer = Buffer.alloc(0);

pipeOut.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const idx = buffer.indexOf(0);
    if (idx < 0) break;
    const raw = buffer.subarray(0, idx).toString('utf8');
    buffer = buffer.subarray(idx + 1);
    if (!raw.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      continue;
    }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.message}${msg.error.data ? ` (${msg.error.data})` : ''}`));
      else resolve(msg.result);
    }
  }
});

function send(method, params = {}, sessionId) {
  nextId += 1;
  const id = nextId;
  const payload = { id, method, params };
  if (sessionId) payload.sessionId = sessionId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`CDP 超时：${method}`));
      }
    }, 30000);
    pipeIn.write(`${JSON.stringify(payload)}\0`);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cleanup() {
  try {
    chrome.kill();
  } catch {
    /* ignore */
  }
  setTimeout(() => {
    try {
      fs.rmSync(profile, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    process.exit(0);
  }, 400);
}

try {
  await sleep(900);
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });

  await send('Page.enable', {}, sessionId);
  await send('Runtime.enable', {}, sessionId);
  await send(
    'Emulation.setDeviceMetricsOverride',
    { width, height, deviceScaleFactor: 1, mobile: false },
    sessionId
  );
  await send('Page.navigate', { url }, sessionId);
  await sleep(Number(opt.wait || 2500));

  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails;
      throw new Error(
        `${detail.text || 'JS 执行出错'}${detail.exception?.description ? `：${detail.exception.description.split('\n')[0]}` : ''}`
      );
    }
    return result.result?.value;
  };

  if (opt.hover) {
    const box = await evaluate(
      `(() => { const el = document.querySelector(${JSON.stringify(opt.hover)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`
    );
    if (box) {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y, buttons: 0 }, sessionId);
      await sleep(500);
    }
  }
  if (opt.click) {
    await evaluate(`document.querySelector(${JSON.stringify(opt.click)})?.click()`);
    await sleep(700);
  }
  if (opt.script) {
    await evaluate(opt.script);
    await sleep(700);
  }
  if (opt.eval) {
    const value = await evaluate(opt.eval);
    console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  }
  if (opt.hold) await sleep(Number(opt.hold));

  if (opt.eval2) {
    const value = await evaluate(opt.eval2);
    console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  }

  const shot = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
  fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
  fs.writeFileSync(outFile, Buffer.from(shot.data, 'base64'));
  console.log(`已保存 ${outFile}`);
} catch (err) {
  console.error(`失败：${err.message}`);
  if (chromeErr) console.error(chromeErr.split('\n').slice(-6).join('\n'));
  cleanup();
  process.exitCode = 1;
}
cleanup();
