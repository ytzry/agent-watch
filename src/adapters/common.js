/**
 * 统一事件模型 + 公共字段提取（无 provider 依赖，供 adapters/index.js 与各 adapter 使用）
 *
 * 注意：EVENTS / pick / getXxx 放这里而不是 adapters/index.js，
 * 是为了避免循环依赖——adapters/index.js 静态导入各 adapter，
 * 而各 adapter 又要从这里拿 EVENTS / getSessionId 等。
 * 若它们定义在 index.js，adapter 导入 index.js 时 EVENTS 还没初始化（TDZ）。
 */

/**
 * @typedef {Object} NormalizedEvent
 * @property {string} provider          adapter 标识（如 'claude-code'）
 * @property {string} sessionId         会话 ID
 * @property {string} event             事件名（见 EVENTS）
 * @property {string} [title]           会话标题
 * @property {string} [project]         项目名（cwd 推断，可后补）
 * @property {string} [cwd]             工作目录
 * @property {string} [mode]            归一化回复模式
 * @property {string} [toolName]        工具名
 * @property {object} [toolInput]       工具入参
 * @property {string} [lastMessage]     最后助手消息
 * @property {boolean} [hasBackground]  是否有后台任务/定时器
 * @property {string} [reason]          结束/错误原因
 * @property {string} [model]           会话当前使用的模型名（hook payload 带了才有；ZCode 无，由 ingest 从官方 db 回查）
 */

export const EVENTS = {
  SESSION_START: 'session_start',
  PROMPT: 'prompt', // UserPromptSubmit
  TOOL_USE: 'tool_use', // PreToolUse / PostToolUse
  PERMISSION_REQUEST: 'permission_request', // 需要审批
  ASK_USER: 'ask_user', // 需要用户回复（AskUserQuestion / request_user_input / agent_needs_input）
  TODO: 'todo',
  STOP: 'stop',
  STOP_FAILURE: 'stop_failure',
  PRE_COMPACT: 'pre_compact',
  SUBAGENT_START: 'subagent_start',
  SUBAGENT_STOP: 'subagent_stop',
  SESSION_END: 'session_end',
};

/**
 * 从 hook payload 提取公共字段（各家实际都传 snake_case: session_id / cwd / hook_event_name）
 * 同时兼容 camelCase（防御性）。
 */
export function pick(payload, snake, camel) {
  return payload?.[snake] ?? payload?.[camel] ?? undefined;
}

export function getSessionId(payload) {
  return pick(payload, 'session_id', 'sessionId');
}

export function getCwd(payload) {
  return pick(payload, 'cwd', 'cwd');
}

export function getEventName(payload) {
  return pick(payload, 'hook_event_name', 'hookEventName') || payload?.event;
}

export function getToolInput(payload) {
  return pick(payload, 'tool_input', 'toolInput');
}

export function getToolName(payload) {
  return pick(payload, 'tool_name', 'toolName');
}

export function getToolResponse(payload) {
  return pick(payload, 'tool_response', 'toolResponse');
}

export function getLastAssistantMessage(payload) {
  return pick(payload, 'last_assistant_message', 'lastAssistantMessage');
}

export function getPermissionMode(payload) {
  return pick(payload, 'permission_mode', 'permissionMode');
}

/** 会话当前模型名（hook payload 顶层 model / modelId；'<synthetic>' 等占位值不算真实模型）。
 *  实测只有 Codex SessionStart payload 带 model（codex-rs hooks schema）；Claude/ZCode 不带 → undefined，
 *  由 ingest 从会话文件/官方 db 兜底。 */
export function getModel(payload) {
  const m = payload?.model ?? payload?.modelId;
  if (!m || typeof m !== 'string' || m.startsWith('<')) return undefined;
  return m;
}
