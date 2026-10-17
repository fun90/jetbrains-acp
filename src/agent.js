import packageInfo from '../package.json' with { type: 'json' };
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { mkdtemp, writeFile, rm, stat, unlink, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateTerminalInput } from './terminal-input.js';
import { PiProcess } from './pi.js';
import { Tasks } from './tasks.js';
import { Interactions } from './interactions.js';
import { Transcript } from './transcript.js';
import { SessionIndex } from './session-index.js';
import { SessionFork } from './session-fork.js';
import { Commands } from './commands.js';
import { convertMcp, convertPrompt } from './convert.js';
import { changedFiles, fileSnapshot } from './file-changes.js';
import { air, invalid, logError, modelKey, requireCwd, requireId, restrictedModes } from './shared.js';

const extensionPath = fileURLToPath(new URL('../extensions/acp.ts', import.meta.url));
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

// 需要按会话串行执行的方法（见 Agent.lifecycle）。
const lifecycleMethods = {
  'session/load': (agent, params) => agent.loadSession(params),
  'session/resume': (agent, params) => agent.resumeSession(params),
  'session/close': (agent, params) => agent.closeSession(params),
  'session/delete': (agent, params) => agent.deleteSession(params),
  'session/fork': (agent, params) => agent.forks.fork(params),
  '_session/rename': (agent, params) => agent.renameSession(params),
  '_session/goal': (agent, params) => agent.goalSession(params),
};

