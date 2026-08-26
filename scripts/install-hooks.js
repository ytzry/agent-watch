/**
 * 自动安装各 agent 的 hook 配置（带备份）
 *
 * 目标文件：
 *  - Claude Code: ~/.claude/settings.json        hooks: { "<Event>": [...] }（type:"http" 直连）
 *  - Codex:       ~/.codex/config.toml           [hooks] 表（command+curl 转发）
 *  - ZCode:       ~/.zcode/cli/config.json       hooks: { enabled:true, events: { "<Event>": [...] } }
 *
 * 用法：npm run hooks:install [-- --provider claude-code|codex|zcode]
 * 不传 provider 则全部安装。安装前先把原文件**复制**一份到 ~/.agent-watch-backups/
 * （原件必须留在原地），然后只合并写入本工具自己的键，不碰配置里的其它内容。
 *
 * 为什么备份必须用 copy 而不是 rename：rename 会把原路径搬空，下面的
 * JSON.parse(readFileSync(file)) 读到的永远是"文件不存在"，于是从 {} 重写，
 * 用户手工加的 mcp.servers / plugins 等全部被抹掉（已实际造成过 MCP 丢失）。
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { config } from '../src/config.js';

const BASE = config.hookBaseUrl;
const BACKUP_DIR = path.join(homedir(), '.agent-watch-backups');

function expandHome(p) {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return path.join(homedir(), p.slice(2));
  return p;
}

function backup(filePath) {
  if (!existsSync(filePath)) return;
  mkdirSync(BACKUP_DIR, { recursive: true });
  const name = path.basename(filePath) + '.' + Date.now() + '.bak';
  copyFileSync(filePath, path.join(BACKUP_DIR, name));
  console.log(`  已备份 ${filePath} → ${BACKUP_DIR}/${name}`);
}

/**
 * 探测本机可用的 curl 绝对路径（跨平台，换机器/系统免改）。
 *
 * 为什么必须绝对路径：ZCode/Codex 的 command hook 子进程继承的是宿主应用的
 * 系统 PATH——Windows 上不含 Git Bash 的 mingw64/bin，裸 `curl` 解析不到，
 * 导致 hook.run.failed（本仓库已踩坑，全部 hook 静默失败）。
 *
 * 探测顺序（Windows）：
 *   1. C:\Windows\System32\curl.exe（系统自带，无空格，不经 shell 直接 spawn 也安全）
 *   2. C:\Program Files\Git\mingw64\bin\curl.exe（Git 的，带引号防空格）
 *   3. 以上都没有 → 回退裸 `curl`，靠 PATH（macOS/Linux 通常有）
 */
function resolveCurl() {
  if (process.platform === 'win32') {
    const candidates = [
      'C:\\Windows\\System32\\curl.exe',
      'C:\\Program Files\\Git\\mingw64\\bin\\curl.exe',
      'C:\\Program Files\\Git\\cmd\\curl.exe',
    ];
    for (const c of candidates) {
      if (existsSync(c)) return c.includes(' ') ? `"${c}"` : c;
    }
  }
  return 'curl';
}

function curlCommand(url) {
  // --json @-：curl ≥7.82，自动设 Content-Type: application/json 并 POST。
  // 不用 -H '...'：Windows 上 command hook 经 cmd.exe 执行，单引号按字面拆分、
  // 双引号也可能带引号原样传给 curl，导致非法 header（服务端 400），
  // 且 `application/json'` 会被当成额外 URL 触发 DNS 失败（curl exit 6 → hook 全挂）。
  return `${resolveCurl()} -s --json @- ${BASE}${url}`;
}

/* ---------- Claude Code ---------- */
function installClaude() {
  const file = expandHome('~/.claude/settings.json');
  console.log(`\n[Claude Code] ${file}`);
  backup(file);
  const settings = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  settings.hooks = settings.hooks || {};
  // type:"http" 需要**绝对 URL**（相对路径无法发起请求），与 Codex/ZCode 的 curl 前缀保持一致
  const url = `${BASE}/api/hooks/claude-code`;
  const events = [
    'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse',
    'PostToolUseFailure', 'PermissionRequest', 'Notification', 'Stop',
    'StopFailure', 'SessionEnd', 'SubagentStart', 'SubagentStop',
  ];
  for (const ev of events) {
    settings.hooks[ev] = [
      { hooks: [{ type: 'http', url, timeout: 10 }] },
    ];
  }
  writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
  console.log(`  ✅ hooks 已写入（type:"http" 直连 ${url}）`);
}

