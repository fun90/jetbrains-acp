import { randomUUID } from 'node:crypto';
import { Agent, convertPrompt } from './agent.js';
import { gitPatch } from './file-diff.js';

const invalid = message => Object.assign(new Error(message), { code: -32602 });
const options = values => values.map(({ id, ...option }) => ({ configId: id, ...option }));
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const failure = error => ({ code: Number.isInteger(error.code) ? error.code : -32603, message: error.message });

export class ProtocolAgent {
  constructor({ send, ...settings }) {
    this.send = send;
    this.version = 1;
    this.requests = new Map();
    this.jobs = new Map();
    this.active = new Map();
    this.tails = new Map();
    this.replays = new Map();
    this.interactions = new Map();
    this.states = new Map();
    this.agent = new Agent({ ...settings, send: record => this.output(record) });
    this.agent.onUserMessage = (session, id) => {
      const job = this.active.get(session.id);
      if (job && !job.responded) this.accept(job, id);
    };
    this.agent.onForegroundState = (session, state, result) => {
      if (this.version === 2 && !this.active.has(session.id) && (!session.parentId || this.agent.nativeSubagents)) {
        this.state(session.id, state, result);
      }
    };
  }

  error(id, error) {
    this.send({ jsonrpc: '2.0', id, error: failure(error) });
  }

