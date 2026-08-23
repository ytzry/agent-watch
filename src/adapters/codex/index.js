/**
 * Codex CLI adapter
 *
 * Hook 配置（~/.codex/config.toml）：
 *   [hooks]
 *   PreToolUse = [ { matcher = "Bash", hooks = [ { type="command", command="curl ... -d @-", timeout=30 } ] } ]
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
  getLastAssistantMessage, getPermissionMode, getToolResponse,
} from '../index.js';

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

const adapter = {
  name: 'codex',
  displayName: 'Codex',
  logo: 'codex',
  hookConfigPath: '~/.codex/config.toml',
  transcriptDir: '~/.codex/sessions',
  transcriptPattern: (sessionId) => `${sessionId}.jsonl`,

  normalize(payload, rawEventName) {
    const sid = getSessionId(payload);
    const cwd = getCwd(payload);
    const toolName = getToolName(payload);
    const toolInput = getToolInput(payload);
    const toolResponse = getToolResponse(payload);
    const mode = normalizeMode(getPermissionMode(payload));
    const lastMessage = getLastAssistantMessage(payload);
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
