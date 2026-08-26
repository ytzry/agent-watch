/**
 * 统一归一化事件模型的 model 字段测试
 *
 * 背景：昨天(5dadd03)把模型名做在了会话文件解析层（parseSessionFile），
 * 归一化事件模型（NormalizedEvent / normalize()）没有 model 字段——
 * Codex SessionStart hook payload 顶层自带的 model 被丢弃，
 * 会话中途换模型时文件同步的"只补空"守卫也永远刷不过来。
 *
 * 覆盖：
 *  1. common.getModel 的字段提取与占位过滤
 *  2. 三家 adapter normalize 都携带 model（payload 带了才有）
 *  3. ingest.applyEvent 用 ev.model 覆盖旧值（中途换模型可刷新）
 */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import { getModel } from '../src/adapters/common.js';
import claudeCode from '../src/adapters/claude-code/index.js';
import codex from '../src/adapters/codex/index.js';
import zcode from '../src/adapters/zcode/index.js';
import { EVENTS } from '../src/adapters/index.js';
import { hub } from '../src/hub.js';
import { applyEvent } from '../src/hooks/ingest.js';

/* ---------- getModel 助手 ---------- */

test('getModel：顶层 model / modelId 都取；占位与非字符串返回 undefined', () => {
  assert.equal(getModel({ model: 'gpt-5.4' }), 'gpt-5.4');
  assert.equal(getModel({ modelId: 'deepseek-v4-flash' }), 'deepseek-v4-flash');
  // '<synthetic>' 等占位模型名不是真实模型（Claude 收尾合成消息），同 transcript 解析口径
  assert.equal(getModel({ model: '<synthetic>' }), undefined);
  assert.equal(getModel({ model: '' }), undefined);
  assert.equal(getModel({}), undefined);
  assert.equal(getModel(null), undefined);
});

/* ---------- 各 adapter normalize 携带 model ---------- */

test('codex normalize：SessionStart payload 顶层 model 进入归一化事件（实测字段）', () => {
  const ev = codex.normalize({
    hook_event_name: 'SessionStart',
    session_id: 'sess_t_codex_m',
    cwd: '/tmp/x',
    model: 'gpt-5.4',
    permission_mode: 'default',
  }, 'SessionStart');
  assert.equal(ev.event, EVENTS.SESSION_START);
  assert.equal(ev.model, 'gpt-5.4');

  const evNoModel = codex.normalize({
    hook_event_name: 'Stop', session_id: 'sess_t_codex_m',
  }, 'Stop');
  assert.equal(evNoModel.model, undefined);
});

test('codex normalize：PermissionRequest 分支同样携带 model', () => {
  const ev = codex.normalize({
    hook_event_name: 'PermissionRequest',
    session_id: 'sess_t_codex_p',
    tool_name: 'Bash',
    tool_input: { command: 'ls' },
    model: 'gpt-5.4',
  }, 'PermissionRequest');
  assert.equal(ev.event, EVENTS.PERMISSION_REQUEST);
  assert.equal(ev.model, 'gpt-5.4');
});

test('claude normalize：model 透传；<synthetic> 占位被过滤', () => {
  const ev = claudeCode.normalize({
    hook_event_name: 'UserPromptSubmit',
    session_id: 'sess_t_claude_m',
    prompt: '你好',
    model: 'deepseek-v4-flash',
  }, 'UserPromptSubmit');
  assert.equal(ev.model, 'deepseek-v4-flash');

  const synthetic = claudeCode.normalize({
    hook_event_name: 'UserPromptSubmit',
    session_id: 'sess_t_claude_m',
    prompt: '你好',
    model: '<synthetic>',
  }, 'UserPromptSubmit');
  assert.equal(synthetic.model, undefined);
});

test('zcode normalize：默认无 model（payload 不带）；带 modelId 时防御性透传', () => {
  const ev = zcode.normalize({
    hook_event_name: 'Stop', session_id: 'sess_t_zcode_m',
  }, 'Stop');
  assert.equal(ev.model, undefined);

  const withModel = zcode.normalize({
    hook_event_name: 'Stop', session_id: 'sess_t_zcode_m', modelId: 'deepseek-v4-flash',
  }, 'Stop');
  assert.equal(withModel.model, 'deepseek-v4-flash');
});

/* ---------- ingest 应用 ev.model ---------- */

test('applyEvent：ev.model 覆盖旧模型名（会话中途切换模型可刷新）', () => {
  const id = 'sess_t_model_switch';
  hub.ensureSession(id, 'codex', { model: 'gpt-5.3' });
  applyEvent({ provider: 'codex', sessionId: id, event: EVENTS.PROMPT, title: '', model: 'gpt-5.4' });
  assert.equal(hub.sessions.get(id).model, 'gpt-5.4');
});

test('applyEvent：无 model 的事件不改动已有模型名（ZCode payload 不带的常态）', () => {
  const id = 'sess_t_model_keep';
  hub.ensureSession(id, 'zcode', { model: 'deepseek-v4-flash' });
  applyEvent({ provider: 'zcode', sessionId: id, event: EVENTS.STOP, title: '', hasBackground: false });
  assert.equal(hub.sessions.get(id).model, 'deepseek-v4-flash');
});
