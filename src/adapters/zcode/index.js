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
} from '../index.js';

const ASK_TOOLS = new Set(['AskUserQuestion', 'ask_user', 'ask']);

function normalizeMode(raw) {
  // ZCode 权限模式可能以字符串出现在 payload；未知则保留原值
  if (!raw) return null;
  const m = String(raw).toLowerCase();
  if (m.includes('plan')) return 'plan';
  if (m.includes('auto')) return 'auto';
  if (m.includes('accept')) return 'acceptEdits';
  if (m.includes('bypass') || m.includes('dontask') || m.includes('yolo')) return 'bypass';
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

const adapter = {
  name: 'zcode',
  displayName: 'ZCode',
  logo: 'zcode',
  hookConfigPath: '~/.zcode/cli/config.json',
  rolloutDir: '~/.zcode/cli/rollout',
  rolloutPattern: (sessionId) => `model-io-sess_${sessionId}.jsonl`,
  subagentPattern: (sessionId) => `model-io-sess_subagent_*`,

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
