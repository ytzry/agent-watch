/**
 * Claude Code adapter
 *
 * Hook 配置（~/.claude/settings.json）：
 *   hooks: { "<Event>": [ { matcher?, hooks: [ { type:"http", url:"...", timeout } ] } ] }
 *
 * 事件（官方文档）：SessionStart, UserPromptSubmit, PreToolUse, PostToolUse,
 * PostToolUseFailure, PermissionRequest, Notification, Stop, StopFailure, SessionEnd, ...
 *
 * 特点：
 * - 原生 type:"http" 直连本服务（最干净）
 * - Notification matcher agent_needs_input / permission_prompt → waiting_input
 * - todo：PostToolUse matcher TodoWrite 解析 tool_input.todos
 * - transcript：~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl（tailer 解析 usage）
 */
import {
  EVENTS, getSessionId, getCwd, getToolInput, getToolName,
  getLastAssistantMessage, getPermissionMode,
} from '../common.js';
import { readFileTail, contextWindowFor } from '../../session-utils.js';

const eventMap = {
  SessionStart: EVENTS.SESSION_START,
  UserPromptSubmit: EVENTS.PROMPT,
  PreToolUse: EVENTS.TOOL_USE,
  PostToolUse: EVENTS.TOOL_USE,
  PostToolUseFailure: EVENTS.STOP_FAILURE,
  Stop: EVENTS.STOP,
  StopFailure: EVENTS.STOP_FAILURE,
  PreCompact: EVENTS.PRE_COMPACT,
  SubagentStart: EVENTS.SUBAGENT_START,
  SubagentStop: EVENTS.SUBAGENT_STOP,
  SessionEnd: EVENTS.SESSION_END,
};

function normalizeMode(raw) {
  if (!raw) return null;
  const m = String(raw).toLowerCase();
  if (m === 'plan') return 'plan';
  if (m === 'auto') return 'auto';
  if (m === 'acceptedits') return 'acceptEdits';
  if (m === 'bypasspermissions') return 'bypass';
  if (m === 'dontask') return 'bypass';
  // default / 其他 → ask（默认询问）
  return 'ask';
}

/* ---------- transcript 解析（usage / 标题 / mode / 回复状态） ---------- */

/**
 * 解析 Claude transcript。只读文件尾部（避免大文件 OOM）。
 * 实测字段（2026-08）：
 *  - usage 在 assistant message 的 message.usage（input_tokens/output_tokens/
 *    cache_read_input_tokens/cache_creation.ephemeral_5m|1h_input_tokens）
 *  - 标题在 ai-title 行的 aiTitle 字段
 *  - 权限模式在 permission-mode 行的 permissionMode 字段（default/auto/plan/acceptEdits/...）
 *  - transcript 行**不含 assistant 模型字段**（只有 user 行带 model），模型从 usage 附近不可得，
 *    上下文窗口回退 200k
 */
export function parseTranscript(filePath) {
  const body = readFileTail(filePath, 1 * 1024 * 1024);
  const lines = body.split('\n').filter(Boolean);
  let totalInput = 0, totalOutput = 0, totalCacheRead = 0, totalCacheCreate = 0;
  let lastContextInput = 0; // 最近一次请求的上下文大小（input）
  let lastText = '';
  let aiTitle = '';
  let firstPrompt = '';
  let cwd = '';
  let mode = null; // 最近一次 permission-mode 行
  let lastTs = 0; // 最后一条 user/assistant 行时间戳（活跃判定用）
  let replyState = null; // done / running / null
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      // ai-title 行（官方标题）
      if (obj.type === 'ai-title' && obj.aiTitle && !aiTitle) aiTitle = obj.aiTitle;
      if (!cwd && obj.cwd) cwd = obj.cwd;
      // 权限模式（permission-mode 行，比 hook 更全；hook 的 PermissionRequest 也带，但回显时没有）
      if (obj.type === 'permission-mode' && obj.permissionMode) mode = normalizeMode(obj.permissionMode);
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
      // 最后一条实质对话消息（user 提问 / assistant 文字回复），排除 thinking/tool_use/tool_result/system
      if ((obj.type === 'user' || obj.type === 'assistant') && obj.message?.content) {
        const c = obj.message.content;
        let text = '';
        if (typeof c === 'string') text = c.trim();
        else if (Array.isArray(c)) {
          // 只取 text 块；thinking 块（2026-08 实测 assistant 常带）不是回复内容
          text = c.filter((x) => x.type === 'text' && !x.text?.startsWith('<')).map((x) => x.text).join(' ').trim();
        }
        if (text) lastText = text.slice(0, 200);
        if (obj.timestamp) {
          const t = Date.parse(obj.timestamp);
          if (!isNaN(t)) lastTs = Math.max(lastTs, t);
        }
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
        // 回复状态：assistant 消息后面跟 tool_use → 还在干活；最后一条 assistant 是文字 → 完成
        // 简化：整文件里出现 tool_use 且最后一条 assistant 无文字 → running；否则最后是文字 → done
      }
      // 最后一条 assistant 是否带文字（决定 replyState）
      if (obj.type === 'assistant' && obj.message?.content) {
        const c = obj.message.content;
        const hasText = Array.isArray(c) ? c.some((x) => x.type === 'text') : typeof c === 'string';
        if (hasText) replyState = 'done';
        else if (Array.isArray(c) && c.some((x) => x.type === 'tool_use')) replyState = 'running';
      }
    } catch {}
  }
  const totalTokens = totalInput + totalOutput + totalCacheRead + totalCacheCreate;
  // 命中率分母 = 非缓存输入 + 缓存读取（Claude 的 input_tokens 不包含 cache_read，分开计数）。
  // cache_creation 是本次写入的冷启动 token，不计入命中率（它属于成本，不属于命中）。
  const hitDenom = totalInput + totalCacheRead;
  const usage = totalTokens ? {
    inputTokens: totalInput,
    outputTokens: totalOutput,
    cacheReadTokens: totalCacheRead,
    cacheCreateTokens: totalCacheCreate,
    // 当前上下文 = 最近一次请求的 input（进度条用这个）；total 是会话累计（参考）
    // 实测：Claude 的 input_tokens 是逐条**累计值**（每条 assistant 的 usage 是全会话累计），
    // 所以 lastContextInput 已经是"累计上下文"，用它当 contextTokens 会偏大——
    // 这里直接暴露累计值，由下游决定；进度条语义对齐 ZCode/Codex（单次请求上下文）
    // 但我们无法从 transcript 恢复"单次"，故 contextTokens 用最近一条的 input（=累计上下文）
    totalTokens: lastContextInput || totalInput,
    contextTokens: lastContextInput || totalInput,
    sessionTotalTokens: totalTokens,
    // 缓存命中率 = cache_read / (input + cache_read + cache_create)，范围 0-1
    cacheHitRate: hitDenom > 0 ? totalCacheRead / hitDenom : null,
  } : null;
  if (!usage && !aiTitle && !firstPrompt && !lastText && !mode && !lastTs) return null;
  return { usage, aiTitle, firstPrompt, lastMessage: lastText || null, cwd, mode, lastActivityAt: lastTs, replyState };
}

