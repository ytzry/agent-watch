import { readFileSync, existsSync, watchFile, readdirSync, openSync, readSync, statSync, closeSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { hub, STATES } from './hub.js';

/**
 * 文件 tail 解析器：监听各 agent 的 rollout/transcript 文件，提取：
 *  - 上下文用量（token 数 / 上下文窗口）
 *  - 子代理用量
 *  - 最后助手消息
 *
 * 各家文件：
 *  - ZCode:   ~/.zcode/cli/rollout/model-io-sess_<sid>.jsonl
 *  - Claude:  ~/.claude/projects/<encoded-cwd>/<sid>.jsonl
 *  - Codex:   ~/.codex/sessions/<sid>.jsonl
 *
 * 这些都是内部格式（官方标注可能变更），解析必须容错：任何字段缺失/结构变化
 * 都静默降级（usage 保持 null，不报错）。
 */

function expandHome(p) {
  if (!p) return null;
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return path.join(homedir(), p.slice(2));
  return p;
}

/* ---------- ZCode 模型上下文窗口（从官方 model catalog 读取） ---------- */
const ZCODE_CATALOG_DIR = '/Applications/ZCode.app/Contents/Resources/model-providers';
let zcodeContextCache = null; // { modelId -> contextWindow }

/** 加载 ZCode 模型目录，构建 modelId → contextWindow 映射（缓存） */
function loadZCodeContextWindows() {
  if (zcodeContextCache) return zcodeContextCache;
  const cache = {};
  try {
    const dir = ZCODE_CATALOG_DIR;
    if (!existsSync(dir)) return cache;
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    for (const f of files) {
      try {
        const catalog = JSON.parse(readFileSync(path.join(dir, f), 'utf8'));
        const providers = catalog.providers || [];
        for (const p of providers) {
          const models = p.models || p.modelList || [];
          const walk = (m) => {
            if (!m || typeof m !== 'object') return;
            const cw = m.contextWindow || m.context_window || m.contextLength;
            const id = m.modelId || m.id || m.name;
            if (cw && id) cache[id] = cw;
            // 嵌套找（models 可能是对象或数组）
            if (Array.isArray(m.models)) m.models.forEach(walk);
            else if (m.models && typeof m.models === 'object') Object.values(m.models).forEach(walk);
          };
          // models 可能是数组或对象
          if (Array.isArray(models)) models.forEach(walk);
          else if (models && typeof models === 'object') Object.values(models).forEach(walk);
        }
      } catch {}
    }
  } catch {}
  zcodeContextCache = cache;
  return cache;
}

/** 按模型 id 查上下文窗口（支持前缀匹配，如 deepseek/deepseek-v4-flash） */
function zcodeContextWindowFor(modelId) {
  if (!modelId) return null;
  const cache = loadZCodeContextWindows();
  if (cache[modelId]) return cache[modelId];
  // 前缀匹配：deepseek-v4-flash 或 xxx/deepseek-v4-flash
  const base = modelId.split('/').pop();
  for (const [id, cw] of Object.entries(cache)) {
    if (id === base || id.endsWith('/' + base) || base.endsWith(id)) return cw;
  }
  return null;
}

/**
 * 通用上下文窗口推断（借鉴 Claude-Code-Agent-Monitor 的 [1m] 启发式）：
 * 1. 先从 ZCode model catalog（如可读）精确查
 * 2. 模型名带 [1m]/[1M] 后缀 → 1M（Claude 1M 变体）
 * 3. 已知默认窗口表
 * 4. 兜底 200k（Claude Code 历史默认）
 * 返回 null 表示"无法可靠推断"（调用方决定是否用默认值）。
 */
const KNOWN_CONTEXT_WINDOWS = {
  'deepseek-v4-flash': 1000000,
  'deepseek-v3': 1000000,
  'claude-opus': 200000,
  'claude-sonnet': 200000,
  'claude-haiku': 200000,
  'gpt-5': 400000,
  'gpt-5.5': 400000,
  'gpt-4': 128000,
  'gpt-4o': 128000,
  'o3': 200000,
  'o4': 200000,
};

export function inferContextWindow(modelId, catalogLookup = zcodeContextWindowFor) {
  if (!modelId) return null;
  const fromCatalog = catalogLookup(modelId);
  if (fromCatalog) return fromCatalog;
  // [1m] / [1M] 后缀 → 1M 窗口（Claude 1M 变体，CCAM 同款启发式）
  if (/\[1m\]/i.test(modelId)) return 1000000;
  const base = modelId.split('/').pop().toLowerCase();
  for (const [name, cw] of Object.entries(KNOWN_CONTEXT_WINDOWS)) {
    if (base === name || base.startsWith(name + '-') || base.startsWith(name + ':')) return cw;
  }
  return null;
}

/** 按模型 id 解析 context window（查不到时用默认 200k，但会带出模型名供前端排查） */
function contextWindowFor(modelId) {
  return inferContextWindow(modelId) || 200000;
}

/** 找 ZCode rollout 文件（子代理为 model-io-sess_subagent_*） */
function findZCodeRollout(sessionId, cwd) {
  const dir = expandHome('~/.zcode/cli/rollout');
  // 主会话
  const main = path.join(dir, `model-io-sess_${sessionId}.jsonl`);
  if (existsSync(main)) return main;
  // 会话 ID 可能是短前缀（sess_xxx 开头），放宽匹配
  if (!existsSync(dir)) return null;
  try {
    const files = readdirSync(dir);
    const match = files.find((f) => f.includes(sessionId));
    return match ? path.join(dir, match) : null;
  } catch {
    return null;
  }
}

/** 解析 ZCode rollout JSONL，提取 usage 和 max_tokens（只读文件尾部，避免大文件 OOM） */
function parseZCodeRollout(filePath, sessionId) {
  try {
    const fd = openSync(filePath, 'r');
    const size = statSync(filePath).size;
    // 只读最后 512KB（usage 在最新记录）
    const readLen = Math.min(size, 512 * 1024);
    const buf = Buffer.alloc(readLen);
    readSync(fd, buf, 0, readLen, size - readLen);
    closeSync(fd);
    const text = buf.toString('utf8');
    const lines = text.split('\n').filter(Boolean);
    let last = null;
    let modelId = '';
    // 缓存命中率统计（当前会话，最近 readLen 内所有请求）
    let sumInput = 0, sumCacheRead = 0, sumCacheCreate = 0;
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        // usage 嵌套在 response 里（也可能是顶层，防御两种）
        const u = obj.usage || obj.response?.usage;
        // 取最后一条"有实际上下文"的 usage（跳过空记录）
        if (u && (u.inputTokens ?? 0) >= 500) last = u;
        // 模型 id（从 model.modelId 读）
        if (!modelId && obj.model?.modelId) modelId = obj.model.modelId;
        // 缓存命中率：累计最近所有请求（只算有实际 token 的）
        if (u && (u.inputTokens ?? 0) > 0) {
          sumInput += u.inputTokens ?? 0;
          sumCacheRead += u.cacheReadTokens ?? 0;
          sumCacheCreate += u.cacheCreationTokens ?? u.cacheWriteTokens ?? 0;
        }
      } catch {}
    }
    if (!last) return null;
    // 上下文窗口：优先从官方 model catalog 查（deepseek-v4-flash = 1000000），再按模型名推断
    // 之前用 request.body.max_tokens（输出上限）是错的
    const ctxWindow = contextWindowFor(modelId);
    const hitDenom = sumInput + sumCacheRead + sumCacheCreate;
    return {
      inputTokens: last.inputTokens ?? null,
      outputTokens: last.outputTokens ?? null,
      // ZCode 的 totalTokens 是单次请求 input+output = 当前上下文
      totalTokens: last.totalTokens ?? null,
      contextTokens: last.totalTokens ?? null,
      cacheReadTokens: last.cacheReadTokens ?? null,
      reasoningTokens: last.reasoningTokens ?? null,
      maxTokens: ctxWindow,
      // 缓存命中率 = cache_read / (input + cache_read + cache_create)，范围 0-1
      cacheHitRate: hitDenom > 0 ? Math.round((sumCacheRead / hitDenom) * 1000) / 1000 : null,
    };
  } catch {
    return null;
  }
}

