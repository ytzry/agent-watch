/**
 * Codex CLI adapter
 *
 * Hook 配置（~/.codex/config.toml）：
 *   [hooks]
 *   PreToolUse = [ { matcher = "Bash", hooks = [ { type="command", command="curl -s --json @- http://127.0.0.1:<port>/api/hooks/codex", timeout=30 } ] } ]
 *   ...
 *
 * 事件（源码验证 11 个）：SessionStart, UserPromptSubmit, PreToolUse, PostToolUse,
 * PostToolUseFailure?, PermissionRequest, PreCompact, PostCompact, SessionEnd,
 * SubagentStart, SubagentStop, Stop
 *
 * 特点：
 * - 无原生 http，用 command+curl 转发
 * - permission_mode: default/acceptEdits/plan/dontAsk/bypassPermissions
 * - todo：PostToolUse matcher update_plan 解析 tool_response.plan
 * - SessionEnd 默认 1s 超时 → install 时设 timeout=2
 * - rollout/transcript：~/.codex/sessions/<id>.jsonl（tailer 解析）
 */
import {
  EVENTS, getSessionId, getCwd, getToolInput, getToolName,
  getLastAssistantMessage, getPermissionMode, getToolResponse, getModel,
} from '../common.js';
import { readFileTail } from '../../session-utils.js';

const eventMap = {
  SessionStart: EVENTS.SESSION_START,
  UserPromptSubmit: EVENTS.PROMPT,
  PreToolUse: EVENTS.TOOL_USE,
  PostToolUse: EVENTS.TOOL_USE,
  PostToolUseFailure: EVENTS.STOP_FAILURE,
  PreCompact: EVENTS.PRE_COMPACT,
  PostCompact: EVENTS.PRE_COMPACT, // 归为压缩事件
  Stop: EVENTS.STOP,
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
  if (m === 'bypasspermissions' || m === 'dontask') return 'bypass';
  return 'ask';
}

/** 从 update_plan 的 tool_response 解析 todo（plan 数组） */
function parsePlanTodos(toolResponse) {
  if (!toolResponse || typeof toolResponse !== 'object') return null;
  const plan = toolResponse.plan || toolResponse.todos;
  if (!Array.isArray(plan)) return null;
  return plan.map((item) => {
    if (typeof item === 'string') return { description: item, status: 'pending' };
    return {
      description: item.step || item.description || item.title || '',
      status: item.status || item.state || 'pending',
    };
  });
}

/* ---------- rollout 解析（usage / 标题 / mode / 回复状态） ---------- */

/**
 * 解析 Codex rollout（Responses API 结构）。只读尾部（usage 在最新记录，避免大文件 OOM）。
 * 实测字段（2026-08，v0.119+）：
 *  - usage 在 event_msg 的 payload.type === 'token_count' 的 payload.info：
 *      total_token_usage（全会话累计）/ last_token_usage（最近一次请求）
 *      { input_tokens, cached_input_tokens, output_tokens, total_tokens, ... }
 *    cached_input_tokens 已含在 input_tokens 中（input = 非缓存 + 缓存）。
 *    ⚠ info 可能为 null（多次实测），此时跳过该记录。
 *  - 标题/首条 user：response_item 的 payload.type === 'message' 且 role === 'user'，
 *    content[].type === 'input_text'（实测；非 text）
 *  - 最后 assistant 文字：response_item message role=assistant content[].type === 'output_text'
 *  - 会话最后一条消息也可能是 event_msg payload.type === 'agent_message' 的 message（旁白）
 *  - mode 不在 rollout 里，由 scanner 从 threads.approval_mode 传入（parseSessionFile 不解析）
 */
