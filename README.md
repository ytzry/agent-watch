# Agent Watch

通过各 agent 的 hook 机制，把 **Claude Code / Codex / ZCode** 的会话事件实时转发到本地 Node 服务，归一化成统一状态，用 WebSocket 推送到 **ofa.js** 前端（手机 / 平板 / 副屏浏览器均可访问）。

## 功能

- **任务卡片流**：首页按项目分组展示所有 agent 会话，每张卡片显示：
  - agent 品牌 logo（非文本）
  - 会话标题（prompt / 最后消息）
  - 状态徽章（执行中 / 等待审批 / 等待回复 / 已完成 / 后台任务 / 压缩中 / 错误 / 已结束）
  - 回复模式（询问 / 自动 / 计划 / 接受编辑 / 完全访问，各家归一化）
  - todo 待办列表（从 `TodoWrite` / `update_plan` 工具解析）
  - 上下文使用进度条（从 rollout / transcript 文件 tail 解析 token 用量）
  - 最后消息摘要
- **声音播报**：每状态可配置是否播报 + 提示音（内置 6 种合成音）+ 音量，存 localStorage
- **WebSocket 实时推送**：状态变化即时更新所有已打开页面
- **目录级适配层**：新增 agent 只需加一个目录 + 注册一行

## 快速开始

```bash
npm install
npm start          # 启动服务，默认 http://0.0.0.0:8799
```

> 默认端口 8799（本机 8787 被 ZCode 的 ace MCP 服务占用）。如需换端口：`AW_PORT=8788 npm start`。

### 安装 hook 配置（自动）

```bash
npm run hooks:install              # 安装全部三家
npm run hooks:install -- --provider=zcode   # 只装 ZCode
```

会备份原配置文件到 `~/.agent-watch-backups/`，然后写入：

| Agent | 配置文件 | hook 方式 |
|---|---|---|
| Claude Code | `~/.claude/settings.json` | 原生 `type:"http"` 直连 |
| Codex | `~/.codex/config.toml` | `[hooks]` command+curl 转发 |
| ZCode | `~/.zcode/cli/config.json` | `hooks.enabled + events` command+curl 转发 |

安装后**完全重启对应 agent 客户端**使 hook 生效。

卸载：

```bash
npm run hooks:uninstall
```

### 手机 / 平板访问

1. 确保手机与 Mac 在同一 Wi-Fi
2. 找到 Mac 局域网 IP：`ipconfig getifaddr en0`（macOS）
3. 浏览器访问 `http://<Mac-IP>:<端口>`（如 `http://192.168.1.2:8799`）

## 架构

```
agent hook (HTTP POST / stdin curl)
        │
        ▼
POST /api/hooks/:provider      ← 统一入口（src/hooks/ingest.js）
        ▼
src/adapters/<provider>/       ← 目录级适配层（payload 归一化）
        ▼
src/hub.js                     ← 状态中枢（纯内存 Map + 状态机 + 广播）
        ▼
src/ws.js                      ← WebSocket 广播（snapshot / state_change）
        ▼
web/  ofa.js 前端（首页卡片流 + 设置页 + 声音播报）
```

```
agent-watch/
├── server.js                  # 入口（Express + WS + 静态）
├── src/
│   ├── config.js              # 端口 / host / hook 转发地址
│   ├── hub.js                 # 会话状态中枢 + 状态机
│   ├── ws.js                  # WebSocket 广播
│   ├── tailer.js              # rollout/transcript 文件 tail（上下文用量）
│   ├── scanner.js             # 启动扫描：恢复历史活跃会话（回显正在跑的任务）
│   ├── zcode-turns.js         # ZCode 轮次轮询：官方 db turn_usage 识别手动中断（中断不发 hook）
│   ├── routes.js
│   ├── hooks/ingest.js        # POST /api/hooks/:provider
│   └── adapters/              # ★ 扩展点：新增 agent 加目录
│       ├── index.js           # 注册表 + 公共字段提取
│       ├── claude-code/       # Claude Code adapter
│       ├── codex/             # Codex adapter
│       └── zcode/             # ZCode adapter
├── scripts/
│   ├── install-hooks.js       # 自动写三家 hook 配置（带备份）
│   └── uninstall-hooks.js
└── web/                       # ofa.js 前端
    ├── index.html
    ├── app-config.js
    ├── pages/home.html        # 首页卡片流
    ├── pages/settings.html    # 声音播报设置
    ├── components/task-card.html
    ├── lib/ofa.mjs            # ofa.js 框架（本地化）
    ├── lib/ws-client.js       # WS 客户端
    └── lib/sound.js           # Web Audio 合成提示音
```

