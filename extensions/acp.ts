import { readFileSync } from 'node:fs';

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
