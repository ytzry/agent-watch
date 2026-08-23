import { EventEmitter } from 'node:events';

/**
 * 会话状态中枢（纯内存）
 *
 * 状态机：
 *   created → running → awaiting_approval → running
 *                     ↘ waiting_input     → running
 *                     ↘ idle              → running
 *                     ↘ background_task   → running
 *                     ↘ compacting        → running
 *                     ↘ error             → (可恢复 running)
 *   任意状态 → ended
 */
export const STATES = {
  CREATED: 'created',
  RUNNING: 'running',
  AWAITING_APPROVAL: 'awaiting_approval',
  WAITING_INPUT: 'waiting_input',
  IDLE: 'idle',
  BACKGROUND_TASK: 'background_task',
  COMPACTING: 'compacting',
  ERROR: 'error',
  ENDED: 'ended',
};

// 状态 → 默认播报（前端按状态查设置，这里只定义默认提示音类型；null = 不播）
export const STATE_SOUND_DEFAULT = {
  [STATES.CREATED]: null,
  [STATES.RUNNING]: null,
  [STATES.AWAITING_APPROVAL]: 'alert', // 需要人审批 → 提醒
  [STATES.WAITING_INPUT]: 'alert', // 需要人回复 → 提醒
  [STATES.IDLE]: 'success', // AI 回复完成 → 完成音
  [STATES.BACKGROUND_TASK]: null,
  [STATES.COMPACTING]: null,
  [STATES.ERROR]: 'error', // 出错 → 错误音
  [STATES.ENDED]: null,
};

class Hub extends EventEmitter {
  constructor() {
    super();
    /** @type {Map<string, object>} sessionId -> session */
    this.sessions = new Map();
    /** @type {Array<object>} 事件历史（环形，防内存膨胀） */
    this.events = [];
    this.eventsMax = 500;
  }

  /** 获取或创建会话 */
  ensureSession(sessionId, provider, initial = {}) {
    let s = this.sessions.get(sessionId);
    if (!s) {
      s = {
        id: sessionId,
        provider,
        title: '',
        project: '',
        cwd: '',
        mode: null, // 归一化回复模式：ask/auto/plan/acceptEdits/bypass/未知原值
        state: STATES.CREATED,
        todo: [],
        lastMessage: '',
        lastTool: null,
        lastEventAt: Date.now(),
        startedAt: Date.now(),
        updatedAt: Date.now(),
        endedAt: null,
        subagents: [], // 子代理用量快照
        usage: null, // { inputTokens, outputTokens, totalTokens, maxTokens, pct }
        ...initial,
      };
      this.sessions.set(sessionId, s);
      this._pushEvent({ type: 'session_new', session: s });
      this.emit('change', s, { event: 'session_new' });
    }
    return s;
  }

  /** 更新会话字段，若状态变化则广播 event（前端据此播放声音） */
  update(sessionId, patch, { stateChangedBy } = {}) {
    const s = this.sessions.get(sessionId);
    if (!s) return null;
    const prevState = s.state;
    Object.assign(s, patch, { updatedAt: Date.now() });
    const stateChanged = s.state !== prevState;
    if (stateChanged) {
      this._pushEvent({
        type: 'state_change',
        session: this.publicView(s),
        from: prevState,
        to: s.state,
        by: stateChangedBy,
      });
    } else {
      this._pushEvent({ type: 'session_update', session: this.publicView(s) });
    }
    this.emit('change', s, { event: stateChanged ? 'state_change' : 'session_update', from: prevState });
    return s;
  }

  /** 会话结束 */
  end(sessionId, reason = 'session_end') {
    const s = this.sessions.get(sessionId);
    if (!s || s.state === STATES.ENDED) return;
    this.update(sessionId, { state: STATES.ENDED, endedAt: Date.now() }, { stateChangedBy: reason });
  }

  /** 记录一次工具调用（更新最后工具 + 标题兜底） */
  noteTool(sessionId, { toolName, toolInput, provider } = {}) {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    const patch = { lastTool: toolName, state: STATES.RUNNING };
    if (toolInput && !s.title && typeof toolInput === 'object') {
      const cmd = toolInput.command || toolInput.description || toolInput.prompt || toolInput.file_path;
      if (typeof cmd === 'string' && cmd.trim()) patch.title = cmd.trim().slice(0, 120);
    }
    this.update(sessionId, patch);
  }

  /** 会话列表（按最近更新排序） */
  list() {
    return [...this.sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** 按项目分组（供前端快照用） */
  groupByProject() {
    const groups = new Map();
    for (const s of this.list()) {
      const key = s.project || s.cwd || '未知项目';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(this.publicView(s));
    }
    return [...groups.entries()].map(([project, sessions]) => ({ project, sessions }));
  }

  /** 对外快照（前端渲染用） */
  snapshot() {
    return {
      groups: this.groupByProject(),
      counts: this.counts(),
      connectedAt: this.connectedAt || null,
    };
  }

  counts() {
    const c = {};
    for (const st of Object.values(STATES)) c[st] = 0;
    for (const s of this.sessions.values()) c[s.state] = (c[s.state] || 0) + 1;
    return c;
  }

  publicView(s) {
    return {
      id: s.id,
      provider: s.provider,
      title: s.title,
      project: s.project,
      cwd: s.cwd,
      mode: s.mode,
      state: s.state,
      todo: s.todo,
      lastMessage: s.lastMessage,
      lastTool: s.lastTool,
      usage: s.usage,
      subagents: s.subagents,
      startedAt: s.startedAt,
      updatedAt: s.updatedAt,
      endedAt: s.endedAt,
    };
  }

  _pushEvent(e) {
    this.events.push({ ...e, ts: Date.now() });
    if (this.events.length > this.eventsMax) this.events.splice(0, this.events.length - this.eventsMax);
  }

  recentEvents(n = 50) {
    return this.events.slice(-n);
  }

  /**
   * 陈旧会话清扫：超过 staleMs 无任何更新 → ended（防幽灵会话）。
   *
   * 边界规则：
   * - waiting_input / awaiting_approval 是"等用户"状态，可长期挂着，但 agent 进程
   *   可能已退出且没有 SessionEnd hook（ZCode 白名单无此事件）→ 给一个长上限
   *   （staleWaitMs，默认 12h），超过即结束，避免审批卡住的幽灵会话永久挂着
   * - background_task 可以长时间不更新（后台定时任务）→ 给中间上限（staleBgMs，
   *   默认 4h）
   * - 其余状态（running/idle/compacting/error…）默认 30 分钟无更新 → ended
   */
  staleSweep(staleMs = 30 * 60 * 1000, staleWaitMs = 12 * 3600 * 1000, staleBgMs = 4 * 3600 * 1000) {
    const now = Date.now();
    for (const s of this.sessions.values()) {
      if (s.state === STATES.ENDED) continue;
      const idleSince = now - s.updatedAt;
      let limit = staleMs;
      if (s.state === STATES.AWAITING_APPROVAL || s.state === STATES.WAITING_INPUT) limit = staleWaitMs;
      else if (s.state === STATES.BACKGROUND_TASK) limit = staleBgMs;
      if (idleSince > limit) {
        this.update(s.id, { state: STATES.ENDED, endedAt: now }, { stateChangedBy: 'stale_sweep' });
      }
    }
  }
}

export const hub = new Hub();
