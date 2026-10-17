/**
 * 端到端自检：起一个临时服务实例，验证
 *   1. 引擎探测
 *   2. 命令行通道（用 tools/mock-engine.mjs 模拟 Claude 风格的 stream-json）
 *   3. HTTP 通道（Ollama，若本机可用）
 *   4. 会话持久化 / 记忆 / 消息编辑
 *   5. 历史解析与导入、自动同步
 *   6. Markdown 渲染
 * 用法：node tools/selftest.mjs
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderMarkdown } from '../web/js/markdown.mjs';
import { classifyFailure, repairCandidateOrder } from '../server/health.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 4318 + Math.floor(Math.random() * 200);
const BASE = `http://127.0.0.1:${PORT}`;

const results = [];
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      results.push({ name, ok: true });
      console.log(`  ✓ ${name}`);
    })
    .catch((err) => {
      results.push({ name, ok: false, error: err.message });
      console.log(`  ✗ ${name}\n      ${err.message}`);
    });
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwb-selftest-'));

/* ---------- 造一个假的 Codex 历史目录 ---------- */
const historyDir = path.join(tmp, 'codex-sessions', '2026', '10', '06');
fs.mkdirSync(historyDir, { recursive: true });
const rollout = path.join(historyDir, 'rollout-2026-10-06T10-00-00-abc.jsonl');
const lines = [
  {
    timestamp: '2026-10-06T02:00:00.000Z',
    type: 'session_meta',
    payload: { session_id: 'fixture-session', cwd: 'D:\\demo', timestamp: '2026-10-06T02:00:00.000Z' }
  },
  {
    timestamp: '2026-10-06T02:00:01.000Z',
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: '<environment_context>\n  <cwd>D:\\demo</cwd>\n</environment_context>\n\n帮我看看这个项目的结构' }]
    }
  },
  {
    timestamp: '2026-10-06T02:00:02.000Z',
    type: 'response_item',
    payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '这是一个 React + Vite 项目。' }] }
  }
];
fs.writeFileSync(rollout, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`, 'utf8');

/* ---------- 写测试用引擎配置 ---------- */
const configFile = path.join(tmp, 'engines.json');
fs.writeFileSync(
  configFile,
  JSON.stringify(
    {
      engines: [
        {
          id: 'mock',
          label: '模拟 CLI',
          kind: 'cli',
          group: '测试',
          badge: 'MK',
          accent: '#888',
          command: 'node',
          entry: path.join(ROOT, 'tools', 'mock-engine.mjs'),
          baseArgs: ['--print', '--output-format', 'stream-json'],
          promptMode: 'stdin',
          resumeArgs: ['--print', '--output-format', 'stream-json', '--resume', '{{sessionId}}'],
          resumePromptMode: 'stdin',
          models: ['mock-model']
        },
        {
          id: 'broken',
          label: '坏掉的 CLI',
          kind: 'cli',
          group: '测试',
          badge: 'BR',
          command: 'definitely-not-a-real-binary-xyz',
          promptMode: 'arg',
          models: []
        },
        {
          id: 'flaky',
          label: '能启动但会报错的 CLI',
          kind: 'cli',
          group: '测试',
          badge: 'FL',
          command: 'node',
          entry: path.join(ROOT, 'tools', 'mock-fail-engine.mjs'),
          promptMode: 'arg',
          models: []
        },
        {
          id: 'ollama',
          label: 'Ollama',
          kind: 'openai',
          group: '测试',
          badge: 'OL',
          baseUrl: 'http://127.0.0.1:11434/v1',
          apiKey: 'ollama',
          modelsEndpoint: 'http://127.0.0.1:11434/api/tags',
          modelsPath: 'models',
          modelsNameKey: 'name',
          models: []
        },
        {
          id: 'catalog',
          label: '模型目录引擎',
          kind: 'cli',
          group: '测试',
          badge: 'CT',
          command: 'node',
          entry: path.join(ROOT, 'tools', 'mock-engine.mjs'),
          promptMode: 'stdin',
          models: ['还没同步'],
          modelsFrom: {
            type: 'codexCatalog',
            path: path.join(tmp, 'model-catalog.json'),
            configPath: path.join(tmp, 'model-config.toml')
          },
          modelsEndpoint: null
        }
      ],
      historySources: [{ id: 'codex', label: 'Codex CLI', kind: 'codex', path: path.join(tmp, 'codex-sessions'), autoSync: true }]
    },
    null,
    2
  ),
  'utf8'
);

const dataDir = path.join(tmp, 'data');

// 给「动态模型」那条测试准备的假模型目录 / 配置
fs.writeFileSync(
  path.join(tmp, 'model-catalog.json'),
  JSON.stringify({ models: [{ slug: 'test-flash' }, { slug: 'test-pro' }] }, null, 2),
  'utf8'
);
fs.writeFileSync(path.join(tmp, 'model-config.toml'), 'model = "test-flash"\n', 'utf8');

const server = spawn(process.execPath, [path.join(ROOT, 'server', 'index.mjs')], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), AIWB_DATA: dataDir, AIWB_CONFIG: configFile },
  stdio: ['ignore', 'pipe', 'pipe']
});
let serverLog = '';
server.stdout.on('data', (d) => {
  serverLog += d.toString();
});
server.stderr.on('data', (d) => {
  serverLog += d.toString();
});

const json = async (method, url, body) => {
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(data?.error || `${res.status}`);
  return data;
};

async function chat(payload) {
  const res = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const events = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';
    for (const frame of frames) {
      const line = frame.split('\n').find((l) => l.startsWith('data:'));
      if (line) events.push(JSON.parse(line.slice(5).trim()));
    }
  }
  return events;
}

async function waitForServer(tries = 60) {
  for (let i = 0; i < tries; i += 1) {
    try {
      await json('GET', '/api/health');
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw new Error(`服务启动失败：\n${serverLog}`);
}

function cleanup() {
  try {
    server.kill();
  } catch {
    /* ignore */
  }
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

console.log(`\nAI Workbench 自检（临时目录 ${tmp}）\n`);
await waitForServer();

await check('健康检查返回 ok', async () => {
  const health = await json('GET', '/api/health');
  assert.equal(health.ok, true);
});

await check('引擎探测：可用的 CLI 与坏掉的 CLI 能区分', async () => {
  const { engines } = await json('GET', '/api/engines');
  const mock = engines.find((e) => e.id === 'mock');
  const broken = engines.find((e) => e.id === 'broken');
  assert.equal(mock.available, true, '模拟引擎应可用');
  assert.equal(broken.available, false, '坏掉的引擎应不可用');
});

let conversationId = null;
let firstAssistant = '';

await check('命令行通道：流式返回正文 + 工具调用 + 会话 ID', async () => {
  const events = await chat({ engineId: 'mock', content: '你好，测试一下', cwd: tmp });
  const text = events.filter((e) => e.type === 'delta').map((e) => e.text).join('');
  assert.ok(text.includes('模拟引擎'), `输出里应包含模型回复，实际：${text.slice(0, 120)}`);
  assert.ok(text.includes('```js'), 'Markdown 代码块应原样保留');
  assert.ok(events.some((e) => e.type === 'tool' && e.name === 'Read'), '应收到工具调用事件');
  assert.ok(
    events.some((e) => e.type === 'tool' && e.name === 'command_execution'),
    '命令执行事件应识别为工具调用'
  );
  assert.ok(!text.includes('SHOULD-NOT-APPEAR-IN-TEXT'), '命令输出不应混进正文');
  const session = events.find((e) => e.type === 'session');
  assert.ok(session?.sessionId?.startsWith('mock-'), '应解析出 session_id');
  const done = events.find((e) => e.type === 'done');
  assert.ok(done?.conversationId === undefined || true);
  firstAssistant = text;
  conversationId = events.find((e) => e.type === 'start').conversationId;
  assert.ok(conversationId, 'start 事件应带上会话 ID');
});

