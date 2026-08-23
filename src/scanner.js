/**
 * 启动扫描器：扫描各 agent 的会话文件，重建**当前在跑的**会话记录
 * （服务启动前就在进行的任务，启动后被回显；不回显历史/空闲会话）
 *
 * - Claude Code: `claude agents --json`（官方权威运行中进程列表）
 * - Codex:       ~/.codex/state_5.sqlite 的 threads 表（官方会话索引）
 * - ZCode:       ~/.zcode/cli/db/db.sqlite 的 session 表
 *
 * 回显的会话仅靠扫描无法确定"是否正在执行"，统一标 waiting_input，
 * 由后续 hook 事件精确更新为 running / 其他状态。
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { homedir } from 'node:os';
import { hub, STATES } from './hub.js';
import { projectFromCwd } from './hooks/ingest.js';

// 只回显最近 5 分钟内有活动的会话（= 当前正在跑的任务；更早的一律视为历史，不回显）
const ACTIVE_WINDOW_MS = 5 * 60 * 1000;

function expandHome(p) {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return path.join(homedir(), p.slice(2));
  return p;
}

/** 从 Claude 编码目录还原 cwd：-Users-ytzry--Documents → /Users/ytzry-Documents */
function decodeClaudeCwd(encoded) {
  // Claude 编码：/ → -，原 - → --。解码：-- → -，单个 - → /
  const decoded = encoded.replace(/--/g, '\u0000').replace(/-/g, '/').replace(/\u0000/g, '-');
  return decoded.startsWith('/') ? decoded : '/' + decoded;
}

/** 提取 Claude transcript 的 sessionId + 第一条真实 user 文本（标题）+ 真实 cwd + 是否执行中 */
function parseClaudeTranscript(filePath) {
  try {
    const lines = readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
    let sessionId = '';
    let firstUserText = '';
    let cwd = '';
    let lastType = '';
    for (let i = 0; i < lines.length; i++) {
      try {
        const o = JSON.parse(lines[i]);
        if (!sessionId && o.sessionId) sessionId = o.sessionId;
        // 真实 cwd 在 transcript 内容里（比目录名解码准确，目录名编码有歧义）
        if (!cwd && o.cwd) cwd = o.cwd;
        // 第一条真正的 user 文本（跳过 tool_result / system；content 可能是 string 或数组）
        if (!firstUserText && o.type === 'user' && o.message?.content) {
          const c = o.message.content;
          let text = '';
          if (typeof c === 'string') {
            text = c.trim();
          } else if (Array.isArray(c)) {
            text = c
              .filter((x) => x.type === 'text' && !x.text?.startsWith('<'))
              .map((x) => x.text)
              .join(' ')
              .trim();
          }
          if (text && !text.startsWith('[Request') && !text.startsWith('<')) firstUserText = text.slice(0, 120);
        }
        // 记录最后一条消息类型（判断是否执行中）
        if (o.type === 'user' || o.type === 'assistant') lastType = o.type;
      } catch {}
    }
    // 执行中判断：最后一条是 user（用户刚提交，agent 正在跑）；最后是 assistant 则已回复完（不算执行中）
    const isRunning = lastType === 'user';
    return { sessionId, lastUserText: firstUserText, cwd, isRunning };
  } catch {
    return { sessionId: '', lastUserText: '', cwd: '', isRunning: false };
  }
}

/** 提取 Codex rollout 的 sessionId/cwd/lastUserText */
function parseCodexRollout(filePath) {
  try {
    const lines = readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
    let sessionId = '';
    let cwd = '';
    let lastUserText = '';
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const o = JSON.parse(lines[i]);
        if (!sessionId && o.session_id) sessionId = o.session_id;
        if (!cwd && o.cwd) cwd = o.cwd;
        if (!lastUserText && o.type === 'response_item' && o.payload?.type === 'message' && o.payload?.role === 'user') {
          const text = o.payload.content?.[0]?.text || '';
          if (text) lastUserText = text.slice(0, 120);
        }
      } catch {}
    }
    return { sessionId, cwd, lastUserText };
  } catch {
    return { sessionId: '', cwd: '', lastUserText: '' };
  }
}

/** 提取 ZCode rollout 的 sessionId + 首条 user 消息 */
function parseZCodeRollout(filePath) {
  try {
    const lines = readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
    let sessionId = '';
    let lastUserText = '';
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const o = JSON.parse(lines[i]);
        if (!sessionId && o.sessionId) sessionId = o.sessionId;
        // request.body 是 messages 数组（对象键），找 user 消息
        if (!lastUserText && o.request?.body) {
          const body = o.request.body;
          const msgs = Array.isArray(body) ? body : Object.values(body).filter((v) => v && typeof v === 'object');
          for (const m of msgs) {
            if (m.role === 'user' && m.content) {
              const text = Array.isArray(m.content)
                ? m.content.filter((c) => typeof c === 'string' || c?.type === 'text').map((c) => (typeof c === 'string' ? c : c.text)).join(' ')
                : String(m.content);
              if (text.trim()) { lastUserText = text.trim().slice(0, 120); break; }
            }
          }
        }
      } catch {}
    }
    return { sessionId, lastUserText };
  } catch {
    return { sessionId: '', lastUserText: '' };
  }
}

