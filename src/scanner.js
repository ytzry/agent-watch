/**
 * 启动扫描器：扫描各 agent 的会话文件，重建**当前在跑的**会话记录
 * （服务启动前就在进行的任务，启动后被回显；不回显历史/空闲会话）
 *
 * - Claude Code: ~/.claude/projects 下最近写入的 transcript（文件 mtime = 真实对话活动；
 *                打开了但没对话的交互进程没有 jsonl，天然不会误报成任务）
 * - Codex:       ~/.codex/state_5.sqlite 的 threads 表（官方会话索引）
 * - ZCode:       ~/.zcode/cli/rollout 下最近写入的 rollout 文件
 *                （db 的 time_updated 打开会话就会刷新，会误报"从未对话"的会话；
 *                 rollout 文件只有真正产生过模型 I/O 的会话才有）
 *
 * 回显的会话仅靠扫描无法确定"是否正在执行"，统一标 waiting_input，
 * 由后续 hook 事件精确更新为 running / 其他状态。
 */
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { homedir } from 'node:os';
import { hub, STATES } from './hub.js';
import { parseZCodeRollout as parseZCodeRolloutFile } from './session-files.js';
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

/** 从 transcript 内容提取最后一条真实对话时间戳（user/assistant 行的 timestamp，毫秒）。
 *  mtime 会被非对话动作（打开/恢复/快照重写）刷新，内容时间戳才是真实对话活动。
 *  返回 0 表示无对话时间戳。 */
function lastTranscriptActivity(filePath) {
  try {
    const lines = readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
    let lastTs = 0;
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const o = JSON.parse(lines[i]);
        if ((o.type === 'user' || o.type === 'assistant') && o.timestamp) {
          const t = Date.parse(o.timestamp);
          if (!isNaN(t) && t > lastTs) return t;
        }
      } catch {}
    }
  } catch {}
  return lastTs;
}

/** 扫描 Claude Code 会话：transcript 文件 mtime + 内容真实对话时间戳双重判定。
 *  为什么不能只看 mtime：Claude 打开/恢复会话、写 file-history-snapshot 都会重写文件、
 *  刷新 mtime——内容没有新增对话，却会被误判成"正在跑的任务"（旧会话误报）。
 *  内容时间戳（user/assistant 行）只有真实对话才会新增，作为活跃判定的权威依据。 */
