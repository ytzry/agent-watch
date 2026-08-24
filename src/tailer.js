import { existsSync, watchFile, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { hub } from './hub.js';
import { findSessionFile, parseZCodeRollout, parseClaudeTranscript, parseCodexRollout, computeUsage } from './session-files.js';

/**
 * 文件 tail 轮询：监听各 agent 的 rollout/transcript 文件变化，
 * 实时刷新上下文用量 / 标题 / 最后消息。
 *
 * 注意：会话"是否结束"完全由 hook 事件驱动（Stop / SessionEnd / StopFailure），
 * 这里**不做任何时间判定**——文件停止增长不代表会话结束（可能只是长思考/挂起）。
 *
 * 解析逻辑与 hook 即时同步共用 src/session-files.js（文件定位 + 解析 + usage 标准化）。
 *
 * 各家文件：
 *  - ZCode:   ~/.zcode/cli/rollout/model-io-sess_<sid>.jsonl
 *  - Claude:  ~/.claude/projects/<encoded-cwd>/<sid>.jsonl
 *  - Codex:   ~/.codex/sessions/<sid>.jsonl
 */

function expandHome(p) {
  if (!p) return null;
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return path.join(homedir(), p.slice(2));
  return p;
}

/** 监听一个会话的文件，把解析结果回写 hub（会话 usage / lastMessage / 子代理） */
export function watchSessionFile(sessionId, provider, cwd) {
  const filePath = findSessionFile(sessionId, provider, cwd);
  if (!filePath) return;

  const parse = () => {
    let result = null;
    if (provider === 'zcode') {
      result = parseZCodeRollout(filePath, sessionId);
    } else if (provider === 'claude-code') result = parseClaudeTranscript(filePath, sessionId);
    else result = parseCodexRollout(filePath, sessionId);
    if (!result) return;

    const s = hub.sessions.get(sessionId);
    if (!s) return;
    const patch = {};
    const usage = computeUsage(result.usage);
    if (usage) patch.usage = usage;
    // 标题：ai-title > 首条 user prompt；只补空（db 官方标题 / hook 标题优先，不覆盖）
    if (result.aiTitle && !s.title) patch.title = result.aiTitle;
    else if (result.firstPrompt && !s.title) patch.title = result.firstPrompt;
    if (result.lastMessage) patch.lastMessage = result.lastMessage;
    if (Object.keys(patch).length) hub.update(sessionId, patch);
    // 状态：按最后一条 model_io 的回复状态收敛（AI 回复完成 → idle；有工具调用 → running）。
    // 只在 running/waiting_input 间切换，不覆盖询问/审批/错误等主动状态
    if (result.replyState) hub.applyReplyState(sessionId, result.replyState);
  };

  // 初始解析一次 + 监听文件变化
  parse();
  try {
    watchFile(filePath, { interval: 2000 }, parse);
  } catch {
    // 文件不存在/权限问题 → 忽略
  }
}
