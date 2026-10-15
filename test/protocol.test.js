import test from 'node:test';
import assert from 'node:assert/strict';
import { ProtocolAgent } from '../src/protocol.js';

async function setup() {
  const records = [];
  const protocol = new ProtocolAgent({ send: record => records.push(record) });
  await protocol.receive({ jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: 2, info: { name: 'test', version: '1' } } });
  protocol.agent.sessions.set('s', { id: 's' });
  records.length = 0;
  return { protocol, records };
}

const prompt = { jsonrpc: '2.0', id: 2, method: 'session/prompt',
  params: { sessionId: 's', prompt: [{ type: 'text', text: '你好' }] } };
const update = value => ({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's', update: value } });

for (const version of [1, 2]) {
  test(`v${version} 返回每轮 token 并在完成前发布会话累计费用，取消后不串轮`, async () => {
    const records = [];
    const protocol = new ProtocolAgent({ send: record => records.push(record) });
    await protocol.receive({ jsonrpc: '2.0', id: 1, method: 'initialize', params: version === 1
      ? { protocolVersion: 1 } : { protocolVersion: 2, info: { name: 'test', version: '1' } } });
    let cost = 0.5;
    let cancelled = false;
    const session = { id: 's', blocks: new Map(), pi: { request: async type => {
      if (type === 'get_session_stats') {
        await Promise.resolve();
        return { cost, contextUsage: { tokens: 20, contextWindow: 1000 } };
      }
      assert.equal(type, 'prompt');
      protocol.agent.onUserMessage(session, `user-${cost}`);
      protocol.agent.event(session, { type: 'agent_start' });
      for (let index = 0; index < 2; index++) {
        protocol.agent.event(session, { type: 'message_end', message: {
          role: 'assistant', content: [], usage: { input: 10, output: 2, cacheRead: 3, cacheWrite: 1 },
        } });
      }
      cost += 0.25;
      protocol.agent.event(session, { type: 'agent_settled', aborted: cancelled });
      return { disposition: 'started' };
    } } };
    protocol.agent.sessions.set('s', session);
    await protocol.agent.refreshUsage(session);
    assert.deepEqual(records.at(-1).params.update.cost, { amount: 0.5, currency: 'USD' });
    for (const id of [2, 3]) {
      cancelled = id === 3;
      records.length = 0;
      await protocol.receive({ ...prompt, id });
      if (version === 2) await protocol.tails.get('s');
      const result = version === 1 ? records.at(-1).result : records.at(-1).params.update;
      assert.equal(result.stopReason, cancelled ? 'cancelled' : 'end_turn');
      assert.deepEqual(result.usage, { totalTokens: 32, inputTokens: 20, outputTokens: 4,
        cachedReadTokens: 6, cachedWriteTokens: 2 });
      const usageIndex = records.findIndex(record => record.params?.update?.sessionUpdate === 'usage_update');
      assert.ok(usageIndex >= 0 && usageIndex < records.length - 1);
      assert.deepEqual(records[usageIndex].params.update, { sessionUpdate: 'usage_update', used: 20, size: 1000,
        cost: { amount: cancelled ? 1 : 0.75, currency: 'USD' } });
    }
  });
}

test('v2 初始化校验、版本协商和失败重试', async () => {
  const records = [];
  const protocol = new ProtocolAgent({ send: record => records.push(record) });
  for (const params of [
    { protocolVersion: 2 }, { protocolVersion: 2, info: [] },
    { protocolVersion: 2, info: { name: 'test', version: '1' }, capabilities: [] },
    { protocolVersion: 2.5, info: { name: 'test', version: '1' } },
    { protocolVersion: -1, info: { name: 'test', version: '1' } },
    { protocolVersion: 65536, info: { name: 'test', version: '1' } },
  ]) {
    await protocol.receive({ jsonrpc: '2.0', id: 1, method: 'initialize', params });
    assert.equal(records.at(-1).error.code, -32602);
    assert.equal(protocol.agent.initialized, false);
  }
  await protocol.receive({ jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: 3, info: { name: 'test', version: '1' }, capabilities: { auth: { terminal: {} } } } });
  assert.equal(records.at(-1).result.protocolVersion, 2);
  assert.equal(records.at(-1).result.authMethods[0].type, 'terminal');
  assert.equal(records.at(-1).result.authMethods[0].methodId, 'pi-login');
  assert.equal(records.at(-1).result.authMethods[0].id, undefined);
  assert.deepEqual(records.at(-1).result.authMethods[0].env, [{ name: 'PI_ACP_SETUP', value: '1' }]);
  assert.ok(!('subagents' in records.at(-1).result.capabilities.session));
  await protocol.receive({ jsonrpc: '2.0', id: 2, method: 'initialize',
    params: { protocolVersion: 2, info: { name: 'test', version: '1' } } });
  assert.equal(records.at(-1).error.code, -32602);
});

