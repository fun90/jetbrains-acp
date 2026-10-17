import { invalid, logError } from './shared.js';

// 适配器自己实现的斜杠命令（/status、/compact、/goal），以及发布给客户端的命令列表。
export class Commands {
  constructor(agent) {
    this.agent = agent;
  }

  isLocal(text) {
    return text === '/status' || /^\/(compact|goal)(?:\s|$)/.test(text);
  }

  // Air 聊天框中的 /stdin、/eof 转为唯一可输入终端的输入；返回 true 表示已处理。
  async terminalChat(session, prompt) {
    const text = prompt.message;
    if (prompt.images || (!/^\/stdin(?: |$)/.test(text) && text.trim() !== '/eof')) return false;
    const terminals = [...session.inputTerminals];
    if (terminals.length !== 1) throw invalid('需要恰好一个可输入的运行中终端');
    const eof = text.trim() === '/eof';
    await this.agent.terminalInput({ sessionId: session.id, terminalId: terminals[0],
      data: eof ? '' : text.slice('/stdin '.length) + '\n', eof });
    return true;
  }

  async run(session, text, fileReportRequest) {
    const finish = result => {
      if (fileReportRequest) this.agent.sendFileReport(session, { fileReportRequest, changedPaths: new Set(), starts: 0,
        cancelled: session.command?.cancelled, error: session.command?.error });
      return result;
    };
    if (/^\/goal(?:\s|$)/.test(text)) {
      const argument = text.slice('/goal'.length).trim();
      if (!argument) {
        this.agent.update(session, { sessionUpdate: 'agent_message_chunk', content: { type: 'text',
          text: session.goal ? `长期目标（${session.goal.status}）：${session.goal.objective}` : '尚未设置长期目标' } });
      } else {
        await this.agent.lifecycle(session.id, () => this.agent.goalSession({ sessionId: session.id,
          ...(['pause', 'resume', 'clear'].includes(argument)
            ? { action: argument } : { action: 'set', objective: argument }),
        }));
      }
      return finish({ stopReason: 'end_turn' });
    }
    if (text === '/status') {
      const stats = await session.pi.request('get_session_stats');
      const usage = stats.contextUsage;
      const lines = [
        `模型：${session.currentModelId}`,
        `推理级别：${session.thinkingLevel}`,
        `消息：${stats.totalMessages}，工具调用：${stats.toolCalls}`,
        `累计 token：${stats.tokens?.total ?? 0}，成本：$${Number(stats.cost ?? 0).toFixed(4)}`,
        usage ? `上下文：${usage.tokens ?? '待刷新'} / ${usage.contextWindow}${usage.percent == null ? '' : ` (${usage.percent}%)`}` : '上下文：不可用',
      ];
      this.agent.update(session, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: lines.join('\n') } });
      await this.agent.sendUsage(session, stats);
      return finish({ stopReason: 'end_turn' });
    }
    const customInstructions = text.slice('/compact'.length).trim() || undefined;
    const command = { cancelled: false };
    session.command = command;
    session.changingConfig = true;
    try {
      const result = await session.pi.request('compact', customInstructions ? { customInstructions } : {});
      if (command.cancelled) return finish({ stopReason: 'cancelled' });
      if (this.agent.clientCapabilities?.session?.compaction == null) {
        this.agent.update(session, { sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `上下文压缩完成：${result?.tokensBefore ?? '?'} → ${result?.estimatedTokensAfter ?? '?'} tokens` } });
      }
      await this.agent.refreshUsage(session).catch(logError('刷新用量失败'));
      return finish({ stopReason: 'end_turn' });
    } catch (error) {
      if (command.cancelled) return finish({ stopReason: 'cancelled' });
      command.error = error;
      if (this.agent.airSessionFailure) return finish(this.agent.failureResult(session, error));
      finish({});
      throw error;
    } finally {
      session.command = null;
      session.changingConfig = false;
    }
  }

  async publish(session) {
    const result = await session.pi.request('get_commands');
    const availableCommands = new Map([
      ['status', { name: 'status', description: '显示当前模型、token、成本和上下文使用情况', input: null }],
      // Air 的 ACP v1 解析器需要 input 的类型判别字段。
      ['compact', { name: 'compact', description: '压缩对话上下文，可附带摘要要求', input: { type: 'unstructured', hint: '可选摘要要求' } }],
      ['goal', { name: 'goal', description: '设置或查看长期目标，也支持 pause、resume、clear',
        input: { type: 'unstructured', hint: '目标内容或 pause / resume / clear' } }],
    ]);
    if (this.agent.terminalChatInput) {
      availableCommands.set('stdin', { name: 'stdin', description: '向当前运行的终端输入一行文本',
        input: { type: 'unstructured', hint: '输入文本，自动添加换行' } });
      availableCommands.set('eof', { name: 'eof', description: '关闭当前运行终端的 stdin', input: null });
    }
    for (const command of result?.commands ?? []) {
      if (!command?.name || command.name.startsWith('__acp') || availableCommands.has(command.name)) continue;
      availableCommands.set(command.name, { name: command.name,
        description: command.description || command.name, input: null });
    }
    this.agent.update(session, { sessionUpdate: 'available_commands_update',
      availableCommands: [...availableCommands.values()] });
  }
}
