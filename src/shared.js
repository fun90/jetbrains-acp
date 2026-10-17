import { isAbsolute } from 'node:path';
import { t } from './i18n.js';

// 各模块共用的小工具与常量，不依赖 Agent 状态。
export const invalid = message => Object.assign(new Error(message), { code: -32602 });
export const air = value => ({ _meta: { jetbrains: { air: { version: 1, ...value } } } });
export const logError = key => error => process.stderr.write(`${t(key, { error: error.message })}\n`);
export const modelKey = model => `${model.provider}/${model.id}`;
export const readOnlyTools = ['read', 'grep', 'find', 'ls', 'update_plan', 'task_status'];
export const terminalTools = ['bash', 'powershell'];
export const restrictedModes = ['read-only', 'plan'];

export const requireId = sessionId => {
  if (typeof sessionId !== 'string' || !sessionId) throw invalid(t('missingSessionId'));
};
export const requireCwd = (cwd, message = t('cwdAbsolute')) => {
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) throw invalid(message);
};
