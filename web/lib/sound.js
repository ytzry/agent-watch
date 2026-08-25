/**
 * 声音播报：Web Audio API 合成提示音（零音频资源）
 * 提供 6 种内置音 + 音量控制 + 试听
 *
 * 播报配置存 localStorage（每状态：{ enabled, sound, volume }）
 * 默认：waiting_input/awaiting_approval → alert，idle → success，error → error，
 *       ws_disconnected → error，ws_connected → success，其余关
 */

export const SOUNDS = {
  beep: { label: '哔哔', desc: '短促单音' },
  ding: { label: '叮', desc: '清脆一声' },
  chime: { label: '风铃', desc: '双音上扬' },
  alert: { label: '提醒', desc: '三连急促' },
  success: { label: '成功', desc: '上行双音' },
  error: { label: '错误', desc: '下行双音' },
};

export const STATUS_KEYS = [
  'awaiting_approval',
  'waiting_input',
  'idle',
  'background_task',
  'compacting',
  'error',
  'ended',
  'ws_disconnected',
  'ws_connected',
];

const DEFAULT_SETTINGS = {
  awaiting_approval: { enabled: true, sound: 'alert' },
  waiting_input: { enabled: true, sound: 'alert' },
  idle: { enabled: true, sound: 'success' },
  background_task: { enabled: false, sound: 'beep' },
  compacting: { enabled: false, sound: 'beep' },
  error: { enabled: true, sound: 'error' },
  ended: { enabled: false, sound: 'ding' },
  ws_disconnected: { enabled: true, sound: 'error' },
  ws_connected: { enabled: true, sound: 'success' },
};

const MASTER_VOLUME_KEY = 'agent-watch-master-volume';

let ctx = null;

// 总音量：从 localStorage 读取（默认 0.7），setMasterVolume 持久化
let masterVolume = Number(typeof localStorage !== 'undefined' ? localStorage.getItem(MASTER_VOLUME_KEY) : null) || 0.7;

function getCtx() {
  if (!ctx) {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    // 自动播放策略：无用户手势时 AudioContext 初始为 suspended，osc.start() 只排队不发声。
    // 这里尽力 resume（若浏览器放行则成功；否则等首次用户手势由 unlockAudio 再试）
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  }
  return ctx;
}

/** 解锁音频：浏览器要求用户手势后才能发声，首次交互时 resume 挂起的上下文 */
function unlockAudio() {
  try {
    const c = getCtx();
    if (c.state === 'suspended') c.resume().catch(() => {});
  } catch {}
}

// 首次用户交互（点击/触摸/按键）时解锁；之后移除监听，避免常驻开销
if (typeof window !== 'undefined') {
  const unlock = () => {
    unlockAudio();
    window.removeEventListener('pointerdown', unlock);
    window.removeEventListener('touchstart', unlock);
    window.removeEventListener('keydown', unlock);
  };
  window.addEventListener('pointerdown', unlock);
  window.addEventListener('touchstart', unlock);
  window.addEventListener('keydown', unlock);
}

function tone(freq, start, dur, type = 'sine', gain = 0.5) {
  const c = getCtx();
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  g.gain.setValueAtTime(0, start);
  g.gain.linearRampToValueAtTime(gain, start + 0.01);
  g.gain.exponentialRampToValueAtTime(0.001, start + dur);
  osc.connect(g).connect(c.destination);
  osc.start(start);
  osc.stop(start + dur + 0.05);
}

/** 播放指定音效（带音量） */
export function playSound(name, volume) {
  const v = volume ?? masterVolume;
  const c = getCtx();
  // 播放前再尝试一次 resume：某些浏览器挂起后不自动恢复，播放时唤醒最可靠
  if (c.state === 'suspended') c.resume().catch(() => {});
  const t = c.currentTime;
  try {
    switch (name) {
      case 'beep':
        tone(880, t, 0.15, 'square', v * 0.4);
        break;
      case 'ding':
        tone(1046.5, t, 0.4, 'sine', v * 0.6);
        break;
      case 'chime':
        tone(880, t, 0.5, 'sine', v * 0.5);
        tone(1318.5, t + 0.08, 0.5, 'sine', v * 0.5);
        break;
      case 'alert':
        tone(740, t, 0.12, 'square', v * 0.4);
        tone(740, t + 0.18, 0.12, 'square', v * 0.4);
        tone(740, t + 0.36, 0.18, 'square', v * 0.4);
        break;
      case 'success':
        tone(523.25, t, 0.2, 'sine', v * 0.6);
        tone(783.99, t + 0.15, 0.35, 'sine', v * 0.6);
        break;
      case 'error':
        tone(392, t, 0.3, 'sawtooth', v * 0.4);
        tone(311.13, t + 0.2, 0.4, 'sawtooth', v * 0.4);
        break;
      default:
        tone(880, t, 0.15, 'square', v * 0.4);
    }
  } catch {
    // 音频不可用（如静音策略）→ 忽略
  }
}