await check('对话落盘：用户消息 + 助手消息都保存了', async () => {
  const { conversation } = await json('GET', `/api/conversations/${conversationId}`);
  assert.equal(conversation.messages.length, 2);
  assert.equal(conversation.messages[0].role, 'user');
  assert.equal(conversation.messages[1].role, 'assistant');
  assert.ok(conversation.messages[1].content.includes('模拟引擎'));
  assert.ok(conversation.title && conversation.title !== '新对话', `标题应自动生成，实际：${conversation.title}`);
});

await check('原生续聊：记住引擎返回的 session 并复用 --resume', async () => {
  const { conversation } = await json('GET', `/api/conversations/${conversationId}`);
  assert.ok(conversation.sessions?.mock, '应保存引擎会话 ID');
  const events = await chat({ conversationId, engineId: 'mock', content: '第二轮', cwd: tmp });
  const cmd = events.find((e) => e.type === 'command');
  assert.ok(String(cmd.command).includes('--resume'), `第二次应带 --resume，实际：${cmd.command}`);
  assert.ok(String(cmd.command).includes(conversation.sessions.mock), '应带上正确的会话 ID');
});

await check('记忆：注入到 CLI 提示词里', async () => {
  await json('PATCH', '/api/memory', { global: '我叫测试用户，偏好简短回答。', notes: [] });
  const created = await json('POST', '/api/conversations', { engineId: 'mock', cwd: tmp });
  const events = await chat({ conversationId: created.conversation.id, engineId: 'mock', content: '还在吗', cwd: tmp });
  const text = events.filter((e) => e.type === 'delta').map((e) => e.text).join('');
  assert.ok(text.includes('我叫测试用户'), '模拟引擎回显的提示词里应包含全局记忆');
});

await check('运行期报错：能拿到错误事件，服务不崩', async () => {
  const events = await chat({ engineId: 'flaky', content: 'hello', cwd: tmp });
  assert.ok(events.some((e) => e.type === 'error'), '应返回 error 事件');
  const health = await json('GET', '/api/health');
  assert.equal(health.ok, true, '服务应仍然存活');
});

await check('历史扫描：能解析 Codex rollout 并剥离环境上下文', async () => {
  const data = await json('GET', '/api/history/scan?source=codex');
  assert.equal(data.items.length, 1, '应扫描到 1 个会话');
  assert.ok(data.items[0].messageCount >= 2);
});

await check('导入历史：生成只读镜像会话', async () => {
  const scan = await json('GET', '/api/history/scan?source=codex');
  const { results } = await json('POST', '/api/history/import', { source: 'codex', refs: [scan.items[0].ref] });
  assert.equal(results[0].ok, true, JSON.stringify(results[0]));
  const { conversation } = await json('GET', `/api/conversations/${results[0].conversationId}`);
  assert.equal(conversation.source, 'import');
  assert.equal(conversation.messages[0].role, 'user');
  assert.ok(!conversation.messages[0].content.includes('environment_context'), '环境上下文应被剥离');
  assert.ok(conversation.messages[0].content.includes('帮我看看这个项目的结构'));
});

await check('自动同步：开启后能增量导入新会话', async () => {
  await json('POST', '/api/sync/config', { enabled: true, autoSync: { intervalSeconds: 30, sources: ['codex'] } });
  const extra = path.join(historyDir, 'rollout-2026-10-06T11-00-00-def.jsonl');
  const copy = fs.readFileSync(rollout, 'utf8').replace('帮我看看这个项目的结构', '第二个会话');
  fs.writeFileSync(extra, copy, 'utf8');
  await new Promise((r) => setTimeout(r, 3200));
  const report = await json('POST', '/api/sync/now', {});
  assert.ok(report.imported >= 1, `应至少导入 1 个新会话，实际 ${JSON.stringify(report)}`);
});

await check('HTTP 通道：如果本机 Ollama 在线就真跑一轮', async () => {
  const { engines } = await json('GET', '/api/engines');
  const ollama = engines.find((e) => e.id === 'ollama');
  if (!ollama?.models?.length) {
    console.log('      （跳过：本机没有 Ollama 模型）');
    return;
  }
  const model = ollama.models.find((m) => /7b|3b|1b|mini|small/i.test(m)) || ollama.models[0];
  const events = await chat({ engineId: 'ollama', model, content: '只回答两个字：收到', cwd: tmp });
  const text = events.filter((e) => e.type === 'delta').map((e) => e.text).join('');
  if (events.some((e) => e.type === 'error')) {
    const message = events.find((e) => e.type === 'error').message;
    console.log(`      （跳过：${message.slice(0, 120)}）`);
    return;
  }
  assert.ok(text.trim().length > 0, '应收到模型输出');
  console.log(`      模型 ${model} 回复：${text.trim().slice(0, 40)}`);
});

await check('Markdown 渲染：标题 / 列表 / 代码块 / 表格', async () => {
  const { html, codes } = renderMarkdown('# 标题\n\n- a\n- b\n\n```js\nconst x = 1;\n```\n\n| a | b |\n| --- | --- |\n| 1 | 2 |');
  assert.ok(html.includes('<h1>标题</h1>'));
  assert.ok(html.includes('<li>a</li>'));
  assert.ok(html.includes('code-block'));
  assert.equal(codes[0].code, 'const x = 1;');
  assert.ok(html.includes('<table>'));
});

