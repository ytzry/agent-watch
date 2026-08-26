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
 * @property {string} [model]           会话当前使用的模型名（hook payload 带了才有；ZCode 无，由 ingest 从官方 db 回查）
 */

/**
 * 各 adapter 导出的形状：
 * {
 *   name: 'zcode',
 *   displayName: 'ZCode',
 *   logo: 'zcode',            // web/assets/logos/<logo>.svg
 *   normalize(payload, rawEventName): NormalizedEvent | null,
 *   parseSessionFile(filePath, sessionId): SessionFileInfo | null,  // 统一文件解析
 * }
 */
import claudeCode from './claude-code/index.js';
import codex from './codex/index.js';
import zcode from './zcode/index.js';
import { EVENTS, getSessionId, getCwd, getEventName, getToolInput, getToolName, getToolResponse, getLastAssistantMessage, getPermissionMode, getModel, pick } from './common.js';

const adapters = [claudeCode, codex, zcode];
const byName = new Map(adapters.map((a) => [a.name, a]));

/** 同步取 adapter（静态注册，无动态 import；未知 provider 返回 null） */
export function getAdapter(provider) {
  return byName.get(provider) || null;
}

export function listAdapters() {
  return adapters.map((a) => a.name);
}

export {
  EVENTS,
  pick,
  getSessionId,
  getCwd,
  getEventName,
  getToolInput,
  getToolName,
  getToolResponse,
  getLastAssistantMessage,
  getPermissionMode,
  getModel,
};