/** 在 ~/.claude/projects 下查找 sessionId 对应的 transcript 文件（返回路径或 null） */
function findClaudeTranscript(sessionId) {
  const root = expandHome('~/.claude/projects');
  if (!existsSync(root)) return null;
  try {
    for (const dir of readdirSync(root)) {
      const p = path.join(root, dir, sessionId + '.jsonl');
      if (existsSync(p)) return p;
    }
  } catch {}
  return null;
}

/** 扫描 Claude Code 会话：用官方 `claude agents --json`（权威的运行中进程列表） */
function scanClaude() {
  try {
    const out = execFileSync('claude', ['agents', '--json'], {
      timeout: 10000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const agents = JSON.parse(out);
    if (!Array.isArray(agents)) return [];
    const found = [];
    for (const a of agents) {
      if (!a.sessionId) continue;
      // transcript 最近写入时间 = 真实最近活动（比 startedAt 准：老进程可能今天还在用）
      const transcript = findClaudeTranscript(a.sessionId);
      const lastActivity = transcript ? statSync(transcript).mtimeMs : 0;
      // 状态映射（事件驱动状态机）：idle = 坐在提示符等输入 → waiting；blocked = 等审批；无 status = 未知
      let state = 'running';
      if (a.status === 'idle') state = 'waiting_input';
      else if (a.status === 'blocked' || a.state === 'blocked') state = 'awaiting_approval';
      // 只回显最近 5 分钟还有活动的会话（进程列表里可能挂着长期闲置的残留终端）
      if (Date.now() - (lastActivity || a.startedAt || Date.now()) > ACTIVE_WINDOW_MS) continue;
      // 标题：优先 cwd basename 作为项目显示；会话真实标题由 tailer 的 ai-title/首条 prompt 覆盖
      const projectName = a.cwd ? a.cwd.split('/').filter(Boolean).pop() || '' : '';
      found.push({
        provider: 'claude-code',
        sessionId: a.sessionId,
        cwd: a.cwd || '',
        title: projectName || a.name || '',
        lastMessage: '',
        state,
        updatedAt: new Date(lastActivity || a.startedAt || Date.now()).toISOString(),
      });
    }
    return found;
  } catch (err) {
    // claude 命令不可用或超时 → 回退到目录扫描（尽量找）
    console.log('[scanner] claude agents --json 不可用，回退目录扫描:', err.message.slice(0, 80));
    return scanClaudeFallback();
  }
}

/** 回退方案：目录扫描（claude agents --json 不可用时） */
function scanClaudeFallback() {
  const root = expandHome('~/.claude/projects');
  if (!existsSync(root)) return [];
  const found = [];
  try {
    const dirs = readdirSync(root);
    for (const dir of dirs) {
      const dirPath = path.join(root, dir);
      try {
        const files = readdirSync(dirPath).filter((f) => f.endsWith('.jsonl'));
        for (const f of files) {
          const filePath = path.join(dirPath, f);
          const mtime = statSync(filePath).mtimeMs;
          // 只看最近 ACTIVE_WINDOW_MS 内写入过的文件（= 正在跑的任务）
          if (Date.now() - mtime > ACTIVE_WINDOW_MS) continue;
          const { sessionId, lastUserText, cwd, isRunning } = parseClaudeTranscript(filePath);
          if (!sessionId) continue;
          found.push({
            provider: 'claude-code',
            sessionId,
            cwd: cwd || decodeClaudeCwd(dir),
            title: lastUserText,
            lastMessage: '',
            state: isRunning ? 'running' : 'waiting_input',
            updatedAt: new Date(mtime).toISOString(),
          });
        }
      } catch {}
    }
  } catch {}
  return found;
}

/** 扫描 Codex 会话：读官方 state_5.sqlite 的 threads 表（id/title/cwd/tokens_used/recency） */
function scanCodex() {
  const dbPath = expandHome('~/.codex/state_5.sqlite');
  if (!existsSync(dbPath)) return [];
  try {
    // 用 sqlite3 CLI 查询（node 无内置 sqlite）
    const sql = `SELECT id, title, cwd, tokens_used, archived, recency_at_ms FROM threads WHERE archived=0 ORDER BY recency_at_ms DESC`;
    const out = execFileSync('sqlite3', [dbPath, sql], { encoding: 'utf8', timeout: 5000 });
    const found = [];
    const lines = out.split('\n').filter(Boolean);
    for (const line of lines) {
      const [id, title, cwd, tokensUsed, archived, recencyMs] = line.split('|');
      if (!id) continue;
      const recency = Number(recencyMs || 0);
      // 只回显最近 ACTIVE_WINDOW_MS 有活动的（= 正在跑/刚跑完）；recency 无效则跳过
      if (!recency || Date.now() - recency > ACTIVE_WINDOW_MS) continue;
      found.push({
        provider: 'codex',
        sessionId: id,
        cwd: cwd || '',
        title: title || '',
        lastMessage: '',
        state: 'waiting_input', // Codex 线程存在 = 会话存在等输入，hook 事件精确更新
        updatedAt: new Date(recency).toISOString(),
      });
    }
    return found;
  } catch (err) {
    console.log('[scanner] Codex threads 查询失败，回退 rollout 扫描:', err.message.slice(0, 80));
    return scanCodexFallback();
  }
}

/** Codex 回退：rollout 文件扫描 */
function scanCodexFallback() {
  const root = expandHome('~/.codex/sessions');
  if (!existsSync(root)) return [];
  const found = [];
  const walk = (dir) => {
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.jsonl') && e.name.includes('rollout-')) {
          const mtime = statSync(p).mtimeMs;
          if (Date.now() - mtime > ACTIVE_WINDOW_MS) continue;
          const { sessionId, cwd, lastUserText } = parseCodexRollout(p);
          const id = sessionId || e.name.replace('rollout-', '').replace('.jsonl', '');
          if (!id) continue;
          found.push({
            provider: 'codex',
            sessionId: id,
            cwd: cwd || '',
            title: lastUserText,
            lastMessage: '',
            state: 'running',
            updatedAt: new Date(mtime).toISOString(),
          });
        }
      }
    } catch {}
  };
  walk(root);
  return found;
}

