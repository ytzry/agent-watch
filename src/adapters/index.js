/**
 * 统一归一化事件模型（各 adapter 把自家 hook payload 转成这个形状）
 *
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

/**
 * 各 adapter 导出的形状：
 * {
 *   name: 'zcode',
 *   displayName: 'ZCode',
 *   logo: 'zcode',            // web/assets/logos/<logo>.svg
 *   normalize(payload, rawEventName): NormalizedEvent | null,
 * }
 */
export async function getAdapter(provider) {
  const mod = await import(`./${provider}/index.js`);
  return mod.default;
}

export function listAdapters() {
  // 静态导入以保持 bundle 简单，注册新 agent 时在此追加
  return ['claude-code', 'codex', 'zcode'];
}
