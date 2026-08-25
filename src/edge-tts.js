/**
 * edge-tts 协议直连实现（微软 Edge 免费神经语音，零依赖、无 API key）
 *
 * 协议参考 rany2/edge-tts（MIT）：连 speech.platform.bing.com 的 WebSocket，
 * 发 speech.config + ssml 两条消息，收二进制音频帧拼成 mp3。
 * Sec-MS-GEC = Windows file time（1601 纪元、按 5 分钟取整、100ns 间隔）
 *             与 TrustedClientToken 拼接后 SHA256 的大写 hex。
 *
 * 注意：这是微软浏览器内部接口，不保证长期稳定；任何失败由调用方降级处理。
 */
import crypto from 'node:crypto';
import { WebSocket } from 'ws';

const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const GEC_VERSION = '1-143.0.3650.75'; // 需与 User-Agent 的 Chromium 版本段一致
const WSS_URL =
  'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1' +
  `?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}`;
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0';
const OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 服务端要求 JS 风格时间串：Tue Aug 25 2026 16:29:00 GMT+0000 (Coordinated Universal Time) */
export function dateToString(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${WEEKDAYS[d.getUTCDay()]} ${MONTHS[d.getUTCMonth()]} ${p(d.getUTCDate())} ` +
    `${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} ` +
    'GMT+0000 (Coordinated Universal Time)'
  );
}

/** 生成 Sec-MS-GEC：Windows file time 按 5 分钟向下取整 + token 的 SHA256 大写 */
export function generateSecMsGec(now = Date.now()) {
  const ticks = BigInt(Math.floor(now / 1000)) + 11644473600n; // 转 1601 纪元
  const rounded = ticks - (ticks % 300n); // 5 分钟取整
  const str = `${rounded * 10000000n}${TRUSTED_CLIENT_TOKEN}`; // 100ns 间隔
  return crypto.createHash('sha256').update(str, 'ascii').digest('hex').toUpperCase();
}

function escapeXml(s) {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

/** 合成 mp3；成功 resolve Buffer，任何失败 reject（无网络/超时/协议失效） */
export function synthesizeEdgeTts(text, { voice = 'zh-CN-XiaoxiaoNeural', rate = '+0%' } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(arg);
    };

    const timer = setTimeout(() => {
      ws.terminate();
      finish(reject, new Error('edge-tts: timeout'));
    }, 20000);

    const url =
      `${WSS_URL}&ConnectionId=${crypto.randomUUID()}` +
      `&Sec-MS-GEC=${generateSecMsGec()}&Sec-MS-GEC-Version=${GEC_VERSION}`;
    const ws = new WebSocket(url, {
      headers: {
        'User-Agent': USER_AGENT,
        Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
        Pragma: 'no-cache',
        'Cache-Control': 'no-cache',
      },
    });

    ws.on('open', () => {
      const configMsg =
        `X-Timestamp:${dateToString()}\r\n` +
        'Content-Type:application/json; charset=utf-8\r\n' +
        'Path:speech.config\r\n\r\n' +
        `{"context":{"synthesis":{"audio":{"metadataoptions":` +
        `{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},` +
        `"outputFormat":"${OUTPUT_FORMAT}"}}}}\r\n`;
      ws.send(configMsg);

      const ssml =
        `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='zh-CN'>` +
        `<voice name='${voice}'><prosody pitch='+0Hz' rate='${rate}' volume='+0%'>` +
        `${escapeXml(text)}</prosody></voice></speak>`;
      // ssml 的 X-Timestamp 带 Z 后缀（服务端 bug，需原样保留，见 edge-tts 源码注释）
      const ssmlMsg =
        `X-RequestId:${crypto.randomUUID()}\r\n` +
        'Content-Type:application/ssml+xml\r\n' +
        `X-Timestamp:${dateToString()}Z\r\nPath:ssml\r\n\r\n${ssml}`;
      ws.send(ssmlMsg);
    });

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
        if (buf.length < 2) return;
        const headerLen = buf.readUInt16BE(0);
        if (2 + headerLen > buf.length) return;
        if (buf.subarray(2, 2 + headerLen).includes(Buffer.from('Path:audio'))) {
          chunks.push(buf.subarray(2 + headerLen));
        }
        return;
      }
      if (data.toString().includes('Path:turn.end')) {
        ws.close();
        finish(resolve, Buffer.concat(chunks));
      }
    });

    ws.on('error', (err) => finish(reject, err));
    ws.on('close', () => {
      if (chunks.length) finish(resolve, Buffer.concat(chunks));
      else finish(reject, new Error('edge-tts: closed before audio'));
    });
  });
}