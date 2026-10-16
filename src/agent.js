import packageInfo from '../package.json' with { type: 'json' };
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { isDeepStrictEqual, promisify } from 'node:util';
import { mkdtemp, writeFile, rm, stat, unlink, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateTerminalInput } from './terminal-input.js';
import { PiProcess } from './pi.js';
import { Tasks } from './tasks.js';
import { gitPatch, fileDiffs, toolPath } from './file-diff.js';
import { changedFiles, fileSnapshot } from './file-changes.js';

const executeFile = promisify(execFile);
const extensionPath = fileURLToPath(new URL('../extensions/acp.ts', import.meta.url));
const invalid = message => Object.assign(new Error(message), { code: -32602 });
const modes = {
  zh: [
    { id: 'plan', name: '规划', description: '只分析和制定计划，自动拒绝修改文件及执行命令' },
    { id: 'read-only', name: '只读', description: '自动拒绝写文件、执行命令及其他非内置只读工具' },
    { id: 'standard', name: '标准访问', description: '写文件、执行命令及其他非内置只读工具逐次请求授权' },
    { id: 'full', name: '完全访问', description: '本会话自动允许全部工具调用，包括写文件和执行命令' },
  ],
  en: [
    { id: 'plan', name: 'Plan', description: 'Analyze and plan only; automatically deny file changes and command execution' },
    { id: 'read-only', name: 'Read Only', description: 'Automatically deny file writes, command execution, and tools other than built-in read-only tools' },
    { id: 'standard', name: 'Standard Access', description: 'Request approval for each file write, command execution, or tool other than built-in read-only tools' },
    { id: 'full', name: 'Full Access', description: 'Automatically allow all tool calls in this session, including file writes and command execution' },
  ],
};
const toolKind = name => ({ read: 'read', grep: 'search', find: 'search', ls: 'read',
  write: 'edit', edit: 'edit', update_plan: 'think', background_shell: 'execute', bash: 'execute', powershell: 'execute' })[name] || 'other';

