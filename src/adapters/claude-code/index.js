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
} from '../index.js';

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
