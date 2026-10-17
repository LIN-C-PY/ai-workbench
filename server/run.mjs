import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, RUN_DIR, ensureDirs } from './config.mjs';
import { buildSpawn, resolveOpenAI } from './engines.mjs';
import { LineBuffer, TextAccumulator, parseLine, stripAnsi } from './stream.mjs';

/** stderr 里哪些内容算「疑似故障」，用于失败判定 */
const LOOKS_LIKE_ERROR =
  /error|错误|失败|异常|denied|refused|not found|exception|fatal|not logged in|unauthorized|rate limit|超时|无法/i;

/** stdout 里的这类内容属于「程序自己的提示」，不是模型回答 */
const LOOKS_LIKE_NOTICE =
  /^\s*(WARNING|WARN|Codex is ignoring|Reading (prompt|additional input) from stdin|OpenAI Codex v|workdir:|model:|provider:|approval:|sandbox:|reasoning (effort|summaries):|session id:)/i;

function logRun(runId, event) {
  try {
    ensureDirs();
    fs.appendFileSync(path.join(RUN_DIR, `${runId}.jsonl`), `${JSON.stringify(event)}\n`, 'utf8');
  } catch {
    /* 日志写失败不影响主流程 */
  }
}

function killTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
    } else {
      process.kill(-pid, 'SIGTERM');
    }
  } catch {
    /* ignore */
  }
}

/**
 * 跑一个 CLI 引擎，把输出翻译成统一事件流。
 * @param {(event:object)=>void} emit
 */
export function runCli({ engine, spec, runId, onEvent, signal, timeoutMs = 30 * 60 * 1000 }) {
  return new Promise((resolve) => {
    const emit = (event) => {
      logRun(runId, event);
      onEvent(event);
    };

    emit({ type: 'command', command: spec.display, cwd: spec.cwd });

    // 工作目录不存在时 spawn 会抛出误导性的 ENOENT，这里提前兜住
    let cwd = spec.cwd;
    try {
      if (!cwd || !fs.statSync(cwd).isDirectory()) throw new Error('not a directory');
    } catch {
      emit({ type: 'log', stream: 'system', line: `工作目录不可用（${cwd || '未设置'}），本次运行改在 ${ROOT}` });
      cwd = ROOT;
    }

    let child;
    try {
      // spec.env 里已经带上了「用户终端那套环境」（含 profile 里写的变量）+ 引擎自己的 env
      const baseEnv = spec.env && Object.keys(spec.env).length ? spec.env : process.env;
      const env = { ...baseEnv, FORCE_COLOR: '0', NO_COLOR: '1', CI: '1' };
      child = spawn(spec.command, spec.args, {
        cwd,
        windowsHide: true,
        shell: false,
        env
      });
    } catch (err) {
      emit({ type: 'error', message: `启动失败：${err.message}` });
      resolve({ text: '', sessionId: null, exitCode: -1 });
      return;
    }

    const lineBuffers = { stdout: new LineBuffer(), stderr: new LineBuffer() };
    const accumulator = new TextAccumulator();
    const errors = [];
    let sessionId = null;
    let finished = false;
    let timedOut = false;
    let signalled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      emit({ type: 'log', stream: 'system', line: `超过 ${Math.round(timeoutMs / 60000)} 分钟，已终止本次运行` });
      killTree(child.pid);
    }, timeoutMs);

    const handleLine = (stream, line) => {
      const parsed = parseLine(line);
      if (parsed.sessionId && !sessionId) {
        sessionId = parsed.sessionId;
        emit({ type: 'session', sessionId });
      }
      if (parsed.kind === 'empty') return;

      if (parsed.kind === 'tool' && parsed.tool) {
        emit({ type: 'tool', name: parsed.tool.name, input: parsed.tool.input });
        return;
      }
      if (parsed.kind === 'error') {
        emit({ type: 'log', stream: 'stderr', line: parsed.text || parsed.raw });
        emit({ type: 'error', message: parsed.text || '引擎返回错误' });
        errors.push(parsed.text || '引擎返回错误');
        return;
      }
      if (parsed.kind === 'text' && parsed.text) {
        // 纯文本行里那些「警告 / 提示」不算回答内容，只进日志
        if (stream === 'stdout' && LOOKS_LIKE_NOTICE.test(parsed.text)) {
          const plain = stripAnsi(parsed.text).trim();
          if (plain) emit({ type: 'log', stream: 'system', line: plain });
          return;
        }
        // stderr 是诊断信息，不能当正文塞进回答里
        if (stream === 'stderr') {
          const plain = stripAnsi(parsed.text).trim();
          if (plain) {
            emit({ type: 'log', stream: 'stderr', line: plain });
            if (LOOKS_LIKE_ERROR.test(plain)) errors.push(plain);
          }
          return;
        }
        const delta = accumulator.push(parsed.text);
        if (delta) emit({ type: 'delta', text: delta });
        return;
      }
      if (stream === 'stderr') {
        const plain = stripAnsi(parsed.raw).trim();
        if (plain) {
          emit({ type: 'log', stream: 'stderr', line: plain });
          if (/error|错误|失败|denied|not found|refused/i.test(plain)) errors.push(plain);
        }
      } else if (parsed.json) {
        emit({ type: 'raw', json: parsed.json });
      }
    };

    for (const stream of ['stdout', 'stderr']) {
      child[stream].setEncoding('utf8');
      child[stream].on('data', (chunk) => {
        for (const line of lineBuffers[stream].feed(chunk)) handleLine(stream, line);
      });
    }

    const finish = (exitCode) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      for (const stream of ['stdout', 'stderr']) {
        for (const line of lineBuffers[stream].flush()) handleLine(stream, line);
      }
      const text = accumulator.emit;
      if (exitCode !== 0 && !text) {
        emit({ type: 'error', message: `进程退出码 ${exitCode}，且没有输出。可以在右侧日志里查看完整命令行。` });
      }
      resolve({ text, sessionId, exitCode, errors, timedOut, signalled });
    };

    child.on('error', (err) => {
      emit({ type: 'error', message: `进程启动异常：${err.message}` });
      errors.push(`进程启动异常：${err.message}`);
      finish(-1);
    });
    child.on('close', (code) => finish(code ?? 0));

    if (signal) {
      const abort = () => {
        signalled = true;
        killTree(child.pid);
      };
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    }

    if (spec.stdin !== null && spec.stdin !== undefined) {
      try {
        child.stdin.write(spec.stdin);
        child.stdin.end();
      } catch (err) {
        emit({ type: 'log', stream: 'system', line: `写入 stdin 失败：${err.message}` });
      }
    } else {
      try {
        child.stdin.end();
      } catch {
        /* ignore */
      }
    }
  });
}

