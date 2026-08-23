/**
 * 卸载 agent-watch 写入的 hook 配置
 *
 * 由于 install 时备份了原文件到 ~/.agent-watch-backups/，
 * 卸载会尝试恢复最近一份备份；没有备份则只移除 hooks 键。
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const BACKUP_DIR = path.join(homedir(), '.agent-watch-backups');

function expandHome(p) {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return path.join(homedir(), p.slice(2));
  return p;
}

function restoreBackup(filePath) {
  if (!existsSync(BACKUP_DIR)) return false;
  const base = path.basename(filePath);
  const backups = readdirSync(BACKUP_DIR)
    .filter((f) => f.startsWith(base + '.'))
    .sort();
  if (backups.length === 0) return false;
  const latest = path.join(BACKUP_DIR, backups[backups.length - 1]);
  const content = readFileSync(latest, 'utf8');
  writeFileSync(filePath, content);
  console.log(`  ↩️ 已从备份恢复 ${latest}`);
  return true;
}

function stripHooksJson(filePath, hookKey = 'hooks') {
  const cfg = JSON.parse(readFileSync(filePath, 'utf8'));
  delete cfg[hookKey];
  writeFileSync(filePath, JSON.stringify(cfg, null, 2) + '\n');
  console.log(`  🗑️ 已移除 ${filePath} 的 ${hookKey} 键`);
}

function uninstallClaude() {
  const file = expandHome('~/.claude/settings.json');
  console.log(`\n[Claude Code] ${file}`);
  if (!existsSync(file)) return console.log('  不存在，跳过');
  if (restoreBackup(file)) return;
  stripHooksJson(file);
}

function uninstallCodex() {
  const file = expandHome('~/.codex/config.toml');
  console.log(`\n[Codex] ${file}`);
  if (!existsSync(file)) return console.log('  不存在，跳过');
  if (restoreBackup(file)) return;
  // 无备份则手动移除 agent-watch 段落
  const content = readFileSync(file, 'utf8');
  const marker = '# --- agent-watch hooks';
  const idx = content.indexOf(marker);
  if (idx === -1) return console.log('  未找到 agent-watch 标记，跳过');
  writeFileSync(file, content.slice(0, idx).replace(/\n{3,}$/, '\n'));
  console.log('  🗑️ 已移除 agent-watch hooks 段落');
}

function uninstallZCode() {
  const file = expandHome('~/.zcode/cli/config.json');
  console.log(`\n[ZCode] ${file}`);
  if (!existsSync(file)) return console.log('  不存在，跳过');
  if (restoreBackup(file)) return;
  stripHooksJson(file);
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