/** 解析 Claude transcript（assistant 消息行含 usage）。只读文件尾部（避免大文件 OOM）。 */
function parseClaudeTranscript(filePath, sessionId) {
  try {
    const size = statSync(filePath).size;
    const fd = openSync(filePath, 'r');
    // 只读最后 1MB：usage/标题都在尾部（最近请求的上下文 + 最新 ai-title + 最后消息）
    const readLen = Math.min(size, 1 * 1024 * 1024);
    const buf = Buffer.alloc(readLen);
    readSync(fd, buf, 0, readLen, size - readLen);
    closeSync(fd);
    const text = buf.toString('utf8');
    // 从首个完整行开始（截断可能从行中间开始）
    const firstNewline = text.indexOf('\n');
    const body = firstNewline === -1 ? text : text.slice(firstNewline + 1);
    const lines = body.split('\n').filter(Boolean);
    // 累计用量（参考 ccusage：input + output + cache_creation + cache_read）
    let totalInput = 0, totalOutput = 0, totalCacheRead = 0, totalCacheCreate = 0;
    let lastContextInput = 0; // 最近一次请求的上下文大小（input）
    let lastText = '';
    let aiTitle = '';
    let firstPrompt = '';
    let cwd = '';
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        // ai-title 行（开源项目用它做会话标题）
        if (obj.type === 'ai-title' && obj.title && !aiTitle) aiTitle = obj.title;
        if (!cwd && obj.cwd) cwd = obj.cwd;
        // 首条真实 user 文本（fallback 标题，跳过 tool_result）
        if (!firstPrompt && obj.type === 'user' && obj.message?.content) {
          const c = obj.message.content;
          let text = '';
          if (typeof c === 'string') text = c.trim();
          else if (Array.isArray(c)) {
            text = c.filter((x) => x.type === 'text' && !x.text?.startsWith('<')).map((x) => x.text).join(' ').trim();
          }
          if (text && !text.startsWith('[Request') && !text.startsWith('<')) firstPrompt = text.slice(0, 120);
        }
        if (obj.type === 'assistant' && obj.message?.usage) {
          const u = obj.message.usage;
          const input = u.input_tokens ?? u.inputTokens ?? 0;
          const output = u.output_tokens ?? u.outputTokens ?? 0;
          // cache_creation：新格式 cache_creation.ephemeral_5m/1h，旧格式 cache_creation_input_tokens
          const cc = u.cache_creation
            ? (u.cache_creation.ephemeral_5m_input_tokens || 0) + (u.cache_creation.ephemeral_1h_input_tokens || 0)
            : (u.cache_creation_input_tokens ?? 0);
          const cr = u.cache_read_input_tokens ?? u.cacheReadTokens ?? 0;
          totalInput += input;
          totalOutput += output;
          totalCacheRead += cr;
          totalCacheCreate += cc;
          // 最近一次有实际上下文的请求（input >= 500 表示真实上下文）
          if (input >= 500) lastContextInput = input;
        }
        if (obj.type === 'assistant' && obj.message?.content) {
          const texts = obj.message.content
            .filter((c) => c.type === 'text')
            .map((c) => c.text)
            .join('\n')
            .trim();
          if (texts) lastText = texts;
        }
      } catch {}
    }
    const totalTokens = totalInput + totalOutput + totalCacheRead + totalCacheCreate;
    if (!totalTokens) return { usage: null, lastMessage: lastText || null, aiTitle, firstPrompt, cwd };
    const hitDenom = totalInput + totalCacheRead + totalCacheCreate;
    return {
      usage: {
        inputTokens: totalInput,
        outputTokens: totalOutput,
        cacheReadTokens: totalCacheRead,
        cacheCreateTokens: totalCacheCreate,
        // 当前上下文 = 最近一次请求的 input（进度条用这个）；total 是会话累计（参考）
        totalTokens: lastContextInput || totalInput,
        contextTokens: lastContextInput || totalInput,
        sessionTotalTokens: totalTokens,
        // 缓存命中率 = cache_read / (input + cache_read + cache_create)，范围 0-1
        cacheHitRate: hitDenom > 0 ? Math.round((totalCacheRead / hitDenom) * 1000) / 1000 : null,
      },
      lastMessage: lastText || null,
      aiTitle,
      firstPrompt,
      cwd,
    };
  } catch {
    return { usage: null, lastMessage: null, aiTitle: '', firstPrompt: '', cwd: '' };
  }
}

