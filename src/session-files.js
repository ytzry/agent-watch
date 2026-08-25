/**
 * 会话本地文件统一访问层（tailer 轮询 / hook 即时同步 / 启动扫描共用）
 *
 * 每家 agent 的会话状态都落盘在本地文件（rollout/transcript/jsonl），
 * 这里统一负责：
 *  - 定位文件路径（带缓存，避免每次 hook 都扫目录）
 *  - 委托给各 adapter 的 parseSessionFile 解析（统一中间格式 SessionFileInfo）
 *
 * 归一化原则：**各家文件格式的差异收敛在 adapter 内**，
 * 下游（tailer / ingest / scanner）只消费统一格式：
 *   SessionFileInfo = {
 *     usage: { inputTokens, outputTokens, totalTokens, contextTokens, cacheReadTokens,
 *              maxTokens, sessionTotalTokens?, cacheHitRate, reasoningTokens? },
 *     aiTitle, firstPrompt, lastMessage, cwd, sessionId,
 *     mode, lastActivityAt, replyState, replyStateAt,
 *   }
 * 语义约定：
 *  - contextTokens / totalTokens = 当前上下文（最近一次请求），进度条用
 *  - sessionTotalTokens = 全会话累计（Claude/Codex 有；ZCode 单次即上下文，null）
 *  - cacheHitRate 各家分母口径不同，adapter 内已按各自口径算好
 *  - mode 可能来自文件（Claude permission-mode 行）或 db（ZCode permission / Codex approval_mode），
 *    adapter 解析文件时可能给 null，由调用方从 db 补齐
 *  - replyState / replyStateAt = 最后一条可判定记录的回复结论及其落盘时间；
 *    at 供 hub.applyReplyState 做陈旧守卫（早于最近对话活动的结论描述的是上一轮，不采纳）
 */
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { getAdapter, getToolName, getToolInput } from './adapters/index.js';
import { readFileTail } from './session-utils.js';

function expandHome(p) {
  if (!p) return null;
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return path.join(homedir(), p.slice(2));
  return p;
}

/* ---------- 文件路径定位（带缓存） ---------- */

/** 路径缓存：sessionId → filePath（找不到 → null；文件删除后下一次 hook 会重扫） */
const pathCache = new Map();
const PATH_CACHE_MAX = 1000;

function cachePath(sessionId, p) {
  if (p) pathCache.set(sessionId, p);
  else pathCache.delete(sessionId);
  if (pathCache.size > PATH_CACHE_MAX) pathCache.clear();
  return p;
}

/** 找 ZCode rollout 文件（子代理为 model-io-sess_subagent_*） */
function findZCodeRollout(sessionId) {
  const dir = expandHome('~/.zcode/cli/rollout');
  // 文件名是 model-io-sess_<uuid>.jsonl，sessionId 带 sess_ 前缀 → 先试精确、再试去前缀
  const main = path.join(dir, `model-io-sess_${sessionId}.jsonl`);
  if (existsSync(main)) return main;
  const noPrefix = sessionId.startsWith('sess_') ? sessionId.slice(5) : sessionId;
  const alt = path.join(dir, `model-io-sess_${noPrefix}.jsonl`);
  if (existsSync(alt)) return alt;
  // 兜底：目录内按 uuid 子串匹配（会话 ID 可能是短前缀）
  if (!existsSync(dir)) return null;
  try {
    const files = readdirSync(dir);
    const match = files.find((f) => f.includes(sessionId) || f.includes(noPrefix));
    return match ? path.join(dir, match) : null;
  } catch {
    return null;
  }
}

/** 找 Claude transcript 文件：扫 ~/.claude/projects 按 sessionId 匹配（cwd 编码有歧义，不用） */
function findClaudeTranscript(sessionId) {
  try {
    const root = expandHome('~/.claude/projects');
    if (!existsSync(root)) return null;
    const dirs = readdirSync(root);
    for (const dir of dirs) {
      const cand = path.join(root, dir, `${sessionId}.jsonl`);
      if (existsSync(cand)) return cand;
    }
  } catch {}
  return null;
}

/** 找 Codex rollout 文件：先试顶层 <sessionId>.jsonl，再递归子目录找 rollout-<ts>-<sessionId>.jsonl
 *  （实测 Codex 按日期分目录：~/.codex/sessions/2026/03/21/rollout-...-<sessionId>.jsonl） */