/** 跑一个 OpenAI 兼容接口，把 SSE 流翻译成同一套事件。 */
export async function runOpenAI({ engine, model, messages, onEvent, signal, runId }) {
  const { baseUrl, apiKey, model: resolvedModel, extraBody, headers } = resolveOpenAI(engine, model);
  if (!baseUrl) {
    onEvent({ type: 'error', message: '这个引擎还没有填写 baseUrl，请到设置里补上。' });
    return { text: '', usage: null };
  }

  const url = `${baseUrl}/chat/completions`;
  const body = { model: resolvedModel, messages, stream: true, ...extraBody };
  onEvent({ type: 'command', command: `POST ${url}  (model=${resolvedModel})`, cwd: '' });

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        ...headers
      },
      body: JSON.stringify(body),
      signal
    });
  } catch (err) {
    if (err.name === 'AbortError') return { text: '', usage: null, errors: [], signalled: true };
    onEvent({ type: 'error', message: `连接失败：${err.message}` });
    return { text: '', usage: null, errors: [`连接失败：${err.message}`] };
  }

  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => '');
    onEvent({ type: 'error', message: `HTTP ${res.status} ${res.statusText} ${detail.slice(0, 600)}` });
    return { text: '', usage: null, httpStatus: res.status, errors: [`HTTP ${res.status} ${res.statusText} ${detail.slice(0, 300)}`] };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const buffer = new LineBuffer();
  let full = '';
  let reasoningText = '';
  let usage = null;
  let finishReason = null;

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      for (const rawLine of buffer.feed(decoder.decode(value, { stream: true }))) {
        const line = rawLine.trim();
        if (!line || line.startsWith(':')) continue;
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') continue;
        let json;
        try {
          json = JSON.parse(payload);
        } catch {
          continue;
        }
        if (json.usage) usage = json.usage;
        const choice = json.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) finishReason = choice.finish_reason;
        const delta = choice.delta || {};
        // 推理模型（deepseek-flash 等）会先吐 reasoning_content，那不是给人看的正文
        if (delta.reasoning_content) {
          reasoningText += delta.reasoning_content;
          onEvent({ type: 'reasoning', text: delta.reasoning_content });
        }
        const piece = delta.content || '';
        if (piece) {
          full += piece;
          onEvent({ type: 'delta', text: piece });
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const call of delta.tool_calls) {
            if (call.function?.name) onEvent({ type: 'tool', name: call.function.name, input: call.function.arguments });
          }
        }
        if (choice.message?.content && !full) {
          full = choice.message.content;
          onEvent({ type: 'delta', text: full });
        }
      }
    }
  } catch (err) {
    if (err.name !== 'AbortError') onEvent({ type: 'error', message: `读取流失败：${err.message}` });
  }

  logRun(runId, { type: 'done', length: full.length, usage, finishReason });
  // 只有推理、没有正文时，把推理当结果（不然用户看到一片空白）
  if (!full && reasoningText) {
    full = reasoningText;
    onEvent({ type: 'delta', text: reasoningText });
  }
  return { text: full, usage, finishReason };
}

export { buildSpawn, killTree };