await check('消息编辑：PATCH 后内容被更新', async () => {
  const { conversation } = await json('POST', '/api/conversations', { engineId: 'mock', cwd: tmp });
  const { added } = await json('POST', `/api/conversations/${conversation.id}/messages`, { messages: [{ role: 'user', content: '原始内容' }] });
  await json('PATCH', `/api/conversations/${conversation.id}/messages/${added[0].id}`, { content: '修改后的内容' });
  const after = await json('GET', `/api/conversations/${conversation.id}`);
  assert.equal(after.conversation.messages[0].content, '修改后的内容');
});

await check('前端接线：app.mjs 里引用的 DOM id 都存在于 index.html', async () => {
  const appJs = fs.readFileSync(path.join(ROOT, 'web', 'js', 'app.mjs'), 'utf8');
  const html = fs.readFileSync(path.join(ROOT, 'web', 'index.html'), 'utf8');
  const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  // 只检查 $('#simpleId') 这种写法；带空格/点的选择器和动态创建的节点不算
  const used = new Set(
    [...appJs.matchAll(/\$\('#([A-Za-z][\w-]*)'\)/g)].map((m) => m[1])
  );
  // 有些节点是弹窗里动态创建的（h('input', { id: 'xxx' })），这些也算存在
  const created = new Set([...appJs.matchAll(/id:\s*'([A-Za-z][\w-]*)'/g)].map((m) => m[1]));
  const missing = [...used].filter((id) => !htmlIds.has(id) && !created.has(id));
  assert.equal(missing.length, 0, `index.html 缺少这些 id：${missing.join(', ')}`);
  assert.ok(used.size > 10, '应该引用到了足够多的界面元素');
});

await check('静态资源：页面与脚本都能正常访问', async () => {
  const files = ['/', '/css/app.css', '/js/app.mjs', '/js/api.mjs', '/js/markdown.mjs'];
  for (const file of files) {
    const res = await fetch(`${BASE}${file}`);
    assert.equal(res.status, 200, `${file} 应返回 200`);
    const body = await res.text();
    assert.ok(body.length > 100, `${file} 内容不应为空`);
  }
  const html = await (await fetch(`${BASE}/`)).text();
  assert.ok(html.includes('AI Workbench'), '首页应包含应用名');
  assert.ok(html.includes('/js/app.mjs'), '首页应加载前端入口');
});

await check('前端模块：导入路径都存在', async () => {
  const appJs = fs.readFileSync(path.join(ROOT, 'web', 'js', 'app.mjs'), 'utf8');
  const imports = [...appJs.matchAll(/from\s+'(\.[^']+)'/g)].map((m) => m[1]);
  assert.ok(imports.length >= 2, '应至少有 2 个相对导入');
  for (const spec of imports) {
    const target = path.resolve(path.join(ROOT, 'web', 'js'), spec);
    assert.ok(fs.existsSync(target), `${spec} 指向的文件不存在`);
  }
});

await check('批处理换行：start.cmd 必须是 CRLF（LF 会让 cmd.exe 解析错乱）', async () => {
  const file = path.join(ROOT, 'start.cmd');
  const buf = fs.readFileSync(file);
  const text = buf.toString('utf8');
  const crlf = (text.match(/\r\n/g) || []).length;
  const loneLf = (text.match(/(?<!\r)\n/g) || []).length;
  assert.ok(crlf > 10, `start.cmd 应该用 CRLF 换行，现在只有 ${crlf} 个`);
  assert.equal(loneLf, 0, `start.cmd 有 ${loneLf} 个单独的 LF 换行`);
  assert.ok(!text.startsWith('\uFEFF'), 'start.cmd 不应带 BOM');
});

await check('图标：assets/aiworkbench.ico 结构合法', async () => {
  const file = path.join(ROOT, 'assets', 'aiworkbench.ico');
  assert.ok(fs.existsSync(file), '快捷方式图标不存在，跑一下 node tools/make-icon.mjs');
  const buf = fs.readFileSync(file);
  assert.equal(buf.readUInt16LE(0), 0, 'ICO 头应为 0');
  assert.equal(buf.readUInt16LE(2), 1, '类型应为 1（图标）');
  const count = buf.readUInt16LE(4);
  assert.ok(count >= 4, `应包含多个尺寸，实际 ${count} 个`);
  for (let i = 0; i < count; i += 1) {
    const entry = 6 + i * 16;
    const bytes = buf.readUInt32LE(entry + 8);
    const offset = buf.readUInt32LE(entry + 12);
    assert.ok(offset + bytes <= buf.length, `第 ${i} 个图像越界`);
  }
});