function suffixPrefixOverlap(previous, next) {
  const values = [
    ...Array.from(next, character => character.codePointAt(0)),
    -1,
    ...Array.from(previous, character => character.codePointAt(0)).slice(-[...next].length),
  ];
  const prefix = new Array(values.length).fill(0);
  for (let index = 1; index < values.length; index++) {
    let matched = prefix[index - 1];
    while (matched && values[index] !== values[matched]) matched = prefix[matched - 1];
    if (values[index] === values[matched]) matched++;
    prefix[index] = matched;
  }
  return Math.min(prefix.at(-1), next.length);
}

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
    const locale = process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG ||
      Intl.DateTimeFormat().resolvedOptions().locale;
    this.chinese = /^zh(?:[-_.@]|$)/i.test(locale);
    this.modes = modes[this.chinese ? 'zh' : 'en'];
    this.send = send;
    this.command = command;
    this.args = args;
    this.sessions = new Map();
    this.tasks = new Tasks(this);
    this.permissions = new Map();
    this.urlElicitations = new Map();
    this.lifecycleOperations = new Map();
    this.subscriptions = new Map();
    this.sequence = 0;
    this.clientCapabilities = {};
    this.initialized = false;
    this.closing = false;
  }

  update(session, update) {
    if (this.tasks.childUpdate(session, update)) return;
    if (!update.messageId && session.turn && ['agent_message_chunk', 'agent_thought_chunk'].includes(update.sessionUpdate) &&
        session.assistantMessageId) {
      update = { ...update, messageId: update.sessionUpdate === 'agent_thought_chunk'
        ? `${session.assistantMessageId}:thinking` : session.assistantMessageId };
    }
    this.send({ jsonrpc: '2.0', method: 'session/update',
      params: { sessionId: session.id, update } });
  }

  lifecycle(sessionId, operation) {
    if (typeof sessionId !== 'string' || !sessionId) return operation();
    const previous = this.lifecycleOperations.get(sessionId) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    this.lifecycleOperations.set(sessionId, current);
    return current.finally(() => {
      if (this.lifecycleOperations.get(sessionId) === current) this.lifecycleOperations.delete(sessionId);
    });
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
      this.clientCapabilities = params.clientCapabilities ?? {};
      const air = this.clientCapabilities?._meta?.jetbrains?.air;
      const airCapabilities = air?.version >= 1 && Array.isArray(air.capabilities) ? air.capabilities : [];
      this.airDiffPatch = airCapabilities.includes('diffPatch');
      this.airFileReport = airCapabilities.includes('agentFileChangeReport');
      this.airClient = air != null && typeof air === 'object' && !Array.isArray(air);
      this.airCustomInstructions = airCapabilities.includes('customInstructions');
      this.airRecommendedValue = airCapabilities.includes('recommendedValue');
      this.airSessionFailure = airCapabilities.includes('sessionFailure');
      this.airIndex = airCapabilities.includes('sessionIndex');
      const subagents = this.clientCapabilities.subagents;
      this.nativeSubagents = (subagents != null && typeof subagents === 'object' && !Array.isArray(subagents)) ||
        airCapabilities.includes('nativeSubagentSessions');
      this.asyncTasks = airCapabilities.includes('asyncTasks');
      this.terminalChatInput = this.airClient && this.protocolVersion !== 2;
      this.terminalInputEnabled = this.clientCapabilities?._meta?.terminal_input === true || this.terminalChatInput;
      this.initialized = true;
      return { protocolVersion: 1, agentInfo: { name: packageInfo.name, title: 'pi', version: packageInfo.version },
        agentCapabilities: { loadSession: true, sessionCapabilities: {
          list: {}, resume: {}, close: {}, delete: {}, fork: {}, subagents: {},
        },
          promptCapabilities: { image: true, embeddedContext: true },
          mcpCapabilities: { http: true, sse: false } }, authMethods: this.clientCapabilities.auth?.terminal === true || this.clientCapabilities._meta?.['terminal-auth'] === true
          ? [{ id: 'pi-login', name: '登录 pi 模型提供商',
            description: '在终端 pi 中输入 /login，完成登录后退出并返回 IDE', type: 'terminal',
            env: { PI_ACP_SETUP: '1' },
            _meta: { 'terminal-auth': { args: ['--setup', '--pi-command', this.command, '--', ...this.args] } } }]
          : [],
        _meta: { steering: { supported: true },
          terminal_input: { supported: true, controlMethod: '_terminal/input', encoding: 'utf8', maxBytes: 65536 },
          ...(air && typeof air === 'object' ? { jetbrains: { air: { version: 1,
            goal: { version: 1, controlMethod: '_session/goal', actions: ['set', 'pause', 'resume', 'clear'] },
            capabilities: ['diffPatch', 'agentFileChangeReport', 'customInstructions',
              'recommendedValue', 'sessionFailure', 'asyncTasks', 'nativeSubagentSessions', ...(this.airIndex ? [
                'sessionIndex', 'sessionArchive', 'sessionRename', 'sessionListSubscribe',
              ] : [])], } } } : {}) } };
    }
    if (!this.initialized) throw invalid('请先 initialize');
    if ((method === 'authenticate' || method === 'auth/login') &&
        (this.clientCapabilities.auth?.terminal === true || this.clientCapabilities._meta?.['terminal-auth'] === true)) {
      throw invalid('终端认证不能通过 ACP 请求执行，请启动终端登录入口后重新连接');
    }
    if (method === 'auth/logout' && this.protocolVersion === 2 && this.clientCapabilities.auth?.terminal === true) {
      this.loggedOut = true;
      await Promise.allSettled([...this.lifecycleOperations.values()]);
      await Promise.allSettled([...this.sessions.values()].filter(session => !session.parentId)
        .map(session => this.closeSession({ sessionId: session.id })));
      await this.close();
      return {};
    }
    if (this.loggedOut) throw Object.assign(new Error('已退出当前连接，请完成终端登录后重新连接'), { code: -32000 });
    if (this.closing) throw new Error('适配器正在关闭');
    if (['_session/async_task/list', '_session/async_task/stop'].includes(method)) {
      const session = this.sessions.get(params.sessionId);
      if (!session) throw invalid('会话不存在');
      if (method.endsWith('/stop')) return this.tasks.stop(session, params.asyncTaskId);
      return { tasks: [...this.tasks.tasks.values()].filter(task => task.owner === session.id)
        .map(task => this.tasks.snapshot(task)) };
    }
    if (method === '_terminal/input') return this.terminalInput(params);
    if (method === 'session/new') return this.newSession(params);
    if (method === 'session/list') {
      const listed = await this.listSessions(params);
      return { ...listed, sessions: listed.sessions.map(info => this.sessionInfo(info)) };
    }
    if (method === 'session/load') return this.lifecycle(params.sessionId, () => this.loadSession(params));
    if (method === 'session/resume') return this.lifecycle(params.sessionId, () => this.resumeSession(params));
    if (method === 'session/close') return this.lifecycle(params.sessionId, () => this.closeSession(params));
    if (method === 'session/delete') return this.lifecycle(params.sessionId, () => this.deleteSession(params));
    if (method === 'session/fork') return this.lifecycle(params.sessionId, () => this.forkSession(params));
    if (method === '_session/rename') return this.lifecycle(params.sessionId, () => this.renameSession(params));
    if (method === '_session/goal') return this.lifecycle(params.sessionId, () => this.goalSession(params));
    if (method === '_session/archive' || method === '_session/unarchive') {
      if (!this.airIndex) throw invalid('客户端未协商 sessionIndex');
      return this.lifecycle(params.sessionId, () => this.archiveSession(params, method === '_session/archive'));
    }
    if (method === '_session/list/subscribe') return this.subscribeList(params);
    if (method === '_session/list/unsubscribe') return this.unsubscribeList(params);
    if (!['session/prompt', '_session/steering', 'session/cancel', 'session/set_model', 'session/set_config_option', 'session/set_mode'].includes(method)) {
      throw Object.assign(new Error(`不支持的方法：${method}`), { code: -32601 });
    }
    const session = this.sessions.get(params.sessionId);
    if (!session) {
      const task = this.tasks.relation(params.sessionId);
      if (method === 'session/cancel' && task && task.state !== 'running') return {};
      throw invalid('会话不存在');
    }
    if (session.failure) throw session.failure;
    if (this.lifecycleOperations.has(params.sessionId) && method !== 'session/cancel') {
      throw invalid('会话正在操作，请稍后重试');
    }
    if (method === 'session/set_mode' || (method === 'session/set_config_option' && params.configId === 'mode')) {
      const modeId = method === 'session/set_mode' ? params.modeId : params.value;
      if (!this.modes.some(mode => mode.id === modeId)) throw invalid('未知权限模式');
      await this.setMode(session, modeId);
      return method === 'session/set_mode' ? {} : { configOptions: this.modelConfig(session) };
    }
    if (method === 'session/set_model' || method === 'session/set_config_option') {
      const configId = method === 'session/set_model' ? 'model' : params.configId;
      const value = method === 'session/set_model' ? params.modelId : params.value;
      if (!['model', 'thinking'].includes(configId)) throw invalid('未知配置选项');
      if (session.turn) throw invalid('执行期间不能切换模型或推理级别');
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
      this.cancelPermissions(session);
      if (session.parentId) await this.tasks.close(session);
      if (session.command) {
        session.command.cancelled = true;
        await session.pi.request('abort');
      } else if (session.turn) {
        const turn = session.turn;
        turn.cancelled = true;
        await session.pi.request('clear_queue');
        if (session.turn === turn) await session.pi.request('abort');
      }
      return {};
    }
    const steering = method === '_session/steering';
    if (this.terminalChatInput) {
      const input = convertPrompt(params.prompt);
      if (!input.images && (/^\/stdin(?: |$)/.test(input.message) || input.message.trim() === '/eof')) {
        const terminals = [...session.inputTerminals];
        if (terminals.length !== 1) throw invalid('需要恰好一个可输入的运行中终端');
        const eof = input.message.trim() === '/eof';
        await this.terminalInput({ sessionId: session.id, terminalId: terminals[0],
          data: eof ? '' : input.message.slice(7) + '\n', eof });
        return steering ? { outcome: 'injected' } : { stopReason: 'end_turn' };
      }
    }
    if (session.turn && !steering) throw invalid('该会话已有正在执行的提示');
    if (session.turn?.cancelled) throw invalid('会话正在取消，请稍后重试');
    if (session.turn?.finishing) throw invalid('会话正在生成文件报告，请稍后重试');
    if (session.changingConfig) throw invalid('配置正在切换，请稍后重试');
    const prompt = convertPrompt(params.prompt);
    if (!steering && !prompt.images && (prompt.message.trim() === '/status' ||
        /^\/(compact|goal)(?:\s|$)/.test(prompt.message.trim()))) {
      return this.localCommand(session, prompt.message.trim(), this.fileReportRequest(params));
    }
    return this.prompt(session, prompt, steering, steering ? undefined : this.fileReportRequest(params));
  }

  async terminalInput(params) {
    if (!this.terminalInputEnabled) throw invalid('客户端未启用 _meta.terminal_input');
    try { validateTerminalInput(params); } catch (error) { throw invalid(error.message); }
    const session = this.sessions.get(params.sessionId);
    if (!session) throw invalid('会话不存在');
    if (session.failure) throw session.failure;
    if (!session.turn || session.turn.cancelled || session.changingConfig ||
        this.lifecycleOperations.has(session.id) || ['read-only', 'plan'].includes(session.mode) ||
        !session.inputTerminals?.has(params.terminalId)) throw invalid('终端当前不可输入');
    await session.pi.request('terminal_input', { terminalId: params.terminalId, data: params.data, eof: params.eof });
    if (params.eof) session.inputTerminals.delete(params.terminalId);
    this.update(session, { sessionUpdate: 'tool_call_update', toolCallId: params.terminalId,
      _meta: { terminal_input: { terminal_id: params.terminalId, data: params.data } } });
    return {};
  }

  goalUpdate(session) {
    if (!this.airClient) return;
    this.update(session, { sessionUpdate: 'session_info_update', _meta: { jetbrains: { air: {
      version: 1, goal: session.goal ? { ...session.goal, controlMethod: '_session/goal' } : null,
    } } } });
  }

  async goalSession(params) {
    const session = this.sessions.get(params.sessionId);
    if (!session) throw invalid('会话不存在');
    if (session.failure) throw session.failure;
    if (session.changingConfig) throw invalid('会话正在操作，请稍后重试');
    if (!['set', 'pause', 'resume', 'clear'].includes(params.action)) throw invalid('未知 goal 操作');
    const now = Date.now();
    let goal;
    if (params.action === 'set') {
      if (typeof params.objective !== 'string' || !params.objective.trim() || params.objective.length > 10000) {
        throw invalid('goal objective 无效');
      }
      goal = { objective: params.objective.trim(), status: 'active', createdAt: now, updatedAt: now };
    } else if (params.action === 'clear') goal = null;
    else {
      if (!session.goal) throw invalid('当前没有 goal');
      goal = { ...session.goal, status: params.action === 'pause' ? 'paused' : 'active', updatedAt: now };
    }
    await session.pi.request('prompt', { message: `/__acp_goal ${JSON.stringify(goal)}` });
    session.goal = goal;
    this.goalUpdate(session);
    return {};
  }

  fileReportRequest(params) {
    if (!this.airFileReport) return undefined;
    const request = params._meta?.jetbrains?.air?.agentFileChangeReportRequest;
    return request?.version === 1 && typeof request.requestId === 'string' &&
      /^[A-Za-z0-9._:-]{1,128}$/.test(request.requestId) && Object.keys(request).length === 2
      ? request.requestId : undefined;
  }

  sendFileReport(session, turn) {
    if (!turn.fileReportRequest) return;
    const paths = [...turn.changedPaths].filter(path => {
      const name = relative(session.cwd, path);
      return name === '' || (name !== '..' && !name.startsWith(`..${sep}`) && !isAbsolute(name));
    }).filter(path => path.length <= 4096).slice(0, 1024);
    const truncated = paths.length < turn.changedPaths.size || !!turn.filesIncomplete;
    let report = turn.cancelled
      ? { version: 1, requestId: turn.fileReportRequest, status: 'unavailable', reason: 'cancelled' }
      : turn.error
        ? { version: 1, requestId: turn.fileReportRequest, status: 'unavailable', reason: 'providerError' }
        : !turn.starts && !turn.filesBefore
          ? { version: 1, requestId: turn.fileReportRequest, status: 'unavailable', reason: 'notReported' }
          : { version: 1, requestId: turn.fileReportRequest, status: 'reported',
            paths, declaredComplete: false, truncated,
            uncertainty: '包含内置 edit/write 报告及工作目录前后快照的文件变化（含命令、MCP、扩展）；不扫描 .git 和符号链接目标。无法区分外部并发修改，可能遗漏修改后恢复、目录外及轮次结束后的后台修改。' +
              (turn.filesIncomplete ? ' 快照扫描未完成（读取失败或超过 20000 项／2 秒限制），新增和删除可能漏报。' : '') };
    while (report.status === 'reported' && Buffer.byteLength(JSON.stringify(report)) > 256 * 1024 && report.paths.length) {
      report.paths.pop();
      report = { ...report, truncated: true };
    }
    this.update(session, { sessionUpdate: 'session_info_update', _meta: { jetbrains: { air: {
      version: 1, agentFileChangeReport: report,
    } } } });
  }

  async prompt(session, prompt, steering, fileReportRequest) {
    const created = !session.turn;
    if (created) this.onForegroundState?.(session, 'running');
    if (created) {
      let resolve;
      const completed = new Promise(done => { resolve = done; });
      const turn = { completed, pending: 0, starts: 0, settled: false,
        cancelled: false, error: null, stopReason: 'end_turn', usage: Promise.resolve(),
        fileReportRequest, changedPaths: new Set() };
      if (fileReportRequest) turn.filesBefore = fileSnapshot(session.cwd);
      turn.finish = () => {
        if (session.turn !== turn || !turn.settled || turn.pending || turn.finishing) return;
        const complete = () => {
          this.cancelPermissions(session, { keepAcceptedUrls: true });
          session.turn = null;
          if (steering && turn.error && !turn.cancelled) {
            this.update(session, { sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: `\n执行失败：${turn.error.message}\n` } });
          }
          resolve();
        };
        if (!turn.filesBefore || turn.cancelled || turn.error) return complete();
        turn.finishing = true;
        turn.filesBefore.then(async before => {
          const after = await fileSnapshot(session.cwd);
          for (const path of changedFiles(before, after)) turn.changedPaths.add(path);
          turn.filesIncomplete = before.incomplete || after.incomplete;
        }).catch(() => { turn.filesIncomplete = true; }).finally(complete);
      };
      turn.settle = () => { turn.settled = true; turn.finish(); };
      session.turn = turn;
      const task = this.tasks.tasks.get(session.taskId);
      if (task && task.state !== 'running') {
        task.state = 'running';
        task.output = '';
        task.error = undefined;
        task.truncated = false;
        turn.taskWrite = this.tasks.save(this.sessions.get(task.owner), task);
        task.completion = turn.completed.then(() => this.tasks.finish(task,
          turn.cancelled ? 'stopped' : turn.error ? 'failed' : 'completed', turn.error));
        task.completion.catch(error => process.stderr.write(`保存子任务失败：${error.message}\n`));
      }
    }
    const turn = session.turn;
    turn.pending++;
    // 串行提交，避免前一条提示尚在预处理时再次启动运行。
    const submission = (turn.submission ?? Promise.resolve()).catch(() => {}).then(async () => {
      await turn.taskWrite;
      await turn.filesBefore;
      if (turn.cancelled) throw invalid('会话正在取消，请稍后重试');
      const starts = turn.starts;
      const accepted = await session.pi.request('prompt', {
        ...prompt, ...(steering ? { streamingBehavior: 'steer' } : {}),
      });
      if (accepted?.disposition === 'started' && turn.starts === starts) turn.settled = false;
      if (accepted?.disposition === 'handled' && created) turn.settle();
      return accepted;
    });
    turn.submission = submission;
    let accepted;
    try {
      accepted = await submission;
    } catch (error) {
      if (created) { turn.error = error; turn.settle(); }
      if (steering) return { outcome: 'failed' };
    } finally {
      turn.pending--;
      turn.finish();
    }
    if (steering) return { outcome: accepted?.disposition === 'started' ? 'startedNewTurn' : 'injected' };
    await turn.completed;
    await turn.usage;
    this.sendFileReport(session, turn);
    const usage = turn.tokens ? { usage: turn.tokens } : {};
    this.onForegroundState?.(session, 'idle', { stopReason: turn.cancelled ? 'cancelled' : turn.error ? 'error' : turn.stopReason,
      ...(turn.error && !turn.cancelled ? { error: { code: Number.isInteger(turn.error.code) ? turn.error.code : -32603,
        message: turn.error.message } } : {}) });
    if (turn.cancelled) return { stopReason: 'cancelled', ...usage };
    if (turn.error) {
      if (this.airSessionFailure) return { stopReason: 'end_turn', ...usage, _meta: { jetbrains: { air: {
        version: 1, sessionFailure: this.sessionFailure(session, turn.error),
      } } } };
      throw turn.error;
    }
    return { stopReason: turn.stopReason, ...usage };
  }

  recordUsage(session, usage) {
    if (!session.turn || !usage || !['input', 'output', 'cacheRead', 'cacheWrite'].every(key =>
      Number.isSafeInteger(usage[key]) && usage[key] >= 0)) return;
    const tokens = session.turn.tokens ??= {
      totalTokens: 0, inputTokens: 0, outputTokens: 0, cachedReadTokens: 0, cachedWriteTokens: 0,
    };
    tokens.inputTokens += usage.input;
    tokens.outputTokens += usage.output;
    tokens.cachedReadTokens += usage.cacheRead;
    tokens.cachedWriteTokens += usage.cacheWrite;
    tokens.totalTokens += usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
  }

  sessionFailure(session, error) {
    const message = error?.message || String(error);
    const lower = message.toLowerCase();
    const category = /rate.?limit|quota|context.?window|token limit/.test(lower) ? 'limit'
      : /connect|network|econn|timeout|exited|退出/.test(lower) ? 'connection'
        : /bad request|invalid|不支持|无效/.test(lower) ? 'request' : 'service';
    return { id: `${session.id}:error:${++this.sequence}`, revision: 1, category,
      severity: 'error', title: message.slice(0, 240),
      ...(message.length > 240 ? { details: message } : {}), actions: ['retry'] };
  }

  async resumeSession(params, metadata = {}) {
    if (typeof params.sessionId !== 'string' || !params.sessionId) throw invalid('缺少 sessionId');
    if (typeof params.cwd !== 'string' || !isAbsolute(params.cwd)) throw invalid('cwd 必须是绝对路径');
    convertMcp(params.mcpServers ?? []);
    let existing = this.sessions.get(params.sessionId);
    if (existing) {
      if (existing.turn || existing.command || existing.changingConfig || !existing.availableModels) throw invalid('会话正在使用，请稍后重试');
      if (resolve(existing.cwd) !== resolve(params.cwd)) throw invalid('会话工作目录不匹配');
      existing = await this.updateSessionMcp(existing, params);
      const history = await existing.pi.request('get_entries');
      await this.tasks.restore(existing, this.tasks.branch(history), { ...metadata.restoreContext, replay: false });
      const { sessionId, ...result } = this.sessionState(existing);
      return result;
    }
    const history = (await this.listSessions({ cwd: params.cwd }, { includeArchived: true })).sessions;
    const saved = history.find(session => session.sessionId === params.sessionId && resolve(session.cwd) === resolve(params.cwd));
    if (!saved) throw invalid('当前目录中没有此历史会话');
    const { sessionId, ...result } = await this.newSession({ ...params, mcpServers: params.mcpServers ?? [] },
      { ...metadata, id: saved.sessionId, path: saved.path });
    const session = this.sessions.get(sessionId);
    const entries = await session.pi.request('get_entries');
    await this.tasks.restore(session, this.tasks.branch(entries), { ...metadata.restoreContext, replay: false });
    return result;
  }

  async updateSessionMcp(existing, params) {
    if (isDeepStrictEqual(convertMcp(params.mcpServers ?? []), convertMcp(existing.mcpServers))) return existing;
    if ([...this.tasks.tasks.values()].some(task => task.owner === existing.id && task.state === 'running')) {
      throw invalid('后台任务正在运行，请结束任务后再更新 MCP 配置');
    }
    existing.changingConfig = true;
    let replacement;
    try {
      await existing.taskWrites;
      const state = await existing.pi.request('get_state');
      if (!state.sessionFile) throw new Error('原会话未持久保存');
      await this.newSession(params, { id: existing.id, path: state.sessionFile,
        parentId: existing.parentId, taskId: existing.taskId, mode: existing.mode,
        instructions: existing.customInstructions, keepBusy: true });
      replacement = this.sessions.get(existing.id);
      replacement.changingConfig = true;
      if (replacement.currentModelId !== existing.currentModelId) {
        const model = replacement.availableModels.find(model => `${model.provider}/${model.id}` === existing.currentModelId);
        if (!model) throw new Error('原会话模型不可用');
        await replacement.pi.request('set_model', { provider: model.provider, modelId: model.id });
        replacement.currentModelId = existing.currentModelId;
        await this.refreshThinking(replacement);
      }
      if (replacement.thinkingLevel !== existing.thinkingLevel) {
        await replacement.pi.request('set_thinking_level', { level: existing.thinkingLevel });
        replacement.thinkingLevel = existing.thinkingLevel;
      }
      replacement.recommendedModelId = existing.recommendedModelId;
      replacement.recommendedThinkingLevel = existing.recommendedThinkingLevel;
      replacement.changingConfig = false;
    } catch (error) {
      this.sessions.set(existing.id, existing);
      if (replacement) {
        try { await replacement.pi.close(); }
        finally { await rm(replacement.directory, { recursive: true, force: true }); }
      }
      throw error;
    } finally {
      existing.changingConfig = false;
    }
    try { await existing.pi.close(); }
    finally { await rm(existing.directory, { recursive: true, force: true }); }
    return replacement;
  }

  async deleteSession(params) {
    if (typeof params.sessionId !== 'string' || !params.sessionId) throw invalid('缺少 sessionId');
    const live = this.sessions.get(params.sessionId);
    const requestedCwd = params.cwd ?? live?.cwd;
    if (requestedCwd !== undefined && (typeof requestedCwd !== 'string' || !isAbsolute(requestedCwd))) {
      throw invalid('cwd 必须是绝对路径');
    }
    const saved = (await this.listSessions(requestedCwd ? { cwd: requestedCwd } : {}, { includeArchived: true })).sessions
      .find(session => session.sessionId === params.sessionId);
    if (!saved) throw invalid('没有此历史会话');
    const cwd = requestedCwd ?? saved.cwd;
    let header;
    let historyText;
    try {
      historyText = await readFile(saved.path, 'utf8');
      header = JSON.parse(historyText.split('\n', 1)[0]);
    }
    catch { throw invalid('历史会话文件无效，未执行删除'); }
    if (header?.id !== params.sessionId || resolve(header.cwd) !== resolve(cwd)) {
      throw invalid('历史会话文件身份不匹配，未执行删除');
    }
    const hasTasks = historyText.split('\n').some(line => {
      try { const entry = JSON.parse(line); return entry.customType === 'acp_task' && entry.data?.owner === params.sessionId; }
      catch { return false; }
    });
    if (!live && hasTasks) await this.resumeSession({ sessionId: params.sessionId, cwd, mcpServers: params.mcpServers ?? [] });
    if (live || hasTasks) await this.closeSession(params);
    try { await unlink(saved.path); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await rm(`${saved.path}.tasks`, { recursive: true, force: true });
    return {};
  }

  async renameSession(params) {
    if (typeof params.sessionId !== 'string' || !params.sessionId) throw invalid('缺少 sessionId');
    if (typeof params.title !== 'string' || !params.title.trim()) throw invalid('标题不能为空');
    const session = this.sessions.get(params.sessionId);
    if (session) {
      if (session.turn || session.changingConfig) throw invalid('会话正在使用，请稍后重试');
      await session.pi.request('set_session_name', { name: params.title.trim() });
      return {};
    }
    const saved = (await this.listSessions({}, { includeArchived: true })).sessions.find(info => info.sessionId === params.sessionId);
    if (!saved) throw invalid('没有此历史会话');
    const opened = await this.newSession({ cwd: saved.cwd, mcpServers: [] }, { id: saved.sessionId, path: saved.path });
    try { await this.sessions.get(opened.sessionId).pi.request('set_session_name', { name: params.title.trim() }); }
    finally { await this.closeSession({ sessionId: opened.sessionId }); }
    return {};
  }

  async closeSession(params) {
    if (typeof params.sessionId !== 'string' || !params.sessionId) throw invalid('缺少 sessionId');
    const session = this.sessions.get(params.sessionId);
    if (!session) return {};
    session.changingConfig = true;
    this.cancelPermissions(session);
    try {
      await this.tasks.close(session);
      if (session.command) {
        session.command.cancelled = true;
        await session.pi.request('abort');
      } else if (session.turn) {
        const turn = session.turn;
        turn.cancelled = true;
        await session.pi.request('clear_queue');
        await session.pi.request('abort');
        await turn.completed;
      }
    } finally {
      this.sessions.delete(session.id);
      try { try { await session.taskWrites; } finally { await session.pi.close(); } }
      finally { await rm(session.directory, { recursive: true, force: true }); }
    }
    return {};
  }

  async forkSession(params) {
    if (typeof params.sessionId !== 'string' || !params.sessionId) throw invalid('缺少 sessionId');
    const fork = params._meta?.jetbrains?.air?.fork;
    if (fork !== undefined && (!fork || Array.isArray(fork) || fork.version !== 1 ||
        typeof fork.messageId !== 'string' || !fork.messageId.trim() ||
        (fork.messageFingerprint !== undefined && (typeof fork.messageFingerprint !== 'string' ||
          !/^sha256:[a-fA-F0-9]{64}$/.test(fork.messageFingerprint))) ||
        (fork.messageOccurrence !== undefined && (!Number.isSafeInteger(fork.messageOccurrence) || fork.messageOccurrence < 1)))) {
      throw invalid('分叉点参数无效');
    }
    let source = this.sessions.get(params.sessionId);
    if (!source) {
      if (typeof params.cwd !== 'string' || !isAbsolute(params.cwd)) throw invalid('分叉历史会话需要绝对 cwd');
      const saved = (await this.listSessions({ cwd: params.cwd }, { includeArchived: true })).sessions
        .find(info => info.sessionId === params.sessionId);
      if (!saved) throw invalid('当前目录中没有此历史会话');
      await this.newSession({ cwd: params.cwd, mcpServers: params.mcpServers ?? [] },
        { id: saved.sessionId, path: saved.path });
      source = this.sessions.get(params.sessionId);
    }
    if (source.turn || source.command || source.changingConfig) throw invalid('会话正在使用，请稍后重试');
    const cwd = params.cwd ?? source.cwd;
    if (typeof cwd !== 'string' || !isAbsolute(cwd) || resolve(cwd) !== resolve(source.cwd)) {
      throw invalid('分叉会话必须使用原工作目录');
    }
    const requestedMcp = params.mcpServers ?? source.mcpServers;
    convertMcp(requestedMcp);
    source.changingConfig = true;
    try {
      return await this.cloneSession(source, params, cwd);
    } finally {
      source.changingConfig = false;
    }
  }

  async cloneSession(source, params, cwd) {
    const fork = params._meta?.jetbrains?.air?.fork;
    let forkEntryId;
    if (fork) {
      const branch = this.tasks.branch(await source.pi.request('get_entries'));
      const messageId = fork.messageId.replace(/:segment:\d+$/, '');
      let index = branch.findIndex(entry => entry.message?.role === 'assistant' &&
        (entry.message.acpMessageId ?? entry.id) === messageId);
      if (index < 0 && fork.messageFingerprint) {
        let occurrence = 0;
        index = branch.findIndex(entry => {
          if (entry.message?.role !== 'assistant') return false;
          const text = (entry.message.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('');
          const fingerprint = `sha256:${createHash('sha256').update(text).digest('hex')}`;
          return fingerprint === fork.messageFingerprint.toLowerCase() && ++occurrence === (fork.messageOccurrence ?? 1);
        });
      }
      if (index < 0) throw invalid('当前分支中没有此助手消息');
      // 保留消息所在整轮，避免在工具调用与结果之间截断历史。
      const nextUser = branch.findIndex((entry, position) => position > index && entry.message?.role === 'user');
      forkEntryId = branch[nextUser < 0 ? branch.length - 1 : nextUser - 1].id;
    }
    const oldState = await source.pi.request('get_state');
    const sourceMode = source.mode;
    const sourceModelId = source.currentModelId;
    const sourceThinking = source.thinkingLevel;
    const sourceMcp = source.mcpServers;
    const customInstructions = source.customInstructions ? { _meta: { jetbrains: { air: {
      customInstructions: source.customInstructions,
    } } } } : {};
    if (!oldState.sessionFile) throw new Error('原会话未持久保存');
    const cloned = forkEntryId
      ? await source.pi.request('prompt', { message: `/__acp_fork ${JSON.stringify(forkEntryId)}` })
      : await source.pi.request('clone');
    if (cloned?.cancelled) throw invalid('pi 取消了会话分叉');
    let newState;
    try {
      newState = await source.pi.request('get_state');
      if (forkEntryId && newState.sessionId === source.id) throw invalid('pi 未执行指定消息分叉');
      if (!newState.sessionId || newState.sessionId === source.id || !newState.sessionFile) {
        throw new Error('pi 未创建正确的分叉会话');
      }
      await source.pi.request('prompt', { message: '/__acp_check' });
      await source.pi.request('prompt', { message: `/__acp_mode ${sourceMode === 'plan' ? 'plan' : 'default'}` });
    } catch (error) {
      if (forkEntryId && newState?.sessionId === source.id) throw error;
      this.sessions.delete(source.id);
      try { await source.pi.close(); }
      finally { await rm(source.directory, { recursive: true, force: true }); }
      throw error;
    }
    this.sessions.delete(source.id);
    source.id = newState.sessionId;
    this.sessions.set(source.id, source);
    try {
      const requestedMcp = params.mcpServers ?? sourceMcp;
      const changeMcp = JSON.stringify(convertMcp(requestedMcp)) !== JSON.stringify(convertMcp(sourceMcp));
      if (changeMcp) {
        await source.pi.close();
        await rm(source.directory, { recursive: true, force: true });
        this.sessions.delete(source.id);
        await this.newSession({ cwd, mcpServers: requestedMcp, ...customInstructions },
          { id: newState.sessionId, path: newState.sessionFile });
        source = this.sessions.get(newState.sessionId);
      }
      await this.newSession({ cwd, mcpServers: sourceMcp, ...customInstructions },
        { id: params.sessionId, path: oldState.sessionFile });
      const restored = this.sessions.get(params.sessionId);
      for (const session of changeMcp ? [restored, source] : [restored]) {
        const model = session.availableModels.find(candidate => `${candidate.provider}/${candidate.id}` === sourceModelId);
        if (model && session.currentModelId !== sourceModelId) {
          await session.pi.request('set_model', { provider: model.provider, modelId: model.id });
          session.currentModelId = sourceModelId;
          await this.refreshThinking(session);
        }
        if (session.thinkingLevels.includes(sourceThinking) && session.thinkingLevel !== sourceThinking) {
          await session.pi.request('set_thinking_level', { level: sourceThinking });
          session.thinkingLevel = sourceThinking;
        }
        await this.setMode(session, sourceMode, false);
      }
    } catch (error) {
      const restored = this.sessions.get(params.sessionId);
      if (restored) {
        this.sessions.delete(restored.id);
        await restored.pi.close();
        await rm(restored.directory, { recursive: true, force: true });
      }
      this.sessions.delete(source.id);
      await source.pi.close();
      await rm(source.directory, { recursive: true, force: true });
      throw error;
    }
    await Promise.all([
      this.publishCommands(source).catch(error => process.stderr.write(`发布命令失败：${error.message}\n`)),
      this.refreshUsage(source).catch(error => process.stderr.write(`刷新用量失败：${error.message}\n`)),
    ]);
    if (source.goal) this.goalUpdate(source);
    return this.sessionState(source);
  }

  async localCommand(session, text, fileReportRequest) {
    const finish = result => {
      if (fileReportRequest) this.sendFileReport(session, { fileReportRequest, changedPaths: new Set(), starts: 0,
        cancelled: session.command?.cancelled, error: session.command?.error });
      return result;
    };
    if (/^\/goal(?:\s|$)/.test(text)) {
      const argument = text.slice('/goal'.length).trim();
      if (!argument) {
        this.update(session, { sessionUpdate: 'agent_message_chunk', content: { type: 'text',
          text: session.goal ? `长期目标（${session.goal.status}）：${session.goal.objective}` : '尚未设置长期目标' } });
      } else {
        await this.lifecycle(session.id, () => this.goalSession({ sessionId: session.id,
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
      this.update(session, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: lines.join('\n') } });
      await this.sendUsage(session, stats);
      return finish({ stopReason: 'end_turn' });
    }
    const customInstructions = text.slice('/compact'.length).trim() || undefined;
    const command = { cancelled: false };
    session.command = command;
    session.changingConfig = true;
    try {
      const result = await session.pi.request('compact', customInstructions ? { customInstructions } : {});
      if (command.cancelled) return finish({ stopReason: 'cancelled' });
      if (this.clientCapabilities?.session?.compaction == null) {
        this.update(session, { sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `上下文压缩完成：${result?.tokensBefore ?? '?'} → ${result?.estimatedTokensAfter ?? '?'} tokens` } });
      }
      await this.refreshUsage(session).catch(error => process.stderr.write(`刷新用量失败：${error.message}\n`));
      return finish({ stopReason: 'end_turn' });
    } catch (error) {
      if (command.cancelled) return finish({ stopReason: 'cancelled' });
      command.error = error;
      if (this.airSessionFailure) return finish({ stopReason: 'end_turn', _meta: { jetbrains: { air: {
        version: 1, sessionFailure: this.sessionFailure(session, error),
      } } } });
      finish({});
      throw error;
    } finally {
      session.command = null;
      session.changingConfig = false;
    }
  }

  async publishCommands(session) {
    const result = await session.pi.request('get_commands');
    const availableCommands = new Map([
      ['status', { name: 'status', description: '显示当前模型、token、成本和上下文使用情况', input: null }],
      // Air 的 ACP v1 解析器需要 input 的类型判别字段。
      ['compact', { name: 'compact', description: '压缩对话上下文，可附带摘要要求', input: { type: 'unstructured', hint: '可选摘要要求' } }],
      ['goal', { name: 'goal', description: '设置或查看长期目标，也支持 pause、resume、clear',
        input: { type: 'unstructured', hint: '目标内容或 pause / resume / clear' } }],
    ]);
    if (this.terminalChatInput) {
      availableCommands.set('stdin', { name: 'stdin', description: '向当前运行的终端输入一行文本',
        input: { type: 'unstructured', hint: '输入文本，自动添加换行' } });
      availableCommands.set('eof', { name: 'eof', description: '关闭当前运行终端的 stdin', input: null });
    }
    for (const command of result?.commands ?? []) {
      if (!command?.name || command.name.startsWith('__acp') || availableCommands.has(command.name)) continue;
      availableCommands.set(command.name, { name: command.name,
        description: command.description || command.name, input: null });
    }
    this.update(session, { sessionUpdate: 'available_commands_update',
      availableCommands: [...availableCommands.values()] });
  }

  async sendUsage(session, stats) {
    const usage = stats?.contextUsage;
    if (usage && Number.isFinite(usage.tokens) && Number.isFinite(usage.contextWindow) && usage.contextWindow > 0) {
      this.update(session, { sessionUpdate: 'usage_update', used: usage.tokens, size: usage.contextWindow,
        ...(Number.isFinite(stats.cost) && stats.cost >= 0 ? { cost: { amount: stats.cost, currency: 'USD' } } : {}),
      });
    }
  }

  async refreshUsage(session) {
    if (!this.sessions.has(session.id) || session.pi.closed) return;
    await this.sendUsage(session, await session.pi.request('get_session_stats'));
  }

  sessionInfo({ path, archived, forkedFrom, ...info }) {
    if (!this.airIndex) return info;
    const active = this.sessions.get(info.sessionId);
    const requiresAction = [...this.permissions.values()].some(request => request.session === active);
    return { ...info, _meta: { jetbrains: { air: { version: 1, archived: archived === true,
      state: active?.failure ? 'error' : requiresAction ? 'requires_action' : active?.turn || active?.command ? 'running' : 'idle',
      ...(active?.currentModelId ? { model: active.currentModelId } : {}),
      ...(forkedFrom ? { forkedFrom } : {}),
    } } } };
  }

  async readHistory(context, params) {
    let cwds = [context.cwd];
    if (params._meta?.jetbrains?.air?.list?.includeWorktrees === true) {
      try {
        const { stdout } = await executeFile('git', ['worktree', 'list', '--porcelain', '-z'],
          { cwd: context.cwd, timeout: 5000, maxBuffer: 1024 * 1024 });
        cwds = [...new Set([...cwds, ...stdout.split('\0').filter(value => value.startsWith('worktree '))
          .map(value => value.slice('worktree '.length))])];
      } catch { /* 非 Git 项目只查询当前工作目录。 */ }
    }
    context.history = undefined;
    await context.pi.request('prompt', { message: `/__acp_list ${JSON.stringify({ all: params.cwd === undefined, cwds })}` });
    if (!context.history) throw new Error('pi 未返回历史会话列表');
    return context.history;
  }

  async listSessions(params, { includeArchived = false } = {}) {
    if (params.cursor !== undefined && (typeof params.cursor !== 'string' || !/^\d+$/.test(params.cursor))) {
      throw invalid('会话列表游标无效');
    }
    const offset = Number(params.cursor ?? 0);
    if (!Number.isSafeInteger(offset)) throw invalid('会话列表游标无效');
    const options = params._meta?.jetbrains?.air?.list ?? {};
    const limit = options.limit ?? Number.POSITIVE_INFINITY;
    if (options.limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)) {
      throw invalid('会话列表数量限制无效');
    }
    const archived = includeArchived ? 'all' : options.archived ?? 'unarchived';
    if (!['unarchived', 'archived', 'all'].includes(archived)) throw invalid('归档筛选无效');
    if (options.includeWorktrees !== undefined && typeof options.includeWorktrees !== 'boolean') {
      throw invalid('includeWorktrees 必须是布尔值');
    }
    const created = await this.newSession({ cwd: params.cwd ?? process.cwd(), mcpServers: [] }, { discovery: true });
    try {
      const history = (await this.readHistory(created, params)).filter(info =>
        archived === 'all' || (info.archived === true) === (archived === 'archived'));
      const sessions = history.slice(offset, offset + limit);
      return { sessions, ...(offset + limit < history.length ? { nextCursor: String(offset + limit) } : {}) };
    } finally {
      await this.closeSession({ sessionId: created.id });
    }
  }

  async archiveSession(params, archived) {
    if (typeof params.sessionId !== 'string' || !params.sessionId) throw invalid('缺少 sessionId');
    const live = this.sessions.get(params.sessionId);
    const saved = (await this.listSessions({}, { includeArchived: true })).sessions
      .find(info => info.sessionId === params.sessionId);
    if (!saved) throw invalid('没有此历史会话');
    if (archived && live) await this.closeSession({ sessionId: live.id });
    const temporary = !this.sessions.has(params.sessionId);
    if (temporary) await this.newSession({ cwd: saved.cwd, mcpServers: [] }, { id: saved.sessionId, path: saved.path });
    const context = this.sessions.get(params.sessionId);
    try {
      if (archived && !live) {
        const entries = await context.pi.request('get_entries');
        await this.tasks.restore(context, this.tasks.branch(entries), { replay: false });
        await this.tasks.close(context);
      }
      await context.pi.request('prompt', { message: `/__acp_archive ${archived}` });
      this.update(context, { sessionUpdate: 'session_info_update', _meta: {
        jetbrains: { air: { version: 1, archived } },
      } });
    } finally {
      if (temporary) await this.closeSession({ sessionId: context.id });
    }
    return {};
  }

  async subscribeList(params) {
    if (!this.airIndex) throw invalid('客户端未协商 sessionIndex');
    if (typeof params.cwd !== 'string' || !isAbsolute(params.cwd)) throw invalid('cwd 必须是绝对路径');
    if (this.subscriptions.size >= 8) throw invalid('会话列表订阅数量已达上限');
    const subscription = { id: randomUUID(), cwd: params.cwd, active: true, previous: new Map() };
    this.subscriptions.set(subscription.id, subscription);
    try {
      subscription.context = await this.newSession({ cwd: params.cwd, mcpServers: [] }, { discovery: true });
      if (this.closing) throw new Error('适配器正在关闭');
      await this.refreshSubscription(subscription, false);
      subscription.timer = setInterval(() => {
        if (!subscription.active || subscription.pending || this.closing) return;
        subscription.pending = this.refreshSubscription(subscription).catch(error => {
          if (subscription.active && !this.closing) process.stderr.write(`刷新会话列表失败：${error.message}\n`);
        }).finally(() => { subscription.pending = null; });
      }, 2000);
      subscription.timer.unref();
      setImmediate(() => {
        if (subscription.active && !this.closing) this.send({ jsonrpc: '2.0', method: '_session/list/changes',
          params: { subscriptionId: subscription.id, sessions: [...subscription.previous.values()], removed: [] } });
      });
      return { subscriptionId: subscription.id };
    } catch (error) {
      await this.unsubscribeList({ subscriptionId: subscription.id });
      throw error;
    }
  }

  async refreshSubscription(subscription, emit = true) {
    const history = await this.readHistory(subscription.context, { cwd: subscription.cwd,
      _meta: { jetbrains: { air: { list: { includeWorktrees: true } } } } });
    if (!subscription.active) return;
    const current = new Map(history.map(info => [info.sessionId, this.sessionInfo(info)]));
    const sessions = [...current.values()].filter(info =>
      JSON.stringify(info) !== JSON.stringify(subscription.previous.get(info.sessionId)));
    const removed = [...subscription.previous.keys()].filter(id => !current.has(id));
    subscription.previous = current;
    if (emit && (sessions.length || removed.length)) this.send({ jsonrpc: '2.0', method: '_session/list/changes',
      params: { subscriptionId: subscription.id, sessions, removed } });
  }

  async unsubscribeList(params) {
    if (typeof params.subscriptionId !== 'string' || !params.subscriptionId) throw invalid('缺少 subscriptionId');
    const subscription = this.subscriptions.get(params.subscriptionId);
    if (!subscription) return {};
    subscription.active = false;
    clearInterval(subscription.timer);
    this.subscriptions.delete(subscription.id);
    if (subscription.context) await this.closeSession({ sessionId: subscription.context.id });
    return {};
  }

  async loadSession(params, metadata = {}) {
    if (typeof params.sessionId !== 'string' || !params.sessionId) throw invalid('缺少 sessionId');
    if (typeof params.cwd !== 'string' || !isAbsolute(params.cwd)) throw invalid('cwd 必须是绝对路径');
    convertMcp(params.mcpServers);
    let existing = this.sessions.get(params.sessionId);
    if (existing && (existing.turn || existing.command || existing.changingConfig || !existing.availableModels)) throw invalid('会话正在使用，请稍后重试');
    if (existing && resolve(existing.cwd) !== resolve(params.cwd)) throw invalid('会话工作目录不匹配');
    if (existing?.failure) throw existing.failure;
    let result;
    if (existing) {
      existing = await this.updateSessionMcp(existing, params);
      result = this.sessionState(existing);
    }
    else {
      const history = (await this.listSessions({ cwd: params.cwd }, { includeArchived: true })).sessions;
      if (this.sessions.has(params.sessionId)) throw invalid('会话正在加载，请稍后重试');
      const saved = history.find(session => session.sessionId === params.sessionId && resolve(session.cwd) === resolve(params.cwd));
      if (!saved) throw invalid('当前目录中没有此历史会话');
      result = await this.newSession(params, { ...metadata, id: saved.sessionId, path: saved.path });
    }
    const session = this.sessions.get(params.sessionId);
    session.changingConfig = true;
    try {
      const branch = this.tasks.branch(await session.pi.request('get_entries'));
      session.tools.clear();
      for (const entry of branch) this.replay(session, entry);
      await this.tasks.restore(session, branch, metadata.restoreContext);
      session.tools.clear();
      const state = await session.pi.request('get_state');
      if (state.sessionName) this.update(session, { sessionUpdate: 'session_info_update', title: state.sessionName });
      const { sessionId, ...loaded } = result;
      return loaded;
    } catch (error) {
      this.sessions.delete(session.id);
      await session.pi.close();
      await rm(session.directory, { recursive: true, force: true });
      throw error;
    } finally {
      session.changingConfig = false;
    }
  }

  publishPlan(session, result, isError = false) {
    const entries = result?.details?.acpPlan;
    if (isError || !Array.isArray(entries) || entries.length > 100 || entries.some(entry =>
      typeof entry?.content !== 'string' || !entry.content || entry.content.length > 10000 ||
      !['high', 'medium', 'low'].includes(entry.priority) ||
      !['pending', 'in_progress', 'completed'].includes(entry.status))) return;
    this.update(session, { sessionUpdate: 'plan', entries });
  }

  compactionUpdate(session, compactionId, status, result, error) {
    if (this.clientCapabilities?.session?.compaction != null) {
      this.update(session, { sessionUpdate: 'compaction_update', compactionId, status,
        ...(this.protocolVersion === 2 && typeof result?.summary === 'string'
          ? { summary: [{ type: 'text', text: result.summary }] } : {}),
        ...(status === 'failed' && error ? { error } : {}) });
    } else {
      this.update(session, { sessionUpdate: status === 'in_progress' ? 'tool_call' : 'tool_call_update',
        toolCallId: compactionId, ...(status === 'in_progress' ? { title: '压缩对话上下文', kind: 'think' } : {}),
        status: status === 'in_progress' ? 'in_progress' : status === 'completed' ? 'completed' : 'failed',
        ...(result ? { rawOutput: result } : {}),
      });
    }
  }

  replay(session, entry) {
    if (entry.type === 'compaction') {
      const id = `pi-compaction-${entry.id}`;
      this.compactionUpdate(session, id, 'in_progress');
      this.compactionUpdate(session, id, 'completed', { summary: entry.summary, tokensBefore: entry.tokensBefore });
      return;
    }
    const message = entry.type === 'message' ? entry.message : null;
    if (!message) return;
    if (message.role === 'toolResult') {
      this.update(session, { sessionUpdate: 'tool_call_update', toolCallId: message.toolCallId,
        status: message.isError ? 'failed' : 'completed', ...this.toolResult(session, message.toolCallId, message, message.isError) });
      this.publishPlan(session, message, message.isError);
      session.tools.delete(message.toolCallId);
      session.terminals.delete(message.toolCallId);
      return;
    }
    if (!['user', 'assistant'].includes(message.role)) return;
    const blocks = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content ?? [];
    for (const block of blocks) {
      if (block.type === 'toolCall' && message.role === 'assistant') {
        const tool = this.tool(session, { toolCallId: block.id, toolName: block.name, args: block.arguments });
        session.tools.set(block.id, tool);
        const terminal = ['bash', 'powershell'].includes(block.name);
        if (terminal) session.terminals.set(block.id, '');
        this.update(session, { sessionUpdate: 'tool_call', ...tool,
          ...(terminal ? { content: [{ type: 'terminal', terminalId: block.id }],
            _meta: { terminal_info: { terminal_id: block.id, cwd: session.cwd } } } : {}),
          status: 'pending' });
      } else if (block.type === 'thinking' && message.role === 'assistant') {
        this.update(session, { sessionUpdate: 'agent_thought_chunk', messageId: `${message.acpMessageId ?? entry.id}:thinking`, content: { type: 'text', text: block.thinking } });
      } else if (['text', 'image'].includes(block.type)) {
        const content = block.type === 'text' ? { type: 'text', text: block.text }
          : { type: 'image', data: block.data, mimeType: block.mimeType };
        this.update(session, { sessionUpdate: message.role === 'user' ? 'user_message_chunk' : 'agent_message_chunk', messageId: message.acpMessageId ?? entry.id, content });
      }
    }
  }

  async newSession(params, { id = randomUUID(), path, discovery = false, parentId, taskId, mode, instructions, keepBusy = false } = {}) {
    if (typeof params.cwd !== 'string' || !isAbsolute(params.cwd)) throw invalid('cwd 必须是绝对路径');
    if (!(await stat(params.cwd)).isDirectory()) throw invalid('cwd 必须是目录');
    const mcpServers = convertMcp(params.mcpServers ?? []);
    const customInstructions = instructions ?? (this.airCustomInstructions
      ? params._meta?.jetbrains?.air?.customInstructions : undefined);
    if (customInstructions !== undefined && (typeof customInstructions !== 'string' || customInstructions.length > 100000)) {
      throw invalid('自定义指令无效');
    }
    const relation = this.tasks.relation(id);
    parentId ??= relation?.owner;
    taskId ??= relation?.id;
    mode ??= relation?.mode;
    const directory = await mkdtemp(join(tmpdir(), 'pi-acp-'));
    const configPath = join(directory, 'config.json');
    const session = { id, parentId, taskId,
      interactionSessionId: parentId && !this.nativeSubagents
        ? this.sessions.get(parentId)?.interactionSessionId ?? parentId : id, cwd: params.cwd, directory, mcpServers: params.mcpServers ?? [], customInstructions,
      mode: 'full', goal: null, turn: null,
      changingConfig: true, tools: new Map(), terminals: new Map(), inputTerminals: new Set(), blocks: new Map(), compaction: 0 };
    this.sessions.set(session.id, session);
    try {
      const sessionDirIndex = this.args.lastIndexOf('--session-dir');
      await writeFile(configPath, JSON.stringify({ mcpServers, terminalInput: this.terminalInputEnabled === true,
        ...(customInstructions ? { customInstructions } : {}),
        sessionDir: sessionDirIndex === -1 ? undefined : this.args[sessionDirIndex + 1] }), { mode: 0o600 });
      if (this.closing) throw new Error('适配器正在关闭');
      session.pi = new PiProcess({ command: this.command,
        args: [...this.args, '--mode', 'rpc', ...(discovery ? ['--no-session'] : path ? ['--session', path] : ['--session-id', id]), '--extension', extensionPath],
        cwd: params.cwd, configPath,
        onEvent: event => this.event(session, event),
        onControl: request => this.control(session, request),
        onFailure: error => {
          session.failure = error;
          void this.tasks.close(session, error).catch(failure => process.stderr.write(`关闭后台任务失败：${failure.message}\n`));
          if (session.turn) { session.turn.error = error; session.turn.settle(); }
          this.cancelPermissions(session);
        } });
      const state = await session.pi.request('get_state');
      session.file = state.sessionFile;
      await session.pi.request('prompt', { message: '/__acp_check' });
      if (!session.ready) throw new Error('ACP 扩展未就绪，请使用 pi 1.1.0 或兼容版本');
      if (session.failure) throw session.failure;
      if (discovery) return session;
      if (state.sessionId !== id || !state.sessionFile) throw new Error('pi 未创建正确的持久会话，请移除会话选择或 --no-session 启动参数');
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
      session.recommendedModelId = session.currentModelId;
      await this.refreshThinking(session);
      session.recommendedThinkingLevel = session.thinkingLevel;
      session.changingConfig = false;
      if (mode && mode !== session.mode) await this.setMode(session, mode, false);
      session.changingConfig = keepBusy;
      const result = this.sessionState(session);
      if (session.goal) this.goalUpdate(session);
      await Promise.all([
        this.publishCommands(session).catch(error => process.stderr.write(`发布命令失败：${error.message}\n`)),
        this.refreshUsage(session).catch(error => process.stderr.write(`刷新用量失败：${error.message}\n`)),
      ]);
      return result;
    } catch (error) {
      this.sessions.delete(session.id);
      await session.pi?.close();
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }

  sessionState(session) {
    return { sessionId: session.id, configOptions: this.modelConfig(session),
      modes: { currentModeId: session.mode, availableModes: this.modes }, models: {
        currentModelId: session.currentModelId,
        availableModels: session.availableModels.map(model => ({
          modelId: `${model.provider}/${model.id}`, name: model.name || model.id,
        })),
      } };
  }

  async setMode(session, modeId, publish = true) {
    if (session.changingConfig) throw invalid('会话正在操作，请稍后重试');
    const originalMode = session.mode;
    session.changingConfig = true;
    try {
      if (['read-only', 'plan'].includes(modeId)) this.cancelPermissions(session);
      session.mode = modeId;
      if ((modeId === 'plan') !== (originalMode === 'plan')) {
        await session.pi.request('prompt', { message: `/__acp_mode ${modeId === 'plan' ? 'plan' : 'default'}` });
      }
      const task = this.tasks.tasks.get(session.taskId);
      if (task && task.mode !== modeId) {
        const previous = task.mode;
        task.mode = modeId;
        try { await this.tasks.save(this.sessions.get(task.owner), task); }
        catch (error) { task.mode = previous; throw error; }
      }
      if (publish) {
        this.update(session, { sessionUpdate: 'current_mode_update', currentModeId: modeId });
        this.update(session, { sessionUpdate: 'config_option_update', configOptions: this.modelConfig(session) });
      }
      if (modeId === 'full') {
        for (const [id, permission] of this.permissions) {
          if (permission.session === session && permission.kind === 'permission') {
            this.permissions.delete(id);
            permission.resolve({ outcome: { outcome: 'selected', optionId: 'allow-once' } });
          }
        }
      }
    } catch (error) {
      session.mode = originalMode;
      throw error;
    } finally {
      session.changingConfig = false;
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
    return [{ id: 'model', name: this.chinese ? '模型' : 'Model', category: 'model', type: 'select',
      currentValue: session.currentModelId,
      ...(this.airRecommendedValue ? { _meta: { jetbrains: { air: {
        version: 1, recommendedValue: session.recommendedModelId,
      } } } } : {}),
      options: session.availableModels.map(model => ({
        value: `${model.provider}/${model.id}`, name: model.name || model.id,
      })),
    }, { id: 'thinking', name: this.chinese ? '推理级别' : 'Thinking Level', category: 'thought_level', type: 'select',
      currentValue: session.thinkingLevel,
      ...(this.airRecommendedValue && session.thinkingLevels.includes(session.recommendedThinkingLevel) ? { _meta: { jetbrains: { air: {
        version: 1, recommendedValue: session.recommendedThinkingLevel,
      } } } } : {}),
      options: session.thinkingLevels.map(level => ({ value: level,
        name: (this.chinese
          ? { off: '关闭', minimal: '最低', low: '低', medium: '中', high: '高', xhigh: '极高', max: '最高' }
          : { off: 'Off', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra High', max: 'Max' })[level] || level,
      })),
    }, { id: 'mode', name: this.chinese ? '权限模式' : 'Permission Mode', category: 'mode', type: 'select',
      currentValue: session.mode,
      options: this.modes.map(mode => ({ value: mode.id, name: mode.name, description: mode.description })),
    }];
  }

  tool(session, event) {
    const name = event.toolName;
    return { toolCallId: event.toolCallId, title: name, kind: toolKind(name),
      rawInput: event.args,
      ...(typeof event.args?.path === 'string' ? { locations: [{ path: toolPath(session.cwd, event.args.path) }] } : {}) };
  }

  content(result) {
    return (result?.content ?? []).filter(c => ['text', 'image'].includes(c.type))
      .map(content => ({ type: 'content', content }));
  }

  terminalOutputKey() {
    const meta = this.clientCapabilities?._meta;
    if (meta?.terminal_output_delta === true) return 'terminal_output_delta';
    if (meta?.terminal_output === true) return 'terminal_output';
    return null;
  }

  terminalUpdate(session, toolCallId, result, final = false) {
    const tool = session.tools.get(toolCallId);
    if (!['bash', 'powershell'].includes(tool?.title)) return {};
    const key = this.terminalOutputKey();
    const previous = session.terminals.get(toolCallId) ?? '';
    const contentOutput = result?.content?.find(block => block.type === 'text')?.text;
    const output = final && previous ? contentOutput
      : final && typeof result?.structuredContent?.output === 'string' ? result.structuredContent.output : contentOutput;
    const overlap = typeof output === 'string' ? suffixPrefixOverlap(previous, output) : 0;
    const delta = key && typeof output === 'string' ? [...output].slice(overlap).join('') : '';
    if (typeof output === 'string') session.terminals.set(toolCallId, output);
    const exitCode = result?.structuredContent?.exit_code;
    return { ...(key || final ? { _meta: {
      ...(delta ? { [key]: { terminal_id: toolCallId, data: delta } } : {}),
      ...(final && Number.isInteger(exitCode) ? { terminal_exit: {
        terminal_id: toolCallId, exit_code: exitCode, signal: null,
      } } : {}),
    } } : {}) };
  }

  toolResult(session, toolCallId, result, isError, final = true) {
    const tool = session.tools.get(toolCallId);
    const terminal = this.terminalUpdate(session, toolCallId, result, final);
    const diffs = fileDiffs(tool, result, isError);
    const firstChangedLine = result?.details?.firstChangedLine;
    const line = !isError && Number.isSafeInteger(firstChangedLine) && firstChangedLine > 0 ? firstChangedLine : diffs[0]?.line;
    const ordinaryContent = this.terminalOutputKey() && ['bash', 'powershell'].includes(tool?.title)
      ? [] : this.content(result);
    const patch = diffs.length ? gitPatch(diffs[0].path, result) : undefined;
    const renderedDiffs = this.airDiffPatch && patch
      ? [{ type: 'diff', path: diffs[0].path, oldText: null, newText: '', _meta: { kind: patch.kind, jetbrains: { air: {
        version: 1, diffPatch: { version: 1, format: 'git_patch', text: patch.text },
      } } } }]
      : diffs.map(({ line, ...diff }) => diff);
    return { content: [...ordinaryContent, ...renderedDiffs], rawOutput: result, ...terminal,
      ...(tool?.locations?.length && line !== undefined ? { locations: [{ path: tool.locations[0].path, line }] } : {}) };
  }

  event(session, event) {
    if (event.type === 'session_info_changed') {
      this.update(session, { sessionUpdate: 'session_info_update', title: event.name ?? null });
      return;
    }
    if (event.type === 'thinking_level_changed' && session.thinkingLevels && !session.changingConfig) {
      session.thinkingLevel = event.level;
      this.update(session, { sessionUpdate: 'config_option_update', configOptions: this.modelConfig(session) });
      return;
    }
    if (event.type === 'compaction_start') {
      session.compaction = (session.compaction ?? 0) + 1;
      session.compactionId = `pi-compaction-${randomUUID()}`;
      this.compactionUpdate(session, session.compactionId, 'in_progress');
      return;
    }
    if (event.type === 'compaction_end') {
      this.recordUsage(session, event.result?.usage);
      this.compactionUpdate(session, session.compactionId ?? `pi-compaction-${randomUUID()}`,
        event.result ? 'completed' : event.aborted ? 'cancelled' : 'failed', event.result, event.errorMessage);
      void this.refreshUsage(session).catch(error => process.stderr.write(`刷新用量失败：${error.message}\n`));
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
      case 'agent_start':
        session.turn.starts++;
        session.turn.settled = false;
        break;
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
        this.recordUsage(session, message.usage);
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
        if (['bash', 'powershell', 'background_shell'].includes(event.toolName)) session.terminals.set(event.toolCallId, '');
        this.update(session, { sessionUpdate: 'tool_call', ...tool,
          ...(['bash', 'powershell', 'background_shell'].includes(event.toolName) ? {
            content: [{ type: 'terminal', terminalId: event.toolCallId }],
            _meta: { terminal_info: { terminal_id: event.toolCallId, cwd: session.cwd } },
          } : {}),
          status: ['read', 'grep', 'find', 'ls', 'update_plan', 'task_status'].includes(event.toolName) ? 'in_progress' : 'pending' });
        break;
      }
      case 'tool_execution_update':
      case 'tool_execution_end': {
        if ([...this.tasks.tasks.values()].some(task => task.owner === session.id && task.toolCallId === event.toolCallId)) {
          if (event.type === 'tool_execution_end') session.tools.delete(event.toolCallId);
          break;
        }
        const tool = session.tools.get(event.toolCallId);
        if (event.type === 'tool_execution_end' && !event.isError && ['edit', 'write'].includes(tool?.title) &&
            tool.locations?.[0]?.path) session.turn.changedPaths?.add(tool.locations[0].path);
        this.update(session, { sessionUpdate: 'tool_call_update', toolCallId: event.toolCallId,
          status: event.type === 'tool_execution_update' ? 'in_progress' : event.isError ? 'failed' : 'completed',
          ...this.toolResult(session, event.toolCallId, event.result ?? event.partialResult,
            event.isError || event.type !== 'tool_execution_end', event.type === 'tool_execution_end') });
        if (event.type === 'tool_execution_end') {
          session.authorizedTasks?.delete(event.toolCallId);
          this.publishPlan(session, event.result, event.isError);
          session.tools.delete(event.toolCallId);
          session.terminals.delete(event.toolCallId);
          session.inputTerminals?.delete(event.toolCallId);
        }
        break;
      }
      case 'auto_retry_end':
        if (!event.success) session.turn.error = new Error(event.finalError || '模型重试失败');
        break;
      case 'agent_settled':
        if (event.aborted) session.turn.cancelled = true;
        session.turn.usage = this.refreshUsage(session).catch(error => {
          process.stderr.write(`刷新用量失败：${error.message}\n`);
        });
        session.turn.settle();
        break;
    }
  }

  async control(session, request) {
    try {
      if (request.action === 'url_elicitation' || request.action === 'url_elicitation_complete') {
        const result = request.action === 'url_elicitation'
          ? await this.elicitUrl(session, request.params ?? {})
          : this.completeUrl(session, request.params?.elicitationId);
        session.pi.controlResponse(request.id, result);
        return;
      }
      if (!session.turn || session.turn.cancelled) throw invalid('会话没有可执行工具的回合');
      let result;
      if (request.action === 'spawn_agent' || request.action === 'background_shell') {
        if (!session.authorizedTasks?.delete(request.toolCallId)) throw invalid('任务工具尚未授权');
        result = await this.tasks.start(session, request.action === 'spawn_agent' ? 'agent' : 'shell',
          request.params ?? {}, request.toolCallId);
      } else if (request.action === 'task_status') result = this.tasks.snapshot(this.tasks.owned(session, request.params?.taskId));
      else if (request.action === 'stop_task') result = await this.tasks.stop(session, request.params?.taskId);
      else throw invalid('未知任务操作');
      session.pi.controlResponse(request.id, result);
    } catch (error) { session.pi.controlResponse(request.id, undefined, error); }
  }

  async elicitUrl(session, params) {
    const capability = this.clientCapabilities?.elicitation?.url;
    if (!capability || typeof capability !== 'object' || Array.isArray(capability)) return { action: 'cancel' };
    if (this.closing || session.failure ||
        !(session.turn || session.command) || session.turn?.cancelled || session.command?.cancelled) {
      return { action: 'cancel' };
    }
    if (typeof params.message !== 'string' || !params.message.trim() || params.message.length > 10000 ||
        typeof params.url !== 'string' || params.url.length > 10000) throw invalid('URL 交互参数无效');
    let url;
    try { url = new URL(params.url); } catch { throw invalid('URL 交互网址无效'); }
    if (url.username || url.password || (url.protocol !== 'https:' &&
        !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
      throw invalid('URL 交互仅允许 HTTPS 或本机 HTTP，且不能包含用户名或密码');
    }
    if (this.urlElicitations.size >= 100) throw invalid('待完成的 URL 交互过多');
    const id = `acp-elicitation-${++this.sequence}`;
    const elicitationId = randomUUID();
    const entry = { session, accepted: false };
    this.urlElicitations.set(elicitationId, entry);
    const decision = new Promise(resolve => this.permissions.set(id, { session, resolve, kind: 'elicitation' }));
    try {
      this.send({ jsonrpc: '2.0', id, method: 'elicitation/create', params: {
        sessionId: session.id, mode: 'url', elicitationId, url: params.url, message: params.message,
      } });
      const result = await decision;
      const action = this.urlElicitations.has(elicitationId) && ['accept', 'decline', 'cancel'].includes(result?.action)
        ? result.action : 'cancel';
      entry.accepted = action === 'accept';
      if (!entry.accepted) this.urlElicitations.delete(elicitationId);
      // URL 响应只保留决定，凭据及其他 content 不经过扩展通道。
      return { action, elicitationId };
    } catch (error) {
      this.urlElicitations.delete(elicitationId);
      throw error;
    } finally { this.permissions.delete(id); }
  }

  completeUrl(session, elicitationId) {
    const entry = this.urlElicitations.get(elicitationId);
    if (!entry?.accepted || entry.session !== session) return { completed: false };
    this.urlElicitations.delete(elicitationId);
    this.send({ jsonrpc: '2.0', method: 'elicitation/complete', params: { elicitationId } });
    return { completed: true };
  }

  async ui(session, event) {
    if (event.method === 'notify' && event.message?.startsWith('PI_ACP_TERMINAL_READY:')) {
      const id = event.message.slice('PI_ACP_TERMINAL_READY:'.length);
      session.inputTerminals.add(id);
      this.update(session, { sessionUpdate: 'tool_call_update', toolCallId: id,
        _meta: { terminal_info: { terminal_id: id, cwd: session.cwd, input_enabled: true } } });
      return;
    }
    if (event.method === 'notify' && event.message?.startsWith('PI_ACP_SESSIONS:')) {
      session.history = JSON.parse(event.message.slice('PI_ACP_SESSIONS:'.length));
      return;
    }
    if (event.method === 'notify' && event.message?.startsWith('PI_ACP_MESSAGE:')) {
      const message = JSON.parse(event.message.slice('PI_ACP_MESSAGE:'.length));
      if (message.role === 'assistant') session.assistantMessageId = message.id;
      if (message.role === 'user') this.onUserMessage?.(session, message.id);
      return;
    }
    if (event.method === 'notify' && event.message?.startsWith('PI_ACP_GOAL:')) {
      session.goal = JSON.parse(event.message.slice('PI_ACP_GOAL:'.length));
      if (session.availableModels && !session.changingConfig) this.goalUpdate(session);
      return;
    }
    if (event.method === 'notify' && event.message === 'PI_ACP_READY') {
      session.ready = true;
      return;
    }
    if (event.method === 'notify') {
      if (this.clientCapabilities?.session?.notices && typeof this.clientCapabilities.session.notices === 'object' &&
          !Array.isArray(this.clientCapabilities.session.notices)) {
        this.update(session, { sessionUpdate: 'notice',
          severity: event.notifyType === 'error' ? 'error' : event.notifyType === 'warning' ? 'warning' : 'info',
          title: event.message || 'pi 通知' });
      }
      return;
    }
    if (event.method !== 'confirm' || event.title !== 'PI_ACP_PERMISSION') {
      if (['confirm', 'select', 'input', 'editor'].includes(event.method)) {
        if (event.method === 'select' && (!Array.isArray(event.options) || event.options.some(option => typeof option !== 'string'))) {
          session.pi.send({ type: 'extension_ui_response', id: event.id, cancelled: true });
          return;
        }
        const form = this.clientCapabilities?.elicitation?.form;
        if (form != null && (session.turn || session.command) && !session.turn?.cancelled && !session.command?.cancelled) {
          const property = event.method === 'confirm'
            ? { type: 'boolean', default: false }
            : event.method === 'select'
              ? { type: 'string', enum: event.options }
              : { type: 'string', ...(event.placeholder ? { description: event.placeholder } : {}),
                ...(event.prefill !== undefined ? { default: event.prefill } : {}) };
          const id = `acp-elicitation-${++this.sequence}`;
          const decision = new Promise(resolve => this.permissions.set(id, { session, resolve, kind: 'elicitation' }));
          this.send({ jsonrpc: '2.0', id, method: 'elicitation/create', params: {
            sessionId: session.interactionSessionId ?? session.id, mode: 'form',
            message: [event.title || 'pi 需要输入', event.message].filter(Boolean).join('\n\n'),
            requestedSchema: { type: 'object', properties: { value: property }, required: ['value'] },
          } });
          const result = await decision;
          const value = result?.content?.value;
          const accepted = result?.action === 'accept' &&
            (event.method === 'confirm' ? typeof value === 'boolean'
              : typeof value === 'string' && (event.method !== 'select' || event.options.includes(value)));
          session.pi.send({ type: 'extension_ui_response', id: event.id,
            ...(accepted ? event.method === 'confirm' ? { confirmed: value } : { value }
              : { cancelled: true }) });
          return;
        }
        session.pi.send({ type: 'extension_ui_response', id: event.id, cancelled: true });
        if (session.turn) this.update(session, { sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `\n扩展交互暂不支持：${event.title ?? event.method}\n` } });
      }
      return;
    }
    const call = JSON.parse(event.message);
    if (session.turn?.cancelled) {
      session.pi.send({ type: 'extension_ui_response', id: event.id, cancelled: true });
      return;
    }
    if (['read-only', 'plan'].includes(session.mode)) {
      session.pi.send({ type: 'extension_ui_response', id: event.id, confirmed: false });
      return;
    }
    if (session.mode === 'full') {
      if (!['read', 'grep', 'find', 'ls', 'update_plan', 'task_status'].includes(call.toolName)) {
        (session.authorizedTasks ??= new Set()).add(call.toolCallId);
      }
      session.pi.send({ type: 'extension_ui_response', id: event.id, confirmed: true });
      this.update(session, { sessionUpdate: 'tool_call_update', toolCallId: call.toolCallId, status: 'in_progress' });
      return;
    }
    if (!session.turn) {
      session.pi.send({ type: 'extension_ui_response', id: event.id, cancelled: true });
      return;
    }
    const tool = session.tools.get(call.toolCallId) ?? this.tool(session, call);
    const id = `acp-permission-${++this.sequence}`;
    const decision = new Promise(resolve => this.permissions.set(id, { session, resolve, kind: 'permission' }));
    this.send({ jsonrpc: '2.0', id, method: 'session/request_permission',
      params: { sessionId: session.interactionSessionId ?? session.id, toolCall: { ...tool, status: 'pending' }, options: [
        { optionId: 'allow-once', name: '允许本次', kind: 'allow_once' },
        { optionId: 'allow-session', name: '本会话允许全部工具', kind: 'allow_always' },
        { optionId: 'reject-once', name: '拒绝本次', kind: 'reject_once' },
      ] } });
    const result = await decision;
    const approved = !['read-only', 'plan'].includes(session.mode) && !session.turn?.cancelled &&
      result?.outcome?.outcome === 'selected' &&
      ['allow-once', 'allow-session'].includes(result.outcome.optionId);
    if (approved && result.outcome.optionId === 'allow-session') await this.setMode(session, 'full');
    if (approved && !['read', 'grep', 'find', 'ls', 'update_plan', 'task_status'].includes(call.toolName)) {
      (session.authorizedTasks ??= new Set()).add(call.toolCallId);
    }
    if (!session.pi.closed) session.pi.send({ type: 'extension_ui_response', id: event.id, confirmed: approved });
    if (approved) this.update(session, { sessionUpdate: 'tool_call_update', toolCallId: call.toolCallId, status: 'in_progress' });
  }

  cancelPermissions(session, { keepAcceptedUrls = false } = {}) {
    for (const [id, entry] of this.urlElicitations) {
      if (entry.session === session && !(keepAcceptedUrls && entry.accepted)) this.urlElicitations.delete(id);
    }
    for (const [id, permission] of this.permissions) {
      if (permission.session === session) {
        this.permissions.delete(id);
        permission.resolve(undefined);
      }
    }
  }

  async close() {
    this.closing = true;
    for (const subscription of this.subscriptions.values()) {
      subscription.active = false;
      clearInterval(subscription.timer);
    }
    await Promise.allSettled([...this.lifecycleOperations.values()]);
    await Promise.all([...this.sessions.values()].filter(session => !session.parentId).map(async session => {
      this.cancelPermissions(session);
      try {
        await this.tasks.close(session);
        await session.taskWrites;
      } finally {
        await session.pi?.close();
        await rm(session.directory, { recursive: true, force: true });
      }
    }));
    this.sessions.clear();
    this.lifecycleOperations.clear();
    this.subscriptions.clear();
  }
}
