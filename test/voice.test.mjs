import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSpeakText, rateToEdge, getAnnounceMode, setAnnounceMode, isVoiceEnabled, setVoiceEnabled, getVoiceSettings } from '../web/lib/sound.js';
import { dateToString, generateSecMsGec } from '../src/edge-tts.js';

test('buildSpeakText：title + 状态短语拼接', () => {
  assert.equal(buildSpeakText('登录页修复', 'waiting_input'), '「登录页修复」正在等待你的输入');
});

test('buildSpeakText：空 title 只播短语；无短语状态不播', () => {
  assert.equal(buildSpeakText('', 'idle'), '处理完毕');
  assert.equal(buildSpeakText('x', 'running'), '');
  assert.equal(buildSpeakText('x', 'unknown_state'), '');
});

test('buildSpeakText：清洗控制字符/空白并截断超长 title', () => {
  assert.equal(buildSpeakText('a\tb\nc\u0007', 'error'), '「a b c」出错了');
  const long = buildSpeakText('x'.repeat(60), 'idle');
  assert.ok(long.length < 60, '超长 title 应被截断');
  assert.equal(long, `「${'x'.repeat(40)}」处理完毕`);
});

test('rateToEdge：语速转 edge prosody rate', () => {
  assert.equal(rateToEdge(1), '+0%');
  assert.equal(rateToEdge(1.2), '+20%');
  assert.equal(rateToEdge(0.75), '-25%');
});

test('dateToString：JS 风格 UTC 时间串（服务端要求格式）', () => {
  assert.equal(
    dateToString(new Date('2026-08-25T16:29:00Z')),
    'Tue Aug 25 2026 16:29:00 GMT+0000 (Coordinated Universal Time)',
  );
});

test('generateSecMsGec：同一 5 分钟窗内稳定，64 位大写 hex', () => {
  const windowStart = 1755999900000; // 秒值 % 300 === 0 的窗起点
  const a = generateSecMsGec(windowStart);
  const b = generateSecMsGec(windowStart + 299999);
  assert.match(a, /^[0-9A-F]{64}$/);
  assert.equal(a, b);
});

test('播报模式：默认提醒音，切换持久化，非法值回落默认', () => {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, String(v)),
  };
  assert.equal(getAnnounceMode(), 'sound');
  setAnnounceMode('voice');
  assert.equal(getAnnounceMode(), 'voice');
  assert.equal(store.get('agent-watch-announce-mode'), 'voice');
  setAnnounceMode('bogus');
  assert.equal(getAnnounceMode(), 'sound');
  assert.equal(store.get('agent-watch-announce-mode'), 'sound');
});

test('语音播报每状态开关：默认与提醒音一致，setVoiceEnabled 持久化', () => {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, String(v)),
  };
  // 默认值与提醒音一致（关键状态开，background_task/compacting/ended 关）
  const defaults = getVoiceSettings().enabled;
  assert.equal(defaults.awaiting_approval, true);
  assert.equal(defaults.waiting_input, true);
  assert.equal(defaults.idle, true);
  assert.equal(defaults.error, true);
  assert.equal(defaults.background_task, false);
  assert.equal(defaults.compacting, false);
  assert.equal(defaults.ended, false);
  assert.equal(isVoiceEnabled('idle'), true);
  assert.equal(isVoiceEnabled('compacting'), false);
  // 切换某个状态：内存与 localStorage 同步，其余状态不受影响
  setVoiceEnabled('compacting', true);
  assert.equal(isVoiceEnabled('compacting'), true);
  assert.equal(isVoiceEnabled('idle'), true);
  assert.equal(isVoiceEnabled('background_task'), false);
  const saved = JSON.parse(store.get('agent-watch-voice'));
  assert.equal(saved.enabled.compacting, true);
  assert.equal(saved.enabled.idle, true, '未改动的状态保持默认值');
  // 关闭后回落 false
  setVoiceEnabled('idle', false);
  assert.equal(isVoiceEnabled('idle'), false);
  assert.equal(isVoiceEnabled('ws_connected'), true, '默认开的状态不受其他开关影响');
});

test('语音播报每状态开关：agent-watch-voice 里未存 enabled 时回落默认', () => {
  const store = new Map([['agent-watch-voice', JSON.stringify({ voice: 'zh-CN-YunxiNeural', rate: 1.2 })]]);
  globalThis.localStorage = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, String(v)),
  };
  const s = getVoiceSettings();
  assert.equal(s.voice, 'zh-CN-YunxiNeural');
  assert.equal(s.rate, 1.2);
  assert.equal(s.enabled.idle, true);
  assert.equal(s.enabled.background_task, false);
});

test('setVoiceEnabled 非法值归一为布尔', () => {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, String(v)),
  };
  setVoiceEnabled('error', 'off');
  assert.equal(isVoiceEnabled('error'), true, "字符串 'off' 应归一为 true");
  setVoiceEnabled('error', 0);
  assert.equal(isVoiceEnabled('error'), false, '数值 0 应归一为 false');
});