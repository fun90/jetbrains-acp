import test from 'node:test';
import assert from 'node:assert/strict';
import { Agent } from '../src/agent.js';
import { ProtocolAgent } from '../src/protocol.js';

const params = { url: 'https://example.com/connect', message: '请授权账号' };
function setup(version = 1) {
  const records = [];
  const protocol = new ProtocolAgent({ send: record => records.push(record) });
  protocol.version = version;
  const agent = protocol.agent;
  agent.clientCapabilities = { elicitation: { url: {} } };
  const responses = [];
  const session = { id: 'url-session', turn: {}, pi: { controlResponse: (...args) => responses.push(args) } };
  return { agent, protocol, records, session, responses };
}

for (const version of [1, 2]) {
  test(`URL 请求和完成通知通过 ACP v${version}，接受仅表示同意打开网址`, async () => {
    const { agent, protocol, records, session, responses } = setup(version);
    protocol.active.set(session.id, { inserted: true });
    const pending = agent.control(session, { id: 'create', action: 'url_elicitation', params });
    const request = records.find(record => record.method === 'elicitation/create');
    assert.deepEqual(request.params, { sessionId: session.id, mode: 'url',
      elicitationId: request.params.elicitationId, ...params });
    assert.deepEqual(agent.interactions.completeUrl(session, request.params.elicitationId), { completed: false });
    await protocol.receive({ jsonrpc: '2.0', id: request.id,
      result: { action: 'accept', content: { token: '不能转发的凭据' } } });
    await pending;
    assert.deepEqual(responses[0], ['create', { action: 'accept', elicitationId: request.params.elicitationId }]);
    assert.equal(records.filter(record => record.method === 'elicitation/complete').length, 0);
    assert.equal(agent.interactions.pending.size, 0);
    // 网页交互可能晚于模型回合结束。
    agent.interactions.cancel(session, { keepAcceptedUrls: true });
    session.turn = null;
    assert.deepEqual(agent.interactions.completeUrl({ id: session.id }, request.params.elicitationId), { completed: false });
    await agent.control(session, { id: 'done', action: 'url_elicitation_complete',
      params: { elicitationId: request.params.elicitationId, token: '不应转发' } });
    assert.deepEqual(responses[1], ['done', { completed: true }]);
    assert.deepEqual(records.find(record => record.method === 'elicitation/complete'), {
      jsonrpc: '2.0', method: 'elicitation/complete', params: { elicitationId: request.params.elicitationId },
    });
    assert.deepEqual(agent.interactions.completeUrl(session, request.params.elicitationId), { completed: false });
    assert.equal(agent.interactions.urlElicitations.size, 0);
    if (version === 2) assert.deepEqual(records.filter(record => record.method === 'session/update')
      .map(record => record.params.update.state), ['requires_action', 'running']);
  });
}

test('URL 拒绝、取消、未知决定和客户端错误均释放状态', async () => {
  for (const result of [{ action: 'decline' }, { action: 'cancel' }, { action: '_unknown' }, undefined]) {
    const { agent, records, session } = setup();
    const pending = agent.interactions.elicitUrl(session, params);
    await agent.receive({ jsonrpc: '2.0', id: records[0].id,
      ...(result ? { result } : { error: { code: -32603, message: '客户端失败' } }) });
    assert.equal((await pending).action, result?.action === 'decline' ? 'decline' : 'cancel');
    assert.equal(agent.interactions.urlElicitations.size, 0);
    assert.equal(agent.interactions.pending.size, 0);
  }
});

test('URL 能力缺失、无回合及已取消时不发送请求', async () => {
  for (const capability of [undefined, null, [], true, 'url']) {
    const { agent, records, session } = setup();
    agent.clientCapabilities = { elicitation: { form: {}, url: capability } };
    assert.deepEqual(await agent.interactions.elicitUrl(session, params), { action: 'cancel' });
    assert.equal(records.length, 0);
  }
  for (const turn of [null, { cancelled: true }]) {
    const { agent, records, session } = setup();
    session.turn = turn;
    assert.deepEqual(await agent.interactions.elicitUrl(session, params), { action: 'cancel' });
    assert.equal(records.length, 0);
  }
});

test('URL 校验拒绝危险协议、远程 HTTP、内嵌凭据及无效参数', async () => {
  const { agent, records, session } = setup();
  for (const url of ['javascript:alert(1)', 'file:///tmp/a', 'http://example.com', 'https://user:pass@example.com',
    'http://localhost.evil.test', '无效网址', null, 'x'.repeat(10001)]) {
    await assert.rejects(agent.interactions.elicitUrl(session, { ...params, url }), /URL/);
  }
  for (const message of ['', null, 'x'.repeat(10001)]) {
    await assert.rejects(agent.interactions.elicitUrl(session, { ...params, message }), /参数/);
  }
  assert.equal(records.length, 0);
  for (const url of ['http://localhost:8080/connect', 'http://127.0.0.1/connect', 'http://[::1]/connect']) {
    const pending = agent.interactions.elicitUrl(session, { ...params, url });
    agent.interactions.cancel(session);
    assert.equal((await pending).action, 'cancel');
  }
});

test('取消清理待回复和已接受请求，忽略迟到回复与完成通知', async () => {
  const { agent, records, session } = setup();
  const first = agent.interactions.elicitUrl(session, params);
  const second = agent.interactions.elicitUrl(session, params);
  assert.notEqual(records[0].params.elicitationId, records[1].params.elicitationId);
  await agent.receive({ jsonrpc: '2.0', id: records[0].id, result: { action: 'accept' } });
  const accepted = await first;
  agent.interactions.cancel(session);
  assert.equal((await second).action, 'cancel');
  await agent.receive({ jsonrpc: '2.0', id: records[1].id, result: { action: 'accept' } });
  assert.deepEqual(agent.interactions.completeUrl(session, accepted.elicitationId), { completed: false });
  assert.equal(agent.interactions.pending.size, 0);
  assert.equal(agent.interactions.urlElicitations.size, 0);
});

test('未完成 URL 请求有数量上限，发送异常也释放状态', async () => {
  const { agent, session } = setup();
  for (let index = 0; index < 100; index++) agent.interactions.urlElicitations.set(String(index), { session, accepted: true });
  await assert.rejects(agent.interactions.elicitUrl(session, params), /过多/);
  agent.interactions.cancel(session);
  agent.send = () => { throw new Error('连接已关闭'); };
  await assert.rejects(agent.interactions.elicitUrl(session, params), /连接已关闭/);
  assert.equal(agent.interactions.pending.size, 0);
  assert.equal(agent.interactions.urlElicitations.size, 0);
});