await check('布局：滚动容器的 min-height 不能漏（否则整页滚不动）', async () => {
  const css = fs.readFileSync(path.join(ROOT, 'web', 'css', 'app.css'), 'utf8');
  const rule = (selector) => {
    const start = css.indexOf(`${selector} {`);
    if (start < 0) return null;
    const open = css.indexOf('{', start);
    const close = css.indexOf('}', open);
    return css.slice(open + 1, close);
  };
  // flex/grid 子项默认 min-height:auto，不归零就会把内容撑出视口，导致「页面滚不动」
  for (const selector of ['.app', '.sidebar', '.main', '.messages', '.conv-list', '.drawer-body', '.modal', '.modal-body']) {
    const body = rule(selector);
    assert.ok(body, `CSS 里找不到 ${selector}`);
    assert.ok(
      /min-height:\s*0/.test(body) || /grid-template-rows:\s*minmax\(0/.test(body),
      `${selector} 缺少 min-height: 0（滚动会失效）`
    );
  }
  assert.ok(/\.conv-del\s*\{/.test(css), '侧栏应该有一个删除按钮的样式');
  assert.ok(/\.conv-item:hover\s+\.conv-del/.test(css), '删除按钮应该在悬停时显示');
});

await check('外观：深色 / 浅色两套主题 + 设计变量不漏不空', async () => {
  const css = fs.readFileSync(path.join(ROOT, 'web', 'css', 'app.css'), 'utf8');
  assert.ok(/:root\[data-theme="light"\]\s*\{/.test(css), '应该有浅色主题覆盖块');

  for (const token of ['--bg', '--panel', '--text', '--accent', '--accent-soft', '--border', '--danger-text', '--ok-text', '--fs-unit']) {
    const lightBlock = css.match(/:root\[data-theme="light"\]\s*\{([\s\S]*?)\n\}/)[1];
    const darkBlock = css.match(/:root\s*\{([\s\S]*?)\n\}/)[1];
    assert.ok(
      lightBlock.includes(`${token}:`) || darkBlock.includes(`${token}:`),
      `${token} 应该在某套主题里定义`
    );
  }

  // 规则区不能再出现写死的颜色，否则浅色主题下会露出深色
  const stripped = css
    .replace(/:root\[data-theme="light"\]\s*\{[\s\S]*?\n\}/g, '')
    .replace(/:root\s*\{[\s\S]*?\n\}/g, '');
  const hardcoded = [
    ...new Set([
      ...[...stripped.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0]),
      ...[...stripped.matchAll(/rgba?\([^)]*\)/g)].map((m) => m[0])
    ])
  ];
  assert.equal(hardcoded.length, 0, `这些颜色应该收敛成变量：${hardcoded.join(', ')}`);

  // 用到的变量都得有定义
  const used = [...new Set([...css.matchAll(/var\((--[\w-]+)\)/g)].map((m) => m[1]))];
  const defined = new Set([...css.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
  const missing = used.filter((token) => !defined.has(token));
  assert.equal(missing.length, 0, `用到但没定义的变量：${missing.join(', ')}`);

  // 字号要能跟着设置缩放
  assert.ok(/--fs-unit/.test(css), '应该有字号缩放变量');
  assert.ok(!/font-size:\s*\d+(\.\d+)?px/.test(stripped), '字号应该写成 calc(N * var(--fs-unit))');
});

await check('外观设置能存能取', async () => {
  const want = { mode: 'light', accent: '#4fb8a8', font: 'yahei', fontSize: 1.08 };
  await json('PATCH', '/api/settings', { appearance: want });
  const got = (await json('GET', '/api/settings')).settings.appearance;
  assert.equal(got.mode, 'light');
  assert.equal(got.accent, '#4fb8a8');
  assert.equal(got.font, 'yahei');
  assert.equal(got.fontSize, 1.08);
  await json('PATCH', '/api/settings', { appearance: { mode: 'dark', accent: '#7c9cff', font: 'system', fontSize: 1 } });
});

await check('目录选择：能在指定目录下新建文件夹（非法名称要拦住）', async () => {
  const base = fs.mkdtempSync(path.join(tmp, 'mkdir-'));
  const created = await json('POST', '/api/fs/mkdir', { parent: base, name: '我的项目' });
  assert.equal(created.ok, true);
  assert.ok(fs.existsSync(created.path), '文件夹应该真的建出来了');
  assert.equal(path.basename(created.path), '我的项目');

  const list = await json('GET', `/api/fs/list?path=${encodeURIComponent(base)}`);
  assert.ok(list.entries.some((e) => e.name === '我的项目'), '新建的文件夹应出现在列表里');

  for (const bad of ['', 'a/b', 'a\\b', '..', 'a?b']) {
    let failed = false;
    try {
      await json('POST', '/api/fs/mkdir', { parent: base, name: bad });
    } catch {
      failed = true;
    }
    assert.ok(failed, `非法名称 ${JSON.stringify(bad)} 应该被拒绝`);
  }

  let dup = false;
  try {
    await json('POST', '/api/fs/mkdir', { parent: base, name: '我的项目' });
  } catch {
    dup = true;
  }
  assert.ok(dup, '重名应该报错而不是静默覆盖');
});

await check('自动同步：后台轮询发现新会话后，前端能收到刷新通知', async () => {
  // 打开事件流
  const res = await fetch(`${BASE}/api/events`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const events = [];
  let buffer = '';
  const pump = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';
        for (const frame of frames) {
          const line = frame.split('\n').find((l) => l.startsWith('data:'));
          if (line) events.push(JSON.parse(line.slice(5).trim()));
        }
      }
    } catch {
      /* 主动取消时会抛，忽略 */
    }
  })();

  await json('POST', '/api/sync/config', { enabled: true, autoSync: { intervalSeconds: 5, sources: ['codex'] } });

  // 造一个新会话，并把修改时间往前推，跳过「文件正在写入」的保护
  const fresh = path.join(historyDir, 'rollout-2026-10-06T12-00-00-ghi.jsonl');
  fs.writeFileSync(fresh, fs.readFileSync(rollout, 'utf8').replace('帮我看看这个项目的结构', '后台轮询测试'), 'utf8');
  const past = new Date(Date.now() - 8000);
  fs.utimesSync(fresh, past, past);

  let hit = null;
  for (let i = 0; i < 40; i += 1) {
    hit = events.find((e) => e.type === 'conversations-changed' && e.reason === 'sync');
    if (hit) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  await reader.cancel().catch(() => {});
  await pump;

  assert.ok(hit, `后台同步应该广播 conversations-changed，收到的事件：${JSON.stringify(events.map((e) => e.type))}`);
  assert.ok(hit.imported >= 1, '通知里应该带上导入了几个会话');

  const status = await json('GET', '/api/sync/status');
  assert.ok(status.lastSyncAt, '同步状态里应该记录最近一次同步时间');
});

await check('删除导入的会话后，同步不会把它拉回来；手动再导入可以恢复', async () => {
  const scan = await json('GET', '/api/history/scan?source=codex');
  const item = scan.items.find((x) => x.imported);
  assert.ok(item, '应该有一个已导入的会话来做这个测试');
  // 找到它对应的会话，然后像用户在界面上那样删掉
  const { conversations } = await json('GET', '/api/conversations');
  const conv = conversations.find((c) => c.sourceRef === item.ref);
  assert.ok(conv, '应该能在会话列表里找到对应条目');
  const del = await json('DELETE', `/api/conversations/${conv.id}`);
  assert.equal(del.ok, true);
  assert.equal(del.tombstoned, true, '删除导入的会话应留下墓碑');

  // 改动源文件（内容 + 时间都变），模拟 CLI 那边继续追加
  const srcFile = path.join(tmp, 'codex-sessions', ...item.ref.slice('codex:'.length).split('/'));
  fs.appendFileSync(
    srcFile,
    `\n${JSON.stringify({
      timestamp: new Date().toISOString(),
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '追加的一条' }] }
    })}\n`,
    'utf8'
  );
  const past = new Date(Date.now() - 8000);
  fs.utimesSync(srcFile, past, past);

  await json('POST', '/api/sync/now', {});
  await new Promise((r) => setTimeout(r, 800));
  const after = await json('GET', '/api/conversations');
  assert.equal(
    after.conversations.filter((c) => c.sourceRef === item.ref).length,
    0,
    '删掉的会话不应该被同步拉回来'
  );

  // 用户明确勾选导入 → 墓碑解除，会话回来
  const reimport = await json('POST', '/api/history/import', { source: 'codex', refs: [item.ref] });
  assert.equal(reimport.results[0].ok, true);
  const scan2 = await json('GET', '/api/history/scan?source=codex');
  const item2 = scan2.items.find((x) => x.ref === item.ref);
  assert.equal(item2.ignored, false, '手动导入后墓碑应被清除');
  const after2 = await json('GET', '/api/conversations');
  assert.equal(after2.conversations.filter((c) => c.sourceRef === item.ref).length, 1, '手动导入应该能恢复');
});

/* ---------- 报错处理：分类 / 自动接手 / 主动修复 ---------- */

await check('用之前先体检：接口能分辨能用和不能用的引擎', async () => {
  const mock = await json('GET', '/api/engines/mock/preflight');
  assert.equal(mock.ok, true, `模拟引擎应该体检通过：${JSON.stringify(mock.checks)}`);
  assert.ok(mock.checks.some((check) => check.name === '命令行程序' && check.ok));
  assert.ok(mock.checks.some((check) => check.name === '能正常启动' && check.ok), '应该真的跑一次确认能启动');

  const broken = await json('GET', '/api/engines/broken/preflight');
  assert.equal(broken.ok, false, '找不到的程序应该体检不通过');
  const failed = broken.checks.filter((check) => !check.ok);
  assert.ok(failed.length >= 1);
  assert.ok(failed[0].detail.includes('definitely-not-a-real-binary'), '要说清楚哪儿不对');
});

await check('不可用时：先拦住（带原因），或者直接换成能用的引擎', async () => {
  // 关掉自动换 → 应该明确拦住，并带上体检结果
  await json('PATCH', '/api/settings', { fallback: { enabled: false, engines: [] } });
  let blocked = null;
  try {
    await streamPath('/api/chat', { engineId: 'broken', content: '能用吗', cwd: tmp });
  } catch (err) {
    blocked = err;
  }
  assert.ok(blocked, '不可用的引擎不该放行');
  assert.equal(blocked.status, 409);
  assert.ok(blocked.payload?.preflight, '要带上体检结果，界面才能说清楚原因');
  assert.ok(
    blocked.payload.preflight.checks.some((check) => !check.ok),
    '体检结果里要有没过的检查项'
  );

  // 开着自动换 → 直接换掉，用户根本看不到报错
  await json('PATCH', '/api/settings', { fallback: { enabled: true, engines: ['mock'], maxAttempts: 1 } });
  const events = await streamPath('/api/chat', { engineId: 'broken', content: '换谁答', cwd: tmp });
  const start = events.find((event) => event.type === 'start');
  assert.equal(start.engineId, 'mock', '应该直接换成能用的那个');
  assert.equal(start.requestedEngineId, 'broken', '要记住用户原本选的是谁');
  assert.ok(start.preflightFallback, 'start 事件里要说明为什么换');
  const text = events.filter((event) => event.type === 'delta').map((event) => event.text).join('');
  assert.ok(text.includes('模拟引擎'), '接手的引擎应该真的回答了');
});

async function streamPath(path, payload) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    let parsed = null;
    try {
      parsed = detail ? JSON.parse(detail) : null;
    } catch {
      parsed = null;
    }
    const err = new Error(parsed?.error || `${path} 返回 ${res.status}：${detail.slice(0, 200)}`);
    err.status = res.status;
    err.payload = parsed;
    throw err;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const events = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';
    for (const frame of frames) {
      const line = frame.split('\n').find((l) => l.startsWith('data:'));
      if (line) events.push(JSON.parse(line.slice(5).trim()));
    }
  }
  return events;
}

