/**
 * ZCode adapter
 *
 * Hook 配置（~/.zcode/cli/config.json）：
 *   hooks: {
 *     enabled: true,
 *     events: {
 *       "<Event>": [ { matcher?, hooks: [ { type:"command", command:"curl -s --json @- http://127.0.0.1:<port>/api/hooks/zcode", timeout } ] } ]
 *     }
 *   }
 *   （Windows 上 hook 经 cmd.exe 跑命令，curl 用 --json @- 读 stdin，避免引号/header 被拆坏）
 *
 * 事件白名单（app.asar 源码验证）：SessionStart, UserPromptSubmit, PreToolUse,
 * PermissionRequest, PostToolUse, PostToolUseFailure, Stop
 *
 * 注意：
 * - ZCode 没有原生 http hook，用 command+curl 转发 stdin JSON
 * - SessionEnd 不在白名单（无法直接 hook 到结束），用 Stop/日志兜底
 * - PermissionRequest 里 tool_name 为 AskUserQuestion → 归为 waiting_input
 * - rollout 文件：~/.zcode/cli/rollout/model-io-sess_<sessionId>.jsonl（含 usage，tailer 解析）
 */
import {
  EVENTS, getSessionId, getCwd, getToolInput, getToolName,
  getLastAssistantMessage, getPermissionMode,
} from '../common.js';
import { readFileTail, contextWindowFor } from '../../session-utils.js';
import { statSync } from 'node:fs';

const ASK_TOOLS = new Set(['AskUserQuestion', 'ask_user', 'ask']);

/** 记录时间戳归一化：epoch 毫秒数或 ISO 字符串 → ms；无效返回 0 */
function parseTs(v) {
  const t = typeof v === 'number' ? v : Date.parse(v);
  return Number.isFinite(t) ? t : 0;
}

function normalizeMode(raw) {
  // ZCode 权限模式可能以字符串出现在 payload；未知则保留原值
  if (!raw) return null;
  const m = String(raw).toLowerCase();
  if (m.includes('plan')) return 'plan';
  if (m.includes('auto')) return 'auto';
  if (m.includes('accept')) return 'acceptEdits';
  if (m.includes('bypass') || m.includes('dontask') || m.includes('yolo')) return 'bypass';
  // build = 自动构建/执行（实测 db permission 常见 {"mode":"build"}）
  if (m.includes('build')) return 'auto';
  if (m.includes('ask') || m.includes('default') || m.includes('manual')) return 'ask';
  return raw;
}

const eventMap = {
  SessionStart: EVENTS.SESSION_START,
  UserPromptSubmit: EVENTS.PROMPT,
  PreToolUse: EVENTS.TOOL_USE,
  PostToolUse: EVENTS.TOOL_USE,
  PostToolUseFailure: EVENTS.STOP_FAILURE,
  PermissionRequest: null, // 单独处理（区分审批/提问）
  Stop: EVENTS.STOP,
};

function extractTitle(payload) {
  return (
    payload?.title ||
    payload?.prompt ||
    getToolInput(payload)?.description ||
    getToolInput(payload)?.command ||
    getLastAssistantMessage(payload) ||
    ''
  );
}

/* ---------- rollout 解析（usage / 标题 / 回复状态） ---------- */

/**
 * 解析 ZCode rollout。只读文件尾部（避免大文件 OOM）。
 * 实测字段（2026-08）：
 *  - 行结构：{ type:'model_io', sessionId, model:{modelId}, request:{body}, response:{finishReason, toolCalls, text, usage}, startedAt, completedAt }
 *  - request.body 是 **JSON 字符串**（含 messages 数组，首条 system 是标题提示词，首条 user 是本次 prompt）
 *  - usage 在 response.usage：{ inputTokens, outputTokens, totalTokens, cacheReadTokens, reasoningTokens }
 *    （无 maxTokens/contextTokens → 用 model catalog 推断）
 *  - response.text 是本次回复文本（lastMessage 来源，比滚动解析更准）
 *  - 回复状态：finishReason==='stop' 且无 toolCalls → done；有 toolCalls → running
 *    同时记下该记录的 startedAt（replyStateAt），供 hub 做陈旧守卫：
 *    新一轮 prompt 提交后、新记录落盘前，文件里最后一条仍是上一轮的 done，
 *    没有时间戳就无法分辨"真完成"和"上一轮遗留"，会把刚提问的会话误打成已完成
 */
