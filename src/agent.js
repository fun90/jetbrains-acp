import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PiProcess } from './pi.js';

const extensionPath = fileURLToPath(new URL('../extensions/acp.ts', import.meta.url));
const invalid = message => Object.assign(new Error(message), { code: -32602 });
const toolKind = name => ({ read: 'read', grep: 'search', find: 'search', ls: 'read',
  write: 'edit', edit: 'edit', bash: 'execute', powershell: 'execute' })[name] || 'other';

export function convertMcp(servers) {
  if (!Array.isArray(servers)) throw invalid('mcpServers 必须是数组');
  const result = Object.create(null);
  const names = new Set();
  for (const server of servers) {
    if (!server || typeof server.name !== 'string' || !/^[\w-]+$/.test(server.name)) {
      throw invalid('MCP 名称只允许字母、数字、下划线和连字符');
    }
    const key = server.name.replaceAll('-', '_');
    if (names.has(key)) throw invalid('MCP 名称重复');
    names.add(key);
    if (server.type === 'http') {
      if (typeof server.url !== 'string' || !/^https?:\/\//.test(server.url) ||
          !Array.isArray(server.headers) || server.headers.some(h =>
            !h || typeof h.name !== 'string' || typeof h.value !== 'string')) {
        throw invalid('HTTP MCP 配置无效');
      }
      result[server.name] = { url: server.url,
        headers: Object.fromEntries(server.headers.map(h => [h.name, h.value])), exposure: 'direct' };
    } else if (!server.type || server.type === 'stdio') {
      if (typeof server.command !== 'string' || !isAbsolute(server.command) ||
          !Array.isArray(server.args) || server.args.some(a => typeof a !== 'string') ||
          !Array.isArray(server.env) || server.env.some(e =>
            !e || typeof e.name !== 'string' || typeof e.value !== 'string')) {
        throw invalid('stdio MCP 需要绝对命令路径、args 和 env 数组');
      }
      result[server.name] = { command: server.command, args: server.args,
        env: Object.fromEntries(server.env.map(e => [e.name, e.value])), exposure: 'direct' };
    } else throw invalid(`不支持 MCP 传输：${server.type}`);
  }
  return result;
}

export function convertPrompt(blocks) {
  if (!Array.isArray(blocks) || !blocks.length) throw invalid('prompt 必须包含内容');
  const text = [];
  const images = [];
  for (const block of blocks) {
    if (block?.type === 'text' && typeof block.text === 'string') text.push(block.text);
    else if (block?.type === 'image' && typeof block.data === 'string' &&
             typeof block.mimeType === 'string' && block.mimeType.startsWith('image/')) {
      images.push({ type: 'image', data: block.data, mimeType: block.mimeType });
    } else if (block?.type === 'resource' && typeof block.resource?.text === 'string') {
      text.push(`文件上下文（${block.resource.uri}）：\n${block.resource.text}`);
    } else if (block?.type === 'resource_link' && typeof block.uri === 'string') {
      text.push(`引用资源：${block.uri}`);
    } else throw invalid(`不支持的提示内容：${block?.type}`);
  }
  return { message: text.join('\n\n'), ...(images.length ? { images } : {}) };
}

export class Agent {
  constructor({ send, command = 'pi', args = [] }) {
    this.send = send;
    this.command = command;
    this.args = args;
    this.sessions = new Map();
    this.permissions = new Map();
    this.sequence = 0;
    this.initialized = false;
    this.closing = false;
  }

  update(session, update) {
    this.send({ jsonrpc: '2.0', method: 'session/update',
      params: { sessionId: session.id, update } });
  }