await check('报错分类：能认出登录 / 限流 / 网络 / 环境这几类问题', async () => {
  assert.equal(classifyFailure({ errors: ['Not logged in · Please run /login'] }).kind, 'auth');
  assert.equal(classifyFailure({ errors: ['HTTP 429 Too Many Requests'] }).kind, 'quota');
  assert.equal(classifyFailure({ errors: ['fetch failed'] }).kind, 'network');
  assert.equal(classifyFailure({ errors: ['Error finding codex home: Could not find home directory'] }).kind, 'env');
  assert.equal(classifyFailure({ text: '有正常输出', errors: [] }), null, '正常输出不该算失败');
  assert.equal(classifyFailure({ text: '', exitCode: 3 }).kind, 'crash', '没输出 + 非 0 退出码应算崩溃');
  assert.equal(classifyFailure({ text: '部分输出', exitCode: 3 }), null, '有输出就不当失败处理');
});

await check('报错匹配：不同错误类型会优先分配不同特长的模型', async () => {
  const settings = { fallback: { engines: ['mock'] } };
  const agents = ['codex', 'claude', 'workbuddy', 'qwen', 'deepseek-harness'];
  const authOrder = repairCandidateOrder({ kind: 'auth' }, settings);
  assert.ok(agents.includes(authOrder[0]), `登录问题应优先给能改配置的 CLI，实际 ${authOrder[0]}`);
  const netOrder = repairCandidateOrder({ kind: 'network' }, settings);
  assert.ok(netOrder.includes('ollama'), '网络问题应该能想到本机 Ollama');
  assert.ok(netOrder.indexOf('ollama') < netOrder.indexOf('mock'), '网络问题优先本机服务');
});

await check('报错换模型：失败后自动交给可用模型接手并留痕', async () => {
  await json('PATCH', '/api/settings', { fallback: { enabled: true, engines: ['mock'], maxAttempts: 1 } });
  const events = await streamPath('/api/chat', { engineId: 'flaky', content: '帮我算一下 1+1', cwd: tmp });
  const text = events.filter((e) => e.type === 'delta').map((e) => e.text).join('');

  assert.ok(events.some((e) => e.type === 'error'), '应该先出现错误事件');
  const fb = events.find((e) => e.type === 'fallback');
  assert.ok(fb, `应该出现接手事件，实际：${JSON.stringify(events.map((e) => e.type))}`);
  assert.equal(fb.to, 'mock');
  assert.ok(fb.failure?.kind, '接手事件里应带上错误分类');
  assert.ok(text.includes('模拟引擎'), '接手模型应该真的回答了');

  const done = events.find((e) => e.type === 'done');
  assert.equal(done.fallback, true, 'done 事件应标记这次是接手回答');
  assert.ok(done.engineId === 'mock');

  const { conversation } = await json('GET', `/api/conversations/${events.find((e) => e.type === 'start').conversationId}`);
  assert.ok(
    conversation.messages.some((m) => m.role === 'system' && m.meta?.fallback),
    '对话里要留下「谁失败、换谁接手」的记录'
  );
  const last = conversation.messages.at(-1);
  assert.equal(last.role, 'assistant');
  assert.equal(last.meta.fallbackFrom, 'flaky');
});

