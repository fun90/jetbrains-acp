import { isAbsolute } from 'node:path';

// 各模块共用的小工具与常量，不依赖 Agent 状态。
export const invalid = message => Object.assign(new Error(message), { code: -32602 });
export const air = value => ({ _meta: { jetbrains: { air: { version: 1, ...value } } } });
export const logError = label => error => process.stderr.write(`${label}：${error.message}\n`);
export const modelKey = model => `${model.provider}/${model.id}`;
export const readOnlyTools = ['read', 'grep', 'find', 'ls', 'update_plan', 'task_status'];
export const terminalTools = ['bash', 'powershell'];
export const restrictedModes = ['read-only', 'plan'];

export const requireId = sessionId => {
  if (typeof sessionId !== 'string' || !sessionId) throw invalid('缺少 sessionId');
};
export const requireCwd = (cwd, message = 'cwd 必须是绝对路径') => {
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) throw invalid(message);
};