test('v2 不支持的旧协议版本协商到最新支持版本', async () => {
  const records = [];
  const protocol = new ProtocolAgent({ send: record => records.push(record) });
  await protocol.receive({ jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: 0, info: { name: 'test', version: '1' } } });
  assert.equal(records.at(-1).result.protocolVersion, 2);
});

test('v2 忽略未知能力和无效 elicitation 能力，按会话可见性报告自主执行状态', async () => {
  const records = [];
  const protocol = new ProtocolAgent({ send: record => records.push(record) });
  await protocol.receive({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
    protocolVersion: 2, info: { name: 'test', version: '1' }, capabilities: {
      subagents: {}, fs: {}, terminal: {}, elicitation: { form: false, url: {}, unknown: {} },
    },
  } });
  assert.equal(protocol.agent.nativeSubagents, false);
  assert.deepEqual(protocol.agent.clientCapabilities.elicitation, { url: {} });
  records.length = 0;
  protocol.agent.onForegroundState({ id: 'parent' }, 'running');
  protocol.agent.onForegroundState({ id: 'child', parentId: 'parent' }, 'running');
  assert.equal(records.length, 1);
  protocol.agent.nativeSubagents = true;
  protocol.agent.onForegroundState({ id: 'child', parentId: 'parent' }, 'running');
  protocol.agent.onForegroundState({ id: 'child', parentId: 'parent' }, 'idle', { stopReason: 'end_turn' });
  assert.deepEqual(records.map(record => record.params.update.state), ['running', 'running', 'idle']);
});

test('v2 补齐 MCP 可选字段，拒绝未声明能力和无效参数', async () => {
  const { protocol, records } = await setup();
  const dispatched = [];
  protocol.agent.dispatch = async (method, params) => { dispatched.push({ method, params }); return {}; };
  await protocol.receive({ jsonrpc: '2.0', id: 2, method: 'session/new', params: {
    cwd: '/workspace', mcpServers: [{ name: 'stdio', command: '/bin/tool' },
      { type: 'http', name: 'http', url: 'https://example.com/mcp' }],
  } });
  assert.deepEqual(dispatched.at(-1).params.mcpServers, [
    { name: 'stdio', command: '/bin/tool', args: [], env: [] },
    { type: 'http', name: 'http', url: 'https://example.com/mcp', headers: [] },
  ]);
  await protocol.receive({ jsonrpc: '2.0', id: 3, method: 'session/list', params: { cwd: null, cursor: null } });
  assert.deepEqual(dispatched.at(-1).params, {});
  for (const [method, params] of [
    ['session/new', { additionalDirectories: ['/other'] }], ['session/new', { systemPrompt: { type: 'append', text: 'x' } }],
    ['session/new', { mcpServers: [null] }], ['session/resume', { sessionId: 's', replayFrom: [] }],
    ['session/resume', { sessionId: 's', replayFrom: { type: 'unknown' } }],
    ['session/prompt', []], ['session/close', {}],
    ['session/set_config_option', { sessionId: 's', configId: 'mode', type: 'boolean', value: true }],
  ]) {
    await protocol.receive({ jsonrpc: '2.0', id: 4, method, params });
    assert.equal(records.at(-1).error.code, -32602);
  }
  assert.equal(dispatched.length, 2);
  await protocol.receive({ jsonrpc: '2.0', id: 5, method: 'session/cancel', params: [] });
  assert.equal(records.at(-1).error.code, -32602);
  const length = records.length;
  await protocol.receive({ jsonrpc: '2.0', method: 'session/cancel', params: [] });
  assert.equal(records.length, length);
});