## 扩展新 agent

在 `src/adapters/` 下新建目录（如 `grok/`），包含：

```js
// src/adapters/grok/index.js
import { EVENTS, getSessionId, getCwd } from '../index.js';

export default {
  name: 'grok',
  displayName: 'Grok',
  logo: 'grok',                    // web/assets/logos/grok.svg
  hookConfigPath: '~/.grok/hooks/agent-monitor.json',
  normalize(payload, rawEventName) {
    // 把 grok 的 hook payload 归一化为统一事件模型
    return { provider: 'grok', sessionId: getSessionId(payload), event: EVENTS.SESSION_START, ... };
  },
};
```

然后：
1. `src/adapters/index.js` 的 `listAdapters()` 加 `'grok'`
2. `scripts/install-hooks.js` 加 installers 条目
3. `web/assets/logos/` 加 logo SVG

## 状态机

```
created → running → awaiting_approval → running
                  ↘ waiting_input     → running
                  ↘ idle              → running
                  ↘ background_task   → running
                  ↘ compacting        → running
                  ↘ error             → (可恢复 running)
任意状态 → ended
```

- **awaiting_approval**：PermissionRequest（工具审批）
- **waiting_input**：AskUserQuestion / request_user_input / agent_needs_input（需人回复）
- **idle**：Stop（AI 完成一轮回复）

## 已知限制

- **上下文用量**依赖内部文件格式（ZCode rollout / Claude transcript / Codex rollout 官方标注可能变更），解析容错，变更时降级为不显示
- **todo 列表**：三家均无官方 todo hook，通过捕获 `TodoWrite`（Claude/ZCode）或 `update_plan`（Codex）工具调用解析
- **启动扫描回显**：服务启动时自动恢复活跃会话，无需额外存储——三家都读**官方数据源**（不依赖 hook 猜测）：
  - **Claude Code**：`~/.claude/projects` 下最近写入的 transcript（文件 mtime = 真实对话活动；打开了但没对话的进程没有 jsonl，不会误报成任务；最后一条消息是 user → running，否则 waiting_input）
  - **Codex**：`~/.codex/state_5.sqlite` 的 `threads` 表（官方会话索引：title/cwd/tokens_used/recency_at_ms/archived）
  - **ZCode**：`~/.zcode/cli/db/db.sqlite` 的 `session` 表（title/directory/time_updated/time_archived）
- **正在跑的会话也能看到**：服务启动前就在进行的任务，启动后被扫描回显（状态与官方一致），后续 hook 事件实时更新
- **会话状态机**（参照 Claude-Code-Agent-Monitor 开源方案）：SessionStart → waiting（等输入）、Prompt/工具 → running、Stop → idle（等下一轮）、PermissionRequest → 等待审批；30 分钟无更新自动清扫为 ended（防幽灵会话）
- **上下文用量**（参照 ccusage 开源方案）：Claude 按 `input + output + cache_creation + cache_read` 累计，进度条显示**当前上下文**（最近一次请求 input）；ZCode rollout 的 usage
- **会话标题**（参照开源优先级）：`/rename`/ai-title > 首条 user prompt > 项目名 > 短 ID
- **首版不做回复注入**（仅监控 + 播报），后续可扩展 ZCode 的 PermissionRequest 注入通道
- **ZCode 手动中断不发任何 hook**（zcode.cjs 源码验证：Stop hook 只派发在回复正常完成路径，取消路径无 hook、rollout 也不补记录）。运行中靠轮询官方 db `turn_usage` 表收敛：`cancelled_by_user=1` → 已结束，`completed` → 已完成，`error` → 错误；启动回显也按它修正，被中断的会话不再误恢复成"执行中"
