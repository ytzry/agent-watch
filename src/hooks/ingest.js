import { Router } from 'express';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { homedir } from 'node:os';
import { hub, STATES } from '../hub.js';
import { EVENTS, getAdapter, listAdapters, getEventName } from '../adapters/index.js';
/**
 * 从 cwd 推断项目名：向上找 .git 目录，取仓库名；没有则取 basename。
 * 注意：hook 运行时拿 cwd 即可，不必读磁盘（避免 hook 阻塞）。这里做纯路径推断。
 */
export function projectFromCwd(cwd) {
  if (!cwd || typeof cwd !== 'string') return '未知项目';
  const parts = cwd.split('/').filter(Boolean);
  if (parts.length === 0) return cwd;
  // 找 .git 段：/path/to/repo/.git 或 /path/to/repo（含 .git 子目录）
  const idx = parts.indexOf('.git');
  if (idx > 0) return parts[idx - 1];
  return parts[parts.length - 1];
}

const router = Router();

// ZCode 官方会话 db 的轻量缓存查询（key: sessionId → { title, directory }）
// hook payload 缺失 cwd/title 时兜底用；查不到返回 null（不阻塞事件）
const zcodeMetaCache = new Map();
const ZCODE_DB = path.join(homedir(), '.zcode/cli/db/db.sqlite');
function zcodeSessionMeta(sessionId) {
  if (!sessionId) return null;
  if (zcodeMetaCache.has(sessionId)) return zcodeMetaCache.get(sessionId);
  let meta = null;
  try {
    if (existsSync(ZCODE_DB)) {
      // 用 .parameter 绑定，避免会话 ID 里的连字符被当成 SQL 语法
      const out = execFileSync('sqlite3', [
        ZCODE_DB,
        '.parameter init',
        '.parameter set @sid ' + sessionId,
        'SELECT title, directory FROM session WHERE id = @sid',
      ], { encoding: 'utf8', timeout: 3000 });
      const [titleRaw, dirRaw] = out.split('|');
      const title = titleRaw?.trim();
      const directory = dirRaw?.trim();
      if (title || directory) meta = { title: title || null, directory: directory || null };
    }
  } catch {}
  // 只缓存成功结果；失败不缓存（下次再试）
  if (meta) zcodeMetaCache.set(sessionId, meta);
  if (zcodeMetaCache.size > 500) zcodeMetaCache.clear(); // 防膨胀
  return meta;
}

/** POST /api/hooks/:provider — 统一 hook 接收入口 */
router.post('/hooks/:provider', async (req, res) => {
  const { provider } = req.params;
  const payload = req.body || {};
  const rawEvent = getEventName(payload);

  // 调试：打印原始 payload 字段结构（仅字段名，不含值，防敏感泄露）
  if (process.env.AW_DEBUG_PAYLOAD) {
    const keys = Object.keys(payload);
    const sub = {};
    for (const k of keys) {
      const v = payload[k];
      sub[k] = Array.isArray(v) ? `Array(${v.length})` : typeof v === 'object' && v ? `Object{${Object.keys(v).slice(0, 6).join(',')}}` : typeof v;
    }
    console.log(`[ingest-debug] ${provider} rawEvent=${rawEvent}`, JSON.stringify(sub));
  }

  try {
    const adapter = await getAdapter(provider);
    const ev = adapter.normalize(payload, rawEvent);
    if (!ev) {
      // 不认识的原始事件，静默 200（hook 调用方不关心）
      return res.json({ ok: true, ignored: rawEvent });
    }
    applyEvent(ev);
    res.json({ ok: true });
  } catch (err) {
    console.error(`[ingest] ${provider}/${rawEvent} error:`, err.message);
    res.status(200).json({ ok: false, error: err.message }); // 仍 200，避免 hook 侧报错
  }
});