export function parseRollout(filePath) {
  const body = readFileTail(filePath, 512 * 1024);
  const lines = body.split('\n').filter(Boolean);
  let lastUsage = null; // 最近一次有效 token_count 的 last_token_usage
  let lastText = '';
  let firstUserText = '';
  let cwd = '';
  let sessionId = '';
  let modelContextWindow = null;
  let model = ''; // 最近一次 turn_context 的模型名（如 gpt-5.4）
  // 命中率：累计所有 token_count 事件（input 含 cached，分母=总输入即可）
  let sumInput = 0, sumCached = 0;
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (!sessionId && obj.type === 'session_meta' && obj.payload?.id) sessionId = obj.payload.id;
      if (!cwd && obj.type === 'session_meta' && obj.payload?.cwd) cwd = obj.payload.cwd;
      // 模型名在 turn_context 行（payload.model），不在 session_meta；一直覆盖到最后一行
      if (obj.type === 'turn_context' && obj.payload?.model) model = obj.payload.model;
      if (obj.type === 'event_msg' && obj.payload?.type === 'token_count' && obj.payload.info) {
        const info = obj.payload.info;
        const u = info.last_token_usage || info.total_token_usage || null;
        if (u && (u.input_tokens ?? 0) > 0) {
          lastUsage = {
            inputTokens: u.input_tokens ?? null,
            outputTokens: u.output_tokens ?? null,
            totalTokens: u.total_tokens ?? null,
            cacheReadTokens: u.cached_input_tokens ?? null,
            contextTokens: u.input_tokens ?? null,
          };
          modelContextWindow = info.model_context_window ?? null;
          sumInput += u.input_tokens ?? 0;
          sumCached += u.cached_input_tokens ?? 0;
        }
      }
      if (obj.type === 'response_item' && obj.payload?.type === 'message') {
        const p = obj.payload;
        const texts = (p.content || [])
          .filter((c) => c?.type === 'output_text' || c?.type === 'input_text')
          .map((c) => c.text)
          .join(' ');
        if (p.role === 'assistant') {
          if (texts.trim()) lastText = texts.trim().slice(0, 200);
        } else if (p.role === 'user' && texts.trim() && !firstUserText) {
          firstUserText = texts.trim().slice(0, 120);
        }
      }
      // 旁白（agent_message）也计入最后消息（Codex 会话的最后一条常是它）
      if (obj.type === 'event_msg' && obj.payload?.type === 'agent_message' && obj.payload?.message) {
        lastText = String(obj.payload.message).slice(0, 200);
      }
    } catch {}
  }
  // 命中率 = cached / 总输入（input_tokens 已含 cached）。cache_creation 无此概念。
  const hitDenom = sumInput;
  if (!lastUsage && !firstUserText && !lastText && !cwd && !sessionId) return null;
  return {
    usage: lastUsage ? {
      ...lastUsage,
      cacheHitRate: hitDenom > 0 ? sumCached / hitDenom : null,
      // Codex 的 model_context_window 本身就是数值窗口（实测 258400），直接透传；非法时回落 200k
      maxTokens: modelContextWindow || 200000,
      sessionTotalTokens: null, // Codex 无单次 vs 累计区分：last_token_usage 已是单次
    } : null,
    firstPrompt: firstUserText || null,
    lastMessage: lastText || null,
    cwd,
    sessionId,
    model: model || null,
    replyState: null, // Codex rollout 无明确的"回复完成"信号（task_complete 可作完成依据）
  };
}

const adapter = {
  name: 'codex',
  displayName: 'Codex',
  logo: 'codex',
  hookConfigPath: '~/.codex/config.toml',
  transcriptDir: '~/.codex/sessions',
  transcriptPattern: (sessionId) => `${sessionId}.jsonl`,

  /** 统一文件解析：Codex rollout → SessionFileInfo */
  parseSessionFile(filePath) {
    const r = parseRollout(filePath);
    if (!r) return null;
    return {
      usage: r.usage,
      firstPrompt: r.firstPrompt,
      lastMessage: r.lastMessage,
      cwd: r.cwd || '',
      sessionId: r.sessionId || '',
      mode: null, // 由 scanner 从 threads.approval_mode 传入
      model: r.model || '',
      lastActivityAt: 0,
      replyState: null,
    };
  },

  normalize(payload, rawEventName) {
    const sid = getSessionId(payload);
    const cwd = getCwd(payload);
    const toolName = getToolName(payload);
    const toolInput = getToolInput(payload);
    const toolResponse = getToolResponse(payload);
    const mode = normalizeMode(getPermissionMode(payload));
    const lastMessage = getLastAssistantMessage(payload);
    const model = getModel(payload); // SessionStart payload 顶层带 model（codex-rs hooks schema）
    if (rawEventName === 'PermissionRequest') {
      const isAsk = /request_user_input|ask_user|ask/i.test(toolName);
      return {
        provider: 'codex',
        sessionId: sid,
        event: isAsk ? EVENTS.ASK_USER : EVENTS.PERMISSION_REQUEST,
        toolName,
        toolInput,
        title: toolInput?.description || toolInput?.command,
        cwd,
        mode,
        model,
      };
    }

    const ev = eventMap[rawEventName];
    if (!ev) return null;

    const out = {
      provider: 'codex',
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
      model,
      lastMessage,
    };

    if (ev === EVENTS.TOOL_USE) {
      out.toolName = toolName;
      out.toolInput = toolInput;
      const todos = parsePlanTodos(toolResponse);
      if (toolName === 'update_plan' && todos) {
        out.event = EVENTS.TODO;
        out.todo = todos;
      }
    }
    // PostToolUseFailure 携带失败工具信息
    if (ev === EVENTS.STOP_FAILURE) {
      out.toolName = toolName;
      out.toolInput = toolInput;
      out.reason = payload.reason || payload.error || 'tool failure';
    }
    if (ev === EVENTS.SESSION_END) out.reason = payload.reason;
    return out;
  },
};

export default adapter;