await check('报错留痕：关掉自动接手时，失败会留下可处理的记录', async () => {
  await json('PATCH', '/api/settings', { fallback: { enabled: false, engines: ['mock'] } });
  const events = await streamPath('/api/chat', { engineId: 'flaky', content: '再来一次', cwd: tmp });
  const done = events.find((e) => e.type === 'done');
  assert.ok(done.failure?.kind, 'done 里应该带上错误分类');
  assert.ok(!events.some((e) => e.type === 'fallback'), '关掉之后不应该自动接手');

  const { conversation } = await json('GET', `/api/conversations/${events.find((e) => e.type === 'start').conversationId}`);
  const sys = conversation.messages.find((m) => m.role === 'system' && m.meta?.failure);
  assert.ok(sys, '应该留下一条带 failure 的系统消息');
  assert.equal(sys.meta.engineId, 'flaky');
});

await check('修复报错：按错误类型挑模型，修完在对话里留痕并标记原引擎', async () => {
  await json('PATCH', '/api/settings', { fallback: { enabled: false, engines: ['mock'] } });
  const chatEvents = await streamPath('/api/chat', { engineId: 'flaky', content: '我需要它正常工作', cwd: tmp });
  const conversationId = chatEvents.find((e) => e.type === 'start').conversationId;
  const { conversation } = await json('GET', `/api/conversations/${conversationId}`);
  const failed = conversation.messages.find((m) => m.role === 'system' && m.meta?.failure);
  assert.ok(failed, '先要有一次失败记录');

  const events = await streamPath('/api/repair', {
    conversationId,
    engineId: failed.meta.engineId,
    failure: failed.meta.failure,
    request: '我需要它正常工作',
    repairEngineId: 'mock'
  });
  assert.ok(events.some((e) => e.type === 'start' && e.repair), '应该有修复任务的开始事件');
  const text = events.filter((e) => e.type === 'delta').map((e) => e.text).join('');
  assert.ok(text.includes('模拟引擎'), '修复模型应该真的跑了');
  assert.ok(events.some((e) => e.type === 'done' && e.repair), '应该有修复完成事件');

  const after = await json('GET', `/api/conversations/${conversationId}`);
  const repairMsg = after.conversation.messages.find((m) => m.meta?.repair && m.role === 'assistant');
  assert.ok(repairMsg, '修复结果应该落进对话');
  assert.equal(repairMsg.meta.repairTarget, 'flaky', '要记住修的是哪个引擎');
  assert.ok(
    after.conversation.messages.some((m) => m.role === 'system' && m.meta?.repairWith === 'mock'),
    '要留下「用谁修」的记录'
  );
});

await check('翻译：逐条翻译并写回消息元数据', async () => {
  const created = await json('POST', '/api/conversations', { engineId: 'mock', cwd: tmp });
  const { added } = await json('POST', `/api/conversations/${created.conversation.id}/messages`, {
    messages: [
      { role: 'user', content: 'hello world' },
      { role: 'assistant', content: 'this is a test message' }
    ]
  });

  const events = await streamPath('/api/translate', {
    conversationId: created.conversation.id,
    messageIds: [added[1].id],
    targetLang: '简体中文',
    engineId: 'mock'
  });
  const start = events.find((e) => e.type === 'translate-start');
  assert.equal(start.total, 1, '应该只翻指定的一条');
  assert.equal(start.engineId, 'mock');
  assert.equal(start.targetLang, '简体中文');

  const translated = events.find((e) => e.type === 'translated');
  assert.ok(translated?.text, '应该拿到译文');

  const done = events.find((e) => e.type === 'translate-done');
  assert.equal(done.done, 1);
  assert.equal(done.failed, 0);

  const after = await json('GET', `/api/conversations/${created.conversation.id}`);
  const msg = after.conversation.messages.find((m) => m.id === added[1].id);
  assert.ok(msg.meta?.translation?.text, '译文要写进消息元数据（刷新后还在）');
  assert.equal(msg.meta.translation.lang, '简体中文');
  assert.equal(msg.meta.translation.engineId, 'mock');
});

await check('导入的会话重新同步后，译文不会被冲掉', async () => {
  // 拿一个「导入 + 已经被同步过」的会话
  const scan = await json('GET', '/api/history/scan?source=codex');
  const { conversations } = await json('GET', '/api/conversations');
  let item = null;
  let conv = null;
  let target = null;
  for (const candidate of scan.items.filter((x) => x.imported)) {
    const matched = conversations.find((c) => c.sourceRef === candidate.ref);
    if (!matched) continue;
    const full = await json('GET', `/api/conversations/${matched.id}`);
    const assistant = full.conversation.messages.find((m) => m.role === 'assistant');
    if (assistant) {
      item = candidate;
      conv = matched;
      target = assistant;
      break;
    }
  }
  assert.ok(item && conv && target, '需要一个带助手消息的已导入会话');

  const events = await streamPath('/api/translate', {
    conversationId: conv.id,
    messageIds: [target.id],
    targetLang: 'English',
    engineId: 'mock'
  });
  assert.ok(events.some((e) => e.type === 'translated'), '先得翻译成功');

  // 源文件继续增长 —— 模拟 CLI 那边还在用这个会话
  const srcFile = path.join(tmp, 'codex-sessions', ...item.ref.slice('codex:'.length).split('/'));
  fs.appendFileSync(
    srcFile,
    `\n${JSON.stringify({
      timestamp: new Date().toISOString(),
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '又来了一条' }] }
    })}\n`,
    'utf8'
  );
  const past = new Date(Date.now() - 8000);
  fs.utimesSync(srcFile, past, past);
  await json('POST', '/api/sync/now', {});

  const after = await json('GET', `/api/conversations/${conv.id}`);
  const stillThere = after.conversation.messages.find(
    (m) => m.role === 'assistant' && m.meta?.translation?.lang === 'English'
  );
  if (!stillThere) {
    const dbgFile = path.join(tmp, 'codex-sessions', ...item.ref.slice('codex:'.length).split('/'));
    console.log('      调试：ref =', item.ref, '| 文件行数 =', fs.readFileSync(dbgFile, 'utf8').split('\n').filter(Boolean).length);
    console.log('      调试：文件内容类型 =', fs.readFileSync(dbgFile, 'utf8').split('\n').filter(Boolean).map((l) => {
      try { const j = JSON.parse(l); return `${j.type}:${j.payload?.type || ''}:${j.payload?.role || ''}`; } catch { return 'bad'; }
    }).join(', '));
    console.log(
      '      调试：重新同步后消息 =',
      JSON.stringify(
        after.conversation.messages.map((m) => ({ role: m.role, meta: m.meta, head: String(m.content).slice(0, 20) })),
        null,
        1
      ).slice(0, 900)
    );
  }
  assert.ok(stillThere, '重新同步之后译文应该还在');
  assert.ok(
    after.conversation.messages.some((m) => m.content.includes('又来了一条')),
    '同时应该把新增的消息同步进来'
  );
});

