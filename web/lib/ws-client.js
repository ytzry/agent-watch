/**
 * WebSocket 客户端：连接 /ws，维护快照 + 状态变化事件
 * 供页面模块使用：import { connect, getSnapshot, subscribe } from '/lib/ws-client.js'
 *
 * 连接保障：
 * - 断线自动重连：指数退避 + 抖动（1s 起，封顶 30s），连接成功后退避计数清零
 * - 应用层心跳：每 10s 发 ping（服务端回 pong），30s 未收到任何消息判定假死，主动重建
 * - 建连超时保护：10s 内未 onopen（如 TCP 被中间设备挂起）则放弃重试
 * - 页面恢复可见 / 网络恢复时立即重连，不等退避
 */

let ws = null;
let snapshot = { groups: [], counts: {} };
let connected = false;
const listeners = new Set();

const RETRY_BASE_MS = 1000;       // 首次重连延迟
const RETRY_MAX_MS = 30000;       // 重连延迟上限
const RETRY_FACTOR = 2;           // 每次失败翻倍
const PING_INTERVAL_MS = 10000;   // 心跳间隔
const STALE_MS = 30000;           // 超过此时长未收到任何消息 → 连接假死
const CONNECT_TIMEOUT_MS = 10000; // 建连超时

let retryCount = 0;
let retryTimer = null;   // 重连延迟定时器
let pingTimer = null;    // 心跳定时器
let connectTimer = null; // 建连超时定时器
let lastMessageAt = 0;   // 最近一次收到消息的时间戳

function notify(msg) {
  for (const fn of listeners) fn(msg);
}

/** 已有可用连接（含正在建立）则跳过；已关闭的旧连接不阻塞重连 */
function isOpenOrConnecting() {
  return ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING);
}

function clearTimers() {
  clearTimeout(retryTimer);
  clearTimeout(connectTimer);
  clearInterval(pingTimer);
  retryTimer = null;
  connectTimer = null;
  pingTimer = null;
}

export function connect() {
  // 已有可用连接（含正在建立）：同步补发一次当前状态，
  // 让新挂载的页面（如 o-page 返回后重建）立即拿到真实连接状态，而不是停留在初始值
  if (isOpenOrConnecting()) {
    notify({ type: connected ? 'connected' : 'disconnected' });
    return;
  }
  clearTimeout(retryTimer);
  retryTimer = null;

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  lastMessageAt = Date.now();

  // 建连超时保护：连接长时间打不开则放弃重建
  connectTimer = setTimeout(() => {
    if (ws && ws.readyState === WebSocket.CONNECTING) {
      console.warn('[ws] 连接超时，放弃并重试');
      teardownForRetry();
      scheduleReconnect();
    }
  }, CONNECT_TIMEOUT_MS);

  ws.onmessage = (e) => {
    lastMessageAt = Date.now();
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    if (msg.type === 'snapshot') {
      snapshot = msg.data;
      if (!connected) {
        // 服务端推快照即代表连接已建立：补齐 connected 状态
        // （避免连接瞬间收到的 snapshot 早于 onopen 回调导致状态缺失）
        connected = true;
        clearTimeout(connectTimer);
        retryCount = 0;
        startHeartbeat();
        notify({ type: 'connected' });
      }
      notify({ type: 'snapshot', data: msg.data });
    } else if (msg.type === 'state_change') {
      // 更新本地快照中的对应 session
      const { session } = msg;
      updateSessionInSnapshot(session);
      notify({ type: 'state_change', session, from: msg.from });
    } else if (msg.type === 'session_update') {
      updateSessionInSnapshot(msg.session);
      notify({ type: 'session_update', session: msg.session });
    } else if (msg.type === 'events') {
      notify({ type: 'events', data: msg.data });
    }
    // ping/pong 及未知消息无需处理
  };

  ws.onopen = () => {
    connected = true;
    clearTimeout(connectTimer);
    retryCount = 0; // 连接成功，重置退避
    startHeartbeat();
    notify({ type: 'connected' });
    // 建连即同步补发快照，覆盖「连接成功但 snapshot 因无后续消息未及时到达」的场景
    notify({ type: 'snapshot', data: snapshot });
  };

  ws.onerror = () => {
    // error 后必然触发 close，重连统一在 onclose 处理
  };

  ws.onclose = () => {
    connected = false;
    stopHeartbeat();
    notify({ type: 'disconnected' });
    scheduleReconnect();
  };
}

