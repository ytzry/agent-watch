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
import { startZcodeTurnPoller } from './src/zcode-turns.js';
import { synthesizeEdgeTts } from './src/edge-tts.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const server = http.createServer(app);

app.use(express.json({ limit: '2mb' }));

// hook 接收入口
app.use('/api', ingestRouter);

// 简单 REST（前端快照 / 状态）
app.get('/api/state', (_req, res) => res.json(hub.snapshot()));
app.get('/api/health', (_req, res) => res.json({ ok: true, uptime: process.uptime() }));

// ── 语音播报合成：edge-tts（微软免费神经语音）。
// 失败/无网络 → 503 + fallback 标记，前端自动降级到浏览器 speechSynthesis。
// 短文本合成一次约几百 ms，同文本 5 分钟内命中内存缓存。
const ttsCache = new Map(); // `text|voice|rate` -> Buffer
const TTS_VOICES = new Set([
  'zh-CN-XiaoxiaoNeural', 'zh-CN-YunxiNeural', 'zh-CN-YunjianNeural', 'zh-CN-XiaoyiNeural',
  'en-US-EmmaMultilingualNeural', 'en-US-AvaMultilingualNeural',
]);
app.get('/api/tts', async (req, res) => {
  const text = String(req.query.text ?? '').trim().slice(0, 200);
  const voice = String(req.query.voice ?? 'zh-CN-XiaoxiaoNeural');
  const rate = String(req.query.rate ?? '+0%');
  if (!text) return res.status(400).json({ error: 'text required' });
  if (!TTS_VOICES.has(voice) || !/^[+-]\d+%$/.test(rate)) {
    return res.status(400).json({ error: 'invalid voice/rate' });
  }
  const key = `${text}|${voice}|${rate}`;
  const cached = ttsCache.get(key);
  if (cached) return res.type('audio/mpeg').set('Cache-Control', 'public, max-age=300').send(cached);
  try {
    const audio = await synthesizeEdgeTts(text, { voice, rate });
    if (ttsCache.size >= 100) ttsCache.clear();
    ttsCache.set(key, audio);
    res.type('audio/mpeg').set('Cache-Control', 'public, max-age=300').send(audio);
  } catch (err) {
    console.warn(`[edge-tts] 合成失败，前端将降级本地语音: ${err.message}`);
    res.status(503).json({ error: err.message, fallback: 'speechSynthesis' });
  }
});

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
  // ZCode 轮次状态轮询：手动中断不发 hook，靠官方 db turn_usage 的 cancelled 行收敛状态
  startZcodeTurnPoller();
  // 会话状态完全由 hook 事件驱动（Stop / SessionEnd / StopFailure），不做时间清扫
});