export function parseRollout(filePath) {
  const body = readFileTail(filePath, 512 * 1024);
  const lines = body.split('\n').filter(Boolean);
  let last = null;
  let modelId = '';
  let firstPrompt = '';
  let replyState = null;
  let replyStateAt = 0;
  let lastText = '';
  let sessionId = '';
  let lastTs = 0;
  // 缓存命中率统计（当前会话，最近 readLen 内所有请求）
  let sumInput = 0, sumCacheRead = 0, sumCacheCreate = 0;
  // firstPrompt 是文件开头的首条请求；只有当整个文件都在读窗内（<=512KB）时才能取到
  let wholeFileInWindow = false;
  try {
    wholeFileInWindow = statSync(filePath).size <= 512 * 1024;
  } catch {}
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (!sessionId && obj.sessionId) sessionId = obj.sessionId;
      if (obj.type === 'model_io' && obj.response) {
        // 只看有响应的记录；请求失败（error 字段）不可判定，跳过
        if (!obj.error && Array.isArray(obj.response.toolCalls)) {
          if (obj.response.finishReason === 'stop' && obj.response.toolCalls.length === 0) {
            replyState = 'done';
          } else if (obj.response.toolCalls.length > 0) {
            replyState = 'running';
          }
          if (replyState) replyStateAt = parseTs(obj.startedAt) || replyStateAt;
        }
        // 最后回复文本（response.text 是该次回复）
        if (obj.response.text && typeof obj.response.text === 'string') {
          lastText = obj.response.text.trim().slice(0, 200);
        }
      }
      // usage 嵌套在 response 里（也可能是顶层，防御两种）
      const u = obj.usage || obj.response?.usage;
      // 取最后一条"有实际上下文"的 usage（跳过空记录）
      if (u && (u.inputTokens ?? 0) >= 500) last = u;
      // 模型 id（从 model.modelId 读）
      if (!modelId && obj.model?.modelId) modelId = obj.model.modelId;
      // 首条真实 user prompt（标题兜底；文件超出读窗时取不到，留给 db 兜底）
      if (!firstPrompt && wholeFileInWindow) firstPrompt = firstUserPromptFromBody(obj.request?.body);
      // 缓存命中率：累计最近所有请求（只算有实际 token 的）。
      // 注意：ZCode 的 inputTokens 已含 cacheReadTokens（input = 非缓存 + 缓存），
      // 分母直接用 inputTokens 即可，不能再把 cacheRead 加一遍（否则双重计数、命中率被低估）。
      if (u && (u.inputTokens ?? 0) > 0) {
        sumInput += u.inputTokens ?? 0;
        sumCacheRead += u.cacheReadTokens ?? 0;
        sumCacheCreate += u.cacheCreationTokens ?? u.cacheWriteTokens ?? 0;
      }
      // 最后一条有内容的记录时间（活跃判定/排序）
      if (obj.startedAt) {
        const t = parseTs(obj.startedAt);
        if (t > lastTs) lastTs = t;
      }
    } catch {}
  }
  // 上下文窗口：优先从官方 model catalog 查（deepseek-v4-flash = 1000000），再按模型名推断
  const ctxWindow = contextWindowFor(modelId);
  // 命中率分母 = 总输入（inputTokens 已含缓存读取）。cacheCreate 另计为新增写入，
  // 不计入命中率分母（它属于"本次写入、下次才读"的冷启动成本）。
  const hitDenom = sumInput + sumCacheCreate;
  const usage = last ? {
    inputTokens: last.inputTokens ?? null,
    outputTokens: last.outputTokens ?? null,
    // ZCode 的 totalTokens 是单次请求 input+output = 当前上下文
    totalTokens: last.totalTokens ?? null,
    contextTokens: last.totalTokens ?? null,
    cacheReadTokens: last.cacheReadTokens ?? null,
    reasoningTokens: last.reasoningTokens ?? null,
    maxTokens: ctxWindow,
    sessionTotalTokens: null, // ZCode 单次即上下文，无独立累计字段
    // 缓存命中率 = cache_read / (input + cache_read + cache_create)，范围 0-1。
    cacheHitRate: hitDenom > 0 ? sumCacheRead / hitDenom : null,
  } : null;
  if (!usage && !firstPrompt && !replyState && !lastText && !sessionId) return null;
  return { usage, firstPrompt: firstPrompt || null, lastMessage: lastText || null, sessionId, replyState, replyStateAt, lastActivityAt: lastTs, model: modelId || null };
}