// ACP v1 协议入口：分发 JSON-RPC 请求、管理会话生命周期与提示轮次，并把 pi 事件转成 ACP 更新。
// 每个会话对应一个 pi RPC 子进程（session.pi）。按职责拆出的协作者：
//   tasks        子 agent 与后台 shell 任务（tasks.js）
//   interactions 扩展 UI 请求、工具授权、表单与 URL 交互（interactions.js）
//   transcript   工具调用、计划、压缩及历史回放的渲染（transcript.js）
//   index        历史会话列表、归档与列表订阅（session-index.js）
//   forks        会话分叉（session-fork.js）
//   commands     /status、/compact、/goal 等本地命令（commands.js）
// ACP v2 由 protocol.js 的 ProtocolAgent 转换后调用本类。
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
    this.interactions = new Interactions(this);
    this.transcript = new Transcript(this);
    this.index = new SessionIndex(this);
    this.forks = new SessionFork(this);
    this.commands = new Commands(this);
    this.lifecycleOperations = new Map();
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
      this.interactions.resolve(message.id, message.result);
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

  initialize(params) {
    if (!Number.isInteger(params.protocolVersion)) throw invalid('缺少 protocolVersion');
    this.clientCapabilities = params.clientCapabilities ?? {};
    const airInfo = this.clientCapabilities?._meta?.jetbrains?.air;
    const airCapabilities = airInfo?.version >= 1 && Array.isArray(airInfo.capabilities) ? airInfo.capabilities : [];
    this.airDiffPatch = airCapabilities.includes('diffPatch');
    this.airFileReport = airCapabilities.includes('agentFileChangeReport');
    this.airClient = airInfo != null && typeof airInfo === 'object' && !Array.isArray(airInfo);
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
    this.terminalAuth = this.clientCapabilities.auth?.terminal === true || this.clientCapabilities._meta?.['terminal-auth'] === true;
    this.initialized = true;
    return { protocolVersion: 1, agentInfo: { name: packageInfo.name, title: 'pi', version: packageInfo.version },
      agentCapabilities: { loadSession: true, sessionCapabilities: {
        list: {}, resume: {}, close: {}, delete: {}, fork: {}, subagents: {},
      },
        promptCapabilities: { image: true, embeddedContext: true },
        mcpCapabilities: { http: true, sse: false } }, authMethods: this.terminalAuth
        ? [{ id: 'pi-login', name: '登录 pi 模型提供商',
          description: '在终端 pi 中输入 /login，完成登录后退出并返回 IDE', type: 'terminal',
          env: { PI_ACP_SETUP: '1' },
          _meta: { 'terminal-auth': { args: ['--setup', '--pi-command', this.command, '--', ...this.args] } } }]
        : [],
      _meta: { steering: { supported: true },
        terminal_input: { supported: true, controlMethod: '_terminal/input', encoding: 'utf8', maxBytes: 65536 },
        ...(airInfo && typeof airInfo === 'object' ? { jetbrains: { air: { version: 1,
          goal: { version: 1, controlMethod: '_session/goal', actions: ['set', 'pause', 'resume', 'clear'] },
          capabilities: ['diffPatch', 'agentFileChangeReport', 'customInstructions',
            'recommendedValue', 'sessionFailure', 'asyncTasks', 'nativeSubagentSessions', ...(this.airIndex ? [
              'sessionIndex', 'sessionArchive', 'sessionRename', 'sessionListSubscribe',
            ] : [])], } } } : {}) } };
  }

  async dispatch(method, params) {
    if (!params || typeof params !== 'object' || Array.isArray(params)) throw invalid('params 必须是对象');
    if (method === 'initialize') return this.initialize(params);
    if (!this.initialized) throw invalid('请先 initialize');
    if ((method === 'authenticate' || method === 'auth/login') && this.terminalAuth) {
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
      return { tasks: this.tasks.ownedBy(session.id)
        .map(task => this.tasks.snapshot(task)) };
    }
    if (method === '_terminal/input') return this.terminalInput(params);
    if (method === 'session/new') return this.newSession(params);
    if (method === 'session/list') {
      const listed = await this.index.list(params);
      return { ...listed, sessions: listed.sessions.map(info => this.index.info(info)) };
    }
    if (Object.hasOwn(lifecycleMethods, method)) {
      return this.lifecycle(params.sessionId, () => lifecycleMethods[method](this, params));
    }
    if (method === '_session/archive' || method === '_session/unarchive') {
      if (!this.airIndex) throw invalid('客户端未协商 sessionIndex');
      return this.lifecycle(params.sessionId, () => this.index.archive(params, method === '_session/archive'));
    }
    if (method === '_session/list/subscribe') return this.index.subscribe(params);
    if (method === '_session/list/unsubscribe') return this.index.unsubscribe(params);
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
      if (configId === 'model' && !session.availableModels.some(model => modelKey(model) === value)) throw invalid('模型不在可用列表中');
      if (configId === 'thinking' && !session.thinkingLevels.includes(value)) throw invalid('当前模型不支持此推理级别');
      if (session.changingConfig) throw invalid('配置正在切换，请稍后重试');
      session.changingConfig = true;
      try {
        await this.applyModelConfig(session, configId === 'model' ? value : undefined,
          configId === 'thinking' ? value : undefined);
        const configOptions = this.modelConfig(session);
        this.update(session, { sessionUpdate: 'config_option_update', configOptions });
        return method === 'session/set_model' ? {} : { configOptions };
      } finally {
        session.changingConfig = false;
      }
    }
    if (method === 'session/cancel') {
      this.interactions.cancel(session);
      if (session.parentId) await this.tasks.close(session);
      await this.cancelTurn(session);
      return {};
    }
    const steering = method === '_session/steering';
    if (this.terminalChatInput && await this.commands.terminalChat(session, convertPrompt(params.prompt))) {
      return steering ? { outcome: 'injected' } : { stopReason: 'end_turn' };
    }
    if (session.turn && !steering) throw invalid('该会话已有正在执行的提示');
    if (session.turn?.cancelled) throw invalid('会话正在取消，请稍后重试');
    if (session.turn?.finishing) throw invalid('会话正在生成文件报告，请稍后重试');
    if (session.changingConfig) throw invalid('配置正在切换，请稍后重试');
    const prompt = convertPrompt(params.prompt);
    if (!steering && !prompt.images && this.commands.isLocal(prompt.message.trim())) {
      return this.commands.run(session, prompt.message.trim(), this.fileReportRequest(params));
    }
    return this.prompt(session, prompt, steering, steering ? undefined : this.fileReportRequest(params));
  }

  async terminalInput(params) {
    if (!this.terminalInputEnabled) throw invalid('客户端未启用 _meta.terminal_input');
    try { validateTerminalInput(params); } catch (error) { throw invalid(error.message); }
    const session = this.requireSession(params.sessionId);
    if (!session.turn || session.turn.cancelled || session.changingConfig ||
        this.lifecycleOperations.has(session.id) || restrictedModes.includes(session.mode) ||
        !session.inputTerminals?.has(params.terminalId)) throw invalid('终端当前不可输入');
    await session.pi.request('terminal_input', { terminalId: params.terminalId, data: params.data, eof: params.eof });
    if (params.eof) session.inputTerminals.delete(params.terminalId);
    this.update(session, { sessionUpdate: 'tool_call_update', toolCallId: params.terminalId,
      _meta: { terminal_input: { terminal_id: params.terminalId, data: params.data } } });
    return {};
  }

  goalUpdate(session) {
    if (!this.airClient) return;
    this.update(session, { sessionUpdate: 'session_info_update',
      ...air({ goal: session.goal ? { ...session.goal, controlMethod: '_session/goal' } : null }) });
  }

  requireSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) throw invalid('会话不存在');
    if (session.failure) throw session.failure;
    return session;
  }

  busy(session) {
    return !!(session.turn || session.command || session.changingConfig);
  }

  async goalSession(params) {
    const session = this.requireSession(params.sessionId);
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
    this.update(session, { sessionUpdate: 'session_info_update', ...air({ agentFileChangeReport: report }) });
  }

  async prompt(session, prompt, steering, fileReportRequest) {
    const created = !session.turn;
    if (created) {
      this.onForegroundState?.(session, 'running');
      let resolve;
      const completed = new Promise(done => { resolve = done; });
      const turn = { completed, pending: 0, starts: 0, settled: false,
        cancelled: false, error: null, stopReason: 'end_turn', usage: Promise.resolve(),
        fileReportRequest, changedPaths: new Set() };
      if (fileReportRequest) turn.filesBefore = fileSnapshot(session.cwd);
      turn.finish = () => {
        if (session.turn !== turn || !turn.settled || turn.pending || turn.finishing) return;
        const complete = () => {
          this.interactions.cancel(session, { keepAcceptedUrls: true });
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
      if (this.airSessionFailure) return this.failureResult(session, turn.error, usage);
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

  failureResult(session, error, usage = {}) {
    return { stopReason: 'end_turn', ...usage, ...air({ sessionFailure: this.sessionFailure(session, error) }) };
  }

  // 打开当前目录中的历史会话；已打开时校验可复用并按需更新 MCP 配置。
  async openSession(params, metadata) {
    requireId(params.sessionId);
    requireCwd(params.cwd);
    convertMcp(params.mcpServers);
    const existing = this.sessions.get(params.sessionId);
    if (existing) {
      if (this.busy(existing) || !existing.availableModels) throw invalid('会话正在使用，请稍后重试');
      if (resolve(existing.cwd) !== resolve(params.cwd)) throw invalid('会话工作目录不匹配');
      if (existing.failure) throw existing.failure;
      return this.updateSessionMcp(existing, params);
    }
    const saved = await this.index.find(params.sessionId, params.cwd);
    if (this.sessions.has(params.sessionId)) throw invalid('会话正在加载，请稍后重试');
    if (!saved) throw invalid('当前目录中没有此历史会话');
    await this.newSession(params, { ...metadata, id: saved.sessionId, path: saved.path });
    return this.sessions.get(params.sessionId);
  }

  async resumeSession(params, metadata = {}) {
    const session = await this.openSession({ ...params, mcpServers: params.mcpServers ?? [] }, metadata);
    const entries = await session.pi.request('get_entries');
    await this.tasks.restore(session, this.tasks.branch(entries), { ...metadata.restoreContext, replay: false });
    const { sessionId, ...result } = this.sessionState(session);
    return result;
  }

  // 切换到指定模型和推理级别；非 strict 时跳过不可用的值。
  async applyModelConfig(session, modelId, thinkingLevel, strict = true) {
    if (modelId !== undefined && modelId !== session.currentModelId) {
      const model = session.availableModels.find(candidate => modelKey(candidate) === modelId);
      if (model) {
        await session.pi.request('set_model', { provider: model.provider, modelId: model.id });
        session.currentModelId = modelId;
        await this.refreshThinking(session);
      } else if (strict) throw invalid('模型不在可用列表中');
    }
    if (thinkingLevel !== undefined && thinkingLevel !== session.thinkingLevel) {
      if (session.thinkingLevels.includes(thinkingLevel)) {
        await session.pi.request('set_thinking_level', { level: thinkingLevel });
        await this.refreshThinking(session);
      } else if (strict) throw invalid('当前模型不支持此推理级别');
    }
  }

  async disposeSession(session) {
    if (this.sessions.get(session.id) === session) this.sessions.delete(session.id);
    try { await session.pi?.close(); }
    finally { await rm(session.directory, { recursive: true, force: true }); }
  }

  async updateSessionMcp(existing, params) {
    if (isDeepStrictEqual(convertMcp(params.mcpServers ?? []), convertMcp(existing.mcpServers))) return existing;
    if (this.tasks.ownedBy(existing.id).some(task => task.state === 'running')) {
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
      await this.applyModelConfig(replacement, existing.currentModelId, existing.thinkingLevel);
      replacement.recommendedModelId = existing.recommendedModelId;
      replacement.recommendedThinkingLevel = existing.recommendedThinkingLevel;
      replacement.changingConfig = false;
    } catch (error) {
      this.sessions.set(existing.id, existing);
      if (replacement) await this.disposeSession(replacement);
      throw error;
    } finally {
      existing.changingConfig = false;
    }
    await this.disposeSession(existing);
    return replacement;
  }

  async deleteSession(params) {
    requireId(params.sessionId);
    const live = this.sessions.get(params.sessionId);
    const requestedCwd = params.cwd ?? live?.cwd;
    if (requestedCwd !== undefined) requireCwd(requestedCwd);
    const saved = await this.index.find(params.sessionId, requestedCwd);
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
    requireId(params.sessionId);
    if (typeof params.title !== 'string' || !params.title.trim()) throw invalid('标题不能为空');
    const session = this.sessions.get(params.sessionId);
    if (session) {
      if (this.busy(session)) throw invalid('会话正在使用，请稍后重试');
      await session.pi.request('set_session_name', { name: params.title.trim() });
      return {};
    }
    const saved = await this.index.find(params.sessionId);
    if (!saved) throw invalid('没有此历史会话');
    const opened = await this.newSession({ cwd: saved.cwd, mcpServers: [] }, { id: saved.sessionId, path: saved.path });
    try { await this.sessions.get(opened.sessionId).pi.request('set_session_name', { name: params.title.trim() }); }
    finally { await this.closeSession({ sessionId: opened.sessionId }); }
    return {};
  }

  async closeSession(params) {
    requireId(params.sessionId);
    const session = this.sessions.get(params.sessionId);
    if (!session) return {};
    session.changingConfig = true;
    this.interactions.cancel(session);
    try {
      await this.tasks.close(session);
      await this.cancelTurn(session, true);
    } finally {
      this.sessions.delete(session.id);
      try { await session.taskWrites; }
      finally { await this.disposeSession(session); }
    }
    return {};
  }

  // wait 为 true 时无条件中止并等待本轮结束，用于关闭会话。
  async cancelTurn(session, wait = false) {
    if (session.command) {
      session.command.cancelled = true;
      await session.pi.request('abort');
      return;
    }
    const turn = session.turn;
    if (!turn) return;
    turn.cancelled = true;
    await session.pi.request('clear_queue');
    if (wait || session.turn === turn) await session.pi.request('abort');
    if (wait) await turn.completed;
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

  // 会话就绪后发布可用命令与用量；失败只记录日志。
  async publishSession(session) {
    await Promise.all([
      this.commands.publish(session).catch(logError('发布命令失败')),
      this.refreshUsage(session).catch(logError('刷新用量失败')),
    ]);
  }

  async loadSession(params, metadata = {}) {
    const session = await this.openSession(params, metadata);
    const result = this.sessionState(session);
    session.changingConfig = true;
    try {
      const branch = this.tasks.branch(await session.pi.request('get_entries'));
      session.tools.clear();
      for (const entry of branch) this.transcript.replay(session, entry);
      await this.tasks.restore(session, branch, metadata.restoreContext);
      session.tools.clear();
      const state = await session.pi.request('get_state');
      if (state.sessionName) this.update(session, { sessionUpdate: 'session_info_update', title: state.sessionName });
      const { sessionId, ...loaded } = result;
      return loaded;
    } catch (error) {
      await this.disposeSession(session);
      throw error;
    } finally {
      session.changingConfig = false;
    }
  }

  async newSession(params, { id = randomUUID(), path, discovery = false, parentId, taskId, mode, instructions, keepBusy = false } = {}) {
    requireCwd(params.cwd);
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
          void this.tasks.close(session, error).catch(logError('关闭后台任务失败'));
          if (session.turn) { session.turn.error = error; session.turn.settle(); }
          this.interactions.cancel(session);
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
      session.currentModelId = modelKey(current);
      session.recommendedModelId = session.currentModelId;
      await this.refreshThinking(session);
      session.recommendedThinkingLevel = session.thinkingLevel;
      session.changingConfig = false;
      if (mode && mode !== session.mode) await this.setMode(session, mode, false);
      session.changingConfig = keepBusy;
      const result = this.sessionState(session);
      if (session.goal) this.goalUpdate(session);
      await this.publishSession(session);
      return result;
    } catch (error) {
      await this.disposeSession(session);
      throw error;
    }
  }

  sessionState(session) {
    return { sessionId: session.id, configOptions: this.modelConfig(session),
      modes: { currentModeId: session.mode, availableModes: this.modes }, models: {
        currentModelId: session.currentModelId,
        availableModels: session.availableModels.map(model => ({
          modelId: modelKey(model), name: model.name || model.id,
        })),
      } };
  }

  async setMode(session, modeId, publish = true) {
    if (session.changingConfig) throw invalid('会话正在操作，请稍后重试');
    const originalMode = session.mode;
    session.changingConfig = true;
    try {
      if (restrictedModes.includes(modeId)) this.interactions.cancel(session);
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
      if (modeId === 'full') this.interactions.approveAll(session);
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
      ...(this.airRecommendedValue ? air({ recommendedValue: session.recommendedModelId }) : {}),
      options: session.availableModels.map(model => ({
        value: modelKey(model), name: model.name || model.id,
      })),
    }, { id: 'thinking', name: this.chinese ? '推理级别' : 'Thinking Level', category: 'thought_level', type: 'select',
      currentValue: session.thinkingLevel,
      ...(this.airRecommendedValue && session.thinkingLevels.includes(session.recommendedThinkingLevel)
        ? air({ recommendedValue: session.recommendedThinkingLevel }) : {}),
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
      this.transcript.compactionUpdate(session, session.compactionId, 'in_progress');
      return;
    }
    if (event.type === 'compaction_end') {
      this.recordUsage(session, event.result?.usage);
      this.transcript.compactionUpdate(session, session.compactionId ?? `pi-compaction-${randomUUID()}`,
        event.result ? 'completed' : event.aborted ? 'cancelled' : 'failed', event.result, event.errorMessage);
      void this.refreshUsage(session).catch(logError('刷新用量失败'));
      return;
    }
    if (event.type === 'extension_ui_request') {
      void this.interactions.handle(session, event).catch(error => {
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
        this.interactions.cancel(session);
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
      case 'tool_execution_start':
        this.transcript.toolStarted(session, event);
        break;
      case 'tool_execution_update':
      case 'tool_execution_end':
        this.transcript.toolUpdated(session, event);
        break;
      case 'auto_retry_end':
        if (!event.success) session.turn.error = new Error(event.finalError || '模型重试失败');
        break;
      case 'agent_settled':
        if (event.aborted) session.turn.cancelled = true;
        session.turn.usage = this.refreshUsage(session).catch(logError('刷新用量失败'));
        session.turn.settle();
        break;
    }
  }

  async control(session, request) {
    try {
      if (request.action === 'url_elicitation' || request.action === 'url_elicitation_complete') {
        const result = request.action === 'url_elicitation'
          ? await this.interactions.elicitUrl(session, request.params ?? {})
          : this.interactions.completeUrl(session, request.params?.elicitationId);
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

  async close() {
    this.closing = true;
    this.index.close();
    await Promise.allSettled([...this.lifecycleOperations.values()]);
    await Promise.all([...this.sessions.values()].filter(session => !session.parentId).map(async session => {
      this.interactions.cancel(session);
      try {
        await this.tasks.close(session);
        await session.taskWrites;
      } finally {
        await this.disposeSession(session);
      }
    }));
    this.sessions.clear();
    this.lifecycleOperations.clear();
  }
}
