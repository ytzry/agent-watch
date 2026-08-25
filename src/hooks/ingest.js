import { Router } from 'express';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { homedir } from 'node:os';
import { hub, STATES } from '../hub.js';
import { EVENTS, getAdapter, listAdapters, getEventName } from '../adapters/index.js';
import { findSessionFile, parseSessionFile, computeUsage, parseTodoTail } from '../session-files.js';
import { parseZCodePermission } from '../scanner.js';
/**
 * 从 cwd 推断项目名：向上找 .git 目录，取仓库名；没有则取 basename。
 * 注意：hook 运行时拿 cwd 即可，不必读磁盘（避免 hook 阻塞）。这里做纯路径推断。
 * 跨平台：先把 \ 归一成 / 再切，兼容 Windows（D:\a\b）与 POSIX 路径，也兼容混用分隔符的路径。
 */
export function projectFromCwd(cwd) {
  if (!cwd || typeof cwd !== 'string') return '未知项目';
  // Windows 路径（C:\...）里的反斜杠会被 JS 字符串转义吃掉，用 replace 恢复后按两种分隔符切
  const parts = cwd.replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.length === 0) return cwd;
  // 找 .git 段：/path/to/repo/.git 或 /path/to/repo（含 .git 子目录）
  const idx = parts.indexOf('.git');
  if (idx > 0) return parts[idx - 1];
  return parts[parts.length - 1];
}

const router = Router();

// ZCode 官方会话 db 的轻量缓存查询（key: sessionId → { title, directory, permission }）
// hook payload 缺失 cwd/title/mode 时兜底用；查不到返回 null（不阻塞事件）
const zcodeMetaCache = new Map();
const ZCODE_DB = path.join(homedir(), '.zcode/cli/db/db.sqlite');
// 复用连接：hook 事件是热路径，避免每次查标题都重新打开 db；失败时置空下次重开
let zcodeDb = null;
function zcodeSessionMeta(sessionId) {
  if (!sessionId) return null;
  if (zcodeMetaCache.has(sessionId)) return zcodeMetaCache.get(sessionId);
  let meta = null;
  try {
    if (!zcodeDb && existsSync(ZCODE_DB)) zcodeDb = new DatabaseSync(ZCODE_DB);
    if (zcodeDb) {
      // 参数绑定查询，会话 ID 里的连字符是普通值，不会被当成 SQL 语法
      const row = zcodeDb.prepare('SELECT title, directory, permission FROM session WHERE id = ?').get(sessionId);
      const title = row?.title?.trim();
      const directory = row?.directory?.trim();
      if (title || directory || row?.permission) {
        meta = {
          title: title || null,
          directory: directory || null,
          mode: parseZCodePermission(row?.permission),
        };
      }
    }
  } catch {
    zcodeDb = null; // 连接失效（如 db 被重建/锁定）→ 下次事件重新打开
  }
  // 只缓存成功结果；失败不缓存（下次再试）
  if (meta) zcodeMetaCache.set(sessionId, meta);
  if (zcodeMetaCache.size > 500) zcodeMetaCache.clear(); // 防膨胀
  return meta;
}