/** 扫描 ZCode 会话：读官方 db.sqlite 的 session 表（id/title/directory/time_updated/time_archived） */
function scanZCode() {
  const dbPath = expandHome('~/.zcode/cli/db/db.sqlite');
  if (!existsSync(dbPath)) return [];
  try {
    const sql = `SELECT id, title, directory, time_updated, time_archived FROM session WHERE time_archived IS NULL ORDER BY time_updated DESC`;
    const out = execFileSync('sqlite3', [dbPath, sql], { encoding: 'utf8', timeout: 5000 });
    const found = [];
    const lines = out.split('\n').filter(Boolean);
    for (const line of lines) {
      const [id, title, directory, timeUpdated, timeArchived] = line.split('|');
      if (!id) continue;
      const updated = Number(timeUpdated || 0);
      // 只回显最近 ACTIVE_WINDOW_MS 有活动的（= 正在跑的任务）；更早的一律视为历史
      if (Date.now() - updated > ACTIVE_WINDOW_MS) continue;
      // 跳过子代理（parent_id 关联，主会话才有意义）
      if (id.includes('subagent')) continue;
      // 扫描只能确认"会话存在"，不能确定是否执行中（长时间任务无更新时间差）
      // 状态标 waiting_input（等输入/活动），由 hook 事件精确更新为 running/其他
      found.push({
        provider: 'zcode',
        sessionId: id,
        cwd: directory || '',
        title: title || '',
        lastMessage: '',
        state: 'waiting_input',
        updatedAt: new Date(updated).toISOString(),
      });
    }
    return found;
  } catch (err) {
    console.log('[scanner] ZCode session 查询失败，回退 rollout 扫描:', err.message.slice(0, 80));
    return scanZCodeFallback();
  }
}

/** ZCode 回退：rollout 文件扫描 */
function scanZCodeFallback() {
  const root = expandHome('~/.zcode/cli/rollout');
  if (!existsSync(root)) return [];
  const found = [];
  try {
    const files = readdirSync(root).filter((f) => f.startsWith('model-io-sess_') && !f.includes('no-session'));
    for (const f of files) {
      const filePath = path.join(root, f);
      const mtime = statSync(filePath).mtimeMs;
      if (Date.now() - mtime > ACTIVE_WINDOW_MS) continue;
      const { sessionId, lastUserText } = parseZCodeRollout(filePath);
      const id = sessionId || f.replace('model-io-sess_', '').replace('.jsonl', '');
      if (!id) continue;
      found.push({
        provider: 'zcode',
        sessionId: id,
        cwd: '',
        title: lastUserText,
        lastMessage: '',
        state: 'running',
        updatedAt: new Date(mtime).toISOString(),
      });
    }
  } catch {}
  return found;
}

/**
 * 启动时扫描并回显活跃会话。
 * 只填充新会话（不覆盖已存在的活跃会话状态），状态用各 agent 报告的（claude agents --json 的 status）。
 */
export function scanAndRestore() {
  const sessions = [...scanClaude(), ...scanCodex(), ...scanZCode()];
  let restored = 0;
  for (const s of sessions) {
    if (hub.sessions.has(s.sessionId)) continue; // 已有（hook 实时更新的），不覆盖
    // 状态：用扫描到的 state 值（idle/running/awaiting_approval 等），非法值回退 running
    const validStates = Object.values(STATES);
    const state = validStates.includes(s.state) ? s.state : STATES.RUNNING;
    const sess = hub.ensureSession(s.sessionId, s.provider, {
      cwd: s.cwd,
      project: s.cwd ? projectFromCwd(s.cwd) : '',
      title: s.title,
      lastMessage: s.lastMessage,
      updatedAt: Date.parse(s.updatedAt) || Date.now(),
      state,
    });
    restored++;
  }
  if (restored > 0) console.log(`[scanner] 回显 ${restored} 个活跃会话（${sessions.length} 个扫描到）`);
  return restored;
}