function scanClaude() {
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
          // 先看 mtime：最近 ACTIVE_WINDOW_MS 内写入过的文件（= 可能正在跑的任务）。
          // 不用进程 startedAt 兜底：打开了但没发过消息的交互终端没有 transcript，
          // 一旦按启动时间回显就会把"从未对话的会话"误报成任务
          if (Date.now() - mtime > ACTIVE_WINDOW_MS) continue;
          // 再核对内容：最后一条真实对话时间戳（user/assistant 行）也必须在活跃窗口内。
          // mtime 被刷新但内容时间戳是旧会话 → 非对话动作（打开/快照重写），跳过。
          // 两者都满足才判定为"正在跑/刚跑完"的对话。
          const lastActivity = lastTranscriptActivity(filePath);
          if (Date.now() - lastActivity > ACTIVE_WINDOW_MS) continue;
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
    // 用 node:sqlite 直接读官方库：不走子进程管道，查询输出不受 1MB maxBuffer
    // 限制，也不依赖 PATH 里的 sqlite3 CLI
    const db = new DatabaseSync(dbPath);
    try {
      const rows = db
        .prepare('SELECT id, title, cwd, tokens_used, archived, recency_at_ms FROM threads WHERE archived=0 ORDER BY recency_at_ms DESC')
        .all();
      const found = [];
      for (const row of rows) {
        const recency = Number(row.recency_at_ms || 0);
        // 只回显最近 ACTIVE_WINDOW_MS 有活动的（= 正在跑/刚跑完）；recency 无效则跳过
        if (!recency || Date.now() - recency > ACTIVE_WINDOW_MS) continue;
        found.push({
          provider: 'codex',
          sessionId: row.id,
          cwd: row.cwd || '',
          title: row.title || '',
          lastMessage: '',
          state: 'waiting_input', // Codex 线程存在 = 会话存在等输入，hook 事件精确更新
          updatedAt: new Date(recency).toISOString(),
        });
      }
      return found;
    } finally {
      db.close();
    }
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

/** 扫描 ZCode 会话：db 会话索引 + rollout 文件存在性/mtime 双重判定
 *
 * 为什么不能只看 db：ZCode 打开一个会话（未发任何消息）也会刷新 time_updated，
 * 若按 db 时间判活跃，面板会回显"从未对话"的会话（误报）。
 * 因此以 rollout 文件为准——只有真正产生过模型 I/O（= 干过活）的会话才有文件。
 * 再结合 mtime 判活跃窗口：只回显最近 ACTIVE_WINDOW_MS 内有活动的（= 正在跑/刚跑完）。
 */
function scanZCode() {
  const dbPath = expandHome('~/.zcode/cli/db/db.sqlite');
  if (!existsSync(dbPath)) return [];
  try {
    const db = new DatabaseSync(dbPath);
    try {
      // 先扫 rollout 目录，拿"真正干过活"的会话候选（子代理除外）
      const rolloutDir = expandHome('~/.zcode/cli/rollout');
      const candidates = [];
      if (existsSync(rolloutDir)) {
        for (const f of readdirSync(rolloutDir)) {
          const m = f.match(/^model-io-sess_(.+)\.jsonl$/);
          if (!m) continue;
          const sid = 'sess_' + m[1];
          if (sid.includes('subagent')) continue; // 子代理不单独回显
          const mtime = statSync(path.join(rolloutDir, f)).mtimeMs;
          // 只回显最近 ACTIVE_WINDOW_MS 有活动的（= 正在跑的任务）；更早的一律视为历史
          if (Date.now() - mtime > ACTIVE_WINDOW_MS) continue;
          candidates.push({ sessionId: sid, mtime, filePath: path.join(rolloutDir, f) });
        }
      }
      if (!candidates.length) return [];
      // 从 db 批量取候选会话的标题/cwd（用占位符批量查询，避免逐条往返）
      const ids = candidates.map((c) => c.sessionId);
      const placeholders = ids.map(() => '?').join(',');
      const rows = db
        .prepare(`SELECT id, title, directory FROM session WHERE id IN (${placeholders})`)
        .all(...ids);
      const byId = new Map(rows.map((r) => [r.id, r]));
      const found = [];
      for (const c of candidates) {
        const row = byId.get(c.sessionId);
        // 找不到 db 记录也回显（rollout 文件存在 = 干过活）；db 兜底拿不到标题则留空
        // 状态按最后一条 model_io 的回复状态判定（done → idle，有工具调用 → running），
        // 而不是一律 waiting_input——AI 回复完成的会话不该显示"等待回复"
        const parsed = parseZCodeRolloutFile(c.filePath, c.sessionId);
        const replyState = parsed?.replyState;
        const state = replyState === 'done' ? STATES.IDLE : replyState === 'running' ? STATES.RUNNING : STATES.WAITING_INPUT;
        found.push({
          provider: 'zcode',
          sessionId: c.sessionId,
          cwd: row?.directory || '',
          title: row?.title || '',
          lastMessage: parsed?.lastMessage || '',
          state,
          updatedAt: new Date(c.mtime).toISOString(),
        });
      }
      return found;
    } finally {
      db.close();
    }
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
 * 只填充新会话（不覆盖已存在的活跃会话状态），状态用各 agent 扫描源报告的 state 值，非法值回退 running。
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
      lastActivityAt: Date.parse(s.updatedAt) || Date.now(),
      state,
    });
    restored++;
  }
  if (restored > 0) console.log(`[scanner] 回显 ${restored} 个活跃会话（${sessions.length} 个扫描到）`);
  return restored;
}