/** 解析 Codex rollout（Responses API usage 结构）。只读尾部（usage 在最新记录，避免大文件 OOM）。 */
function parseCodexRollout(filePath, sessionId) {
  try {
    const size = statSync(filePath).size;
    const fd = openSync(filePath, 'r');
    const readLen = Math.min(size, 512 * 1024);
    const buf = Buffer.alloc(readLen);
    readSync(fd, buf, 0, readLen, size - readLen);
    closeSync(fd);
    const text = buf.toString('utf8');
    const firstNewline = text.indexOf('\n');
    const body = firstNewline === -1 ? text : text.slice(firstNewline + 1);
    const lines = body.split('\n').filter(Boolean);
    let lastUsage = null;
    let lastText = '';
    let sumInput = 0, sumCacheRead = 0;
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj.type === 'response.completed' && obj.response?.usage) {
          const u = obj.response.usage;
          lastUsage = {
            inputTokens: u.input_tokens ?? null,
            outputTokens: u.output_tokens ?? null,
            totalTokens: u.total_tokens ?? null,
            cacheReadTokens: u.input_tokens_details?.cached_tokens ?? null,
          };
          // 缓存命中率：累计所有 response.completed（Codex 无 cache creation 概念）
          if (u.input_tokens ?? 0) {
            sumInput += u.input_tokens ?? 0;
            sumCacheRead += u.input_tokens_details?.cached_tokens ?? 0;
          }
        }
        if (obj.type === 'response.output_text') {
          lastText = obj.text || lastText;
        }
      } catch {}
    }
    const hitDenom = sumInput + sumCacheRead;
    return {
      usage: lastUsage ? {
        ...lastUsage,
        cacheHitRate: hitDenom > 0 ? Math.round((sumCacheRead / hitDenom) * 1000) / 1000 : null,
      } : null,
      lastMessage: lastText || null,
    };
  } catch {
    return { usage: null, lastMessage: null };
  }
}

