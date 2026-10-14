import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent } from '../src/agent.js';

function session(id, pi) {
  return { id, pi, cwd: tmpdir(), mode: 'standard', changingConfig: false,
    availableModels: [{ provider: 'test', id: 'model' }], currentModelId: 'test/model',
    thinkingLevels: ['off'], thinkingLevel: 'off', goal: null };
}

test('每轮用量累加模型与压缩请求，取消仍保留已发生用量且不计入下一轮', async () => {
  const agent = new Agent({ send: () => {} });
  let cancelled = false;
  const current = session('usage', { request: async type => {
    if (type === 'get_session_stats') return {};
    if (type !== 'prompt') throw new Error(`未知命令：${type}`);
    agent.event(current, { type: 'agent_start' });
    for (const usage of [
      { input: 10, output: 2, cacheRead: 3, cacheWrite: 4 },
      { input: 5, output: 1, cacheRead: 0, cacheWrite: 0 },
      { input: -1, output: 0, cacheRead: 0, cacheWrite: 0 },
    ]) agent.event(current, { type: 'message_end', message: { role: 'assistant', content: [], usage } });
    agent.event(current, { type: 'compaction_end', result: { usage: {
      input: 1, output: 1, cacheRead: 0, cacheWrite: 0,
    } } });
    agent.event(current, { type: 'agent_settled', aborted: cancelled });
    return { disposition: 'started' };
  } });
  agent.sessions.set(current.id, current);
  const usage = { totalTokens: 27, inputTokens: 16, outputTokens: 4, cachedReadTokens: 3, cachedWriteTokens: 4 };
  assert.deepEqual(await agent.prompt(current, { message: '第一轮' }, false), { stopReason: 'end_turn', usage });
  cancelled = true;
  assert.deepEqual(await agent.prompt(current, { message: '第二轮' }, false), { stopReason: 'cancelled', usage });
  current.pi.request = async () => ({ disposition: 'handled' });
  assert.deepEqual(await agent.prompt(current, { message: '/扩展命令' }, false), { stopReason: 'end_turn' });
});

test('分叉来源只向协商会话索引的客户端发布且不暴露存储路径', () => {
  const agent = new Agent({ send: () => {} });
  const info = { sessionId: 'child', cwd: '/repo', path: '/private/child.jsonl', forkedFrom: 'parent' };
  assert.deepEqual(agent.sessionInfo(info), { sessionId: 'child', cwd: '/repo' });
  agent.airIndex = true;
  const result = agent.sessionInfo(info);
  assert.equal(result._meta.jetbrains.air.forkedFrom, 'parent');
  assert.equal('path' in result, false);
  assert.equal('forkedFrom' in result, false);
});

test('历史加载仅回放当前分支，遇到父节点缺失、循环或叶节点缺失仍正常结束', async () => {
  for (const [parentId, leafId, expected] of [
    ['missing', 'reply', ['问题', '回答']],
    ['reply', 'reply', ['问题', '回答']],
    ['missing', 'missing', []],
  ]) {
    const updates = [];
    const agent = new Agent({ send: record => updates.push(record.params.update) });
    const current = session('history', { request: async type => type === 'get_entries' ? {
      leafId, entries: [
        { id: 'reply', parentId: 'user', type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: '回答' }] } },
        { id: 'abandoned', parentId: 'user', type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: '旧分支' }] } },
        { id: 'user', parentId, type: 'message', message: { role: 'user', content: '问题' } },
      ],
    } : {} });
    current.mcpServers = [];
    current.tools = new Map();
    agent.sessions.set(current.id, current);
    const result = await agent.loadSession({ sessionId: current.id, cwd: current.cwd, mcpServers: [] });
    assert.deepEqual(updates.map(update => update.content.text), expected);
    assert.equal('sessionId' in result, false);
    assert.equal(current.changingConfig, false);
    assert.equal(current.tools.size, 0);
  }
});