function findCodexRollout(sessionId) {
  const dir = expandHome('~/.codex/sessions');
  if (!existsSync(dir)) return null;
  const direct = path.join(dir, `${sessionId}.jsonl`);
  if (existsSync(direct)) return direct;
  // 递归子目录匹配 rollout-<ts>-<sessionId>.jsonl（只按文件名结尾匹配，避免误匹配前缀）
  try {
    const walk = (d) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) {
          const r = walk(p);
          if (r) return r;
        } else if (e.name.endsWith(`-${sessionId}.jsonl`)) {
          return p;
        }
      }
      return null;
    };
    return walk(dir);
  } catch {
    return null;
  }
}

/**
 * 定位会话文件路径（带缓存）。
 * 返回 null 表示无文件（该会话可能没有 rollout，如非模型会话）。
 */
export function findSessionFile(sessionId, provider, _cwd) {
  if (!sessionId) return null;
  if (pathCache.has(sessionId)) {
    const cached = pathCache.get(sessionId);
    if (cached === null || existsSync(cached)) return cached; // 缓存有效（含"确认无文件"）
    pathCache.delete(sessionId); // 文件被删 → 重扫
  }
  let p = null;
  if (provider === 'zcode') p = findZCodeRollout(sessionId);
  else if (provider === 'claude-code') p = findClaudeTranscript(sessionId);
  else if (provider === 'codex') p = findCodexRollout(sessionId);
  return cachePath(sessionId, p);
}

/* ---------- 统一解析入口 ---------- */

/**
 * 解析会话文件，返回统一 SessionFileInfo（各 adapter 的 parseSessionFile）。
 * 文件不存在 / 解析失败 / adapter 缺失 → null（静默降级）。
 */
export function parseSessionFile(sessionId, provider, cwd) {
  const adapter = getAdapter(provider);
  if (!adapter?.parseSessionFile) return null;
  const filePath = findSessionFile(sessionId, provider, cwd);
  if (!filePath) return null;
  try {
    return adapter.parseSessionFile(filePath, sessionId, cwd);
  } catch {
    return null;
  }
}

/* ---------- usage 标准化（进度条 pct / maxTokens 修正） ---------- */

/**
 * 把解析出的 usage 标准化成前端需要的形状：
 *  - maxTokens 修正：必须在合理范围（50k-1M），且不小于当前上下文（避免 pct 异常）
 *  - 上下文超窗口时按 1.2 倍显示
 */
export function computeUsage(usage) {
  if (!usage) return null;
  const { totalTokens, contextTokens, maxTokens: rawMax = 200000 } = usage;
  let maxTokens = rawMax;
  if (!(maxTokens >= 50000 && maxTokens <= 2000000)) maxTokens = 200000;
  const ctx = contextTokens || totalTokens || 0;
  if (ctx > maxTokens) maxTokens = Math.ceil((ctx * 1.2) / 1000) * 1000; // 上下文超窗口时按 1.2 倍显示
  return {
    ...usage,
    maxTokens,
    // 上下文进度用 contextTokens（最近一次请求上下文），total 作为累计显示
    pct: ctx ? Math.min(100, Math.round((ctx / maxTokens) * 100)) : null,
  };
}

/* ---------- todo 解析 ---------- */

/** 从 toolInput 解析 todo 列表（PostToolUse matcher TodoWrite 时 tool_input 含 todos） */
function todosFromInput(toolName, toolInput) {
  if (toolName === 'TodoWrite' && toolInput?.todos) return toolInput.todos;
  if (/todo|plan/i.test(toolName || '') && Array.isArray(toolInput?.todos)) return toolInput.todos;
  return null;
}

/** 只读 todo 文件尾部（比全部读入省内存） */
export function parseTodoTail(filePath, maxBytes = 1 * 1024 * 1024) {
  try {
    const text = readFileTail(filePath, maxBytes);
    const lines = text.split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const obj = JSON.parse(lines[i]);
        const todo = todosFromInput(getToolName(obj), getToolInput(obj));
        if (todo) return todo;
      } catch {}
    }
    return null;
  } catch {
    return null;
  }
}

/** 按 provider 的 rollout 文件解析（推荐走 parseSessionFile，这里仅兼容旧调用方） */
export function parseZCodeRollout(filePath, sessionId) {
  return getAdapter('zcode')?.parseSessionFile(filePath, sessionId) || null;
}
export function parseClaudeTranscript(filePath, sessionId) {
  return getAdapter('claude-code')?.parseSessionFile(filePath, sessionId) || null;
}
export function parseCodexRollout(filePath, sessionId) {
  return getAdapter('codex')?.parseSessionFile(filePath, sessionId) || null;
}
