/**
 * 上下文用量/容量测试
 *
 * 背景（实测数据驱动的回归）：
 *  - Claude transcript 的 assistant 行带 message.model（代理路由时是真实模型，
 *    如 deepseek-v4-flash），此前完全没用它 → 容量一律按 200k 兜底显示不准。
 *  - 缓存命中场景下 input_tokens 只含未命中的新增部分（实测 input=67 /
 *    cache_read=516352），当前上下文必须用 input+cache_read+cache_creation 快照。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { inferContextWindow, contextWindowFor } from '../src/session-utils.js';
import { parseTranscript, default as adapter } from '../src/adapters/claude-code/index.js';
import { computeUsage } from '../src/session-files.js';

test('inferContextWindow：组织前缀剥离 / 已知表匹配 / 未知模型返回 null', () => {
  assert.equal(inferContextWindow('deepseek/deepseek-v4-flash'), 1000000);
  assert.equal(inferContextWindow('deepseek-v4-flash'), 1000000);
  assert.equal(inferContextWindow('gpt-4o-2024-xx'), 128000);
  assert.equal(inferContextWindow('ox-alpha-free'), null); // 未知模型不瞎猜，由调用方兜底
  assert.equal(contextWindowFor(undefined), 200000);
});

test('claude：contextTokens 取最近一次请求快照（input+cache_read+cache_create）', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'aw-ctx-'));
  const p = path.join(dir, 't.jsonl');
  const line = (model, usage) => JSON.stringify({ type: 'assistant', timestamp: '2026-08-25T02:00:00.000Z', message: { model, content: [{ type: 'text', text: 'ok' }], usage } });
  writeFileSync(p, [
    line('claude-sonnet-4-5', { input_tokens: 5000, output_tokens: 100 }), // 早期请求
    // 收尾请求：非缓存 input 只剩几十，上下文几乎全在 cache_read 里
    line('<synthetic>', { input_tokens: 0, output_tokens: 0 }),
    line('deepseek-v4-flash', { input_tokens: 67, output_tokens: 35, cache_read_input_tokens: 516352, cache_creation: { ephemeral_5m_input_tokens: 100 } }),
  ].join('\n') + '\n');
  const r = parseTranscript(p);
  assert.equal(r.modelId, 'deepseek-v4-flash'); // 占位值跳过、取最近的真实模型
  assert.equal(r.usage.contextTokens, 67 + 516352 + 100);
  assert.equal(r.usage.totalTokens, 67 + 516352 + 100);

  // 端到端：adapter 补 maxTokens（按模型查窗口）→ computeUsage 出 pct
  const info = adapter.parseSessionFile(p);
  assert.equal(info.usage.maxTokens, 1000000); // 不再是 200k 兜底
  const normed = computeUsage(info.usage);
  assert.equal(normed.pct, Math.round((67 + 516352 + 100) / 1000000 * 100));
  rmSync(dir, { recursive: true, force: true });
});
