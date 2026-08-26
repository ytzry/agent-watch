/**
 * 卸载 agent-watch 写入的 hook 配置
 *
 * 与 install 的合并写入互为逆操作：只精确删除 install 写入的那几个 hook
 * 事件项，配置里的其它内容（MCP、插件状态、用户自己加的 hooks）一律不碰。
 * ~/.agent-watch-backups/ 仅作为历史快照保留，不再整份恢复——整份覆盖会把
 * 安装之后新增的内容一起回滚掉（已实际造成过 MCP 丢失）。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

// 与 install-hooks.js 中各 installer 写入的事件清单保持一致
const CLAUDE_EVENTS = [
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse',
  'PostToolUseFailure', 'PermissionRequest', 'Notification', 'Stop',
  'StopFailure', 'SessionEnd', 'SubagentStart', 'SubagentStop',
];
const ZCODE_EVENTS = [
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse',
  'PostToolUseFailure', 'PermissionRequest', 'Stop',
];

function expandHome(p) {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return path.join(homedir(), p.slice(2));
  return p;
}

/**
 * 只删除 agent-watch 安装的 hook 事件。
 * - Claude 形如 hooks["<Event>"] = [...]；nested=false
 * - ZCode   形如 hooks.events["<Event>"] = [...]（另有 enabled 总开关）；nested=true
 * 删完后顺手摘掉因此空掉的壳（events 容器 / enabled / 整个 hooks 键）；
 * 一个都没命中就不落盘，避免无意义的重写。
 */
function stripHooksJson(filePath, { events, nested = false }) {
  const cfg = JSON.parse(readFileSync(filePath, 'utf8'));
  const hooks = cfg?.hooks;
  if (!hooks || typeof hooks !== 'object') return console.log('  未找到 hooks 键，跳过');
  const container = nested ? hooks.events : hooks;
  if (!container || typeof container !== 'object') return console.log('  未找到 hook 事件，跳过');
  let removed = 0;
  for (const ev of events) {
    if (Object.prototype.hasOwnProperty.call(container, ev)) {
      delete container[ev];
      removed++;
    }
  }
  if (removed === 0) return console.log('  未找到 agent-watch 写入的事件，跳过');
  if (nested && Object.keys(container).length === 0) {
    delete hooks.events;
    delete hooks.enabled; // enabled 由 install 写入，仅在其事件被清空时移除
  }
  if (Object.keys(hooks).length === 0) delete cfg.hooks;
  writeFileSync(filePath, JSON.stringify(cfg, null, 2) + '\n');
  console.log(`  🗑️ 已从 ${filePath} 移除 ${removed} 个 hook 事件`);
}

/* ---------- Claude Code ---------- */
function uninstallClaude() {
  const file = expandHome('~/.claude/settings.json');
  console.log(`\n[Claude Code] ${file}`);
  if (!existsSync(file)) return console.log('  不存在，跳过');
  stripHooksJson(file, { events: CLAUDE_EVENTS });
}

/* ---------- Codex（按标记段落移除，本身即精确） ---------- */
function uninstallCodex() {
  const file = expandHome('~/.codex/config.toml');
  console.log(`\n[Codex] ${file}`);
  if (!existsSync(file)) return console.log('  不存在，跳过');
  const content = readFileSync(file, 'utf8');
  const marker = '# --- agent-watch hooks';
  const idx = content.indexOf(marker);
  if (idx === -1) return console.log('  未找到 agent-watch 标记，跳过');
  writeFileSync(file, content.slice(0, idx).replace(/\n{3,}$/, '\n'));
  console.log('  🗑️ 已移除 agent-watch hooks 段落');
}

/* ---------- ZCode ---------- */
function uninstallZCode() {
  const file = expandHome('~/.zcode/cli/config.json');
  console.log(`\n[ZCode] ${file}`);
  if (!existsSync(file)) return console.log('  不存在，跳过');
  stripHooksJson(file, { events: ZCODE_EVENTS, nested: true });
}

const uninstallers = {
  'claude-code': uninstallClaude,
  codex: uninstallCodex,
  zcode: uninstallZCode,
};

const argProvider = process.argv.find((a) => a.startsWith('--provider='))?.split('=')[1];
const targets = argProvider ? [argProvider] : Object.keys(uninstallers);
for (const t of targets) {
  uninstallers[t]();
}
console.log('\n完成。请完全重启对应 agent 客户端。');
