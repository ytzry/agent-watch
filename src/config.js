export function loadConfig() {
  // 默认 8799：本机 8787 被 ace MCP 服务占用（ZCode 的 IDE 上下文工具），避免冲突
  const port = Number(process.env.AW_PORT || 8799);
  return {
    port,
    host: process.env.AW_HOST || '0.0.0.0',
    // hook 转发目标（默认跟随本服务端口；局域网访问时需改为 Mac 的局域网 IP）
    hookBaseUrl: process.env.AW_HOOK_URL || `http://127.0.0.1:${port}`,
  };
}

export const config = loadConfig();