test('无效分叉点参数不打开或修改源会话', async () => {
  const agent = new Agent({ send: () => {} });
  for (const fork of [null, [], {}, { version: 2, messageId: 'old' },
    { version: 1, messageId: ' ' }, { version: 1, messageId: 'old', messageFingerprint: 'bad' },
    { version: 1, messageId: 'old', messageOccurrence: 0 }]) {
    await assert.rejects(agent.forkSession({ sessionId: 'source', _meta: { jetbrains: { air: { fork } } } }),
      { code: -32602, message: '分叉点参数无效' });
  }
  assert.equal(agent.sessions.size, 0);
});

test('指定消息分叉取消后保留源会话并解除操作锁', async () => {
  const agent = new Agent({ send: () => {} });
  const current = session('source', { request: async type => {
    if (type === 'get_entries') return { leafId: 'reply', entries: [
      { id: 'reply', type: 'message', message: { role: 'assistant', content: [] } },
    ] };
    if (type === 'get_state') return { sessionId: 'source', sessionFile: '/original.jsonl' };
    if (type === 'prompt') return { disposition: 'handled' };
    throw new Error(`未知命令：${type}`);
  } });
  current.mcpServers = [];
  agent.sessions.set(current.id, current);
  await assert.rejects(agent.forkSession({ sessionId: 'source', _meta: { jetbrains: { air: {
    fork: { version: 1, messageId: 'reply' },
  } } } }), { code: -32602, message: 'pi 未执行指定消息分叉' });
  assert.equal(agent.sessions.get('source'), current);
  assert.equal(current.changingConfig, false);
});