/** 找 Claude transcript 文件：扫 ~/.claude/projects 按 sessionId 匹配（cwd 编码有歧义，不用） */
function findClaudeTranscript(sessionId) {
  try {
    const root = expandHome('~/.claude/projects');
    if (!existsSync(root)) return null;
    const dirs = readdirSync(root);
    for (const dir of dirs) {
      const cand = path.join(root, dir, `${sessionId}.jsonl`);
      if (existsSync(cand)) return cand;
    }
  } catch {}
  return null;
}

/** 监听一个会话的文件，把解析结果回写 hub（会话 usage / lastMessage / 子代理） */
export function watchSessionFile(sessionId, provider, cwd) {
  let filePath = null;
  if (provider === 'zcode') {
    filePath = findZCodeRollout(sessionId, cwd);
  } else if (provider === 'claude-code') {
    filePath = findClaudeTranscript(sessionId);
  } else if (provider === 'codex') {
    const dir = expandHome('~/.codex/sessions');
    const cand = path.join(dir, `${sessionId}.jsonl`);
    if (existsSync(cand)) filePath = cand;
  }

  if (!filePath) return;

  // ZCode 无 SessionEnd hook：用 rollout 文件 mtime 探测会话是否已死。
  // 文件不再增长（mtime 超过 ZCODE_STALE_MS 未变化）且会话不处于明确等待状态 → ended。
  // 只对 zcode 启用（Claude/Codex 有 SessionEnd hook，事件更准）。
  const lastWrite = { ms: Date.now() };
  const zcodeLivenessCheck = () => {
    if (provider !== 'zcode') return;
    const s = hub.sessions.get(sessionId);
    if (!s || s.state === STATES.ENDED) return;
    if (s.state === STATES.AWAITING_APPROVAL || s.state === STATES.WAITING_INPUT) {
      // 等待用户输入时不判死（可能挂着等人回复）；但 mtime 仍要刷新基准
      return;
    }
    let mtime = 0;
    try {
      mtime = statSync(filePath).mtimeMs;
    } catch {
      mtime = 0; // 文件没了 → 判死
    }
    if (mtime && Date.now() - mtime < ZCODE_STALE_MS) {
      lastWrite.ms = Date.now(); // 文件还在写 → 活跃
      return;
    }
    // 文件停止写入超过 ZCODE_STALE_MS（或已删除）→ 会话结束
    if (Date.now() - lastWrite.ms > ZCODE_STALE_MS) {
      hub.end(sessionId, 'zcode_rollout_stale');
    }
  };
  // 每 60s 检查一次（watchFile 只监听变化，不监听"停止变化"）
  const livenessTimer = setInterval(zcodeLivenessCheck, 60 * 1000);

    const parse = () => {
      let result = null;
      if (provider === 'zcode') {
        result = { usage: parseZCodeRollout(filePath, sessionId), lastMessage: null };
        lastWrite.ms = Date.now(); // 文件有写 → 刷新活跃基准
      } else if (provider === 'claude-code') result = parseClaudeTranscript(filePath, sessionId);
      else result = parseCodexRollout(filePath, sessionId);
    if (!result) return;

    const s = hub.sessions.get(sessionId);
    if (!s) return;
    const patch = {};
    if (result.usage) {
      const { totalTokens, contextTokens, maxTokens: rawMax = 200000 } = result.usage;
      // maxTokens 修正：必须在合理范围（50k-1M），且不小于当前上下文（避免 pct 异常）
      let maxTokens = rawMax;
      if (!(maxTokens >= 50000 && maxTokens <= 2000000)) maxTokens = 200000;
      const ctx = contextTokens || totalTokens || 0;
      if (ctx > maxTokens) maxTokens = Math.ceil(ctx * 1.2 / 1000) * 1000; // 上下文超窗口时按 1.2 倍显示
      patch.usage = {
        ...result.usage,
        maxTokens,
        // 上下文进度用 contextTokens（最近一次请求上下文），total 作为累计显示
        pct: ctx ? Math.min(100, Math.round((ctx / maxTokens) * 100)) : null,
      };
    }
    // 标题：ai-title > 首条 user prompt（开源项目优先级）；都没有保留现有
    if (result.aiTitle) patch.title = result.aiTitle;
    else if (result.firstPrompt) patch.title = result.firstPrompt;
    if (result.lastMessage) patch.lastMessage = result.lastMessage;
    if (Object.keys(patch).length) hub.update(sessionId, patch);
  };

  // 初始解析一次 + 监听文件变化
  parse();
  try {
    watchFile(filePath, { interval: 2000 }, parse);
  } catch {
    // 文件不存在/权限问题 → 忽略
  }
  // 会话结束后清理 liveness 定时器
  const stopLiveness = () => {
    clearInterval(livenessTimer);
    hub.off('change', onHubChange);
  };
  const onHubChange = (s, meta) => {
    if (s.id === sessionId && meta?.event === 'state_change' && s.state === STATES.ENDED) stopLiveness();
  };
  hub.on('change', onHubChange);
}

// ZCode rollout 文件停止写入多久视为会话结束（无 SessionEnd hook 的兜底）
const ZCODE_STALE_MS = 3 * 60 * 1000;
