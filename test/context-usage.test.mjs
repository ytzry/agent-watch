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
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';

import { inferContextWindow, contextWindowFor, buildZcodeConfigContextMap, lookupConfigContextWindow, zcodeConfigContextWindow, zcodeCatalogCandidateDirs } from '../src/session-utils.js';
import { parseTranscript, default as adapter } from '../src/adapters/claude-code/index.js';
import { parseRollout, default as zcodeAdapter } from '../src/adapters/zcode/index.js';
import { computeUsage } from '../src/session-files.js';

test('inferContextWindow：组织前缀剥离 / 已知表匹配 / 未知模型返回 null', () => {
  assert.equal(inferContextWindow('deepseek/deepseek-v4-flash'), 1000000);
  assert.equal(inferContextWindow('deepseek-v4-flash'), 1000000);
  assert.equal(inferContextWindow('gpt-4o-2024-xx'), 128000);
  assert.equal(inferContextWindow('ox-alpha-free'), null); // 未知模型不瞎猜，由调用方兜底
  assert.equal(contextWindowFor(undefined), 200000);
});

test('buildZcodeConfigContextMap：provider.models[].limit.context 提取 / 非法值跳过', () => {
  const map = buildZcodeConfigContextMap({
    provider: {
      'pid-1': { name: 'opencode', models: {
        'muse-spark-1.3-contributor': { limit: { context: 1000000, output: 128000 } },
        'omen-alpha': { limit: { context: 1000000 } },
        'no-limit-model': { reasoning: {} },          // 无 limit → 跳过
        'bad-limit-model': { limit: { context: -1 } }, // 非法值 → 跳过
      } },
      'pid-2': { name: 'another', models: {
        // 同名模型在另一 provider 下窗口不同 → byModel 取先出现的，byProviderModel 各自保留
        'omen-alpha': { limit: { context: 200000 } },
      } },
      'empty-provider': { name: 'no models' },
    },
  });
  assert.equal(map.byProviderModel['pid-1\x1fmuse-spark-1.3-contributor'], 1000000);
  assert.equal(map.byProviderModel['pid-1\x1fomen-alpha'], 1000000);
  assert.equal(map.byProviderModel['pid-2\x1fomen-alpha'], 200000);
  assert.equal(map.byModel['omen-alpha'], 1000000); // 先出现的 provider 胜
  assert.equal(map.byModel['no-limit-model'], undefined);
  assert.equal(map.byModel['bad-limit-model'], undefined);
  assert.deepEqual(buildZcodeConfigContextMap({}), { byProviderModel: {}, byModel: {} });
  assert.deepEqual(buildZcodeConfigContextMap(null), { byProviderModel: {}, byModel: {} });
});

test('lookupConfigContextWindow：providerId+modelId 精确匹配优先于按名退回', () => {
  const map = buildZcodeConfigContextMap({ provider: {
    p1: { models: { 'glm-x': { limit: { context: 128000 } } } },
    p2: { models: { 'glm-x': { limit: { context: 1000000 } } } },
  } });
  assert.equal(lookupConfigContextWindow(map, 'p2', 'glm-x'), 1000000); // 精确命中
  assert.equal(lookupConfigContextWindow(map, undefined, 'glm-x'), 128000); // 无 providerId 退回 byModel
  assert.equal(lookupConfigContextWindow(map, 'p9', 'glm-x'), 128000); // providerId 不匹配也退回
  assert.equal(lookupConfigContextWindow(map, 'p2', 'unknown'), null);
});

test('contextWindowFor：providerId 参与用户配置查找（真实 v2 config 冒烟）', () => {
  // 本机 ZCode 用户配置：muse-spark-1.3-contributor（1M，catalog 里没有）——修复的原始回归
  if (!existsSync(path.join(homedir(), '.zcode', 'v2', 'config.json'))) return;
  assert.equal(zcodeConfigContextWindow('c149c90b-65d1-48eb-8f5d-31743d87dfeb', 'muse-spark-1.3-contributor'), 1000000);
  assert.equal(zcodeConfigContextWindow('6bc279e5-af28-49fc-b671-01740e15f23e', 'omen-alpha'), 1000000);
  assert.equal(contextWindowFor('muse-spark-1.3-contributor', 'c149c90b-65d1-48eb-8f5d-31743d87dfeb'), 1000000);
});

