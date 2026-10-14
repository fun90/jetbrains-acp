import { Socket } from 'node:net';
import { readFileSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Type } from 'typebox';
import { createBashToolDefinition, createPowerShellToolDefinition, getShellConfig, getPowerShellConfig,
  generateUnifiedPatch, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { readJsonl, writeJsonl } from '../src/jsonl.js';
import { TerminalProcesses } from '../src/terminal-input.js';
import { fileText, MAX_DIFF_BYTES, toolPath } from '../src/file-diff.js';

// 由适配器创建的临时配置，避免覆盖用户或项目的 MCP 设置。
export default function (pi: any) {
  const config = JSON.parse(readFileSync(process.env.PI_ACP_CONFIG!, 'utf8'));
  const channelKey = Symbol.for('pi-acp-control');
  const shared = (process as any)[channelKey] ??= { pending: new Map() };
  const terminals = new TerminalProcesses();
  shared.terminals = terminals;
  let inputChannel: Socket | undefined;
  const pendingTasks: Map<string, { resolve: (value: any) => void; reject: (error: Error) => void }> = shared.pending;
  const taskRequest = (action: string, toolCallId: string, params: any) => new Promise((resolve, reject) => {
    const id = randomUUID();
    pendingTasks.set(id, { resolve, reject });
    if (!inputChannel || inputChannel.destroyed) {
      pendingTasks.delete(id);
      reject(new Error('ACP 任务通道未连接'));
      return;
    }
    writeJsonl(inputChannel, { type: 'acp_task_request', id, action, toolCallId, params });
  });
  const closeChannel = () => {
    shared.terminals.close();
    for (const pending of pendingTasks.values()) pending.reject(new Error('ACP 任务通道已关闭'));
    pendingTasks.clear();
  };
  for (const [event, action] of [
    ['acp:elicitation:url', 'url_elicitation'],
    ['acp:elicitation:complete', 'url_elicitation_complete'],
    ['acp:agent:spawn', 'spawn_agent'],
    ['acp:task:status', 'task_status'],
    ['acp:task:stop', 'stop_task'],
  ]) {
    pi.events.on(event, (request: any) => {
      if (typeof request?.resolve !== 'function' || typeof request?.reject !== 'function') return;
      taskRequest(action, request.toolCallId ?? '', request.params).then(request.resolve, request.reject);
    });
  }
  shared.saveTask = (task: any) => pi.appendEntry('acp_task', task);
  {
    pi.on('session_start', () => {
      // 分叉重载扩展时复用 fd 3，处理器通过 shared 使用当前会话状态。
      inputChannel = shared.socket;
      if (inputChannel) return;
      inputChannel = shared.socket = new Socket({ fd: 3, readable: true, writable: true });
      readJsonl(inputChannel, async (request: any) => {
        if (request.type === 'acp_task_response') {
          const pending = pendingTasks.get(request.id);
          pendingTasks.delete(request.id);
          if (request.success) pending?.resolve(request.data);
          else pending?.reject(new Error(request.error));
          return;
        }
        try {
          if (request.type === 'acp_task_save') shared.saveTask(request.task);
          else await shared.terminals.input(request);
          writeJsonl(inputChannel!, { type: 'response', id: request.id, success: true });
        } catch (error: any) {
          writeJsonl(inputChannel!, { type: 'response', id: request.id, success: false, error: error.message });
        }
      }, () => { closeChannel(); inputChannel?.destroy(); });
      process.once('exit', closeChannel);
      inputChannel.on('error', closeChannel);
      inputChannel.on('end', closeChannel);
    });
    pi.on('session_shutdown', () => terminals.close());
  }
  if (config.terminalInput) {
    for (const name of process.platform === 'win32' ? ['bash', 'powershell'] : ['bash']) {
      const createTool = name === 'bash' ? createBashToolDefinition : createPowerShellToolDefinition;
      const definition = createTool(process.cwd());
      pi.registerTool({ ...definition,
        execute: async (id: string, args: any, signal: AbortSignal, update: any, ctx: any) => {
          const settings = SettingsManager.create(ctx.cwd);
          const tool = createTool(ctx.cwd, {
            commandPrefix: settings.getShellCommandPrefix(),
            operations: { exec: (command: string, cwd: string, options: any) => terminals.exec(id,
              name === 'bash' ? getShellConfig(settings.getShellPath()) : getPowerShellConfig(),
              command, cwd, options, () => ctx.ui.notify(`PI_ACP_TERMINAL_READY:${id}`, 'info')) },
          });
          return tool.execute(id, args, signal, update, ctx);
        },
      });
    }
  }
  for (const [name, description, parameters] of [
    ['spawn_agent', '创建独立上下文的子 agent 并在后台执行；返回 taskId，使用 task_status 查询，stop_task 停止。',
      Type.Object({ prompt: Type.String({ minLength: 1 }), name: Type.Optional(Type.String()) })],
    ['background_shell', '启动后台 shell 命令；返回 taskId，使用 task_status 查询输出，stop_task 停止整个进程组。',
      Type.Object({ command: Type.String({ minLength: 1 }), timeout: Type.Optional(Type.Number({ minimum: 0.001 })) })],
    ['task_status', '查询本会话创建的后台命令或子 agent 的状态与最近输出。', Type.Object({ taskId: Type.String() })],
    ['stop_task', '仅停止指定 taskId 的后台命令或子 agent，不影响其他任务。', Type.Object({ taskId: Type.String() })],
  ] as const) {
    pi.registerTool({ name, label: name, description, parameters,
      execute: async (id: string, args: any, _signal: AbortSignal, _update: any, ctx: any) => {
        let params = args;
        if (name === 'background_shell') {
          const settings = SettingsManager.create(ctx.cwd);
          const prefix = settings.getShellCommandPrefix();
          params = { ...args, command: prefix ? `${prefix}\n${args.command}` : args.command,
            shell: getShellConfig(settings.getShellPath()) };
        }
        const result = await taskRequest(name, id, params);
        return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
      },
    });
  }
  const mutations = new Map<string, { path: string; conflicted: boolean; oldText?: string | null }>();
  let planMode = false;
  let goal: { status: string; objective: string } | null = null;
  pi.on('before_agent_start', (event: any) => {
    const sections = { ...event.systemPromptOptions.sections };
    delete sections.acp_client_instructions;
    delete sections.acp_plan_mode;
    delete sections.acp_goal;
    event.systemPromptOptions.sections = {
      ...sections,
      ...(config.customInstructions ? { acp_client_instructions: config.customInstructions } : {}),
      ...(planMode ? { acp_plan_mode: '只分析问题并制定可执行计划，不修改文件、不执行命令或其他有副作用的工具。' } : {}),
      ...(goal?.status === 'active' ? { acp_goal: `本会话长期目标：${goal.objective}` } : {}),
    };
  });
  pi.registerCommand('__acp_mode', {
    description: '切换 ACP 规划模式',
    handler: async (args: string) => { planMode = args.trim() === 'plan'; },
  });
  pi.registerCommand('__acp_fork', {
    description: '在指定历史条目之后分叉 ACP 会话',
    handler: async (args: string, ctx: any) => {
      await ctx.fork(JSON.parse(args), { position: 'at' });
    },
  });
  pi.registerCommand('__acp_goal', {
    description: '同步 ACP 长期目标',
    handler: async (args: string) => {
      const value = JSON.parse(args);
      if (value !== null && (typeof value?.objective !== 'string' ||
          !['active', 'paused'].includes(value.status))) throw new Error('ACP goal 无效');
      pi.appendEntry('acp_goal', value);
      goal = value;
    },
  });
  pi.registerTool({
    name: 'update_plan', label: '更新计划',
    description: '用结构化步骤更新当前任务的执行计划和进度。仅记录计划，不执行文件或命令操作。',
    parameters: Type.Object({ entries: Type.Array(Type.Object({
      content: Type.String({ minLength: 1, maxLength: 10000 }),
      priority: Type.Union([Type.Literal('high'), Type.Literal('medium'), Type.Literal('low')]),
      status: Type.Union([Type.Literal('pending'), Type.Literal('in_progress'), Type.Literal('completed')]),
    }), { maxItems: 100 }) }),
    execute: async (_id: string, input: any) => ({
      content: [{ type: 'text', text: '计划已更新' }], details: { acpPlan: input.entries },
    }),
  });
  const messageIds = new Map<string, string>();
  pi.on('message_start', (event: any, ctx: any) => {
    if (!['user', 'assistant'].includes(event.message?.role)) return;
    const id = randomUUID();
    messageIds.set(event.message.role, id);
    ctx.ui.notify(`PI_ACP_MESSAGE:${JSON.stringify({ role: event.message.role, id })}`, 'info');
  });
  pi.on('message_end', (event: any) => {
    const id = messageIds.get(event.message?.role);
    if (id && ['user', 'assistant'].includes(event.message?.role)) {
      return { message: { ...event.message, acpMessageId: id } };
    }
  });
  const archiveCache = new Map<string, { modified: number; archived: boolean }>();
  for (const [name, server] of Object.entries(config.mcpServers)) {
    pi.registerMcpServer(name, server);
  }
  pi.registerCommand('__acp_check', {
    description: '检查 ACP 适配器连接',
    handler: async (_args: string, ctx: any) => {
      goal = ctx.sessionManager.getBranch().findLast((entry: any) =>
        entry.type === 'custom' && entry.customType === 'acp_goal')?.data ?? null;
      ctx.ui.notify(`PI_ACP_GOAL:${JSON.stringify(goal)}`, 'info');
      ctx.ui.notify('PI_ACP_READY', 'info');
    },
  });
  pi.registerCommand('__acp_archive', {
    description: '同步 ACP 归档状态',
    handler: async (args: string) => { pi.appendEntry('acp_archive', args.trim() === 'true'); },
  });
  pi.registerCommand('__acp_list', {
    description: '列出 ACP 可恢复的 pi 会话',
    handler: async (args: string, ctx: any) => {
      const directory = config.sessionDir || process.env.PI_CODING_AGENT_SESSION_DIR ||
        SettingsManager.create(ctx.cwd).getSessionDir();
      const options = args.startsWith('{') ? JSON.parse(args) : { all: args === 'all', cwds: [ctx.cwd] };
      const lists = options.all ? [await SessionManager.listAll(directory)]
        : await Promise.all((options.cwds ?? [ctx.cwd]).map((cwd: string) => SessionManager.list(cwd, directory)));
      const sessions = [...new Map(lists.flat().map((session: any) => [session.id, session])).values()] as any[];
      const currentPaths = new Set(sessions.map(session => session.path));
      const idsByPath = new Map(sessions.map(session => [session.path, session.id]));
      for (const path of archiveCache.keys()) if (!currentPaths.has(path)) archiveCache.delete(path);
      ctx.ui.notify(`PI_ACP_SESSIONS:${JSON.stringify(sessions.map(session => {
        const modified = statSync(session.path).mtimeMs;
        let cached = archiveCache.get(session.path);
        if (!cached || cached.modified !== modified) {
          const archived = SessionManager.open(session.path).getBranch().findLast((entry: any) =>
            entry.type === 'custom' && entry.customType === 'acp_archive')?.data === true;
          cached = { modified, archived };
          archiveCache.set(session.path, cached);
        }
        return { sessionId: session.id, cwd: session.cwd, title: session.name || session.firstMessage,
          updatedAt: session.modified.toISOString(), path: session.path, archived: cached.archived,
          ...(idsByPath.has(session.parentSessionPath) ? { forkedFrom: idsByPath.get(session.parentSessionPath) } : {}) };
      }))}`, 'info');
    },
  });
  pi.on('tool_call', async (event: any, ctx: any) => {
    if (['read', 'grep', 'find', 'ls', 'update_plan', 'task_status'].includes(event.toolName)) return;
    if (planMode) return { block: true, reason: '规划模式不允许此工具调用' };
    try {
      const approved = await ctx.ui.confirm('PI_ACP_PERMISSION', JSON.stringify({
        toolCallId: event.toolCallId, toolName: event.toolName, args: event.input,
      }));
      if (!approved) return { block: true, reason: '用户未授权此工具调用' };
    } catch {
      return { block: true, reason: 'IDEA 授权通道不可用' };
    }
    if (!['edit', 'write'].includes(event.toolName) || typeof event.input?.path !== 'string') return;
    try {
      const path = toolPath(ctx.cwd, event.input.path);
      const mutation = { path, conflicted: false, oldText: undefined as string | null | undefined };
      for (const other of mutations.values()) {
        if (other.path === path) { other.conflicted = true; mutation.conflicted = true; }
      }
      mutations.set(event.toolCallId, mutation);
      if (event.toolName === 'write' && typeof event.input.content === 'string' &&
          Buffer.byteLength(event.input.content) <= MAX_DIFF_BYTES) {
        // shortcut: 快照不在 pi 文件锁内，外部并发修改时需在工具操作层捕获。
        mutation.oldText = await fileText(path);
      }
    } catch {
      // 展示元数据不可用不应阻止已经授权的工具。
    }
  });
  pi.on('tool_result', (event: any) => {
    const mutation = mutations.get(event.toolCallId);
    mutations.delete(event.toolCallId);
    if (event.toolName !== 'write' || event.isError || !mutation || mutation.conflicted ||
        mutation.oldText === undefined || typeof event.input?.content !== 'string' ||
        Buffer.byteLength((mutation.oldText ?? '') + event.input.content) > MAX_DIFF_BYTES ||
        event.input.content.includes('\0')) return;
    return { details: { ...event.details, patch: generateUnifiedPatch(event.input.path,
      mutation.oldText ?? '', event.input.content), acpDiff: {
      path: mutation.path, oldText: mutation.oldText, newText: event.input.content,
    } } };
  });
  pi.on('agent_settled', () => { mutations.clear(); });
}
