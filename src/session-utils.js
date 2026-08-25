/**
 * 会话文件解析的通用工具（无 provider 依赖，供 session-files.js 与各 adapter 使用）
 *  - 尾部读取（避免大文件 OOM）
 *  - 上下文窗口推断（ZCode catalog 优先，模型名启发式兜底）
 *  - 文本抽取（string/数组 content 统一）
 */
import { readdirSync, readFileSync, statSync, openSync, readSync, closeSync, existsSync } from 'node:fs';

/** 读文件尾部最多 maxBytes（从最后一个完整行开始） */
export function readFileTail(filePath, maxBytes) {
  try {
    const size = statSync(filePath).size;
    const readLen = Math.min(size, maxBytes);
    const buf = Buffer.alloc(readLen);
    const fd = openSync(filePath, 'r');
    try {
      readSync(fd, buf, 0, readLen, size - readLen);
    } finally {
      closeSync(fd);
    }
    const text = buf.toString('utf8');
    const firstNewline = text.indexOf('\n');
    return firstNewline === -1 ? text : text.slice(firstNewline + 1);
  } catch {
    return '';
  }
}

/* ---------- 上下文窗口 ---------- */

const ZCODE_CATALOG_DIR = '/Applications/ZCode.app/Contents/Resources/model-providers';
let zcodeContextCache = null; // { modelId -> contextWindow }

/** 加载 ZCode 模型目录，构建 modelId → contextWindow 映射（缓存） */
function loadZCodeContextWindows() {
  if (zcodeContextCache) return zcodeContextCache;
  const cache = {};
  try {
    const dir = ZCODE_CATALOG_DIR;
    if (!existsSync(dir)) return cache;
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    for (const f of files) {
      try {
        const catalog = JSON.parse(readFileSync(pathJoin(dir, f), 'utf8'));
        const providers = catalog.providers || [];
        for (const p of providers) {
          const models = p.models || p.modelList || [];
          const walk = (m) => {
            if (!m || typeof m !== 'object') return;
            const cw = m.contextWindow || m.context_window || m.contextLength;
            const id = m.modelId || m.id || m.name;
            if (cw && id) cache[id] = cw;
            if (Array.isArray(m.models)) m.models.forEach(walk);
            else if (m.models && typeof m.models === 'object') Object.values(m.models).forEach(walk);
          };
          if (Array.isArray(models)) models.forEach(walk);
          else if (models && typeof models === 'object') Object.values(models).forEach(walk);
        }
      } catch {}
    }
  } catch {}
  zcodeContextCache = cache;
  return cache;
}

/** 按模型 id 查上下文窗口（支持前缀匹配，如 deepseek/deepseek-v4-flash） */
export function zcodeContextWindowFor(modelId) {
  if (!modelId) return null;
  const cache = loadZCodeContextWindows();
  if (cache[modelId]) return cache[modelId];
  const base = modelId.split('/').pop();
  for (const [id, cw] of Object.entries(cache)) {
    if (id === base || id.endsWith('/' + base) || base.endsWith(id)) return cw;
  }
  return null;
}

/**
 * 通用上下文窗口推断（借鉴 Claude-Code-Agent-Monitor 的 [1m] 启发式）：
 * 1. 先从 ZCode model catalog（如可读）精确查
 * 2. 模型名带 [1m]/[1M] 后缀 → 1M（Claude 1M 变体）
 * 3. 已知默认窗口表
 * 4. 兜底 200k（Claude Code 历史默认）
 * 返回 null 表示"无法可靠推断"（调用方决定是否用默认值）。
 */
const KNOWN_CONTEXT_WINDOWS = {
  'deepseek-v4-flash': 1000000,
  'deepseek-v3': 1000000,
  'claude-opus': 200000,
  'claude-sonnet': 200000,
  'claude-haiku': 200000,
  'gpt-5': 400000,
  'gpt-5.5': 400000,
  'gpt-4': 128000,
  'gpt-4o': 128000,
  'o3': 200000,
  'o4': 200000,
};

export function inferContextWindow(modelId) {
  if (!modelId) return null;
  const fromCatalog = zcodeContextWindowFor(modelId);
  if (fromCatalog) return fromCatalog;
  if (/\[1m\]/i.test(modelId)) return 1000000;
  const base = modelId.split('/').pop().toLowerCase();
  for (const [name, cw] of Object.entries(KNOWN_CONTEXT_WINDOWS)) {
    if (base === name || base.startsWith(name + '-') || base.startsWith(name + ':')) return cw;
  }
  return null;
}

/** 按模型 id 解析 context window（查不到时用默认 200k） */
export function contextWindowFor(modelId) {
  return inferContextWindow(modelId) || 200000;
}

/** 路径拼接（避免在纯工具模块里依赖 node:path 的默认行为不一致，统一用 posix） */
function pathJoin(dir, f) {
  return dir.replace(/\/$/, '') + '/' + f;
}

/* ---------- 文本抽取 ---------- */

/** 从 content（string | 数组 block）抽取纯文本，跳过 thinking/tool_use/tool_result 等非文本块 */
export function extractText(content, { maxLen } = {}) {
  if (!content) return '';
  let text = '';
  if (typeof content === 'string') {
    text = content.trim();
  } else if (Array.isArray(content)) {
    text = content
      .filter((x) => x && x.type === 'text' && !(x.text || '').startsWith('<'))
      .map((x) => x.text)
      .join(' ')
      .trim();
  }
  if (!text) return '';
  return maxLen ? text.slice(0, maxLen) : text;
}