/** 把归一化事件应用到状态中枢 */
export function applyEvent(ev) {
  const s = hub.ensureSession(ev.sessionId, ev.provider);
  const patch = {};

  // 公共字段
  if (ev.cwd) {
    patch.cwd = ev.cwd;
    if (!s.project) patch.project = projectFromCwd(ev.cwd);
  } else if (!s.cwd && ev.provider === 'zcode') {
    // ZCode 部分事件（如 Stop）payload 可能不带 cwd → 从官方 db 回查补齐
    // （会话创建时若缺 cwd，前端会归到"未知项目"，补上后自动迁移）
    const meta = zcodeSessionMeta(ev.sessionId);
    if (meta?.directory) {
      patch.cwd = meta.directory;
      if (!s.project) patch.project = projectFromCwd(meta.directory);
    }
  }
  if (ev.title && !s.title) patch.title = ev.title;
  else if (!s.title && ev.provider === 'zcode') {
    // title 缺失同理从 db 补（db 有 ai 生成的会话标题，比空着强）
    const meta = zcodeSessionMeta(ev.sessionId);
    if (meta?.title) patch.title = meta.title;
  }
  if (ev.mode) patch.mode = ev.mode;
  if (ev.lastMessage) patch.lastMessage = ev.lastMessage;

  switch (ev.event) {
    case EVENTS.SESSION_START:
      // 会话开始（可能 resume/compact）→ waiting（坐在提示符等输入），有活动后转 running
      hub.update(ev.sessionId, { ...patch, state: STATES.WAITING_INPUT }, { stateChangedBy: 'session_start' });
      break;

    case EVENTS.PROMPT:
      hub.update(ev.sessionId, {
        ...patch,
        title: ev.title || s.title,
        state: STATES.RUNNING,
      }, { stateChangedBy: 'prompt' });
      break;

    case EVENTS.TOOL_USE:
      hub.update(ev.sessionId, {
        ...patch,
        lastTool: ev.toolName || s.lastTool,
        state: STATES.RUNNING,
      }, { stateChangedBy: 'tool_use' });
      break;

    case EVENTS.TODO: {
      const todo = Array.isArray(ev.todo) ? ev.todo : s.todo;
      hub.update(ev.sessionId, { ...patch, todo, state: STATES.RUNNING }, { stateChangedBy: 'todo' });
      break;
    }

    case EVENTS.PERMISSION_REQUEST:
      hub.update(ev.sessionId, {
        ...patch,
        lastTool: ev.toolName || s.lastTool,
        state: STATES.AWAITING_APPROVAL,
      }, { stateChangedBy: 'permission_request' });
      break;

    case EVENTS.ASK_USER:
      hub.update(ev.sessionId, {
        ...patch,
        lastTool: ev.toolName || s.lastTool,
        state: STATES.WAITING_INPUT,
      }, { stateChangedBy: 'ask_user' });
      break;

    case EVENTS.PRE_COMPACT:
      hub.update(ev.sessionId, { ...patch, state: STATES.COMPACTING }, { stateChangedBy: 'pre_compact' });
      break;

    case EVENTS.STOP: {
      const bg = ev.hasBackground;
      hub.update(ev.sessionId, {
        ...patch,
        state: bg ? STATES.BACKGROUND_TASK : STATES.IDLE,
      }, { stateChangedBy: bg ? 'background_task' : 'stop' });
      break;
    }

    case EVENTS.STOP_FAILURE:
      hub.update(ev.sessionId, {
        ...patch,
        lastTool: ev.toolName || s.lastTool,
        state: STATES.ERROR,
      }, { stateChangedBy: 'stop_failure' });
      break;

    case EVENTS.SUBAGENT_START:
      // 子代理启动：会话仍 running（不打断），只记录
      hub.update(ev.sessionId, { ...patch, state: STATES.RUNNING }, { stateChangedBy: 'subagent_start' });
      break;

    case EVENTS.SUBAGENT_STOP:
      hub.update(ev.sessionId, { ...patch, state: STATES.RUNNING }, { stateChangedBy: 'subagent_stop' });
      break;

    case EVENTS.SESSION_END:
      hub.end(ev.sessionId, 'session_end');
      break;

    default:
      hub.update(ev.sessionId, patch);
  }
}

export default router;