/** 从 request.body（JSON 字符串或对象）的 messages 里提取首条真实用户输入（标题兜底）。
 *  ZCode 的 rollout 每条 request 只有 [system, user] 两消息：
 *  - system 是英文标题生成提示词（"Generate a concise title..."），必须跳过
 *  - 首条 user 即本次输入的 prompt
 *  tool 相关历史（<command> 等）不在此文件里（rollout 只记模型 I/O）。 */
function firstUserPromptFromBody(body) {
  try {
    if (typeof body === 'string') body = JSON.parse(body);
    if (!body || typeof body !== 'object') return '';
    const msgs = Array.isArray(body.messages) ? body.messages : [];
    for (const m of msgs) {
      if (m?.role !== 'user') continue;
      const c = m.content;
      let text = '';
      if (typeof c === 'string') text = c.trim();
      else if (Array.isArray(c)) {
        text = c
          .filter((x) => x?.type === 'text' && !(x.text || '').startsWith('<'))
          .map((x) => x.text)
          .join(' ')
          .trim();
      }
      if (text && !text.startsWith('[Request') && !text.startsWith('<')) return text.slice(0, 120);
    }
  } catch {}
  return '';
}

const adapter = {
  name: 'zcode',
  displayName: 'ZCode',
  logo: 'zcode',
  hookConfigPath: '~/.zcode/cli/config.json',
  rolloutDir: '~/.zcode/cli/rollout',
  rolloutPattern: (sessionId) => `model-io-sess_${sessionId}.jsonl`,
  subagentPattern: (sessionId) => `model-io-sess_subagent_*`,

  /** 统一文件解析：ZCode rollout → SessionFileInfo */
  parseSessionFile(filePath) {
    const r = parseRollout(filePath);
    if (!r) return null;
    return {
      usage: r.usage,
      firstPrompt: r.firstPrompt,
      lastMessage: r.lastMessage,
      sessionId: r.sessionId || '',
      cwd: '', // ZCode rollout 无 cwd 字段，由 db 提供
      mode: null, // 由 db session.permission 提供
      model: r.model || '',
      lastActivityAt: r.lastActivityAt || 0,
      replyState: r.replyState || null,
      replyStateAt: r.replyStateAt || 0,
    };
  },

  normalize(payload, rawEventName) {
    const sid = getSessionId(payload);
    const cwd = getCwd(payload);
    const toolName = getToolName(payload);
    const toolInput = getToolInput(payload);
    const mode = normalizeMode(getPermissionMode(payload) || payload.mode);
    const ev = eventMap[rawEventName];
    if (rawEventName === 'PermissionRequest') {
      const isAsk = ASK_TOOLS.has(toolName);
      return {
        provider: 'zcode',
        sessionId: sid,
        event: isAsk ? EVENTS.ASK_USER : EVENTS.PERMISSION_REQUEST,
        toolName,
        toolInput,
        title: extractTitle(payload),
        cwd,
        mode,
      };
    }
    if (!ev) return null;

    const out = {
      provider: 'zcode',
      sessionId: sid,
      event: ev,
      title: extractTitle(payload),
      cwd,
      mode,
      lastMessage: getLastAssistantMessage(payload) || payload.message,
    };

    if (ev === EVENTS.TOOL_USE) {
      out.toolName = toolName;
      out.toolInput = toolInput;
      // todo 解析：PostToolUse matcher TodoWrite 时 tool_input 含 todos
      if (toolName === 'TodoWrite' && toolInput?.todos) {
        out.event = EVENTS.TODO;
        out.todo = toolInput.todos;
      }
      // 兜底：任意工具名含 todo/plan 的工具
      if (/todo|plan/i.test(toolName || '') && Array.isArray(toolInput?.todos)) {
        out.event = EVENTS.TODO;
        out.todo = toolInput.todos;
      }
    }
    if (ev === EVENTS.STOP) {
      out.hasBackground = !!((payload.background_tasks || payload.backgroundTasks)?.length ||
        (payload.session_crons || payload.sessionCrons)?.length);
    }
    if (ev === EVENTS.SESSION_END) out.reason = payload.reason;
    return out;
  },
};

export default adapter;