/** POST /api/hooks/:provider — 统一 hook 接收入口 */
router.post('/hooks/:provider', (req, res) => {
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
    const adapter = getAdapter(provider);
    if (!adapter) return res.status(404).json({ ok: false, error: `unknown provider: ${provider}` });
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
  // SessionStart 且会话尚不存在 → 直接丢弃，不创建卡片。
  // ZCode 打开/新建未发消息的会话也会触发 SessionStart，若在这里创建会话，
  // 面板上就会堆满"从未对话"的"新建"卡片（误报）。只有真实活动才创建。
  // （6266c67 只在 switch 分支 return，但开头 ensureSession 已创建，需在这里拦截）
  if (ev.event === EVENTS.SESSION_START && !hub.sessions.has(ev.sessionId)) return;

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
  // 标题优先级（ZCode）：db 官方标题 > hook payload 标题（对 ZCode 通常是首条 prompt，兜底用）。
  // db 是用户/模型生成的会话标题（如"Vue库存周期盘点列表"），比 prompt 更稳定；只补空，不覆盖已有。
  // 注意：ZCode 的 ev.title 就是当次 prompt，绝不能当"官方标题"——db 查询必须优先于它。
  if (!s.title && ev.provider === 'zcode') {
    const meta = zcodeSessionMeta(ev.sessionId);
    if (meta?.title) patch.title = meta.title;
  }
  // mode 补齐：hook payload 没带（ZCode/Codex hook 通常不带 permission_mode）时，
  // ZCode 从 db session.permission（JSON 字符串 {"mode":"..."}）回查，Claude 由文件解析补
  if (!s.mode && ev.provider === 'zcode') {
    const meta = zcodeSessionMeta(ev.sessionId);
    if (meta?.mode) patch.mode = meta.mode;
  }
  // 非 ZCode 或 db 无标题时才用 ev.title 兜底（Claude/Codex 的 ev.title 是真实描述；ZCode 是 prompt）
  if (ev.title && !s.title && !patch.title && ev.provider !== 'zcode') patch.title = ev.title;
  if (ev.mode) patch.mode = ev.mode;
  if (ev.lastMessage) patch.lastMessage = ev.lastMessage;

  // hook 触发时同步读本地会话文件，即时刷新上下文用量 / 缓存命中率 / 标题 / todo / mode。
  // 数据以文件为准（比 hook payload 完整：payload 不含 usage），读取必须快速且容错。
  // 解析统一走 session-files.parseSessionFile（委托给各 adapter 的 parseSessionFile）。
  // 用 setImmediate 异步合并：hook 响应先回（不阻塞 agent 调用方），解析结果随后广播。
  if (ev.event === EVENTS.STOP || ev.event === EVENTS.PROMPT || ev.event === EVENTS.ASK_USER || ev.event === EVENTS.PERMISSION_REQUEST) {
    const provider = ev.provider;
    const sessionId = ev.sessionId;
    const cwd = patch.cwd || ev.cwd || s.cwd;
    setImmediate(() => {
      try {
        // 统一解析（usage / firstPrompt / lastMessage / aiTitle / mode / replyState）
        const result = parseSessionFile(sessionId, provider, cwd);
        if (!result?.usage) return;
        const patch2 = {};
        const usage2 = computeUsage(result.usage);
        if (usage2) patch2.usage = usage2;
        // 标题：ai-title > 首条 user prompt；都没有保留现有。ZCode 用 db 标题（已由 applyEvent 同步补过）
        if (result.aiTitle) patch2.title = result.aiTitle;
        else if (result.firstPrompt && !hub.sessions.get(sessionId)?.title) patch2.title = result.firstPrompt;
        // mode：文件里有（Claude permission-mode 行）且会话还没有 → 补上
        if (result.mode && !hub.sessions.get(sessionId)?.mode) patch2.mode = result.mode;
        if (result.lastMessage) patch2.lastMessage = result.lastMessage;
        // todo：hook payload 无 todo 时从文件补（TodoWrite 的 tool_input 落盘在 rollout）
        if (provider === 'zcode' && !ev.todo) {
          const todo = parseTodoTail(findSessionFile(sessionId, provider, cwd));
          if (todo) patch2.todo = todo;
        }
        if (Object.keys(patch2).length) hub.update(sessionId, patch2);
        // 状态：按最后一条 model_io 的回复状态收敛（AI 回复完成 → idle；有工具调用 → running）
        if (result.replyState) hub.applyReplyState(sessionId, result.replyState);
      } catch (err) { console.error('[ingest] file sync error:', err); }
    });
  }

  switch (ev.event) {
    case EVENTS.SESSION_START:
      // 会话开始/打开：开头已拦截"不存在"的情况；到这里必然已存在
      // （resume 或扫描回显过）→ 仅补公共字段（cwd/title 等），保持原状态不变
      // （打开会话不算活动，不重置 waiting_input，也不刷新 updatedAt——否则
      //  打开一个旧会话就会把它顶到最前，误报成"有活动"）。
      if (Object.keys(patch).length) Object.assign(s, patch);
      break;

    case EVENTS.PROMPT:
      hub.update(ev.sessionId, {
        ...patch,
        state: STATES.RUNNING,
      }, { stateChangedBy: 'prompt', activity: true });
      break;

    case EVENTS.TOOL_USE:
      // 工具调用是任务的持续动作，不算"对话活动"（否则正在跑的长会话靠工具事件
      // 每几秒刷一次 lastActivityAt，永远霸占组首，刚对话完的项目反而排不上去）
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
      }, { stateChangedBy: 'permission_request', activity: true });
      break;

    case EVENTS.ASK_USER:
      hub.update(ev.sessionId, {
        ...patch,
        lastTool: ev.toolName || s.lastTool,
        state: STATES.WAITING_INPUT,
        waitingForInput: true, // 真等待（模型提问等用户），文件信号不得覆盖
      }, { stateChangedBy: 'ask_user', activity: true });
      break;

    case EVENTS.PRE_COMPACT:
      // 上下文压缩是任务内部动作，不算对话活动
      hub.update(ev.sessionId, { ...patch, state: STATES.COMPACTING }, { stateChangedBy: 'pre_compact' });
      break;

    case EVENTS.STOP: {
      // 手动停止（用户点停止按钮 / Esc）会触发 Stop 事件。
      // 有后台任务（定时器/后台进程）→ 会话转为后台任务；否则本次工作已结束。
      // ZCode 无 SessionEnd hook，这里就是会话终止的最终信号，不能标 idle——
      // idle 的语义是"AI 正常回复完成"，前端展示为"已完成"，而手动停止后
      // tailer 的存活探测会把它改成 ended，中间会有一段时间状态不一致。
      const bg = ev.hasBackground;
      hub.update(ev.sessionId, {
        ...patch,
        state: bg ? STATES.BACKGROUND_TASK : STATES.ENDED,
        endedAt: Date.now(),
      }, { stateChangedBy: bg ? 'background_task' : 'stop', activity: true });
      break;
    }

    case EVENTS.STOP_FAILURE:
      // 出错是重要状态变化，算对话活动
      hub.update(ev.sessionId, {
        ...patch,
        lastTool: ev.toolName || s.lastTool,
        state: STATES.ERROR,
      }, { stateChangedBy: 'stop_failure', activity: true });
      break;

    case EVENTS.SUBAGENT_START:
      // 子代理启动：会话仍 running（不打断），只记录；子代理是任务内部动作，不算对话活动
      hub.update(ev.sessionId, { ...patch, state: STATES.RUNNING }, { stateChangedBy: 'subagent_start' });
      break;

    case EVENTS.SUBAGENT_STOP:
      hub.update(ev.sessionId, { ...patch, state: STATES.RUNNING }, { stateChangedBy: 'subagent_stop' });
      break;

    case EVENTS.SESSION_END:
      hub.end(ev.sessionId, 'session_end');
      break;

    default:
      hub.update(ev.sessionId, patch, { activity: true });
  }
}

export default router;
