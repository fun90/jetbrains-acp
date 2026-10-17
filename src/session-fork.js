import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { isAbsolute, resolve } from 'node:path';
import { convertMcp } from './convert.js';
import { invalid, requireCwd, requireId } from './shared.js';
import { t } from './i18n.js';

// session/fork：复制已有会话或从指定助手消息分叉，并让原会话 ID 继续指向原历史。
export class SessionFork {
  constructor(agent) {
    this.agent = agent;
  }

  async fork(params) {
    requireId(params.sessionId);
    const fork = params._meta?.jetbrains?.air?.fork;
    if (fork !== undefined && (!fork || Array.isArray(fork) || fork.version !== 1 ||
        typeof fork.messageId !== 'string' || !fork.messageId.trim() ||
        (fork.messageFingerprint !== undefined && (typeof fork.messageFingerprint !== 'string' ||
          !/^sha256:[a-fA-F0-9]{64}$/.test(fork.messageFingerprint))) ||
        (fork.messageOccurrence !== undefined && (!Number.isSafeInteger(fork.messageOccurrence) || fork.messageOccurrence < 1)))) {
      throw invalid(t('forkPointInvalid'));
    }
    let source = this.agent.sessions.get(params.sessionId);
    if (!source) {
      requireCwd(params.cwd, t('forkCwdAbsolute'));
      const saved = await this.agent.index.find(params.sessionId, params.cwd);
      if (!saved) throw invalid(t('savedSessionNotInCwd'));
      await this.agent.newSession({ cwd: params.cwd, mcpServers: params.mcpServers ?? [] },
        { id: saved.sessionId, path: saved.path });
      source = this.agent.sessions.get(params.sessionId);
    }
    if (this.agent.busy(source)) throw invalid(t('sessionBusy'));
    const cwd = params.cwd ?? source.cwd;
    if (typeof cwd !== 'string' || !isAbsolute(cwd) || resolve(cwd) !== resolve(source.cwd)) {
      throw invalid(t('forkCwdMismatch'));
    }
    const requestedMcp = params.mcpServers ?? source.mcpServers;
    convertMcp(requestedMcp);
    source.changingConfig = true;
    try {
      return await this.clone(source, params, cwd);
    } finally {
      source.changingConfig = false;
    }
  }

  async clone(source, params, cwd) {
    const fork = params._meta?.jetbrains?.air?.fork;
    let forkEntryId;
    if (fork) {
      const branch = this.agent.tasks.branch(await source.pi.request('get_entries'));
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
      if (index < 0) throw invalid(t('assistantMessageNotFound'));
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
    if (!oldState.sessionFile) throw new Error(t('sessionNotPersisted'));
    const cloned = forkEntryId
      ? await source.pi.request('prompt', { message: `/__acp_fork ${JSON.stringify(forkEntryId)}` })
      : await source.pi.request('clone');
    if (cloned?.cancelled) throw invalid(t('forkCancelled'));
    let newState;
    try {
      newState = await source.pi.request('get_state');
      if (forkEntryId && newState.sessionId === source.id) throw invalid(t('forkAtMessageFailed'));
      if (!newState.sessionId || newState.sessionId === source.id || !newState.sessionFile) {
        throw new Error(t('forkCreateFailed'));
      }
      await source.pi.request('prompt', { message: '/__acp_check' });
      await source.pi.request('prompt', { message: `/__acp_mode ${sourceMode === 'plan' ? 'plan' : 'default'}` });
    } catch (error) {
      if (forkEntryId && newState?.sessionId === source.id) throw error;
      await this.agent.disposeSession(source);
      throw error;
    }
    this.agent.sessions.delete(source.id);
    source.id = newState.sessionId;
    this.agent.sessions.set(source.id, source);
    try {
      const requestedMcp = params.mcpServers ?? sourceMcp;
      const changeMcp = !isDeepStrictEqual(convertMcp(requestedMcp), convertMcp(sourceMcp));
      if (changeMcp) {
        await this.agent.disposeSession(source);
        await this.agent.newSession({ cwd, mcpServers: requestedMcp, ...customInstructions },
          { id: newState.sessionId, path: newState.sessionFile });
        source = this.agent.sessions.get(newState.sessionId);
      }
      await this.agent.newSession({ cwd, mcpServers: sourceMcp, ...customInstructions },
        { id: params.sessionId, path: oldState.sessionFile });
      const restored = this.agent.sessions.get(params.sessionId);
      for (const session of changeMcp ? [restored, source] : [restored]) {
        await this.agent.applyModelConfig(session, sourceModelId, sourceThinking, false);
        await this.agent.setMode(session, sourceMode, false);
      }
    } catch (error) {
      const restored = this.agent.sessions.get(params.sessionId);
      if (restored) await this.agent.disposeSession(restored);
      this.agent.sessions.delete(source.id);
      await this.agent.disposeSession(source);
      throw error;
    }
    await this.agent.publishSession(source);
    if (source.goal) this.agent.goalUpdate(source);
    return this.agent.sessionState(source);
  }
}
