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
        waitingForInput: false, // AskUserQuestion 提问后置 true（文件信号不得覆盖该等待）
        todo: [],
        lastMessage: '',
        lastTool: null,
        lastEventAt: Date.now(),
        startedAt: Date.now(),
        updatedAt: Date.now(),
        // 最近一次"对话活动"时间（hook 对话事件刷新；usage/tailer 轮询不刷新）。
        // 排序用它而非 updatedAt——否则正在跑的会话被 tailer 每 2 秒刷 updatedAt，
        // 永远霸占组首，刚对话完的项目反而排不上去。
        lastActivityAt: Date.now(),
        endedAt: null,
        model: '', // 会话在用的模型名（从会话文件/rollout 解析）
        subagentRunning: 0, // 正在运行的子代理数
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

  /** 更新会话字段，若状态变化则广播 event（前端据此播放声音）
   * @param {object} [opts.stateChangedBy] 状态变化原因（广播用）
   * @param {boolean} [opts.activity] 是否算"对话活动"（刷新 lastActivityAt；tailer 轮询不传）
   */
  update(sessionId, patch, { stateChangedBy, activity } = {}) {
    const s = this.sessions.get(sessionId);
    if (!s) return null;
    const prevState = s.state;
    Object.assign(s, patch, { updatedAt: Date.now() });
    if (activity) s.lastActivityAt = Date.now();
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
    this.update(sessionId, { state: STATES.ENDED, endedAt: Date.now() }, { stateChangedBy: reason, activity: true });
  }

  /**
   * 根据文件解析出的"回复状态"归一化为会话状态。
   * 只把 running / waiting_input（且非 AskUserQuestion 真等待）收敛为 idle；
   * 询问/审批/错误/后台任务等主动状态一律不覆盖（它们是 hook 事件的权威结论）。
   * 真等待（waitingForInput=true，AskUserQuestion 提问后）不会被文件信号覆盖——
   * 文件无法表达"模型在等用户"，只有 hook 的 ask_user 事件能标这个状态。
   *
   * @param {object} [opts.at] 该回复结论对应记录的落盘时间（adapter 从记录时间戳解析）。
   *   陈旧守卫：记录早于最近一次对话活动（如刚提交的新 prompt）→ 它描述的是上一轮，
   *   不能覆盖 hook 刚下的结论——否则新提问会被上一轮遗留的 done 立刻打成 idle（已完成），
   *   且后续 running 又刻意不打断 idle，整轮都会卡在"已完成"。
   */
  applyReplyState(sessionId, replyState, { at } = {}) {
    if (!replyState) return;
    const s = this.sessions.get(sessionId);
    if (!s || s.state === STATES.ENDED) return;
    if (at && s.lastActivityAt > at) return;
    if (replyState === 'done') {
      // 回复完成：created/running → idle；兜底等待（非 ask）→ idle；真等待/审批/错误等保持
      if (s.state === STATES.CREATED || s.state === STATES.RUNNING ||
          (s.state === STATES.WAITING_INPUT && !s.waitingForInput)) {
        // 回复完成算一次"对话活动"（模型刚答完，会话确实有动作），刷新 lastActivityAt——
        // 否则 idle 由文件收敛（不带 activity），lastActivityAt 停在更早的 hook 事件，
        // "刚完成回复"的项目反而排不上去
        this.update(sessionId, { state: STATES.IDLE }, { stateChangedBy: 'reply_done', activity: true });
      }
      return;
    }
    // 'running'：文件显示有工具调用待执行 → 会话在干活。
    // 仅提升 created（初始态）与兜底等待；不打断 idle（AI 已完成回复后文件可能短暂显示旧状态），
    // 也不覆盖 AskUserQuestion 真等待
    if (s.state === STATES.CREATED || (s.state === STATES.WAITING_INPUT && !s.waitingForInput)) {
      this.update(sessionId, { state: STATES.RUNNING }, { stateChangedBy: 'reply_running' });
    }
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

  /** 会话列表（按最近活动排序；无 lastActivityAt 的旧数据回退 updatedAt） */
  list() {
    return [...this.sessions.values()].sort((a, b) => this._activityTime(b) - this._activityTime(a));
  }

  _activityTime(s) {
    return s.lastActivityAt || s.updatedAt || 0;
  }

  /** 按项目分组（供前端快照用）
   * 组内会话按最近活动降序；组按「组内最近一次活动」（最大 lastActivityAt）降序 ——
   * 有动作的项目自动排前面。activityAt 供前端增量重排时复用（与 ws-client 排序口径一致）。
   */
  groupByProject() {
    const groups = new Map();
    for (const s of this.list()) {
      const key = s.project || s.cwd || '未知项目';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(this.publicView(s));
    }
    return [...groups.entries()]
      .map(([project, sessions]) => ({
        project,
        sessions,
        activityAt: sessions.reduce((m, s) => Math.max(m, this._activityTime(s)), 0),
      }))
      .sort((a, b) => b.activityAt - a.activityAt);
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
      model: s.model,
      usage: s.usage,
      subagentRunning: s.subagentRunning,
      subagents: s.subagents,
      startedAt: s.startedAt,
      updatedAt: s.updatedAt,
      lastActivityAt: s.lastActivityAt || s.updatedAt,
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
}

export const hub = new Hub();
