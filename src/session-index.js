import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { air, invalid, requireCwd, requireId } from './shared.js';

const executeFile = promisify(execFile);

// 历史会话索引：列表、查找、归档及列表变化订阅。
// 历史由临时启动的 discovery pi 进程通过 /__acp_list 读取。
export class SessionIndex {
  constructor(agent) {
    this.agent = agent;
    this.subscriptions = new Map();
  }

  async find(sessionId, cwd) {
    const { sessions } = await this.list(cwd === undefined ? {} : { cwd }, { includeArchived: true });
    return sessions.find(info => info.sessionId === sessionId && (cwd === undefined || resolve(info.cwd) === resolve(cwd)));
  }

  info({ path, archived, forkedFrom, ...info }) {
    if (!this.agent.airIndex) return info;
    const active = this.agent.sessions.get(info.sessionId);
    const requiresAction = !!active && this.agent.interactions.waiting(active);
    return { ...info, ...air({ archived: archived === true,
      state: active?.failure ? 'error' : requiresAction ? 'requires_action' : active?.turn || active?.command ? 'running' : 'idle',
      ...(active?.currentModelId ? { model: active.currentModelId } : {}),
      ...(forkedFrom ? { forkedFrom } : {}),
    }) };
  }

  async read(context, params) {
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

  async list(params, { includeArchived = false } = {}) {
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
    const created = await this.agent.newSession({ cwd: params.cwd ?? process.cwd(), mcpServers: [] }, { discovery: true });
    try {
      const history = (await this.read(created, params)).filter(info =>
        archived === 'all' || (info.archived === true) === (archived === 'archived'));
      const sessions = history.slice(offset, offset + limit);
      return { sessions, ...(offset + limit < history.length ? { nextCursor: String(offset + limit) } : {}) };
    } finally {
      await this.agent.closeSession({ sessionId: created.id });
    }
  }

  async archive(params, archived) {
    requireId(params.sessionId);
    const live = this.agent.sessions.get(params.sessionId);
    const saved = await this.find(params.sessionId);
    if (!saved) throw invalid('没有此历史会话');
    if (archived && live) await this.agent.closeSession({ sessionId: live.id });
    const temporary = !this.agent.sessions.has(params.sessionId);
    if (temporary) await this.agent.newSession({ cwd: saved.cwd, mcpServers: [] }, { id: saved.sessionId, path: saved.path });
    const context = this.agent.sessions.get(params.sessionId);
    try {
      if (archived && !live) {
        const entries = await context.pi.request('get_entries');
        await this.agent.tasks.restore(context, this.agent.tasks.branch(entries), { replay: false });
        await this.agent.tasks.close(context);
      }
      await context.pi.request('prompt', { message: `/__acp_archive ${archived}` });
      this.agent.update(context, { sessionUpdate: 'session_info_update', ...air({ archived }) });
    } finally {
      if (temporary) await this.agent.closeSession({ sessionId: context.id });
    }
    return {};
  }

  async subscribe(params) {
    if (!this.agent.airIndex) throw invalid('客户端未协商 sessionIndex');
    requireCwd(params.cwd);
    if (this.subscriptions.size >= 8) throw invalid('会话列表订阅数量已达上限');
    const subscription = { id: randomUUID(), cwd: params.cwd, active: true, previous: new Map() };
    this.subscriptions.set(subscription.id, subscription);
    try {
      subscription.context = await this.agent.newSession({ cwd: params.cwd, mcpServers: [] }, { discovery: true });
      if (this.agent.closing) throw new Error('适配器正在关闭');
      await this.refresh(subscription, false);
      subscription.timer = setInterval(() => {
        if (!subscription.active || subscription.pending || this.agent.closing) return;
        subscription.pending = this.refresh(subscription).catch(error => {
          if (subscription.active && !this.agent.closing) process.stderr.write(`刷新会话列表失败：${error.message}\n`);
        }).finally(() => { subscription.pending = null; });
      }, 2000);
      subscription.timer.unref();
      setImmediate(() => {
        if (subscription.active && !this.agent.closing) this.agent.send({ jsonrpc: '2.0', method: '_session/list/changes',
          params: { subscriptionId: subscription.id, sessions: [...subscription.previous.values()], removed: [] } });
      });
      return { subscriptionId: subscription.id };
    } catch (error) {
      await this.unsubscribe({ subscriptionId: subscription.id });
      throw error;
    }
  }

  async refresh(subscription, emit = true) {
    const history = await this.read(subscription.context, { cwd: subscription.cwd,
      _meta: { jetbrains: { air: { list: { includeWorktrees: true } } } } });
    if (!subscription.active) return;
    const current = new Map(history.map(info => [info.sessionId, this.info(info)]));
    const sessions = [...current.values()].filter(info =>
      JSON.stringify(info) !== JSON.stringify(subscription.previous.get(info.sessionId)));
    const removed = [...subscription.previous.keys()].filter(id => !current.has(id));
    subscription.previous = current;
    if (emit && (sessions.length || removed.length)) this.agent.send({ jsonrpc: '2.0', method: '_session/list/changes',
      params: { subscriptionId: subscription.id, sessions, removed } });
  }

  async unsubscribe(params) {
    if (typeof params.subscriptionId !== 'string' || !params.subscriptionId) throw invalid('缺少 subscriptionId');
    const subscription = this.subscriptions.get(params.subscriptionId);
    if (!subscription) return {};
    subscription.active = false;
    clearInterval(subscription.timer);
    this.subscriptions.delete(subscription.id);
    if (subscription.context) await this.agent.closeSession({ sessionId: subscription.context.id });
    return {};
  }

  // 适配器关闭时停止全部轮询；订阅的 discovery 会话由 Agent.close 统一关闭。
  close() {
    for (const subscription of this.subscriptions.values()) {
      subscription.active = false;
      clearInterval(subscription.timer);
    }
    this.subscriptions.clear();
  }
}