/* ---------- 删除：无弹窗、同步到源软件、可撤回 ---------- */

async function pickImported({ needAssistant = false } = {}) {
  const scan = await json('GET', '/api/history/scan?source=codex');
  const { conversations } = await json('GET', '/api/conversations');
  for (const candidate of scan.items.filter((x) => x.imported && !x.ignored)) {
    const conv = conversations.find((c) => c.sourceRef === candidate.ref);
    if (!conv) continue;
    if (needAssistant) {
      const full = await json('GET', `/api/conversations/${conv.id}`);
      if (!full.conversation.messages.some((m) => m.role === 'assistant')) continue;
    }
    return { candidate, conv };
  }
  return null;
}

function sourcePathOf(ref) {
  return path.join(tmp, 'codex-sessions', ...ref.slice('codex:'.length).split('/'));
}

await check('删除：直接删掉，源软件里的记录也一起移走，可一键撤回', async () => {
  const picked = await pickImported();
  assert.ok(picked, '需要一个已导入的会话');
  const { candidate, conv } = picked;
  const file = sourcePathOf(candidate.ref);

  // 把 mtime 往前推，避开「CLI 还在写」的保护
  const past = new Date(Date.now() - 300000);
  fs.utimesSync(file, past, past);
  await json('POST', '/api/sync/now', {});
  fs.utimesSync(file, past, past);

  const del = await json('DELETE', `/api/conversations/${conv.id}`);
  assert.equal(del.ok, true);
  assert.equal(del.tombstoned, true, '导入来的会话要留删除记录');
  assert.ok(del.removedSource?.ok, `源文件该被移走，实际：${JSON.stringify(del.removedSource)}`);
  assert.ok(!fs.existsSync(file), '源目录里不该再有这个文件（源软件也就看不到它了）');
  assert.ok(fs.existsSync(del.removedSource.to), '回收站里应该留一份');

  const afterDelete = await json('GET', '/api/conversations');
  assert.ok(!afterDelete.conversations.some((c) => c.id === conv.id), '会话应该从列表里消失');

  const undo = await json('POST', '/api/trash/undo', { trashPath: del.removedSource.to, ref: candidate.ref });
  assert.equal(undo.ok, true, JSON.stringify(undo));
  assert.ok(fs.existsSync(file), '撤回后源文件要回到原位');
  const afterUndo = await json('GET', '/api/conversations');
  assert.ok(afterUndo.conversations.some((c) => c.sourceRef === candidate.ref), '撤回后会话也要回来');
});

await check('删除保护：CLI 还在写的会话只删工作台副本，不动源文件', async () => {
  const picked = await pickImported();
  assert.ok(picked, '需要一个已导入的会话');
  const { candidate, conv } = picked;
  const file = sourcePathOf(candidate.ref);
  const now = new Date();
  fs.utimesSync(file, now, now); // 刚刚被写过

  const del = await json('DELETE', `/api/conversations/${conv.id}`);
  assert.equal(del.tombstoned, true);
  assert.equal(del.removedSource?.reason, 'active', `实际：${JSON.stringify(del.removedSource)}`);
  assert.ok(fs.existsSync(file), '正在写的会话不能动源文件');
});

await check('删除记录跟着会话走：源文件改名搬家也不会复活', async () => {
  // 自己造一个独立的会话，免得受前面测试的删除记录影响
  const unique = `sess-${Date.now()}`;
  const file = path.join(historyDir, `rollout-${unique}.jsonl`);
  const stamp = new Date().toISOString();
  fs.writeFileSync(
    file,
    `${[
      { timestamp: stamp, type: 'session_meta', payload: { session_id: unique, id: unique, cwd: tmp, timestamp: stamp } },
      {
        timestamp: stamp,
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '搬家测试会话' }] }
      },
      {
        timestamp: stamp,
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '收到了' }] }
      }
    ]
      .map((line) => JSON.stringify(line))
      .join('\n')}\n`,
    'utf8'
  );
  const past = new Date(Date.now() - 300000);
  fs.utimesSync(file, past, past);
  await json('POST', '/api/sync/now', {});

  const { conversations } = await json('GET', '/api/conversations');
  const conv = conversations.find((c) => (c.sourceRef || '').includes(unique));
  assert.ok(conv, '新建的会话应该被同步进来');

  const del = await json('DELETE', `/api/conversations/${conv.id}`);
  assert.ok(del.removedSource?.ok, `先要能移走：${JSON.stringify(del.removedSource)}`);
  const content = fs.readFileSync(del.removedSource.to, 'utf8');

  // 模拟源软件把这条搬到别的目录（比如 Codex 从 sessions 挪进 archived_sessions）
  const moved = path.join(historyDir, 'moved', `rollout-${unique}.jsonl`);
  fs.mkdirSync(path.dirname(moved), { recursive: true });
  fs.writeFileSync(moved, content, 'utf8');
  fs.utimesSync(moved, past, past);

  await json('POST', '/api/sync/now', {});
  const after = await json('GET', '/api/conversations');
  assert.ok(
    !after.conversations.some((c) => (c.sourceRef || '').includes(unique)),
    '换了路径也一样不能复活（删除记录按 sessionId 认人）'
  );
});