const adapter = {
  name: 'claude-code',
  displayName: 'Claude Code',
  logo: 'claude-code',
  hookConfigPath: '~/.claude/settings.json',
  transcriptDir: '~/.claude/projects',
  transcriptPattern: (sessionId, cwd) => {
    // ~/.claude/projects/<cwd 编码>/<sessionId>.jsonl
    const enc = (cwd || '')
      .replace(/^\/+/, '')
      .replace(/[^a-zA-Z0-9-_]/g, '-');
    return `${enc}/${sessionId}.jsonl`;
  },

  /** 统一文件解析：Claude transcript → SessionFileInfo */
  parseSessionFile(filePath) {
    const r = parseTranscript(filePath);
    if (!r) return null;
    return {
      usage: r.usage ? {
        ...r.usage,
        maxTokens: contextWindowFor(r.modelId || undefined), // Claude transcript 无模型 → 200k
      } : null,
      aiTitle: r.aiTitle || null,
      firstPrompt: r.firstPrompt || null,
      lastMessage: r.lastMessage || null,
      cwd: r.cwd || '',
      mode: r.mode || null,
      lastActivityAt: r.lastActivityAt || 0,
      replyState: r.replyState || null,
    };
  },

  normalize(payload, rawEventName) {
    const sid = getSessionId(payload);
    const cwd = getCwd(payload);
    const toolName = getToolName(payload);
    const toolInput = getToolInput(payload);
    const mode = normalizeMode(getPermissionMode(payload));
    const lastMessage = getLastAssistantMessage(payload) || payload.message;
    // Notification → 需要输入信号
    if (rawEventName === 'Notification') {
      const type = payload.notificationType || payload.notification_type || '';
      if (type === 'agent_needs_input' || type === 'permission_prompt' || type === 'idle_prompt') {
        return {
          provider: 'claude-code',
          sessionId: sid,
          event: EVENTS.ASK_USER,
          title: payload.message || payload.title,
          cwd,
        };
      }
      return null;
    }

    // PermissionRequest → 需要审批（Bash/Edit 等），AskUserQuestion 类走 ask_user
    if (rawEventName === 'PermissionRequest') {
      const isAsk = /AskUserQuestion|ask_user/i.test(toolName);
      return {
        provider: 'claude-code',
        sessionId: sid,
        event: isAsk ? EVENTS.ASK_USER : EVENTS.PERMISSION_REQUEST,
        toolName,
        toolInput,
        title: toolInput?.description || toolInput?.command,
        cwd,
        mode,
      };
    }

    const ev = eventMap[rawEventName];
    if (!ev) return null;

    const out = {
      provider: 'claude-code',
      sessionId: sid,
      event: ev,
      title:
        payload.prompt ||
        lastMessage ||
        toolInput?.description ||
        toolInput?.command ||
        '',
      cwd,
      mode,
      lastMessage,
    };

    if (ev === EVENTS.TOOL_USE) {
      out.toolName = toolName;
      out.toolInput = toolInput;
      if (toolName === 'TodoWrite' && toolInput?.todos) {
        out.event = EVENTS.TODO;
        out.todo = toolInput.todos;
      }
    }
    if (ev === EVENTS.STOP) {
      out.hasBackground = !!((payload.background_tasks || payload.backgroundTasks)?.length ||
        (payload.session_crons || payload.sessionCrons)?.length);
    }
    if (ev === EVENTS.SESSION_END) out.reason = payload.reason;
    if (ev === EVENTS.SUBAGENT_START || ev === EVENTS.SUBAGENT_STOP) {
      out.agentType = payload.agentType || payload.agent_type;
    }
    return out;
  },
};

export default adapter;