function loadSettings() {
  try {
    const raw = localStorage.getItem('agent-watch-sounds');
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw);
    const merged = { ...DEFAULT_SETTINGS };
    for (const k of STATUS_KEYS) {
      if (parsed[k]) merged[k] = { ...DEFAULT_SETTINGS[k], ...parsed[k] };
    }
    return merged;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function saveSettings(settings) {
  localStorage.setItem('agent-watch-sounds', JSON.stringify(settings));
}

export function getSettings() {
  return loadSettings();
}

export function setSetting(stateKey, patch) {
  const s = loadSettings();
  s[stateKey] = { ...s[stateKey], ...patch };
  saveSettings(s);
  return s;
}

export function setMasterVolume(v) {
  masterVolume = v;
  try {
    localStorage.setItem(MASTER_VOLUME_KEY, String(v));
  } catch {}
}

export function getMasterVolume() {
  return masterVolume;
}

/** 根据状态播报（若该状态开启）；音量统一用总音量 */
export function notifyState(state, settings) {
  const cfg = (settings || loadSettings())[state];
  if (!cfg?.enabled) return;
  playSound(cfg.sound, masterVolume);
}

/* =========================================================================
 * 播报方式：sound（纯提醒音）| voice（语音播报 title+状态），互斥切换。
 * 设置页按模式只展示对应区块；运行时按模式分派播报。
 * ========================================================================= */

const ANNOUNCE_MODE_KEY = 'agent-watch-announce-mode';

export function getAnnounceMode() {
  try {
    return localStorage.getItem(ANNOUNCE_MODE_KEY) === 'voice' ? 'voice' : 'sound';
  } catch {
    return 'sound';
  }
}

export function setAnnounceMode(mode) {
  try {
    localStorage.setItem(ANNOUNCE_MODE_KEY, mode === 'voice' ? 'voice' : 'sound');
  } catch {}
}

/** 状态变更统一播报入口：sound → 提醒音；voice → 语音播报 title + 状态 */
export function announceStateChange(state, title, sessionId) {
  if (getAnnounceMode() === 'voice') {
    speakStatus(title, state, sessionId);
  } else {
    notifyState(state);
  }
}

/* =========================================================================
 * 语音播报：title + 状态短语。在线走后端 /api/tts（edge-tts），
 * 失败/无网络降级浏览器 speechSynthesis。设置存 localStorage。
 * ========================================================================= */

const VOICE_SETTINGS_KEY = 'agent-watch-voice';

/** 在线语音（edge-tts）白名单，与后端 /api/tts 一致 */
export const EDGE_VOICES = [
  { id: 'zh-CN-XiaoxiaoNeural', label: '晓晓（女）' },
  { id: 'zh-CN-YunxiNeural', label: '云希（男）' },
  { id: 'zh-CN-YunjianNeural', label: '云健（男）' },
  { id: 'zh-CN-XiaoyiNeural', label: '晓伊（女）' },
];
const EDGE_VOICE_IDS = new Set(EDGE_VOICES.map((v) => v.id));

const DEFAULT_VOICE_SETTINGS = {
  voice: 'zh-CN-XiaoxiaoNeural', // edge 语音名，或系统语音名（engine 随所选语音自动判定）
  rate: 1, // 0.5 ~ 2
};

/** 状态 → 播报短语（与 STATUS_KEYS 对应，未知状态不播） */
const STATUS_PHRASES = {
  awaiting_approval: '等待你批准',
  waiting_input: '正在等待你的输入',
  idle: '处理完毕',
  background_task: '后台任务进行中',
  compacting: '正在压缩上下文',
  error: '出错了',
  ended: '会话已结束',
  ws_disconnected: '连接已断开',
  ws_connected: '连接已恢复',
};

function loadVoiceSettings() {
  try {
    const raw = localStorage.getItem(VOICE_SETTINGS_KEY);
    return raw ? { ...DEFAULT_VOICE_SETTINGS, ...JSON.parse(raw) } : { ...DEFAULT_VOICE_SETTINGS };
  } catch {
    return { ...DEFAULT_VOICE_SETTINGS };
  }
}

function saveVoiceSettings(s) {
  localStorage.setItem(VOICE_SETTINGS_KEY, JSON.stringify(s));
}

export function getVoiceSettings() {
  return loadVoiceSettings();
}

export function setVoiceSetting(patch) {
  const s = { ...loadVoiceSettings(), ...patch };
  saveVoiceSettings(s);
  return s;
}

/** 拼接播报文本：清洗 title（空白压缩/控制字符/截断）后接状态短语 */
export function buildSpeakText(title, state) {
  const phrase = STATUS_PHRASES[state];
  if (!phrase) return '';
  const t = String(title || '')
    .replace(/\s+/g, ' ') // 先压缩空白（\t\n 变空格，避免字粘连）
    .replace(/[\u0000-\u001f\u007f]/g, '') // 再删残留控制字符
    .trim()
    .slice(0, 40);
  return t ? `「${t}」${phrase}` : phrase;
}

// 防抖去重：同一会话同一状态 15s 内只播一次，避免连珠炮
const lastSpoken = new Map();
const SPEAK_DEBOUNCE_MS = 15000;

/** 播报 title + 状态（受防抖控制；语音模式即播报，无独立开关） */
export function speakStatus(title, state, sessionId) {
  const text = buildSpeakText(title, state);
  if (!text) return;
  const key = `${sessionId || 'sys'}|${state}`;
  const now = Date.now();
  if (now - (lastSpoken.get(key) || 0) < SPEAK_DEBOUNCE_MS) return;
  lastSpoken.set(key, now);
  if (lastSpoken.size > 200) lastSpoken.clear();
  speakText(text);
}

let currentAudio = null; // 正在播的在线 mp3，新播报顶掉旧播报

/** 播放文本：所选语音是在线 → edge-tts（失败降级本地）；是系统语音 → speechSynthesis */
export async function speakText(text) {
  const cfg = loadVoiceSettings();
  if (EDGE_VOICE_IDS.has(cfg.voice)) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      const res = await fetch(
        `/api/tts?text=${encodeURIComponent(text)}&voice=${encodeURIComponent(cfg.voice)}` +
          `&rate=${encodeURIComponent(rateToEdge(cfg.rate))}`,
        { signal: controller.signal },
      );
      clearTimeout(timer);
      if (res.ok) {
        playBlobAudio(await res.blob());
        return;
      }
    } catch {
      // 无网络 / 服务失败 → 降级本地语音
    }
  }
  speakLocal(text);
}

