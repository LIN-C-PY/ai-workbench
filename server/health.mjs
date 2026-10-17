/**
 * 判断一次运行到底算不算失败，以及是哪一类失败。
 * 分类结果用来决定「要不要换个模型接手」，也给用户一句能懂的解释。
 */

const PATTERNS = [
  {
    kind: 'auth',
    re: /not logged in|please run \/login|unauthorized|invalid api key|401|authentication|没有登录|未登录|凭证|credential/i,
    hint: '这个 CLI / 接口还没有登录或密钥无效，先在终端登录一次，或到「设置 → API Key」里补上密钥。'
  },
  {
    kind: 'quota',
    re: /rate limit|too many requests|429|quota|insufficient balance|余额|限流|超限/i,
    hint: '额度不足或触发限流，等一会儿再试，或者换一个模型。'
  },
  {
    kind: 'network',
    re: /econnrefused|enotfound|etimedout|fetch failed|socket hang up|proxy|network|无法连接|连接失败|超时/i,
    hint: '网络不通或本地服务没启动（比如 Ollama）。检查代理 / 服务状态。'
  },
  {
    kind: 'env',
    re: /could not find home directory|cannot find (the )?path|enoent|不是内部或外部命令|not recognized/i,
    hint: '运行环境有问题：找不到可执行文件或关键环境变量（比如 HOME）。'
  },
  {
    kind: 'context',
    re: /context length|context window|token limit|too long|maximum context|上下文超长/i,
    hint: '上下文太长，换个窗口更大的模型，或先精简对话。'
  },
  {
    kind: 'model',
    re: /model not found|does not exist|unknown model|no such model|模型不存在/i,
    hint: '模型名不对，检查引擎的模型列表。'
  }
];

export function classifyMessage(message) {
  const text = String(message || '');
  for (const rule of PATTERNS) {
    if (rule.re.test(text)) return { kind: rule.kind, hint: rule.hint };
  }
  return { kind: 'engine', hint: '引擎自己报的错，通常是权限、参数或上游服务的问题。' };
}

/**
 * @param {{errors?:string[], text?:string, exitCode?:number, httpStatus?:number, timedOut?:boolean, signalled?:boolean}} run
 * @returns {null | {kind:string, message:string, hint:string, retryable:boolean}}
 */
export function classifyFailure(run) {
  const errors = (run.errors || []).filter(Boolean);
  const text = String(run.text || '').trim();

  if (run.signalled) return null; // 用户自己按的停止，不算故障

  if (errors.length) {
    const message = errors[0];
    const { kind, hint } = classifyMessage(message);
    return { kind, message, hint, retryable: kind !== 'auth' ? true : false };
  }
  if (run.timedOut) {
    return { kind: 'timeout', message: '运行超时', hint: '这次跑太久了，可以让别的模型接着试。', retryable: true };
  }
  if (typeof run.httpStatus === 'number' && run.httpStatus >= 400) {
    return { kind: 'http', message: `HTTP ${run.httpStatus}`, hint: '接口返回了错误状态码。', retryable: run.httpStatus >= 500 };
  }
  if (typeof run.exitCode === 'number' && run.exitCode !== 0 && !text) {
    return {
      kind: 'crash',
      message: `进程退出码 ${run.exitCode}`,
      hint: '命令行程序异常退出且没有输出，可能是参数不兼容或缺少依赖。',
      retryable: true
    };
  }
  if (!text) {
    return { kind: 'empty', message: '没有任何输出', hint: '引擎这次什么都没返回。', retryable: true };
  }
  return null;
}

/** 给接手的模型看的说明 */
export function fallbackPrompt({ engineLabel, model, request, failure }) {
  return [
    '【上一个引擎执行失败，需要你接手】',
    `引擎：${engineLabel}${model ? `（模型 ${model}）` : ''}`,
    `错误类型：${failure.kind}`,
    `错误信息：${failure.message}`,
    failure.hint ? `可能原因：${failure.hint}` : '',
    '',
    '【用户的原始请求】',
    request,
    '',
    '请先一到两句话说明这个错误大概是什么原因、你是怎么绕过的，然后直接完成上面的原始请求。',
    '如果你也做不到，就直接告诉用户需要做什么，不要编造已完成。'
  ]
    .filter((line) => line !== '')
    .join('\n');
}

/**
 * 「匹配可用模型」：不同错误交给不同特长的模型去修。
 * 返回的是候选引擎 id 的顺序，调用方按顺序挑第一个真正可用的。
 */
export function repairCandidateOrder(failure, settings = {}) {
  const kind = failure?.kind || 'engine';
  const fallbackOrder = settings.fallback?.engines || [];
  // 能读写本机文件、能跑命令的 CLI agent，才修得动环境和配置类问题
  const agents = ['codex', 'claude', 'workbuddy', 'qwen', 'deepseek-harness'];
  const locals = ['ollama'];

  const byKind = {
    auth: [...agents, ...locals], // 需要改配置 / 重新登录 / 换密钥
    env: [...agents],
    crash: [...agents],
    config: [...agents],
    model: [...agents, ...locals],
    network: [...locals, ...fallbackOrder, ...agents], // 先用本地服务排除是不是网络问题
    quota: [...fallbackOrder, ...locals, ...agents],
    http: [...fallbackOrder, ...locals, ...agents],
    timeout: [...fallbackOrder, ...locals, ...agents],
    empty: [...agents, ...locals, ...fallbackOrder],
    engine: [...agents, ...locals, ...fallbackOrder]
  };

  const ordered = byKind[kind] || byKind.engine;
  return [...new Set([...ordered, ...fallbackOrder, ...agents, ...locals])];
}

/** 让一个模型去修另一个模型的报错 */
export function repairPrompt({ engine, spec, failure, request, paths = {} }) {
  return [
    '【任务：排查并修复另一个 AI 引擎的报错】',
    '',
    `出问题的引擎：${engine?.label || engine?.id || '未知'}（${engine?.id || '?'}）`,
    `错误类型：${failure?.kind || 'unknown'}`,
    `错误信息：${failure?.message || '(未提供)'}`,
    failure?.hint ? `初步判断：${failure.hint}` : '',
    spec ? `它的启动方式：${spec.command} ${spec.args.join(' ')}` : '',
    engine?.entry ? `入口文件：${engine.entry}` : '',
    paths.cwd ? `它运行的工作目录：${paths.cwd}` : '',
    paths.config ? `工作台引擎配置：${paths.config}` : '',
    paths.runDir ? `运行日志目录（每次运行的原始事件都在里面）：${paths.runDir}` : '',
    request ? `\n【用户原本想让它做的事】\n${request}` : '',
    '',
    '【要求】',
    '1. 先定位根因，不要凭空猜：该读文件就读、该跑命令就跑、该看日志就看。',
    '2. 能在本机直接修的就直接修：改配置、补环境变量、修启动参数、启动缺的服务。',
    '3. 需要用户本人操作的（比如重新登录、输密码），别硬试，给出可复制的命令或步骤。',
    '4. 修完必须验证：跑一条能证明它恢复正常的命令，把关键输出贴出来。',
    '5. 最后用一小段话总结：改了什么 / 现在能不能用 / 用户下一步做什么。'
  ]
    .filter((line) => line !== '')
    .join('\n');
}