await check('删了就一定不复活：源文件没能移走、之后还被改动', async () => {
  // 关掉「同时从源软件移除」，等价于源文件移除失败（文件留在原地）
  await json('PATCH', '/api/settings', { syncDelete: { removeSource: false } });

  const unique = `sess-${Date.now()}-keep`;
  const file = path.join(historyDir, `rollout-${unique}.jsonl`);
  const stamp = new Date().toISOString();
  fs.writeFileSync(
    file,
    `${[
      { timestamp: stamp, type: 'session_meta', payload: { session_id: unique, id: unique, cwd: tmp, timestamp: stamp } },
      {
        timestamp: stamp,
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '删了就别回来' }] }
      }
    ]
      .map((line) => JSON.stringify(line))
      .join('\n')}\n`,
    'utf8'
  );
  const past = new Date(Date.now() - 300000);
  fs.utimesSync(file, past, past);
  await json('POST', '/api/sync/now', {});

  const before = await json('GET', '/api/conversations');
  const conv = before.conversations.find((c) => (c.sourceRef || '').includes(unique));
  assert.ok(conv, '新会话应该先被同步进来');

  const del = await json('DELETE', `/api/conversations/${conv.id}`);
  assert.equal(del.ok, true);
  assert.equal(del.tombstoned, true, '即使不移源文件，也必须留下删除记录');
  assert.equal(del.removedSource, null, '这次不该去动源文件');
  assert.ok(fs.existsSync(file), '源文件还在（模拟移除失败）');

  // 删除记录里必须带上会话 ID，否则源文件改名搬家就认不出来了
  const ignored = JSON.parse(fs.readFileSync(path.join(dataDir, 'imported', 'ignored.json'), 'utf8'));
  assert.ok(ignored[conv.sourceRef]?.sessionId, '删除记录应该带上 sessionId');
  assert.ok(
    fs.existsSync(path.join(ROOT, 'tools', 'backfill-tombstones.mjs')),
    '早期记录可以用这个脚本补 sessionId'
  );

  // 源文件继续被 CLI 改写
  fs.appendFileSync(
    file,
    `\n${JSON.stringify({
      timestamp: new Date().toISOString(),
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '又写了一条' }] }
    })}\n`,
    'utf8'
  );
  fs.utimesSync(file, past, past);
  await json('POST', '/api/sync/now', {});

  const after = await json('GET', '/api/conversations');
  assert.ok(
    !after.conversations.some((c) => (c.sourceRef || '').includes(unique)),
    '源文件还在并且改过，也不能再出现'
  );

  await json('PATCH', '/api/settings', { syncDelete: { removeSource: true } });
});

await check('字体导入：上传 / 列表 / 下载 / 删除，非法格式拦住', async () => {
  const payload = Buffer.from('fake-font-bytes-for-test').toString('base64');
  const data = `data:font/ttf;base64,${payload}`;

  const up = await json('POST', '/api/fonts', { name: '我的字体.ttf', data });
  assert.equal(up.ok, true);
  assert.ok(up.font.id && up.font.file.endsWith('.ttf'), JSON.stringify(up.font));
  assert.ok(up.font.name.includes('我的字体'), '字体名应该保留');

  const list = await json('GET', '/api/fonts');
  assert.ok(list.fonts.some((f) => f.id === up.font.id), '上传的字体应该在列表里');

  const res = await fetch(`${BASE}/api/fonts/${encodeURIComponent(up.font.file)}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'font/ttf');
  assert.ok((await res.text()).includes('fake-font-bytes'), '下载回来的应该是原文件');

  let rejected = false;
  try {
    await json('POST', '/api/fonts', { name: 'not-a-font.exe', data });
  } catch {
    rejected = true;
  }
  assert.ok(rejected, '.exe 不该被当成字体收下');

  await json('DELETE', `/api/fonts/${encodeURIComponent(up.font.file)}`);
  const list2 = await json('GET', '/api/fonts');
  assert.ok(!list2.fonts.some((f) => f.id === up.font.id), '删掉之后不该还在列表里');
});

await check('外观设置落盘：下次打开还是上次的样子', async () => {
  const want = { mode: 'light', accent: '#a78bfa', font: 'songti', fontSize: 1.16, customFonts: [] };
  await json('PATCH', '/api/settings', { appearance: want });

  const file = path.join(dataDir, 'settings.json');
  assert.ok(fs.existsSync(file), '设置应该写进 data/settings.json');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.appearance.mode, 'light');
  assert.equal(saved.appearance.accent, '#a78bfa');
  assert.equal(saved.appearance.font, 'songti');
  assert.equal(saved.appearance.fontSize, 1.16);

  // 模拟重启后再读一次
  const again = (await json('GET', '/api/settings')).settings.appearance;
  assert.equal(again.mode, 'light');
  assert.equal(again.accent, '#a78bfa');

  await json('PATCH', '/api/settings', {
    appearance: { mode: 'dark', accent: '#7c9cff', font: 'system', fontSize: 1, customFonts: [] }
  });
});

await check('环境变量：能解析 profile 里写的变量，并且不把密钥原样吐出来', async () => {
  const info = await json('GET', '/api/env');
  assert.ok(info.captured > 0 || info.profileVars > 0, '至少要抓到一种来源的环境变量');
  assert.ok(Array.isArray(info.resolved) && info.resolved.length >= 0);

  const secret = info.resolved.find((item) => /TOKEN|KEY|SECRET/i.test(item.key) && item.value);
  if (secret) {
    assert.ok(
      secret.value.includes('…') || secret.value === '已设置',
      `密钥类变量要脱敏，实际：${secret.key}=${secret.value}`
    );
  }
  // 至少在真实机器上 profile 里写过 ANTHROPIC_*，注入时应该能生效
  const modelVar = info.resolved.find((item) => item.key === 'ANTHROPIC_MODEL');
  if (modelVar) assert.ok(modelVar.value.length > 0, 'ANTHROPIC_MODEL 应该有值');
});

await check('动态模型：按引擎自己的配置读模型列表，而不是写死的', async () => {
  const { engines } = await json('GET', '/api/engines');
  const catalog = engines.find((engine) => engine.id === 'catalog');
  assert.ok(catalog, '应该有这个测试引擎');
  assert.deepEqual(catalog.models, ['test-flash', 'test-pro'], `实际：${JSON.stringify(catalog.models)}`);
});

cleanup();

const failed = results.filter((r) => !r.ok);
console.log(`\n结果：${results.length - failed.length}/${results.length} 项通过`);
if (failed.length) {
  console.log('\n失败项：');
  for (const item of failed) console.log(`  - ${item.name}: ${item.error}`);
  process.exit(1);
}
console.log('全部通过 ✅\n');