/**
 * 断开并清理旧连接，确保后续只调度一次重连。
 * 必须先把 ws 置空，否则旧 onclose 会再调一次 scheduleReconnect。
 */
function teardownForRetry() {
  clearTimeout(connectTimer);
  connectTimer = null;
  if (ws) {
    const dead = ws;
    ws = null;
    dead.onclose = null;
    try { dead.close(); } catch {}
  }
  stopHeartbeat();
}

/** 指数退避 + 抖动调度重连，避免多端同时重连打满服务端 */
function scheduleReconnect() {
  if (retryTimer) return; // 已有待执行的重连
  const delay = Math.min(RETRY_BASE_MS * Math.pow(RETRY_FACTOR, retryCount), RETRY_MAX_MS);
  retryCount++;
  const jittered = delay * (0.7 + Math.random() * 0.6); // ±30% 抖动
  retryTimer = setTimeout(() => {
    retryTimer = null;
    connect();
  }, jittered);
}

/** 应用层心跳：定期发 ping，超时未收到任何消息判定假死并重建连接 */
function startHeartbeat() {
  stopHeartbeat();
  pingTimer = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'ping' }));
    }
    if (Date.now() - lastMessageAt > STALE_MS) {
      console.warn('[ws] 心跳超时，连接假死，重建连接');
      teardownForRetry();
      scheduleReconnect();
    }
  }, PING_INTERVAL_MS);
}

function stopHeartbeat() {
  clearInterval(pingTimer);
  pingTimer = null;
}

// 页面恢复可见 / 网络恢复 → 立即重连，不等退避
window.addEventListener('online', () => {
  if (!isOpenOrConnecting()) {
    clearTimeout(retryTimer);
    retryTimer = null;
    connect();
  }
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && !isOpenOrConnecting()) {
    clearTimeout(retryTimer);
    retryTimer = null;
    connect();
  }
});

/** 由 groups 重算各状态计数（增量更新后 counts 才能跟上） */
function recount(groups) {
  const c = {};
  for (const g of groups) {
    for (const s of g.sessions) {
      c[s.state] = (c[s.state] || 0) + 1;
    }
  }
  return c;
}

/** 组排序：组内按 updatedAt 降序；组间按「组内最近活动」（最大 updatedAt）降序，
 * 与后端 groupByProject 口径一致 —— 有动作的项目自动排前面 */
function sortGroups(groups) {
  for (const g of groups) {
    g.sessions.sort((a, b) => b.updatedAt - a.updatedAt);
    g.activityAt = g.sessions.reduce((m, s) => Math.max(m, s.updatedAt), 0);
  }
  groups.sort((a, b) => b.activityAt - a.activityAt);
  return groups;
}

function updateSessionInSnapshot(session) {
  // 找到所在组并替换；找不到则创建
  // 注意：必须返回新数组引用，触发前端响应式更新
  const groups = (snapshot.groups || []).map((g) => ({
    ...g,
    sessions: [...g.sessions],
  }));
  const project = session.project || session.cwd || '未知项目';
  let found = false;
  for (const g of groups) {
    const idx = g.sessions.findIndex((s) => s.id === session.id);
    if (idx >= 0) {
      // 会话已在某组：若 project 变化（如先以空 project 归到"未知项目"，
      // 之后 cwd/title 补齐），要把会话迁移到正确组，否则永远卡在旧组
      if (g.project !== project) {
        g.sessions.splice(idx, 1);
        if (g.sessions.length === 0) groups.splice(groups.indexOf(g), 1);
        let ng = groups.find((x) => x.project === project);
        if (!ng) {
          ng = { project, sessions: [] };
          groups.push(ng);
        }
        ng.sessions.push(session); // 位置交给底部 sortGroups 统一排序
      } else {
        g.sessions[idx] = session;
      }
      found = true;
      break;
    }
  }
  if (!found) {
    // 新会话：按 project 归组（位置交给底部 sortGroups 统一排序）
    let g = groups.find((x) => x.project === project);
    if (!g) {
      g = { project, sessions: [] };
      groups.push(g);
    }
    g.sessions.push(session);
  }
  snapshot = { ...snapshot, groups: sortGroups(groups), counts: recount(groups) };
  // 触发局部刷新（页面直接读 snapshot，这里不强制重渲染，由页面 subscribe 处理）
  notify({ type: 'updated', snapshot });
}

export function getSnapshot() {
  return snapshot;
}

export function isConnected() {
  return connected;
}

/** 订阅所有消息（含 snapshot/state_change/updated） */
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
