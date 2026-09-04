/**
 * 会话文件解析的通用工具（无 provider 依赖，供 session-files.js 与各 adapter 使用）
 *  - 尾部读取（避免大文件 OOM）
 *  - 上下文窗口推断（ZCode catalog 优先，模型名启发式兜底）
 *  - 文本抽取（string/数组 content 统一）
 */
import { readdirSync, readFileSync, statSync, openSync, readSync, closeSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * 读文件尾部（自适应扩窗）：先读 maxBytes，若读窗内凑不出一条完整行
 * （最后一条记录本身就超过读窗，如 ZCode 把整轮对话内联进一条 model_io 行），
 * 则成倍扩窗重读，直到至少一条完整行、或已覆盖整个文件/到达 maxWindow 上限。
 * 返回值同旧版：从第一个完整行开始（首个残行丢弃，避免 JSON 解析失败）。
 */
export function readFileTail(filePath, maxBytes, { maxWindow = 32 * 1024 * 1024 } = {}) {
  try {
    const size = statSync(filePath).size;
    let win = Math.min(size, maxBytes);
    for (;;) {
      const readLen = Math.min(size, win);
      const buf = Buffer.alloc(readLen);
      const fd = openSync(filePath, 'r');
      let text;
      try {
        readSync(fd, buf, 0, readLen, size - readLen);
      } finally {
        closeSync(fd);
      }
      text = buf.toString('utf8');
      const firstNewline = text.indexOf('\n');
      const body = firstNewline === -1 ? text : text.slice(firstNewline + 1);
      // body 里还有换行 → 至少一条完整行；或已到文件头/窗口上限，无法再扩
      if (body.indexOf('\n') !== -1 || win >= size || win >= maxWindow) return body;
      win = Math.min(win * 4, maxWindow, size);
    }
  } catch {
    return '';
  }
}

/* ---------- 上下文窗口 ---------- */

// ZCode model catalog 可能所在的目录（按平台枚举候选，全部探测、合并结果）：
// - Windows：LOCALAPPDATA 常规安装；自定义盘符安装（如 D:\Program Files\ZCode）由注册表动态解析
// - macOS：系统 / 用户 Applications（ZCode 与早期 AutoGLM 两个应用名）
// - Linux：electron-builder deb/rpm 的默认安装前缀（/opt、/usr/lib、/usr/share）
// - 全平台：CLI 侧目录（~/.zcode/cli/model-providers）
// 任一平台漏枚举 → catalog 整体读不到，模型只能落到启发式表或 200k 兜底 → 容量显示不准。
export function zcodeCatalogCandidateDirs() {
  const dirs = [];
  const home = homedir();
  const appdata = process.env.LOCALAPPDATA;
  if (appdata) {
    dirs.push(path.join(appdata, 'Programs', 'ZCode', 'resources', 'model-providers'));
    dirs.push(path.join(appdata, 'Programs', 'AutoGLM', 'resources', 'model-providers'));
    dirs.push(path.join(appdata, 'ZCode', 'resources', 'model-providers'));
  }
  // POSIX 固定前缀用纯字符串拼（path.join 在 Windows 上会产出反斜杠风格的 mac/linux 路径；
  // 这些条目只在对应平台被 existsSync 命中，其他平台上落空无害）
  for (const appName of ['ZCode', 'AutoGLM']) {
    dirs.push(`/Applications/${appName}.app/Contents/Resources/model-providers`);
    dirs.push(`${home}/Applications/${appName}.app/Contents/Resources/model-providers`);
  }
  for (const prefix of ['/opt/ZCode', '/opt/zcode', '/usr/lib/ZCode', '/usr/lib/zcode', '/usr/share/zcode']) {
    dirs.push(`${prefix}/resources/model-providers`);
  }
  dirs.push(path.join(home, '.zcode', 'cli', 'model-providers'));
  return dirs;
}

function zcodeCatalogDirs() {
  const dirs = zcodeCatalogCandidateDirs();
  for (const installDir of zcodeInstallDirsFromRegistry()) {
    dirs.push(path.join(installDir, 'resources', 'model-providers'));
  }
  return dirs.filter((d) => existsSync(d));
}

/** 从 Windows 注册表卸载项解析 ZCode 安装目录（值数据含 ZCode 的项 → UninstallString/DisplayIcon 的 exe 所在目录） */
function zcodeInstallDirsFromRegistry() {
  const dirs = new Set();
  if (process.platform !== 'win32') return dirs;
  const roots = [
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  ];
  for (const root of roots) {
    let keys = [];
    try {
      // 只搜值数据（/d）：不带 /d 会把整个卸载树所有 key 都当命中，后续逐 key 查询拖慢数秒
      const found = spawnSync('reg', ['query', root, '/s', '/f', 'ZCode', '/d'], {
        encoding: 'utf8', windowsHide: true, timeout: 5000,
      });
      if (found.status !== 0 || !found.stdout) continue;
      // 输出形如：HKEY_...\Uninstall\<guid>\n    DisplayName    REG_SZ    ZCode 3.10.2
      keys = found.stdout.split('\n').filter((l) => l.startsWith('HKEY_')).map((l) => l.trim());
    } catch {
      continue;
    }
    for (const key of keys) {
      try {
        const vals = spawnSync('reg', ['query', key], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
        if (vals.status !== 0 || !vals.stdout) continue;
        // UninstallString / DisplayIcon 都带 exe 全路径：取引号内路径（含空格）或首个空格前 token 的目录名
        for (const line of vals.stdout.split('\n')) {
          const m = line.match(/\b(?:UninstallString|DisplayIcon)\s+REG_SZ\s+(.+)/i);
          if (!m) continue;
          const exePath = m[1].trim().match(/^"([^"]+)"/)?.[1] || m[1].trim().split(/\s+/)[0];
          if (exePath) dirs.add(path.dirname(exePath));
        }
      } catch {}
    }
  }
  return dirs;
}

let zcodeContextCache = null; // { modelId -> contextWindow }

/** 加载 ZCode 模型目录，构建 modelId → contextWindow 映射（缓存） */
function loadZCodeContextWindows() {
  if (zcodeContextCache) return zcodeContextCache;
  const cache = {};
  try {
    for (const dir of zcodeCatalogDirs()) {
      let files = [];
      try {
        files = readdirSync(dir).filter((f) => f.endsWith('.json'));
      } catch {
        continue;
      }
      for (const f of files) {
        try {
          const catalog = JSON.parse(readFileSync(path.join(dir, f), 'utf8'));
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

/* ---------- ZCode 用户配置的上下文窗口（~/.zcode/v2/config.json） ---------- */

// 会话实际使用的模型（第一方如 muse-spark-*，或用户手动添加的自定义模型）不在安装目录
// 自带的 model catalog 里；ZCode 把这些模型的上下文窗口写在 v2 config 的
// provider[<providerId>].models[<modelId>].limit.context。不读这份配置的话，
// 1M 窗口的模型只能落到 200k 兜底 → 用量进度条放大 5 倍。

/**
 * 从 v2 config JSON 提取上下文窗口映射（纯函数，便于测试）。
 * 返回 { byProviderModel: { '<providerId>\x1f<modelId>': cw }, byModel: { '<modelId>': cw } }
 */
export function buildZcodeConfigContextMap(configObj) {
  const map = { byProviderModel: {}, byModel: {} };
  const providers = configObj?.provider;
  if (!providers || typeof providers !== 'object') return map;
  for (const [pid, p] of Object.entries(providers)) {
    const models = p?.models;
    if (!models || typeof models !== 'object') continue;
    for (const [mid, m] of Object.entries(models)) {
      const cw = m?.limit?.context;
      if (typeof cw !== 'number' || cw <= 0) continue;
      map.byProviderModel[pid + '\x1f' + mid] = cw;
      // 同名模型跨 provider 重复出现时值一致（同一模型多处接入），首个写入即可
      if (!map.byModel[mid]) map.byModel[mid] = cw;
    }
  }
  return map;
}

let zcodeConfigContextCache = null; // { mtimeMs, map }

/** 加载用户 v2 config 的上下文窗口映射（按 mtime 失效缓存——用户在 ZCode 里改模型配置要能刷进来） */
function loadZcodeConfigContexts() {
  const cfgPath = path.join(homedir(), '.zcode', 'v2', 'config.json');
  try {
    const mtimeMs = statSync(cfgPath).mtimeMs;
    if (zcodeConfigContextCache && zcodeConfigContextCache.mtimeMs === mtimeMs) {
      return zcodeConfigContextCache.map;
    }
    const map = buildZcodeConfigContextMap(JSON.parse(readFileSync(cfgPath, 'utf8')));
    zcodeConfigContextCache = { mtimeMs, map };
    return map;
  } catch {
    // 文件不存在/损坏：返回空映射（历史缓存保留，下次 stat 成功即刷新）
    return (zcodeConfigContextCache ||= { mtimeMs: -1, map: { byProviderModel: {}, byModel: {} } }).map;
  }
}

/** 在映射里查找：providerId+modelId 精确匹配优先，退回按模型名 */
export function lookupConfigContextWindow(map, providerId, modelId) {
  if (!modelId) return null;
  if (providerId) {
    const cw = map.byProviderModel[providerId + '\x1f' + modelId];
    if (cw) return cw;
  }
  return map.byModel[modelId] || null;
}

/** 查用户配置的上下文窗口（读真实 ~/.zcode/v2/config.json，缓存） */
export function zcodeConfigContextWindow(providerId, modelId) {
  return lookupConfigContextWindow(loadZcodeConfigContexts(), providerId, modelId);
}

/**
 * 通用上下文窗口推断（借鉴 Claude-Code-Agent-Monitor 的 [1m] 启发式）：
 * 1. 用户 v2 config（providerId+modelId 精确 → 模型名）——用户添加/改过的模型以此为准，
 *    覆盖 catalog 没有的第一方与自定义模型
 * 2. ZCode model catalog（安装目录，注册表解析出的自定义安装路径也在内）
 * 3. 模型名带 [1m]/[1M] 后缀 → 1M（Claude 1M 变体）
 * 4. 已知默认窗口表
 * 5. 兜底 200k（Claude Code 历史默认，在 contextWindowFor）
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

export function inferContextWindow(modelId, providerId) {
  if (!modelId) return null;
  const fromConfig = zcodeConfigContextWindow(providerId, modelId);
  if (fromConfig) return fromConfig;
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
export function contextWindowFor(modelId, providerId) {
  return inferContextWindow(modelId, providerId) || 200000;
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