test('zcode catalog 候选目录：Windows/macOS/Linux 三端都枚举到（多端回归保护）', () => {
  const dirs = zcodeCatalogCandidateDirs();
  const ends = (d) => d.replaceAll('\\', '/').endsWith('/model-providers');
  assert.ok(dirs.every(ends), '所有候选都应指向 model-providers');
  // Windows：LOCALAPPDATA 常规安装（有环境变量时）
  if (process.env.LOCALAPPDATA) {
    assert.ok(dirs.some((d) => d.startsWith(path.join(process.env.LOCALAPPDATA, 'Programs', 'ZCode'))));
  }
  // macOS：系统 + 用户 Applications
  assert.ok(dirs.some((d) => d.includes('/Applications/ZCode.app/Contents/Resources')));
  assert.ok(dirs.some((d) => d.includes('/Applications/AutoGLM.app/Contents/Resources')));
  assert.ok(dirs.some((d) => d === `${homedir()}/Applications/ZCode.app/Contents/Resources/model-providers`));
  // Linux：deb/rpm 默认前缀
  assert.ok(dirs.some((d) => d === '/opt/ZCode/resources/model-providers'));
  assert.ok(dirs.some((d) => d === '/usr/share/zcode/resources/model-providers'));
  // 全平台：CLI 侧目录
  assert.ok(dirs.some((d) => d === path.join(homedir(), '.zcode', 'cli', 'model-providers')));
});

test('zcode parseRollout：maxTokens 取最后一条记录的模型窗口（中途换模型要对上）', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'aw-zc-'));
  const p = path.join(dir, 'model-io-sess_x.jsonl');
  const line = (modelId, providerId, input) => JSON.stringify({
    type: 'model_io', sessionId: 'sess_x', startedAt: '2026-09-04T09:00:00.000Z',
    model: { modelId, providerId },
    response: { finishReason: 'stop', toolCalls: [], text: 'ok', usage: { inputTokens: input, outputTokens: 10, totalTokens: input + 10 } },
  });
  // 前一轮 gpt-4o（已知表 128k），最近一轮未知模型 → 窗口应跟最后一条（200k 兜底），而非开头的 128k
  writeFileSync(p, [line('gpt-4o', 'pidA', 5000), line('unknown-model-x', 'pidA', 20000)].join('\n') + '\n');
  const r = parseRollout(p);
  assert.equal(r.model, 'unknown-model-x');
  assert.equal(r.usage.maxTokens, 200000);
  assert.equal(r.usage.inputTokens, 20000);
  assert.equal(zcodeAdapter.parseSessionFile(p).usage.maxTokens, 200000);
  rmSync(dir, { recursive: true, force: true });
});

test('readFileTail 自适应扩窗：末条记录超过读窗时仍能取到完整行', () => {
  // 实测回归：ZCode 把整轮对话内联进一条 model_io 行，长会话单条 >512KB，
  // 固定读窗内凑不出完整行 → parseRollout 整体返回 null，卡片用量永久停更。
  // 模型用已知表条目（gpt-4o=128k），不依赖本机 v2 config，测试可移植
  const dir = mkdtempSync(path.join(tmpdir(), 'aw-tail-'));
  const p = path.join(dir, 'model-io-sess_big.jsonl');
  const bigFiller = 'x'.repeat(900 * 1024); // 单条 > 512KB 初始读窗
  const line = (modelId, input, filler = '') => JSON.stringify({
    type: 'model_io', sessionId: 'sess_big', startedAt: '2026-09-04T09:00:00.000Z',
    model: { modelId, providerId: 'pidA' },
    request: { body: JSON.stringify({ messages: [{ role: 'user', content: filler }] }) },
    response: { finishReason: 'stop', toolCalls: [], text: 'ok', usage: { inputTokens: input, outputTokens: 10, totalTokens: input + 10 } },
  });
  writeFileSync(p, [line('claude-opus-4-6', 5000), line('gpt-4o', 950000, bigFiller)].join('\n') + '\n');
  const r = parseRollout(p);
  assert.equal(r.model, 'gpt-4o');          // 最后一条（巨大）记录被解析到
  assert.equal(r.usage.maxTokens, 128000);  // 已知表命中（非 200k 兜底）
  assert.equal(r.usage.inputTokens, 950000);
  rmSync(dir, { recursive: true, force: true });
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
