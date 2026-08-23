import { existsSync, watchFile, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { hub, STATES } from './hub.js';
import { findSessionFile, parseZCodeRollout, parseClaudeTranscript, parseCodexRollout, computeUsage } from './session-files.js';

/**
 * 文件 tail 轮询：监听各 agent 的 rollout/transcript 文件变化，
 * 实时刷新上下文用量 / 标题 / 最后消息。
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

  // ZCode 无 SessionEnd hook：用 rollout 文件 mtime 探测会话是否已死。
  // 文件不再增长（mtime 超过 ZCODE_STALE_MS 未变化）且会话不处于明确等待状态 → ended。
  // 只对 zcode 启用（Claude/Codex 有 SessionEnd hook，事件更准）。
  let lastWriteMs = Date.now(); // 上次确认"文件还在写"的时刻（判死基准）
  const zcodeLivenessCheck = () => {
    if (provider !== 'zcode') return;
    const s = hub.sessions.get(sessionId);
    if (!s || s.state === STATES.ENDED) return;
    if (s.state === STATES.AWAITING_APPROVAL || s.state === STATES.WAITING_INPUT) {
      // 等待用户输入时不判死（可能挂着等人回复）
      return;
    }
    let mtime = 0;
    try {
      mtime = statSync(filePath).mtimeMs;
    } catch {
      mtime = 0; // 文件没了 → 判死
    }
    if (mtime && Date.now() - mtime < ZCODE_STALE_MS) {
      lastWriteMs = Date.now(); // 文件还在写 → 活跃
      return;
    }
    // 文件停止写入超过 ZCODE_STALE_MS（或已删除）→ 会话结束
    if (Date.now() - lastWriteMs > ZCODE_STALE_MS) {
      hub.end(sessionId, 'zcode_rollout_stale');
    }
  };
  // 每 60s 检查一次（watchFile 只监听变化，不监听"停止变化"）
  const livenessTimer = setInterval(zcodeLivenessCheck, 60 * 1000);

  const parse = () => {
    let result = null;
    if (provider === 'zcode') {
      result = parseZCodeRollout(filePath, sessionId);
      lastWriteMs = Date.now(); // 文件有写 → 刷新活跃基准
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
  };

  // 初始解析一次 + 监听文件变化
  parse();
  try {
    watchFile(filePath, { interval: 2000 }, parse);
  } catch {
    // 文件不存在/权限问题 → 忽略
  }
  // 会话结束后清理 liveness 定时器
  const stopLiveness = () => {
    clearInterval(livenessTimer);
    hub.off('change', onHubChange);
  };
  const onHubChange = (s, meta) => {
    if (s.id === sessionId && meta?.event === 'state_change' && s.state === STATES.ENDED) stopLiveness();
  };
  hub.on('change', onHubChange);
}

// ZCode rollout 文件停止写入多久视为会话结束（无 SessionEnd hook 的兜底）
const ZCODE_STALE_MS = 3 * 60 * 1000;