/* ---------- Codex ---------- */
function installCodex() {
  const file = expandHome('~/.codex/config.toml');
  console.log(`\n[Codex] ${file}`);
  backup(file);
  const url = '/api/hooks/codex';
  const events = [
    'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse',
    'PermissionRequest', 'PreCompact', 'PostCompact', 'Stop',
    'SubagentStart', 'SubagentStop', 'SessionEnd',
  ];
  const marker = '# --- agent-watch hooks (自动生成，勿手改) ---';
  const lines = ['', marker, '[hooks]'];
  for (const ev of events) {
    const timeout = ev === 'SessionEnd' ? 'timeout = 2' : 'timeout = 30';
    // TOML 双引号字符串里反斜杠是转义符：Windows 路径 C:\... 必须写成 C:\\...
    const cmd = curlCommand(url).replace(/\\/g, '\\\\');
    lines.push(`${ev} = [ { hooks = [ { type = "command", command = "${cmd}", ${timeout} } ] } ]`);
  }
  // 文件可能不存在（全新安装）→ 创建；已有 agent-watch 段 → 先移除再追加（幂等）
  let content = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const existingIdx = content.indexOf(marker);
  if (existingIdx !== -1) {
    content = content.slice(0, existingIdx).replace(/\n{3,}$/, '\n');
  }
  writeFileSync(file, content + lines.join('\n') + '\n');
  console.log('  ✅ [hooks] 已写入（command+curl 转发）');
}

/* ---------- ZCode ---------- */
function installZCode() {
  const file = expandHome('~/.zcode/cli/config.json');
  console.log(`\n[ZCode] ${file}`);
  backup(file);
  const cfg = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const url = '/api/hooks/zcode';
  const events = [
    'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse',
    'PostToolUseFailure', 'PermissionRequest', 'Stop',
  ];
  cfg.hooks = cfg.hooks || {};
  cfg.hooks.enabled = true;
  cfg.hooks.events = cfg.hooks.events || {};
  for (const ev of events) {
    cfg.hooks.events[ev] = [
      { hooks: [{ type: 'command', command: curlCommand(url), timeout: 10 }] },
    ];
  }
  writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
  console.log('  ✅ hooks.enabled=true + events 已写入（command+curl 转发）');
}

const installers = {
  'claude-code': installClaude,
  codex: installCodex,
  zcode: installZCode,
};

const argProvider = process.argv.find((a) => a.startsWith('--provider='))?.split('=')[1];
const targets = argProvider ? [argProvider] : Object.keys(installers);

console.log(`[agent-watch] 安装 hook 配置 → 目标: ${targets.join(', ')}`);
console.log(`[agent-watch] 转发地址: ${BASE}`);

// 校验 hook 服务端口是否存活（node server.js 未启动时安装，hook 只会失败）
import { connect as netConnect } from 'node:net';
const portOk = await new Promise((resolve) => {
  const sock = netConnect({ host: '127.0.0.1', port: config.port, timeout: 800 });
  sock.once('connect', () => { sock.destroy(); resolve(true); });
  sock.once('error', () => resolve(false));
});
if (!portOk) {
  console.error(`\n❌ hook 服务未在 http://127.0.0.1:${config.port} 监听（请先 npm start）`);
  console.error('   安装虽会写入配置，但 hook 调用会全部失败。中止安装。');
  process.exit(1);
}

for (const t of targets) {
  if (!installers[t]) {
    console.error(`  未知 provider: ${t}（可用: ${Object.keys(installers).join(', ')}）`);
    continue;
  }
  installers[t]();
}
console.log('\n完成。请完全重启对应 agent 客户端使 hook 生效。');
