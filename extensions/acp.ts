import { readFileSync } from 'node:fs';
import { SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';

// 由适配器创建的临时配置，避免覆盖用户或项目的 MCP 设置。
export default function (pi: any) {
  const config = JSON.parse(readFileSync(process.env.PI_ACP_CONFIG!, 'utf8'));
  for (const [name, server] of Object.entries(config.mcpServers)) {
    pi.registerMcpServer(name, server);
  }
  pi.registerCommand('__acp_check', {
    description: '检查 ACP 适配器连接',
    handler: async (_args: string, ctx: any) => ctx.ui.notify('PI_ACP_READY', 'info'),
  });
  pi.registerCommand('__acp_list', {
    description: '列出 ACP 可恢复的 pi 会话',
    handler: async (args: string, ctx: any) => {
      const directory = config.sessionDir || process.env.PI_CODING_AGENT_SESSION_DIR ||
        SettingsManager.create(ctx.cwd).getSessionDir();
      const sessions = args === 'all' ? await SessionManager.listAll(directory)
        : await SessionManager.list(ctx.cwd, directory);
      ctx.ui.notify(`PI_ACP_SESSIONS:${JSON.stringify(sessions.map(session => ({
        sessionId: session.id, cwd: session.cwd, title: session.name || session.firstMessage,
        updatedAt: session.modified.toISOString(), path: session.path,
      })))}`, 'info');
    },
  });
  pi.on('tool_call', async (event: any, ctx: any) => {
    if (['read', 'grep', 'find', 'ls'].includes(event.toolName)) return;
    try {
      const approved = await ctx.ui.confirm('PI_ACP_PERMISSION', JSON.stringify({
        toolCallId: event.toolCallId, toolName: event.toolName, args: event.input,
      }));
      if (!approved) return { block: true, reason: '用户未授权此工具调用' };
    } catch {
      return { block: true, reason: 'IDEA 授权通道不可用' };
    }
  });
}
