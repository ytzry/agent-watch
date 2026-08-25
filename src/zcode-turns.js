/**
 * ZCode 轮次状态轮询（官方 db turn_usage 表）
 *
 * 为什么需要它——ZCode 手动中断（停止按钮 / Esc）不触发任何 hook：
 *   zcode.cjs 源码验证，Stop hook 只在模型正常完成回复时派发（runStopHooks 仅在
 *   receiveModelResponse 成功路径调用）；取消路径（appendTurnOutcomeEvent）只写
 *   resultType:"cancelled" 的内部事件，hook 一概不发。rollout 也不补写被中断的
 *   model_io 记录 → 中断后最后一条记录仍是 tool-calls，tailer 会把会话永远判成
 *   running。唯一权威信号是官方 db 的 turn_usage 表：
 *     status: 'completed' | 'cancelled' | 'error'
 *     cancelled_by_user: 0/1（手动中断 = cancelled + cancelled_by_user=1）
 *     completed_at: 轮次结束时间（epoch ms）
 *
 * 两个消费方：
 *   - 轮询（startZcodeTurnPoller）：运行中增量读新轮次行，实时收敛状态
 *       cancelled → ended（用户接管，本轮已终止）；completed → idle；error → error
 *   - 扫描回显（latestZcodeTurns）：服务启动时修正 restore 状态，避免把已中断的
 *     会话按 rollout 尾部误恢复成 running
 */
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { homedir } from 'node:os';
import { hub, STATES } from './hub.js';

const ZCODE_DB = path.join(homedir(), '.zcode/cli/db/db.sqlite');
// 轮询间隔：中断/完成的判定延迟上限。db 是本地 sqlite 只读查询，3s 无压力
const POLL_INTERVAL_MS = 3000;
// 新鲜度守卫：轮次结束时间早于会话最近活动太多次 → 说明该轮之后已有新对话
// （如取消后立刻重新提问），旧行不得覆盖新状态
const STALE_GUARD_MS = 5000;

let turnDb = null;
function openTurnDb() {
  if (turnDb) return turnDb;
  try {
    if (!existsSync(ZCODE_DB)) return null;
    // 只读打开：与运行中的 ZCode 共存，不加锁不干扰
    turnDb = new DatabaseSync(ZCODE_DB, { readOnly: true });
    return turnDb;
  } catch {
    return null;
  }
}

/** 取某会话最近一次轮次的状态；无记录返回 null。
 *  status/cancelledByUser/completedAtMs 供调用方按各自语义消费。 */
export function latestZcodeTurn(sessionId) {
  const db = openTurnDb();
  if (!db || !sessionId) return null;
  try {
    const row = db
      .prepare('SELECT status, cancelled_by_user, completed_at FROM turn_usage WHERE session_id = ? ORDER BY rowid DESC LIMIT 1')
      .get(sessionId);
    if (!row) return null;
    return {
      status: row.status,
      cancelledByUser: !!row.cancelled_by_user,
      completedAtMs: Number(row.completed_at) || 0,
    };
  } catch {
    turnDb = null; // 连接失效（db 重建/锁）→ 下次重开
    return null;
  }
}

/**
 * 增量轮询：从上次游标起读新的轮次行，把终态收敛进 hub（只更新已知会话，不建卡）。
 * 返回本次处理的行数（测试用）。
 * @param {number} [fromRowid] 从该 rowid 之后开始读；不传则自动定位到当前最大值（只看未来）
 */
export function pollZcodeTurnsOnce(fromRowid) {
  const db = openTurnDb();
  if (!db) return 0;
  try {
    let cursor = fromRowid;
    if (cursor === undefined) {
      if (!cursorReady) {
        // 首次只建立游标，不回放历史（历史归 scanner 回显管）。
        // 游标未建立前（如启动时 db 还没生成）绝不增量读——否则会从 0 回放全量历史
        const r = db.prepare('SELECT COALESCE(MAX(rowid), 0) AS m FROM turn_usage').get();
        lastRowid = cursor = r?.m ?? 0;
        cursorReady = true;
        return 0;
      }
      cursor = lastRowid;
    }
    const rows = db.prepare('SELECT rowid AS rid, session_id, status, cancelled_by_user, completed_at FROM turn_usage WHERE rowid > ? ORDER BY rowid ASC LIMIT 500').all(cursor);
    for (const row of rows) {
      cursor = Math.max(cursor, row.rid);
      applyTurnRow(row);
    }
    lastRowid = cursor;
    return rows.length;
  } catch {
    turnDb = null; // 下次重开
    return 0;
  }
}

/** 把一条轮次记录应用到 hub（仅当会话已知且该轮次仍是最新的） */
function applyTurnRow(row) {
  const sid = row.session_id;
  const s = hub.sessions.get(sid);
  if (!s || s.state === STATES.ENDED) return;
  const completedAtMs = Number(row.completed_at) || Date.now();
  // 该轮结束后又有了更新的对话活动（重新提问等）→ 这条旧结果不再代表当前状态
  if (s.lastActivityAt - STALE_GUARD_MS > completedAtMs) return;

  if (row.status === 'cancelled') {
    // 手动中断：本轮已被用户终止（不管是不是本人按的），卡片离开"执行中"→ 已结束。
    // AskUserQuestion 提问后用户按 Esc，提问轮次同样是被终止，理应结束
    hub.end(sid, 'turn_cancelled');
    return;
  }
  if (row.status === 'error') {
    hub.update(sid, { state: STATES.ERROR }, { stateChangedBy: 'turn_error', activity: true });
    return;
  }
  if (row.status === 'completed') {
    // 正常完成 → idle。复用 applyReplyState：不打扰审批/提问/后台任务等主动状态
    hub.applyReplyState(sid, 'done');
  }
}

let lastRowid = 0;
let cursorReady = false;

/** 启动轮次状态轮询（server 启动时调用一次） */
export function startZcodeTurnPoller() {
  pollZcodeTurnsOnce(); // 建立游标：只关注服务启动之后的轮次
  const timer = setInterval(() => pollZcodeTurnsOnce(), POLL_INTERVAL_MS);
  timer.unref?.();
}