test('关闭时取消 RPC 失败仍释放子进程与临时目录', async t => {
  const agent = new Agent({ send: () => {} });
  const directory = await mkdtemp(join(tmpdir(), 'pi-acp-close-failure-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let closed = false;
  const current = session('close', { request: async () => { throw new Error('取消失败'); },
    close: async () => { closed = true; } });
  current.directory = directory;
  current.turn = { cancelled: false };
  agent.sessions.set(current.id, current);
  await assert.rejects(agent.closeSession({ sessionId: current.id }), /取消失败/);
  assert.equal(current.turn.cancelled, true);
  assert.equal(closed, true);
  assert.equal(agent.sessions.size, 0);
  await assert.rejects(stat(directory), { code: 'ENOENT' });
});

test('clone 已接受但读取新会话失败时解除错误会话映射', async t => {
  const agent = new Agent({ send: () => {} });
  const directory = await mkdtemp(join(tmpdir(), 'pi-acp-clone-failure-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let states = 0;
  let closed = false;
  const current = session('source', { request: async type => {
    if (type === 'get_state' && states++ === 0) return { sessionFile: '/original.jsonl' };
    if (type === 'clone') return { cancelled: false };
    throw new Error('新状态丢失');
  }, close: async () => { closed = true; } });
  current.directory = directory;
  agent.sessions.set(current.id, current);
  await assert.rejects(agent.cloneSession(current, { sessionId: 'source' }, current.cwd), /新状态丢失/);
  assert.equal(closed, true);
  assert.equal(agent.sessions.size, 0);
  await assert.rejects(stat(directory), { code: 'ENOENT' });
});

test('MCP 重连失败恢复源映射，后台任务运行时不重连', async () => {
  const agent = new Agent({ send: () => {} });
  let closed = false;
  const current = session('mcp', { request: async () => ({ sessionFile: '/original.jsonl' }),
    close: async () => { closed = true; } });
  current.mcpServers = [];
  agent.sessions.set(current.id, current);
  const params = { sessionId: current.id, cwd: current.cwd,
    mcpServers: [{ type: 'http', name: 'ide', url: 'http://localhost/mcp', headers: [] }] };
  agent.newSession = async () => { agent.sessions.delete(current.id); throw new Error('连接失败'); };
  await assert.rejects(agent.resumeSession(params), /连接失败/);
  assert.equal(agent.sessions.get(current.id), current);
  assert.equal(current.changingConfig, false);
  assert.equal(closed, false);
  agent.tasks.tasks.set('running', { owner: current.id, state: 'running' });
  await assert.rejects(agent.resumeSession(params), { code: -32602, message: '后台任务正在运行，请结束任务后再更新 MCP 配置' });
  assert.equal(agent.sessions.get(current.id), current);
  assert.equal(closed, false);
});

test('目标提交失败不覆盖已生效的目标', async () => {
  const agent = new Agent({ send: () => {} });
  const current = session('goal', { request: async () => { throw new Error('目标提交失败'); } });
  const original = { objective: '原目标', status: 'active', createdAt: 1, updatedAt: 1 };
  current.goal = original;
  agent.sessions.set(current.id, current);
  await assert.rejects(agent.goalSession({ sessionId: current.id, action: 'set', objective: '新目标' }), /提交失败/);
  assert.equal(current.goal, original);
});

test('切完全访问不会把普通输入表单当成工具权限自动允许', async () => {
  const records = [];
  const responses = [];
  const agent = new Agent({ send: record => records.push(record) });
  agent.clientCapabilities = { elicitation: { form: {} } };
  const current = session('form', { closed: false, send: record => responses.push(record) });
  current.turn = {};
  const input = agent.ui(current, { method: 'input', id: 'input-1', title: '输入项目名' });
  const request = records.find(record => record.method === 'elicitation/create');
  await agent.setMode(current, 'full');
  assert.equal(agent.permissions.size, 1);
  assert.equal(responses.length, 0);
  await agent.receive({ jsonrpc: '2.0', id: request.id, result: { action: 'accept', content: { value: '项目一' } } });
  await input;
  assert.deepEqual(responses[0], { type: 'extension_ui_response', id: 'input-1', value: '项目一' });
});

test('手动压缩执行中取消后返回 cancelled，并释放忙状态', async () => {
  const updates = [];
  const agent = new Agent({ send: record => updates.push(record) });
  agent.initialized = true;
  let rejectCompaction;
  const current = session('compact', { request: async type => {
    if (type === 'compact') return new Promise((_resolve, reject) => { rejectCompaction = reject; });
    if (type === 'abort') { rejectCompaction(new Error('压缩已中止')); return; }
    throw new Error(`未知命令：${type}`);
  } });
  agent.sessions.set(current.id, current);
  const compact = agent.dispatch('session/prompt', { sessionId: current.id,
    prompt: [{ type: 'text', text: '/compact' }] });
  assert.equal(current.changingConfig, true);
  await agent.dispatch('session/cancel', { sessionId: current.id });
  assert.deepEqual(await compact, { stopReason: 'cancelled' });
  assert.equal(current.changingConfig, false);
  assert.equal(current.command, null);
});

test('计划输出验证结构，实时与回放使用相同数据', () => {
  const updates = [];
  const agent = new Agent({ send: record => updates.push(record.params.update) });
  const current = { id: 'plan', tools: new Map(), terminals: new Map() };
  const entries = [{ content: '执行验证', priority: 'high', status: 'in_progress' }];
  agent.publishPlan(current, { details: { acpPlan: entries } });
  assert.deepEqual(updates[0], { sessionUpdate: 'plan', entries });
  agent.publishPlan(current, { details: { acpPlan: [{ ...entries[0], status: 'unknown' }] } });
  agent.publishPlan(current, { details: { acpPlan: entries } }, true);
  assert.equal(updates.length, 1);
  agent.replay(current, { type: 'message', message: { role: 'toolResult', toolCallId: 'plan-1',
    content: [], details: { acpPlan: entries }, isError: false } });
  assert.deepEqual(updates.at(-1), updates[0]);
});

test('压缩历史回放在已协商与旧客户端使用对应展示', () => {
  const updates = [];
  const agent = new Agent({ send: record => updates.push(record.params.update) });
  const current = { id: 'history' };
  const entry = { type: 'compaction', id: 'compact-1', summary: '真实摘要', tokensBefore: 500 };
  agent.replay(current, entry);
  assert.equal(updates[0].sessionUpdate, 'tool_call');
  assert.equal(updates[1].rawOutput.summary, '真实摘要');
  agent.clientCapabilities = { session: { compaction: {} } };
  agent.replay(current, entry);
  assert.deepEqual(updates.slice(2).map(update => [update.sessionUpdate, update.status]), [
    ['compaction_update', 'in_progress'], ['compaction_update', 'completed'],
  ]);
});