  async receive(message) {
    if (!message || Array.isArray(message) || message.jsonrpc !== '2.0' ||
        (message.id !== undefined && message.id !== null &&
         typeof message.id !== 'string' && typeof message.id !== 'number')) {
      this.send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: '无效的 JSON-RPC 请求' } });
      return;
    }
    if (!message.method && ('result' in message || 'error' in message)) {
      const permission = this.permissions.get(message.id);
      if (permission) {
        this.permissions.delete(message.id);
        permission.resolve(message.result);
      }
      return;
    }
    if (typeof message.method !== 'string') {
      this.send({ jsonrpc: '2.0', id: message.id ?? null,
        error: { code: -32600, message: '缺少 method' } });
      return;
    }
    // ACP 的 cancel 是通知；其他操作需要请求 ID。
    if (message.id === undefined && message.method !== 'session/cancel') return;
    try {
      const result = await this.dispatch(message.method, message.params ?? {});
      if (message.id !== undefined) this.send({ jsonrpc: '2.0', id: message.id, result });
    } catch (error) {
      if (message.id !== undefined) this.send({ jsonrpc: '2.0', id: message.id,
        error: { code: error.code ?? -32603, message: error.message } });
      else process.stderr.write(`通知处理失败：${error.message}\n`);
    }
  }

  async dispatch(method, params) {
    if (!params || typeof params !== 'object' || Array.isArray(params)) throw invalid('params 必须是对象');
    if (method === 'initialize') {
      if (!Number.isInteger(params.protocolVersion)) throw invalid('缺少 protocolVersion');
      this.initialized = true;
      return { protocolVersion: 1, agentInfo: { name: 'pi-acp', title: 'pi', version: '0.1.0' },
        agentCapabilities: { loadSession: false,
          promptCapabilities: { image: true, embeddedContext: true },
          mcpCapabilities: { http: true, sse: false } }, authMethods: [] };
    }
    if (!this.initialized) throw invalid('请先 initialize');
    if (this.closing) throw new Error('适配器正在关闭');
    if (method === 'session/new') return this.newSession(params);
    if (!['session/prompt', 'session/cancel', 'session/set_model', 'session/set_config_option'].includes(method)) {
      throw Object.assign(new Error(`不支持的方法：${method}`), { code: -32601 });
    }
    const session = this.sessions.get(params.sessionId);
    if (!session) throw invalid('会话不存在');
    if (session.failure) throw session.failure;
    if (method === 'session/set_model' || method === 'session/set_config_option') {
      const configId = method === 'session/set_model' ? 'model' : params.configId;
      const value = method === 'session/set_model' ? params.modelId : params.value;
      if (!['model', 'thinking'].includes(configId)) throw invalid('未知配置选项');
      const model = configId === 'model' ? session.availableModels.find(model => `${model.provider}/${model.id}` === value) : null;
      if (configId === 'model' && !model) throw invalid('模型不在可用列表中');
      if (configId === 'thinking' && !session.thinkingLevels.includes(value)) throw invalid('当前模型不支持此推理级别');
      if (session.changingConfig) throw invalid('配置正在切换，请稍后重试');
      session.changingConfig = true;
      try {
        if (configId === 'model') {
          await session.pi.request('set_model', { provider: model.provider, modelId: model.id });
          session.currentModelId = value;
        } else await session.pi.request('set_thinking_level', { level: value });
        await this.refreshThinking(session);
        const configOptions = this.modelConfig(session);
        this.update(session, { sessionUpdate: 'config_option_update', configOptions });
        return method === 'session/set_model' ? {} : { configOptions };
      } finally {
        session.changingConfig = false;
      }
    }
    if (method === 'session/cancel') {
      if (session.turn) {
        const turn = session.turn;
        turn.cancelled = true;
        this.cancelPermissions(session);
        await session.pi.request('clear_queue');
        if (session.turn === turn) await session.pi.request('abort');
      }
      return {};
    }
    if (session.turn) throw invalid('该会话已有正在执行的提示');
    if (session.changingConfig) throw invalid('配置正在切换，请稍后重试');
    const prompt = convertPrompt(params.prompt);
    let settle;
    const completed = new Promise(resolve => { settle = resolve; });
    const turn = { settle, cancelled: false, error: null, stopReason: 'end_turn' };
    session.turn = turn;
    try {
      const accepted = await session.pi.request('prompt', prompt);
      if (accepted?.disposition === 'handled') turn.settle();
      await completed;
      if (turn.cancelled) return { stopReason: 'cancelled' };
      if (turn.error) throw turn.error;
      return { stopReason: turn.stopReason };
    } finally {
      this.cancelPermissions(session);
      session.turn = null;
    }
  }

  async newSession(params) {
    if (typeof params.cwd !== 'string' || !isAbsolute(params.cwd)) throw invalid('cwd 必须是绝对路径');
    if (!(await stat(params.cwd)).isDirectory()) throw invalid('cwd 必须是目录');
    const mcpServers = convertMcp(params.mcpServers);
    const directory = await mkdtemp(join(tmpdir(), 'pi-acp-'));
    const configPath = join(directory, 'config.json');
    const session = { id: randomUUID(), cwd: params.cwd, directory, turn: null, tools: new Map(), blocks: new Map() };
    this.sessions.set(session.id, session);
    try {
      await writeFile(configPath, JSON.stringify({ mcpServers }), { mode: 0o600 });
      if (this.closing) throw new Error('适配器正在关闭');
      session.pi = new PiProcess({ command: this.command,
        args: [...this.args, '--mode', 'rpc', '--no-session', '--extension', extensionPath],
        cwd: params.cwd, configPath,
        onEvent: event => this.event(session, event),
        onFailure: error => {
          session.failure = error;
          if (session.turn) { session.turn.error = error; session.turn.settle(); }
          this.cancelPermissions(session);
        } });
      const state = await session.pi.request('get_state');
      await session.pi.request('prompt', { message: '/__acp_check' });
      if (!session.ready) throw new Error('ACP 扩展未就绪，请使用 pi 1.1.0 或兼容版本');
      if (session.failure) throw session.failure;
      const available = await session.pi.request('get_available_models');
      session.availableModels = available?.models ?? [];
      if (state?.model && !session.availableModels.some(model =>
        model.provider === state.model.provider && model.id === state.model.id)) {
        session.availableModels.push(state.model);
      }
      const current = state?.model ?? session.availableModels[0];
      if (!current) throw new Error('pi 没有可用模型，请先在终端运行 pi 配置模型提供商及登录信息');
      if (!state?.model) await session.pi.request('set_model', { provider: current.provider, modelId: current.id });
      session.currentModelId = `${current.provider}/${current.id}`;
      await this.refreshThinking(session);
      return { sessionId: session.id, configOptions: this.modelConfig(session), models: {
        currentModelId: session.currentModelId,
        availableModels: session.availableModels.map(model => ({
          modelId: `${model.provider}/${model.id}`, name: `${model.name || model.id} (${model.provider})`,
        })),
      } };
    } catch (error) {
      this.sessions.delete(session.id);
      await session.pi?.close();
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }

  async refreshThinking(session) {
    const [state, available] = await Promise.all([
      session.pi.request('get_state'), session.pi.request('get_available_thinking_levels'),
    ]);
    session.thinkingLevel = state.thinkingLevel;
    session.thinkingLevels = available.levels;
  }

  modelConfig(session) {
    return [{ id: 'model', name: '模型', category: 'model', type: 'select',
      currentValue: session.currentModelId,
      options: session.availableModels.map(model => ({
        value: `${model.provider}/${model.id}`, name: `${model.name || model.id} (${model.provider})`,
      })),
    }, { id: 'thinking', name: '推理级别', category: 'thought_level', type: 'select',
      currentValue: session.thinkingLevel,
      options: session.thinkingLevels.map(level => ({ value: level,
        name: ({ off: '关闭', minimal: '最低', low: '低', medium: '中', high: '高', xhigh: '极高', max: '最高' })[level] || level,
      })),
    }];
  }

  tool(session, event) {
    const name = event.toolName;
    return { toolCallId: event.toolCallId, title: name, kind: toolKind(name),
      rawInput: event.args,
      ...(typeof event.args?.path === 'string' ? { locations: [{ path: resolve(session.cwd, event.args.path) }] } : {}) };
  }

  content(result) {
    return (result?.content ?? []).filter(c => ['text', 'image'].includes(c.type))
      .map(content => ({ type: 'content', content }));
  }

  event(session, event) {
    if (event.type === 'thinking_level_changed' && session.thinkingLevels && !session.changingConfig) {
      session.thinkingLevel = event.level;
      this.update(session, { sessionUpdate: 'config_option_update', configOptions: this.modelConfig(session) });
      return;
    }
    if (event.type === 'extension_ui_request') {
      void this.ui(session, event).catch(error => {
        process.stderr.write(`扩展交互失败：${error.message}\n`);
        if (!session.pi.closed) session.pi.send({ type: 'extension_ui_response', id: event.id, cancelled: true });
      });
      return;
    }
    if (event.type === 'extension_error' && event.extensionPath === extensionPath) {
      const error = new Error(`ACP 扩展失败：${event.error}`);
      session.failure = error;
      session.pi.fail(error, () => {
        if (session.turn) { session.turn.error = error; session.turn.settle(); }
        this.cancelPermissions(session);
      });
      return;
    }
    if (!session.turn) return;
    switch (event.type) {
      case 'message_start':
        if (event.message?.role === 'assistant') {
          session.blocks.clear();
          session.turn.error = null;
          session.turn.stopReason = 'end_turn';
        }
        break;
      case 'message_update': {
        const delta = event.assistantMessageEvent;
        if (delta?.type === 'text_delta' || delta?.type === 'thinking_delta') {
          session.blocks.set(delta.contentIndex, (session.blocks.get(delta.contentIndex) || '') + delta.delta);
          this.update(session, { sessionUpdate: delta.type === 'text_delta' ? 'agent_message_chunk' : 'agent_thought_chunk',
            content: { type: 'text', text: delta.delta } });
        }
        break;
      }
      case 'message_end': {
        const message = event.message;
        if (message?.role !== 'assistant') break;
        for (const [index, block] of (message.content ?? []).entries()) {
          const text = block.type === 'text' ? block.text : block.type === 'thinking' ? block.thinking : null;
          const streamed = session.blocks.get(index) || '';
          if (text && text.startsWith(streamed) && text.length > streamed.length) {
            this.update(session, { sessionUpdate: block.type === 'text' ? 'agent_message_chunk' : 'agent_thought_chunk',
              content: { type: 'text', text: text.slice(streamed.length) } });
          }
        }
        if (message.stopReason === 'error') session.turn.error = new Error(message.errorMessage || '模型执行失败');
        if (message.stopReason === 'length') session.turn.stopReason = 'max_tokens';
        if (message.stopReason === 'aborted') session.turn.cancelled = true;
        break;
      }
      case 'tool_execution_start': {
        const tool = this.tool(session, event);
        session.tools.set(event.toolCallId, tool);
        this.update(session, { sessionUpdate: 'tool_call', ...tool,
          status: ['read', 'grep', 'find', 'ls'].includes(event.toolName) ? 'in_progress' : 'pending' });
        break;
      }
      case 'tool_execution_update':
      case 'tool_execution_end':
        this.update(session, { sessionUpdate: 'tool_call_update', toolCallId: event.toolCallId,
          status: event.type === 'tool_execution_update' ? 'in_progress' : event.isError ? 'failed' : 'completed',
          content: this.content(event.result ?? event.partialResult), rawOutput: event.result ?? event.partialResult });
        if (event.type === 'tool_execution_end') session.tools.delete(event.toolCallId);
        break;
      case 'auto_retry_end':
        if (!event.success) session.turn.error = new Error(event.finalError || '模型重试失败');
        break;
      case 'agent_settled':
        if (event.aborted) session.turn.cancelled = true;
        session.turn.settle();
        break;
    }
  }

  async ui(session, event) {
    if (event.method === 'notify' && event.message === 'PI_ACP_READY') {
      session.ready = true;
      return;
    }
    if (event.method !== 'confirm' || event.title !== 'PI_ACP_PERMISSION') {
      if (['confirm', 'select', 'input', 'editor'].includes(event.method)) {
        session.pi.send({ type: 'extension_ui_response', id: event.id, cancelled: true });
        if (session.turn) this.update(session, { sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `\n扩展交互暂不支持：${event.title ?? event.method}\n` } });
      }
      return;
    }
    const call = JSON.parse(event.message);
    if (!session.turn || session.turn.cancelled) {
      session.pi.send({ type: 'extension_ui_response', id: event.id, cancelled: true });
      return;
    }
    const tool = session.tools.get(call.toolCallId) ?? this.tool(session, call);
    const id = `acp-permission-${++this.sequence}`;
    const decision = new Promise(resolve => this.permissions.set(id, { session, resolve }));
    this.send({ jsonrpc: '2.0', id, method: 'session/request_permission',
      params: { sessionId: session.id, toolCall: { ...tool, status: 'pending' }, options: [
        { optionId: 'allow-once', name: '允许本次', kind: 'allow_once' },
        { optionId: 'reject-once', name: '拒绝本次', kind: 'reject_once' },
      ] } });
    const result = await decision;
    const approved = !session.turn?.cancelled && result?.outcome?.outcome === 'selected' &&
      result.outcome.optionId === 'allow-once';
    if (!session.pi.closed) session.pi.send({ type: 'extension_ui_response', id: event.id, confirmed: approved });
    if (approved) this.update(session, { sessionUpdate: 'tool_call_update', toolCallId: call.toolCallId, status: 'in_progress' });
  }

  cancelPermissions(session) {
    for (const [id, permission] of this.permissions) {
      if (permission.session === session) {
        this.permissions.delete(id);
        permission.resolve(undefined);
      }
    }
  }

  async close() {
    this.closing = true;
    await Promise.all([...this.sessions.values()].map(async session => {
      this.cancelPermissions(session);
      await session.pi?.close();
      await rm(session.directory, { recursive: true, force: true });
    }));
    this.sessions.clear();
  }
}
