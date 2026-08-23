/**
 * WebSocket 客户端：连接 /ws，维护快照 + 状态变化事件
 * 供页面模块使用：import { connect, getSnapshot, onEvent } from '/lib/ws-client.js'
 */

let ws = null;
let snapshot = { groups: [], counts: {} };
let connected = false;
const listeners = new Set();
const stateListeners = new Set();

function notify(msg) {
  for (const fn of listeners) fn(msg);
}

export function connect() {
  if (ws) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);

  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'snapshot') {
      snapshot = msg.data;
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
  };

  ws.onclose = () => {
    connected = false;
    notify({ type: 'disconnected' });
    // 自动重连
    setTimeout(connect, 3000);
  };
  ws.onopen = () => {
    connected = true;
    notify({ type: 'connected' });
  };
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
        ng.sessions.unshift(session);
      } else {
        g.sessions[idx] = session;
      }
      found = true;
      break;
    }
  }
  if (!found) {
    // 新会话：按 project 归组
    let g = groups.find((x) => x.project === project);
    if (!g) {
      g = { project, sessions: [] };
      groups.push(g);
    }
    g.sessions.unshift(session);
  }
  snapshot = { ...snapshot, groups };
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