/** 语速 0.5~2 → edge prosody rate（1 → +0%，1.2 → +20%，0.8 → -20%） */
export function rateToEdge(rate) {
  const delta = Math.round((rate - 1) * 100);
  return `${delta >= 0 ? '+' : ''}${delta}%`;
}

function playBlobAudio(blob) {
  try {
    const url = URL.createObjectURL(blob);
    if (currentAudio) {
      currentAudio.pause();
      URL.revokeObjectURL(currentAudio.dataset.url);
    }
    const audio = new Audio(url);
    audio.dataset.url = url;
    audio.volume = Math.max(0, Math.min(1, masterVolume));
    audio.onended = () => URL.revokeObjectURL(url);
    currentAudio = audio;
    audio.play().catch(() => {});
  } catch {
    // 音频不可用（如自动播放策略）→ 忽略
  }
}

function speakLocal(text) {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
  try {
    speechSynthesis.cancel(); // 顶掉旧播报
    const u = new SpeechSynthesisUtterance(text);
    const cfg = loadVoiceSettings();
    u.rate = cfg.rate;
    u.volume = Math.max(0.05, Math.min(1, masterVolume));
    // 语音：设置里选了系统语音则用它；否则自动挑第一个中文语音
    const voices = speechSynthesis.getVoices();
    u.voice =
      voices.find((v) => v.name === cfg.voice) ||
      voices.find((v) => v.lang.toLowerCase().startsWith('zh')) ||
      null;
    speechSynthesis.speak(u);
  } catch {}
}

/** 系统中文语音列表（含 voiceschanged 等待，返回后回调） */
export function getZhSystemVoices(cb) {
  const pick = () => {
    const voices = speechSynthesis.getVoices().filter((v) => v.lang.toLowerCase().startsWith('zh'));
    cb(voices.map((v) => ({ id: v.name, label: `${v.name}（本地）` })));
  };
  if (!('speechSynthesis' in window)) return cb([]);
  const voices = speechSynthesis.getVoices();
  if (voices.length) return pick();
  speechSynthesis.onvoiceschanged = () => {
    speechSynthesis.onvoiceschanged = null;
    pick();
  };
  // 某些环境不触发 voiceschanged，兜底空列表
  setTimeout(() => {
    if (speechSynthesis.onvoiceschanged) {
      speechSynthesis.onvoiceschanged = null;
      pick();
    }
  }, 1500);
}

/** 试听：按当前设置的语音播一段示例（不受 enabled 开关约束） */
export function previewVoice() {
  speakText('这是语音播报测试，大小写字母，一二三');
}