test('v2 未知和 v1 专属方法返回 method not found', async () => {
  const { protocol, records } = await setup();
  for (const method of ['session/unknown', 'session/load', 'session/set_mode', 'session/set_model', '_session/steering']) {
    await protocol.receive({ jsonrpc: '2.0', id: 2, method, params: {} });
    assert.equal(records.at(-1).error.code, -32601);
  }
});

for (const inserted of [false, true]) {
  test(`v2 ${inserted ? '插入后' : '插入前'}失败遵守响应边界并报告 error 状态`, async () => {
    const { protocol, records } = await setup();
    protocol.agent.dispatch = async () => {
      if (inserted) {
        protocol.agent.onUserMessage({ id: 's' }, 'user-id');
        protocol.output(update({ sessionUpdate: 'tool_call', toolCallId: 'read-1', status: 'in_progress' }));
      }
      throw new Error('模型连接失败');
    };
    await protocol.receive(prompt);
    await protocol.tails.get('s');
    const responses = records.filter(record => record.id === prompt.id);
    assert.equal(responses.length, 1);
    if (inserted) {
      assert.equal(responses[0].result.messageId, 'user-id');
      assert.ok(records.some(record => record.params?.update?.toolCallId === 'read-1' && record.params.update.status === 'failed'));
    } else {
      assert.equal(responses[0].error.code, -32603);
      assert.ok(!records.some(record => record.params?.update?.sessionUpdate === 'user_message_chunk'));
    }
    assert.deepEqual(records.at(-1).params.update, { sessionUpdate: 'state_update', state: 'idle',
      stopReason: 'error', error: { code: -32603, message: '模型连接失败' } });
    assert.equal(protocol.jobs.size, 0);
    assert.equal(protocol.active.size, 0);
  });
}

test('v2 Air 失败元数据仍报告 error，不将后台任务标成失败', async () => {
  const { protocol, records } = await setup();
  protocol.agent.tasks.tasks.set('background', { owner: 's', toolCallId: 'background' });
  protocol.agent.dispatch = async () => {
    protocol.agent.onUserMessage({ id: 's' }, 'user-id');
    protocol.output(update({ sessionUpdate: 'tool_call', toolCallId: 'background', status: 'in_progress' }));
    return { stopReason: 'end_turn', _meta: { jetbrains: { air: { sessionFailure: { title: '限流' } } } } };
  };
  await protocol.receive(prompt);
  await protocol.tails.get('s');
  assert.equal(records.at(-1).params.update.stopReason, 'error');
  assert.equal(records.at(-1).params.update.error.message, '限流');
  assert.ok(!records.some(record => record.params?.update?.status === 'failed'));
});

test('v2 本地命令的多个输出块复用消息 ID，正常结束不关闭后台工具', async () => {
  const { protocol, records } = await setup();
  protocol.agent.dispatch = async () => {
    for (const text of ['第一段', '第二段']) protocol.output(update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }));
    protocol.output(update({ sessionUpdate: 'tool_call', toolCallId: 'background', status: 'in_progress' }));
    return { stopReason: 'end_turn' };
  };
  await protocol.receive(prompt);
  await protocol.tails.get('s');
  const chunks = records.filter(record => record.params?.update?.sessionUpdate === 'agent_message_chunk');
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].params.update.messageId, chunks[1].params.update.messageId);
  assert.ok(records.findIndex(record => record.result?.messageId) < records.indexOf(chunks[0]));
  assert.ok(!records.some(record => record.params?.update?.status === 'failed'));
  assert.equal(records.at(-1).params.update.stopReason, 'end_turn');
});

test('v2 多个并发交互全部回答后才恢复 running，取消后的迟到回答不恢复执行', async () => {
  const { protocol, records } = await setup();
  protocol.active.set('s', { started: true, inserted: true });
  for (const id of [10, 11]) {
    protocol.agent.permissions.set(id, { resolve() {} });
    protocol.output({ jsonrpc: '2.0', id, method: 'session/request_permission', params: {
      sessionId: 's', toolCall: { toolCallId: `tool-${id}`, title: '授权' }, options: [],
    } });
  }
  await protocol.receive({ jsonrpc: '2.0', id: 10, result: { outcome: { outcome: 'cancelled' } } });
  assert.equal(protocol.states.get('s'), 'requires_action');
  await protocol.receive({ jsonrpc: '2.0', id: 11, error: { code: -32603, message: '客户端错误' } });
  assert.equal(protocol.states.get('s'), 'running');
  protocol.active.get('s').cancelled = true;
  protocol.state('s', 'idle', { stopReason: 'cancelled' });
  const count = records.length;
  await protocol.receive({ jsonrpc: '2.0', id: 11, result: {} });
  assert.equal(records.length, count);
});

