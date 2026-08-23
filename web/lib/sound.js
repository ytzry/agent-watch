/**
 * 声音播报：Web Audio API 合成提示音（零音频资源）
 * 提供 6 种内置音 + 音量控制 + 试听
 *
 * 播报配置存 localStorage（每状态：{ enabled, sound, volume }）
 * 默认：waiting_input/awaiting_approval → alert，idle → success，error → error，其余关
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
];

const DEFAULT_SETTINGS = {
  awaiting_approval: { enabled: true, sound: 'alert' },
  waiting_input: { enabled: true, sound: 'alert' },
  idle: { enabled: true, sound: 'success' },
  background_task: { enabled: false, sound: 'beep' },
  compacting: { enabled: false, sound: 'beep' },
  error: { enabled: true, sound: 'error' },
  ended: { enabled: false, sound: 'ding' },
};

const MASTER_VOLUME_KEY = 'agent-watch-master-volume';

let ctx = null;

// 总音量：从 localStorage 读取（默认 0.7），setMasterVolume 持久化
let masterVolume = Number(localStorage?.getItem(MASTER_VOLUME_KEY) || 0.7) || 0.7;

function getCtx() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  return ctx;
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
  const t = getCtx().currentTime;
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