  state(sessionId, state, result = {}) {
    if (this.states.get(sessionId) === state && !Object.keys(result).length) return;
    this.states.set(sessionId, state);
    this.send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId,
      update: { sessionUpdate: 'state_update', state, ...result } } });
  }

  accept(job, messageId) {
    if (job.responded || job.cancelled) return;
    job.responded = true;
    job.inserted = true;
    this.send({ jsonrpc: '2.0', id: job.record.id, result: { messageId } });
    for (const content of job.record.params.prompt) this.send({ jsonrpc: '2.0', method: 'session/update',
      params: { sessionId: job.sessionId, update: { sessionUpdate: 'user_message_chunk', messageId, content } } });
    for (const record of job.buffer.splice(0)) this.output(record);
  }

  cancel(job) {
    job.cancelled = true;
    if (!job.responded) {
      job.responded = true;
      this.error(job.record.id, { code: -32800, message: '提示在插入前已取消' });
    }
  }

  queuePrompt(record) {
    try {
      convertPrompt(record.params?.prompt);
      if (!this.agent.initialized) throw invalid('请先 initialize');
      if (!this.agent.sessions.has(record.params.sessionId)) throw invalid('会话不存在');
      if (this.agent.closing) throw new Error('适配器正在关闭');
    } catch (error) { this.error(record.id, error); return; }
    const job = { record, sessionId: record.params.sessionId, buffer: [], responded: false,
      inserted: false, cancelled: false, started: false, messages: new Map(), tools: new Set() };
    this.jobs.set(record.id, job);
    const previous = this.tails.get(job.sessionId) ?? Promise.resolve();
    const run = previous.catch(() => {}).then(async () => {
      if (job.cancelled) return;
      job.started = true;
      this.active.set(job.sessionId, job);
      this.state(job.sessionId, 'running');
      try {
        const result = await this.agent.dispatch('session/prompt', record.params);
        if (!job.responded) this.accept(job, randomUUID());
        const reported = result._meta?.jetbrains?.air?.sessionFailure;
        if (reported && !job.cancelled) {
          this.finish(job, { stopReason: 'error', error: { code: -32603, message: reported.title }, _meta: result._meta });
        } else this.finish(job, { ...result, ...(job.cancelled ? { stopReason: 'cancelled' } : {}) });
      } catch (error) {
        if (!job.responded) { job.responded = true; this.error(record.id, error); }
        this.finish(job, job.cancelled ? { stopReason: 'cancelled' } : { stopReason: 'error', error: failure(error) });
      } finally {
        this.active.delete(job.sessionId);
        for (const [id, sessionId] of this.interactions) if (sessionId === job.sessionId) this.interactions.delete(id);
      }
    }).finally(() => {
      this.jobs.delete(record.id);
      if (this.tails.get(job.sessionId) === run) this.tails.delete(job.sessionId);
    });
    this.tails.set(job.sessionId, run);
  }

  finish(job, result) {
    if (['error', 'cancelled'].includes(result.stopReason)) {
      for (const toolCallId of job.tools) {
        if ([...this.agent.tasks.tasks.values()].some(task => task.owner === job.sessionId && task.toolCallId === toolCallId)) continue;
        this.output({ jsonrpc: '2.0', method: 'session/update',
          params: { sessionId: job.sessionId, update: { sessionUpdate: 'tool_call_update', toolCallId,
            status: result.stopReason === 'cancelled' ? 'cancelled' : 'failed' } } });
      }
    }
    this.state(job.sessionId, 'idle', result);
  }

  async receive(record) {
    if (!record || Array.isArray(record) || record.jsonrpc !== '2.0' ||
        (record.id !== undefined && record.id !== null && !['string', 'number'].includes(typeof record.id))) {
      return this.agent.receive(record);
    }
    if (record.method === 'initialize') {
      if (!Number.isInteger(record.params?.protocolVersion) || record.params.protocolVersion < 0 || record.params.protocolVersion > 65535) {
        if (record.id !== undefined) this.error(record.id, invalid('protocolVersion 必须是 0 到 65535 的整数'));
        return;
      }
      if (!this.agent.initialized) this.version = record.params.protocolVersion === 1 ? 1 : 2;
    }
    if (this.version === 1) return this.agent.receive(record);
    if (record.method === '$/cancel_request') {
      const job = this.jobs.get(record.params?.requestId);
      if (job && !job.responded) {
        this.cancel(job);
        if (job.started) {
          try { await this.agent.dispatch('session/cancel', { sessionId: job.sessionId }); }
          catch { /* 原提示的完成路径负责报告 cancelled。 */ }
        }
      }
      return;
    }
    if (!record.method) {
      const sessionId = this.interactions.get(record.id);
      this.interactions.delete(record.id);
      if (sessionId && this.agent.permissions.has(record.id) && this.states.get(sessionId) === 'requires_action' &&
          !this.active.get(sessionId)?.cancelled && ![...this.interactions.values()].includes(sessionId)) {
        this.state(sessionId, 'running');
      }
      await this.agent.receive(record);
      return;
    }
    if (typeof record.method !== 'string') return this.agent.receive(record);
    if (record.id === undefined && record.method !== 'session/cancel') return;
    if (record.params != null && !object(record.params)) {
      if (record.id !== undefined) this.error(record.id, invalid('params 必须是对象'));
      return;
    }
    if (['auth/login', 'auth/logout'].includes(record.method) && this.agent.initialized &&
        this.agent.clientCapabilities.auth?.terminal !== true) {
      return this.error(record.id, { code: -32601, message: '客户端未协商终端认证' });
    }
    if (this.agent.loggedOut && !['initialize', 'auth/logout', 'auth/login'].includes(record.method)) {
      if (record.id !== undefined) this.error(record.id, { code: -32000, message: '连接已登出，请完成终端认证后重新连接' });
      return;
    }
    if (record.method === 'auth/logout') for (const job of this.jobs.values()) this.cancel(job);
    if (record.method === 'session/prompt') return this.queuePrompt(record);
    if (['session/resume', 'session/close', 'session/delete', 'session/fork', 'session/cancel', 'session/set_config_option'].includes(record.method) &&
        (typeof record.params?.sessionId !== 'string' || !record.params.sessionId)) {
      if (record.id !== undefined) this.error(record.id, invalid('缺少 sessionId'));
      return;
    }
    if (['session/cancel', 'session/close', 'session/delete'].includes(record.method)) {
      for (const job of this.jobs.values()) if (job.sessionId === record.params?.sessionId) this.cancel(job);
    }
    const request = { ...record, params: record.params ?? {} };
    if (record.method === 'initialize') {
      if (this.agent.initialized) return this.error(record.id, invalid('连接已经初始化'));
      this.agent.protocolVersion = this.version;
      if (!object(request.params.info) || typeof request.params.info.name !== 'string' || typeof request.params.info.version !== 'string') {
        return this.error(record.id, invalid('ACP v2 initialize 缺少 info.name 或 info.version'));
      }
      const capabilities = request.params.capabilities ?? {};
      if (!object(capabilities)) {
        return this.error(record.id, invalid('capabilities 必须是对象'));
      }
      const elicitation = Object.fromEntries(['form', 'url'].filter(mode => object(capabilities.elicitation?.[mode]))
        .map(mode => [mode, capabilities.elicitation[mode]]));
      request.params = { protocolVersion: 1, clientInfo: request.params.info,
        clientCapabilities: { auth: { terminal: object(capabilities.auth?.terminal) }, elicitation, plan: {}, session: { compaction: {}, notices: {} },
          _meta: { ...(object(capabilities._meta) ? capabilities._meta : {}), terminal_output_delta: true } } };
    } else if (['session/new', 'session/resume', 'session/fork'].includes(record.method)) {
      if (request.params.additionalDirectories !== undefined &&
          (!Array.isArray(request.params.additionalDirectories) || request.params.additionalDirectories.length)) {
        return this.error(record.id, invalid('未声明 additionalDirectories 能力，不支持额外工作目录'));
      }
      if (request.params.systemPrompt != null) return this.error(record.id, invalid('未声明 systemPrompt 能力'));
      const servers = request.params.mcpServers ?? [];
      if (!Array.isArray(servers) || servers.some(server => !object(server))) {
        return this.error(record.id, invalid('mcpServers 必须是对象数组'));
      }
      request.params = { ...request.params, mcpServers: servers.map(server => ({ ...server,
        ...(server.type === 'http' ? { headers: server.headers ?? [] } : { args: server.args ?? [], env: server.env ?? [] }) })) };
    }
    if (record.method === 'session/resume') {
      const session = this.agent.sessions.get(request.params.sessionId);
      if (this.agent.lifecycleOperations.has(request.params.sessionId) || this.replays.has(request.params.sessionId) ||
          session?.turn || session?.command || session?.changingConfig) {
        return this.error(record.id, invalid('会话正在使用，请稍后重试'));
      }
      if (request.params.replayFrom != null) {
        if (!object(request.params.replayFrom) || request.params.replayFrom.type !== 'start') {
          return this.error(record.id, invalid('不支持此回放游标'));
        }
        request.method = 'session/load';
        this.replays.set(request.params.sessionId, new Set());
      }
    } else if (record.method === 'session/list') {
      const { cwd, cursor, ...params } = request.params;
      request.params = { ...params, ...(cwd != null ? { cwd } : {}), ...(cursor != null ? { cursor } : {}) };
    } else if (record.method === 'session/set_config_option') {
      if (request.params.type !== 'id' || typeof request.params.value !== 'string') {
        return this.error(record.id, invalid('配置选项需要 type: id 和字符串 value'));
      }
    } else if (['session/load', 'session/set_mode', 'session/set_model', '_session/steering'].includes(record.method)) {
      return this.error(record.id, { code: -32601, message: `ACP v2 不支持此方法：${record.method}` });
    }
    if (record.id !== undefined) this.requests.set(record.id, { method: record.method, sessionId: record.params?.sessionId,
      replaying: request.method === 'session/load' });
    try {
      const result = await this.agent.dispatch(request.method, request.params);
      if (['session/close', 'session/delete'].includes(record.method)) await this.tails.get(record.params.sessionId);
      if (record.method === 'auth/logout') {
        await Promise.allSettled([...this.tails.values()]);
        this.interactions.clear();
        this.states.clear();
      }
      if (record.id !== undefined) this.output({ jsonrpc: '2.0', id: record.id, result });
    } catch (error) {
      if (record.id !== undefined) this.output({ jsonrpc: '2.0', id: record.id, error: failure(error) });
    }
  }

  output(record) {
    if (this.version === 1) { this.send(record); return; }
    if (!record.method) {
      const request = this.requests.get(record.id);
      this.requests.delete(record.id);
      if (request?.replaying) this.replays.delete(request.sessionId);
      if (record.result && request?.method === 'initialize') {
        const result = record.result;
        this.send({ ...record, result: { protocolVersion: 2, info: result.agentInfo,
          capabilities: { session: { prompt: { image: {}, embeddedContext: {} },
            mcp: { stdio: {}, http: {} }, delete: {}, fork: {} } }, authMethods: result.authMethods.map(({ id, env, _meta, ...method }) => ({
            ...method, methodId: id, env: Object.entries(env).map(([name, value]) => ({ name, value })),
          })),
          _meta: { ...result._meta, steering: { supported: false },
            ...(result._meta.jetbrains ? { jetbrains: { air: { ...result._meta.jetbrains.air,
              capabilities: result._meta.jetbrains.air.capabilities.filter(value => value !== 'diffPatch') } } } : {}) },
        } });
      } else if (record.result?.configOptions) {
        const { models, modes, ...result } = record.result;
        this.send({ ...record, result: { ...result, configOptions: options(result.configOptions) } });
        if (['session/new', 'session/resume', 'session/fork'].includes(request?.method)) {
          this.state(result.sessionId ?? request.sessionId, 'idle');
        }
      } else this.send(record);
      if (record.result && ['session/close', 'session/delete'].includes(request?.method)) this.states.delete(request.sessionId);
      return;
    }
    if (record.method === 'session/request_permission' || record.method === 'elicitation/create') {
      const sessionId = record.params.sessionId;
      const owner = this.agent.permissions.get(record.id)?.session;
      if ((!owner?.parentId || owner.id === sessionId) && !this.active.get(sessionId)?.cancelled &&
          (this.active.get(sessionId)?.started || this.active.get(sessionId)?.inserted ||
            ['running', 'requires_action'].includes(this.states.get(sessionId)))) {
        this.state(sessionId, 'requires_action');
        this.interactions.set(record.id, sessionId);
      }
      if (record.method === 'session/request_permission') {
        const { toolCall, ...params } = record.params;
        this.send({ ...record, params: { ...params, title: toolCall.title || '工具授权',
          subject: { type: 'tool_call', toolCall } } });
      } else this.send(record);
      return;
    }
    if (record.method !== 'session/update') { this.send(record); return; }
    const sessionId = record.params.sessionId;
    const job = this.active.get(sessionId);
    if (job && !job.inserted) { job.buffer.push(record); return; }
    let update = record.params.update;
    const emit = value => this.send({ ...record, params: { sessionId, update: value } });
    if (update.sessionUpdate === 'current_mode_update') return;
    if (update.sessionUpdate === 'config_option_update') update = { ...update, configOptions: options(update.configOptions) };
    if (update.sessionUpdate === 'available_commands_update') update = { ...update,
      availableCommands: update.availableCommands.map(command => ({ ...command,
        ...(command.input ? { input: { ...command.input, type: 'text' } } : {}) })) };
    if (update.sessionUpdate === 'plan') update = { sessionUpdate: 'plan_update',
      plan: { type: 'items', planId: 'pi-plan', entries: update.entries } };
    if (['user_message_chunk', 'agent_message_chunk', 'agent_thought_chunk'].includes(update.sessionUpdate)) {
      const messageId = update.messageId ?? job?.messages?.get(update.sessionUpdate) ?? randomUUID();
      job?.messages?.set(update.sessionUpdate, messageId);
      update = { ...update, messageId };
      const replay = this.replays.get(sessionId);
      const key = `${update.sessionUpdate}:${update.messageId}`;
      if (replay && !replay.has(key)) {
        replay.add(key);
        emit({ sessionUpdate: update.sessionUpdate.replace('_chunk', ''), messageId: update.messageId, content: [] });
      }
    }
    if (['tool_call', 'tool_call_update'].includes(update.sessionUpdate)) {
      const { terminal_info: info, terminal_output: output, terminal_output_delta: delta,
        terminal_exit: exit, ...meta } = update._meta ?? {};
      const replay = this.replays.get(sessionId);
      if (info && replay && !replay.has(`terminal:${info.terminal_id}`)) {
        replay.add(`terminal:${info.terminal_id}`);
        emit({ sessionUpdate: 'terminal_update', terminalId: info.terminal_id, output: { data: '' }, exitStatus: null });
      }
      if (info) emit({ sessionUpdate: 'terminal_update', terminalId: info.terminal_id, cwd: info.cwd,
        ...(info.input_enabled === true ? { inputEnabled: true } : {}),
        ...(typeof update.rawInput?.command === 'string' ? { command: update.rawInput.command } : {}) });
      const chunk = delta ?? output;
      if (chunk) emit({ sessionUpdate: 'terminal_output_chunk', terminalId: chunk.terminal_id,
        data: Buffer.from(chunk.data, 'utf8').toString('base64') });
      if (exit) emit({ sessionUpdate: 'terminal_update', terminalId: exit.terminal_id,
        exitStatus: { exitCode: exit.exit_code, signal: exit.signal } });
      const content = [];
      let seenDiff = false;
      for (const block of update.content ?? []) {
        if (block.type !== 'diff') { content.push(block); continue; }
        const patch = gitPatch(block.path, update.rawOutput);
        if (patch) {
          if (!seenDiff) content.push({ type: 'diff', changes: [{ path: block.path,
            operation: patch.kind === 'add' ? 'add' : 'modify' }], patch: { format: 'git_patch', text: patch.text } });
          seenDiff = true;
        } else content.push({ type: 'content', content: { type: 'text',
          text: `${block.path}\n旧内容：\n${block.oldText ?? ''}\n新内容：\n${block.newText}` } });
      }
      const { _meta, ...base } = update;
      update = { ...base, sessionUpdate: 'tool_call_update',
        ...(update.content !== undefined ? { content } : {}), ...(Object.keys(meta).length ? { _meta: meta } : {}) };
      if (job?.tools) {
        if (['completed', 'failed', 'cancelled'].includes(update.status)) job.tools.delete(update.toolCallId);
        else if (['pending', 'in_progress'].includes(update.status)) job.tools.add(update.toolCallId);
      }
    }
    emit(update);
  }

  async close() {
    for (const job of this.jobs.values()) this.cancel(job);
    await this.agent.close();
    await Promise.allSettled([...this.tails.values()]);
    this.interactions.clear();
    this.states.clear();
  }
}
