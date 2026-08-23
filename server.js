import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './src/config.js';
import { hub } from './src/hub.js';
import { setupWs } from './src/ws.js';
import ingestRouter, { applyEvent, projectFromCwd } from './src/hooks/ingest.js';
import { EVENTS, listAdapters } from './src/adapters/index.js';
import { watchSessionFile } from './src/tailer.js';
import { scanAndRestore } from './src/scanner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const server = http.createServer(app);

app.use(express.json({ limit: '2mb' }));

// hook 接收入口
app.use('/api', ingestRouter);

// 简单 REST（前端快照 / 状态）
app.get('/api/state', (_req, res) => res.json(hub.snapshot()));
app.get('/api/health', (_req, res) => res.json({ ok: true, uptime: process.uptime() }));

// 静态前端
app.use(express.static(path.join(__dirname, 'web')));

// WS
setupWs(server);

// 会话文件监听：只在新会话创建时启动 tailer（避免 update 触发的循环）
// 用 WeakSet 记录已启动 tailer 的会话
const tailerStarted = new WeakSet();
hub.on('change', (session, meta) => {
  if (meta?.event === 'session_new') {
    if (session.provider && (session.cwd || session.provider === 'zcode') && !tailerStarted.has(session)) {
      tailerStarted.add(session);
      watchSessionFile(session.id, session.provider, session.cwd);
    }
  }
});

server.listen(config.port, config.host, () => {
  console.log(`[agent-watch] listening on http://${config.host}:${config.port}`);
  console.log(`[agent-watch] hook 入口: POST ${config.hookBaseUrl}/api/hooks/:provider`);
  console.log(`[agent-watch] 已注册适配器: ${listAdapters().join(', ')}`);
  // 启动时扫描回显活跃会话（服务重启 / 启动前就在跑的会话）
  scanAndRestore();
  // 陈旧会话清扫（30 分钟无更新的 running/idle → ended）
  setInterval(() => hub.staleSweep(), 5 * 60 * 1000);
});