test('v2 自主执行等待授权时报告 requires_action，折叠后台子会话的授权不改变父状态', async () => {
  const { protocol, records } = await setup();
  protocol.state('s', 'running');
  const permission = id => ({ jsonrpc: '2.0', id, method: 'session/request_permission', params: {
    sessionId: 's', toolCall: { toolCallId: `tool-${id}`, title: '授权' }, options: [],
  } });
  protocol.agent.permissions.set(10, { resolve() {}, session: { id: 's' } });
  protocol.output(permission(10));
  assert.equal(protocol.states.get('s'), 'requires_action');
  await protocol.receive({ jsonrpc: '2.0', id: 10, result: { outcome: { outcome: 'cancelled' } } });
  assert.equal(protocol.states.get('s'), 'running');
  protocol.agent.permissions.set(11, { resolve() {}, session: { id: 'child', parentId: 's' } });
  const count = records.filter(record => record.params?.update?.sessionUpdate === 'state_update').length;
  protocol.output(permission(11));
  assert.equal(protocol.states.get('s'), 'running');
  assert.equal(records.filter(record => record.params?.update?.sessionUpdate === 'state_update').length, count);
});

test('v2 插入前取消即使底层 abort 抛错也只返回一次取消响应', async () => {
  const { protocol, records } = await setup();
  let rejectPrompt;
  protocol.agent.dispatch = async method => {
    if (method === 'session/prompt') return new Promise((resolve, reject) => { rejectPrompt = reject; });
    rejectPrompt(new Error('abort 失败'));
    throw new Error('abort 失败');
  };
  await protocol.receive(prompt);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(typeof rejectPrompt, 'function');
  await protocol.receive({ jsonrpc: '2.0', method: '$/cancel_request', params: { requestId: prompt.id } });
  await protocol.tails.get('s');
  const responses = records.filter(record => record.id === prompt.id);
  assert.equal(responses.length, 1);
  assert.equal(responses[0].error.code, -32800);
  assert.ok(!records.some(record => record.params?.update?.sessionUpdate === 'user_message_chunk'));
  assert.deepEqual(records.at(-1).params.update, { sessionUpdate: 'state_update', state: 'idle', stopReason: 'cancelled' });
});

test('v2 回放按实体类型重置消息，并清空终端输出与退出状态', async () => {
  const { protocol, records } = await setup();
  protocol.replays.set('s', new Set());
  for (const sessionUpdate of ['user_message_chunk', 'agent_message_chunk', 'agent_thought_chunk']) {
    for (const text of ['一', '二']) protocol.output(update({ sessionUpdate, messageId: 'same-id', content: { type: 'text', text } }));
  }
  assert.deepEqual(records.filter(record => record.params.update.content?.length === 0)
    .map(record => record.params.update.sessionUpdate), ['user_message', 'agent_message', 'agent_thought']);
  protocol.output(update({ sessionUpdate: 'tool_call', toolCallId: 'shell', status: 'pending',
    _meta: { terminal_info: { terminal_id: 'shell', cwd: '/workspace' } } }));
  protocol.output(update({ sessionUpdate: 'tool_call_update', toolCallId: 'shell',
    _meta: { terminal_output_delta: { terminal_id: 'shell', data: '你好' },
      terminal_exit: { terminal_id: 'shell', exit_code: 0, signal: null } } }));
  const terminal = records.filter(record => record.params.update.sessionUpdate.startsWith('terminal_')).map(record => record.params.update);
  assert.deepEqual(terminal[0], { sessionUpdate: 'terminal_update', terminalId: 'shell', output: { data: '' }, exitStatus: null });
  assert.equal(Buffer.from(terminal[2].data, 'base64').toString(), '你好');
  assert.deepEqual(terminal[3].exitStatus, { exitCode: 0, signal: null });
});
