import { WebSocketServer } from 'ws';
import { hub } from './hub.js';

export function setupWs(server) {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws) => {
    // 连接即推全量快照
    ws.send(JSON.stringify({ type: 'snapshot', data: hub.snapshot() }));
    // 补发最近事件（前端重连后能恢复状态）
    ws.send(JSON.stringify({ type: 'events', data: hub.recentEvents(50) }));

    // 应用层心跳：响应前端 ping，用作连接假死探测
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg && msg.type === 'ping') {
          ws.send(JSON.stringify({ type: 'pong' }));
        }
      } catch {}
    });
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
