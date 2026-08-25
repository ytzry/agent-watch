/**
 * 回复状态收敛测试
 *
 * 覆盖两条主线：
 *  1. hub.applyReplyState 的陈旧守卫——新 prompt 提交后、新记录落盘前，
 *     文件尾部仍是上一轮的 done，不得把刚进入 running 的新一轮打成 idle（已完成）。
 *     这是"继续发问后状态卡在已完成"的回归测试。
 *  2. adapter 解析出的 replyState 必须带记录时间戳（replyStateAt），守卫才有的比对。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { hub, STATES } from '../src/hub.js';
import { parseRollout } from '../src/adapters/zcode/index.js';
import { parseTranscript } from '../src/adapters/claude-code/index.js';

/** 建一个测试会话并把 lastActivityAt 固定到 BASE（hub 内部用 Date.now()，测试里手动锚定） */
function fixtureSession(id, base) {
  const s = hub.ensureSession(id, 'zcode');
  s.lastActivityAt = base;
  return s;
}

test('回归：新提问后上一轮遗留的 done 不得把 running 打成 idle', () => {
  const id = 'sess_t_stale_done';
  const base = Date.now();
  fixtureSession(id, base);
  // 用户继续发问：PROMPT hook → running（activity 刷新 lastActivityAt≈base）
  hub.update(id, { state: STATES.RUNNING }, { activity: true });
  hub.sessions.get(id).lastActivityAt = base;
  // 此刻 rollout 尾部仍是上一轮的 done（早于本次提问）
  hub.applyReplyState(id, 'done', { at: base - 60_000 });
  assert.equal(hub.sessions.get(id).state, STATES.RUNNING);
});

test('新一轮真正的 done（晚于提问）正常收敛为 idle', () => {
  const id = 'sess_t_fresh_done';
  const base = Date.now();
  fixtureSession(id, base);
  hub.update(id, { state: STATES.RUNNING }, { activity: true });
  hub.sessions.get(id).lastActivityAt = base;
  hub.applyReplyState(id, 'done', { at: base + 5_000 });
  assert.equal(hub.sessions.get(id).state, STATES.IDLE);
});

test('不带 at 时保持旧行为（向后兼容，如 zcode-turns 已自行做过守卫）', () => {
  const id = 'sess_t_no_at';
  const base = Date.now();
  fixtureSession(id, base);
  hub.update(id, { state: STATES.RUNNING });
  hub.applyReplyState(id, 'done');
  assert.equal(hub.sessions.get(id).state, STATES.IDLE);
});

test('ended 会话不受文件信号影响', () => {
  const id = 'sess_t_ended';
  const base = Date.now();
  fixtureSession(id, base);
  hub.end(id, 'turn_cancelled');
  hub.applyReplyState(id, 'running', { at: base + 60_000 });
  assert.equal(hub.sessions.get(id).state, STATES.ENDED);
});

test('AskUserQuestion 真等待不被文件的 done 覆盖', () => {
  const id = 'sess_t_waiting';
  const base = Date.now();
  fixtureSession(id, base);
  hub.update(id, {
    state: STATES.WAITING_INPUT,
    waitingForInput: true,
  }, { activity: true });
  hub.applyReplyState(id, 'done', { at: base + 60_000 });
  assert.equal(hub.sessions.get(id).state, STATES.WAITING_INPUT);
});

test('running 结论提升 created；不打断 idle（既有语义不回退）', () => {
  const id1 = 'sess_t_promote';
  const base = Date.now();
  fixtureSession(id1, base);
  hub.applyReplyState(id1, 'running', { at: base + 1_000 });
  assert.equal(hub.sessions.get(id1).state, STATES.RUNNING);

  const id2 = 'sess_t_no_interrupt';
  fixtureSession(id2, base);
  hub.update(id2, { state: STATES.IDLE });
  hub.applyReplyState(id2, 'running', { at: base + 1_000 });
  assert.equal(hub.sessions.get(id2).state, STATES.IDLE);
});

/* ---------- adapter 时间戳提取 ---------- */

const ROLLOUT_DIR = mkdtempSync(path.join(tmpdir(), 'aw-rollout-'));

function writeRollout(name, records) {
  const p = path.join(ROLLOUT_DIR, name);
  writeFileSync(p, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return p;
}

const zcodeIo = (over = {}) => ({
  type: 'model_io',
  sessionId: 'sess_fixture',
  startedAt: '2026-08-25T00:00:00.000Z',
  model: { modelId: 'deepseek-v4-flash' },
  request: { body: JSON.stringify({ messages: [{ role: 'user', content: [{ type: 'text', text: '盘点库存' }] }] }) },
  response: { finishReason: 'stop', toolCalls: [], text: '完成', usage: { inputTokens: 1234, outputTokens: 56, totalTokens: 1290 } },
  ...over,
});

test('zcode parseRollout：replyState 取最后一条可判定记录并带其时间戳', () => {
  const t1 = '2026-08-25T00:00:01.000Z';
  const t2ms = 1756080002000; // epoch ms 形式（两种时间戳格式都要支持）
  const p = writeRollout('model-io-sess_fixture_a.jsonl', [
    zcodeIo({ startedAt: t1 }), // 上一轮：stop 无工具 → done
    zcodeIo({ startedAt: t2ms, response: { finishReason: 'tool_calls', toolCalls: [{ name: 'Bash' }], usage: { inputTokens: 2000, outputTokens: 10 } } }), // 新一轮工具调用 → running
  ]);
  const r = parseRollout(p);
  assert.equal(r.replyState, 'running');
  assert.equal(r.replyStateAt, t2ms);
});

test('zcode parseRollout：末条 stop 无工具 → done；error 记录不参与判定也不污染时间戳', () => {
  const tDone = '2026-08-25T00:00:05.000Z';
  const tErr = '2026-08-25T00:00:09.000Z'; // 更晚但请求失败，不可判定
  const p = writeRollout('model-io-sess_fixture_b.jsonl', [
    zcodeIo({ startedAt: tErr, error: { message: 'boom' }, response: undefined }),
    zcodeIo({ startedAt: tDone }),
  ]);
  const r = parseRollout(p);
  assert.equal(r.replyState, 'done');
  assert.equal(r.replyStateAt, Date.parse(tDone));
});

test('claude parseTranscript：末条 assistant 文字 → done；tool_use 在后 → running，均带行时间戳', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'aw-claude-'));
  const p = path.join(dir, 't.jsonl');
  const line = (ts, content) => JSON.stringify({ type: 'assistant', timestamp: ts, message: { content, usage: {} } });
  writeFileSync(p, [
    line('2026-08-25T01:00:00.000Z', [{ type: 'text', text: '第一轮回复' }]),
    line('2026-08-25T01:00:10.000Z', [{ type: 'tool_use', name: 'Bash', input: {} }]),
  ].join('\n') + '\n');
  const r = parseTranscript(p);
  assert.equal(r.replyState, 'running');
  assert.equal(r.replyStateAt, Date.parse('2026-08-25T01:00:10.000Z'));
  rmSync(dir, { recursive: true, force: true });
});
