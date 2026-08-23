import { WebSocketServer } from 'ws';
import { hub } from './hub.js';

export function setupWs(server) {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws) => {
    // 连接即推全量快照
    ws.send(JSON.stringify({ type: 'snapshot', data: hub.snapshot() }));
    // 补发最近事件（前端重连后能恢复状态）
    ws.send(JSON.stringify({ type: 'events', data: hub.recentEvents(50) }));
  });

  // hub 变化 → 广播
  hub.on('change', (session, meta) => {
    const msg = JSON.stringify({
      type: meta.event === 'state_change' ? 'state_change' : 'session_update',
      session: hub.publicView(session),
      from: meta.from,
    });
    for (const client of wss.clients) {
      if (client.readyState === 1) client.send(msg);
    }
  });

  wss.on('error', (err) => console.error('[ws] error:', err.message));
  return wss;
}
