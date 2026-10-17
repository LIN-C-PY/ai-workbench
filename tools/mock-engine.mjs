/**
 * 模拟一个 Claude Code 风格的 CLI 引擎，用来在没有网络/没有账号的情况下
 * 验证工作台的命令行通道：stdin 收提示词，stdout 吐 stream-json，stderr 混杂日志。
 */
import readline from 'node:readline';

const args = process.argv.slice(2);
const sessionId = `mock-${Math.random().toString(36).slice(2, 10)}`;

const rl = readline.createInterface({ input: process.stdin });
const chunks = [];
rl.on('line', (line) => chunks.push(line));
rl.on('close', async () => {
  const prompt = chunks.join('\n').trim() || args.join(' ').trim();
  const emit = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  process.stderr.write('mock engine booting...\n');
  emit({ type: 'system', subtype: 'init', session_id: sessionId, cwd: process.cwd() });
  await wait(60);

  emit({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: `收到你的消息：${prompt.slice(0, 120)}` }] },
    sessionId
  });
  await wait(60);

  emit({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'README.md' } }] },
    sessionId
  });
  await wait(60);

  // Codex 风格的命令执行事件：这类内容只能作为工具调用展示，不能混进正文
  emit({
    type: 'item.completed',
    item: { type: 'command_execution', command: 'dir', aggregated_output: 'SHOULD-NOT-APPEAR-IN-TEXT' }
  });
  await wait(60);

  emit({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: [
            '这是**模拟引擎**的输出，用来测试命令行通道。',
            '',
            '1. 支持 Markdown 渲染',
            '2. 支持工具调用展示',
            '',
            '```js',
            'console.log("hello from mock");',
            '```'
          ].join('\n')
        }
      ]
    },
    sessionId
  });
  await wait(60);

  emit({ type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: sessionId });
  process.exit(0);
});
