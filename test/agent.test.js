import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readJsonl, writeJsonl } from '../src/jsonl.js';
import { Agent, convertMcp, convertPrompt } from '../src/agent.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const fixture = fileURLToPath(new URL('../fixtures/pi.js', import.meta.url));

async function client(t, real = false, savedDirectory, extraArgs = []) {
  const directory = savedDirectory ?? await mkdtemp(join(tmpdir(), 'pi-acp-test-'));
  const child = spawn(process.execPath, ['src/index.js', '--pi-command', real ? (process.env.PI_ACP_PI_COMMAND || 'pi') : process.execPath,
    '--', ...(real ? ['--offline', '--no-extensions', '--no-skills', '--no-context-files', '--no-mcp'] : [fixture]), ...extraArgs],
  { cwd: root, env: { ...process.env, PI_CODING_AGENT_SESSION_DIR: directory }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  const records = [];
  const waiters = [];
  readJsonl(child.stdout, record => {
    records.push(record);
    for (const waiter of [...waiters]) {
      if (waiter.predicate(record)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        clearTimeout(waiter.timer);
        waiter.resolve(record);
      }
    }
  }, error => assert.fail(error.message));
  const wait = predicate => new Promise((resolve, reject) => {
    const found = records.find(predicate);
    if (found) return resolve(found);
    const waiter = { predicate, resolve, timer: setTimeout(() => reject(new Error(`等待超时：${stderr}`)), 10000) };
    waiters.push(waiter);
  });
  let id = 0;
  const send = record => writeJsonl(child.stdin, record);
  const request = (method, params) => {
    const requestId = ++id;
    send({ jsonrpc: '2.0', id: requestId, method, params });
    return wait(record => record.id === requestId && !record.method);
  };
  t.after(async () => {
    for (const waiter of waiters) clearTimeout(waiter.timer);
    const exit = once(child, 'exit');
    child.stdin.end();
    await exit;
    assert.equal(child.exitCode, 0, stderr);
    if (!savedDirectory) await rm(directory, { recursive: true, force: true });
  });
  return { child, records, request, send, wait, directory };
}

async function session(c, mcpServers = []) {
  const initialized = await c.request('initialize', { protocolVersion: 1 });
  assert.equal(initialized.result.protocolVersion, 1);
  assert.deepEqual(initialized.result._meta.steering, { supported: true });
  assert.equal(initialized.result.agentCapabilities.loadSession, true);
  assert.deepEqual(initialized.result.agentCapabilities.sessionCapabilities.list, {});
  const created = await c.request('session/new', { cwd: root, mcpServers });
  assert.ok(created.result?.sessionId, JSON.stringify(created));
  assert.ok(created.result.models.availableModels.length > 0);
  assert.equal(created.result.configOptions[0].currentValue, created.result.models.currentModelId);
  const thinking = created.result.configOptions.find(option => option.id === 'thinking');
  assert.equal(thinking.category, 'thought_level');
  assert.ok(thinking.options.some(option => option.value === thinking.currentValue));
  return created.result.sessionId;
}

test('JSONL 保留 Unicode 分隔符并处理分段 UTF-8 与 CRLF', () => {
  const stream = new PassThrough();
  const records = [];
  readJsonl(stream, record => records.push(record), assert.fail);
  const bytes = Buffer.from('{"text":"你\u2028好\u2029"}\r\n');
  for (const byte of bytes) stream.write(Buffer.from([byte]));
  stream.end();
  assert.deepEqual(records, [{ text: '你\u2028好\u2029' }]);
});

test('提示和 MCP 边界校验', () => {
  assert.deepEqual(convertPrompt([{ type: 'text', text: '查看' },
    { type: 'resource', resource: { uri: 'file:///a', text: '代码' } },
    { type: 'image', mimeType: 'image/png', data: 'abc' }]),
  { message: '查看\n\n文件上下文（file:///a）：\n代码', images: [{ type: 'image', mimeType: 'image/png', data: 'abc' }] });
  assert.throws(() => convertPrompt([{ type: 'audio' }]), /不支持/);
  assert.throws(() => convertMcp([{ name: 'a', command: 'relative', args: [], env: [] }]), /绝对/);
  assert.throws(() => convertMcp([{ name: 'a', type: 'sse' }]), /不支持/);
});

test('初始化、错误、流式输出与真正完成时机', async t => {
  const c = await client(t);
  assert.equal((await c.request('session/new', {})).error.code, -32602);
  const sid = await session(c);
  assert.equal((await c.request('unknown', {})).error.code, -32601);
  assert.equal((await c.request('session/new', { cwd: '.', mcpServers: [] })).error.code, -32602);
  const started = Date.now();
  const response = await c.request('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: '你好' }] });
  assert.equal(response.result.stopReason, 'end_turn');
  assert.ok(Date.now() - started >= 60);
  const chunks = c.records.filter(r => r.params?.update?.sessionUpdate === 'agent_message_chunk');
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].params.update.content.text, '你好\u2028世界');
  assert.equal((await c.request('session/prompt', { sessionId: sid,
    prompt: [{ type: 'text', text: 'handled' }] })).result.stopReason, 'end_turn');
});

test('会话改名推送到 ACP 并更新历史列表，清除名称发送 null', async t => {
  const c = await client(t);
  const sid = await session(c);
  const other = await session(c);
  for (const name of ['自动生成的会话名', '手动修改的会话名', '']) {
    const response = await c.request('session/prompt', { sessionId: sid,
      prompt: [{ type: 'text', text: `/name ${name}` }] });
    assert.equal(response.result.stopReason, 'end_turn');
    const updates = c.records.filter(record => record.params?.update?.sessionUpdate === 'session_info_update');
    assert.equal(updates.at(-1).method, 'session/update');
    assert.equal(updates.at(-1).params.sessionId, sid);
    assert.deepEqual(updates.at(-1).params.update, { sessionUpdate: 'session_info_update', title: name || null });
    assert.ok(!updates.some(record => record.params.sessionId === other));
    if (name) {
      const listed = await c.request('session/list', { cwd: root });
      assert.equal(listed.result.sessions.find(info => info.sessionId === sid).title, name);
    }
  }
});

test('本机 pi 自动命名、扩展改名及 steering（显式启用，使用本地模型替身）', { skip: !process.env.PI_ACP_SMOKE }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-acp-title-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const extension = join(directory, 'title.ts');
  await writeFile(extension, `import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
  export default function (pi: any) {
    pi.registerProvider('title-test', {
      api: 'title-test-api', apiKey: 'test', baseUrl: 'http://localhost',
      models: [{ id: 'mock', name: '标题测试模型', reasoning: false, input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 100 }],
      streamSimple: (model: any, context: any) => {
        const stream = createAssistantMessageEventStream();
        const input = context.messages.filter((message: any) => message.role === 'user').at(-1);
        const text = input?.content?.some((block: any) => block.text === '等待引导') ? '等待引导已开始'
          : input?.content?.some((block: any) => block.text === '补充约束') ? '已采纳补充约束' : '测试回答';
        const message = { role: 'assistant', content: [{ type: 'text', text }],
          api: model.api, provider: model.provider, model: model.id, stopReason: 'stop', timestamp: Date.now(),
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        if (text === '等待引导已开始') {
          stream.push({ type: 'start', partial: message });
          stream.push({ type: 'text_delta', contentIndex: 0, delta: text, partial: message });
          setTimeout(() => {
            stream.push({ type: 'done', reason: 'stop', message });
            stream.end();
          }, 200);
        } else {
          stream.push({ type: 'done', reason: 'stop', message });
          stream.end();
        }
        return stream;
      },
    });
    pi.on('agent_settled', () => { pi.setSessionName('首轮自动标题'); });
    pi.registerCommand('__test_title', {
      description: '验证会话改名事件',
      handler: async (args: string) => { pi.setSessionName(args); },
    });
  }`);
  const c = await client(t, true, undefined, ['--extension', extension, '--model', 'title-test/mock']);
  const sid = await session(c);
  const first = await c.request('session/prompt', { sessionId: sid,
    prompt: [{ type: 'text', text: '验证首轮自动命名' }] });
  assert.equal(first.result.stopReason, 'end_turn');
  const automatic = await c.wait(record => record.params?.update?.title === '首轮自动标题');
  assert.equal(automatic.params.update.sessionUpdate, 'session_info_update');
  assert.equal(automatic.params.sessionId, sid);
  assert.ok(c.records.indexOf(automatic) < c.records.indexOf(first));
  assert.equal(c.records.filter(record => record.params?.update?.title === '首轮自动标题').length, 1);
  const response = await c.request('session/prompt', { sessionId: sid,
    prompt: [{ type: 'text', text: '/__test_title 本机扩展标题' }] });
  assert.equal(response.result.stopReason, 'end_turn');
  const update = await c.wait(record => record.params?.update?.title === '本机扩展标题');
  assert.equal(update.params.sessionId, sid);
  assert.equal(update.params.update.title, '本机扩展标题');
  const running = c.request('session/prompt', { sessionId: sid,
    prompt: [{ type: 'text', text: '等待引导' }] });
  await c.wait(record => record.params?.update?.content?.text === '等待引导已开始');
  const injected = await c.request('_session/steering', { sessionId: sid,
    prompt: [{ type: 'text', text: '补充约束' }] });
  assert.deepEqual(injected.result, { outcome: 'injected' });
  assert.equal((await running).result.stopReason, 'end_turn');
  assert.ok(c.records.some(record => record.params?.update?.content?.text === '已采纳补充约束'));
  const idle = await c.request('_session/steering', { sessionId: sid,
    prompt: [{ type: 'text', text: '补充约束' }] });
  assert.deepEqual(idle.result, { outcome: 'startedNewTurn' });
});

for (const option of ['allow-once', 'reject-once', 'cancel']) {
  test(`工具授权：${option}`, async t => {
    const c = await client(t);
    const sid = await session(c);
    await c.request('session/set_mode', { sessionId: sid, modeId: 'standard' });
    const prompt = c.request('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: 'permission' }] });
    const permission = await c.wait(r => r.method === 'session/request_permission');
    assert.equal(permission.params.toolCall.locations[0].path, root + 'a.txt');
    if (option === 'cancel') c.send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: sid } });
    else c.send({ jsonrpc: '2.0', id: permission.id, result: { outcome: { outcome: 'selected', optionId: option } } });
    assert.equal((await prompt).result.stopReason, option === 'cancel' ? 'cancelled' : 'end_turn');
    const tool = c.records.find(r => r.params?.update?.rawOutput);
    assert.equal(tool.params.update.status, option === 'allow-once' ? 'completed' : 'failed');
  });
}

test('默认完全访问自动放行，标准访问允许本会话全部工具且不影响其他会话', async t => {
  const c = await client(t);
  const sid = await session(c);
  const created = c.records.find(r => r.result?.sessionId === sid).result;
  assert.equal(created.modes.currentModeId, 'full');
  assert.equal(created.configOptions.find(option => option.id === 'mode').currentValue, 'full');
  const toolPrompt = sessionId => c.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'permission' }] });
  assert.equal((await toolPrompt(sid)).result.stopReason, 'end_turn');
  assert.equal(c.records.filter(r => r.method === 'session/request_permission').length, 0);
  const standard = await c.request('session/set_config_option', { sessionId: sid, configId: 'mode', value: 'standard' });
  assert.equal(standard.result.configOptions.find(option => option.id === 'mode').currentValue, 'standard');
  const first = toolPrompt(sid);
  const permission = await c.wait(r => r.method === 'session/request_permission');
  c.send({ jsonrpc: '2.0', id: permission.id, result: { outcome: { outcome: 'selected', optionId: 'allow-session' } } });
  assert.equal((await first).result.stopReason, 'end_turn');
  await toolPrompt(sid);
  assert.equal(c.records.filter(r => r.method === 'session/request_permission').length, 1);
  const other = await session(c);
  await c.request('session/set_mode', { sessionId: other, modeId: 'standard' });
  const second = toolPrompt(other);
  const otherPermission = await c.wait(r => r.method === 'session/request_permission' && r.params.sessionId === other);
  c.send({ jsonrpc: '2.0', id: otherPermission.id, result: { outcome: { outcome: 'selected', optionId: 'reject-once' } } });
  await second;
  assert.equal((await c.request('session/set_mode', { sessionId: sid, modeId: 'missing' })).error.code, -32602);
  await c.request('session/set_mode', { sessionId: sid, modeId: 'standard' });
  const third = toolPrompt(sid);
  await c.wait(r => r.method === 'session/request_permission' && r.params.sessionId === sid && r.id !== permission.id);
  // 切回完全访问应解除当前等待中的授权，而不是留下工具挂起。
  await c.request('session/set_mode', { sessionId: sid, modeId: 'full' });
  assert.equal((await third).result.stopReason, 'end_turn');
});

test('Air steering 注入文本和图片，原提示等待补充消息执行完成', async t => {
  const c = await client(t);
  const sid = await session(c);
  const first = c.request('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: 'wait' }] });
  const prompt = [{ type: 'text', text: '补充要求' }, { type: 'image', mimeType: 'image/png', data: 'abc' }];
  const [injected, second] = await Promise.all([
    c.request('_session/steering', { sessionId: sid, prompt }),
    c.request('_session/steering', { sessionId: sid, prompt: [{ type: 'text', text: '第二条补充' }] }),
  ]);
  assert.deepEqual(injected.result, { outcome: 'injected' });
  assert.deepEqual(second.result, { outcome: 'injected' });
  assert.ok(!c.records.some(record => record.result?.stopReason));
  assert.equal((await first).result.stopReason, 'end_turn');
  const chunk = c.records.find(record => record.params?.update?.content?.text?.includes('补充要求'));
  assert.deepEqual(JSON.parse(chunk.params.update.content.text), convertPrompt(prompt));
  const secondChunk = c.records.find(record => record.params?.update?.content?.text?.includes('第二条补充'));
  assert.deepEqual(JSON.parse(secondChunk.params.update.content.text), { message: '第二条补充' });
  assert.ok(c.records.indexOf(chunk) < c.records.indexOf(secondChunk));
});

test('空闲 steering 启动新回合，继续接收补充消息并可取消', async t => {
  const c = await client(t);
  const sid = await session(c);
  assert.deepEqual((await c.request('_session/steering', { sessionId: sid,
    prompt: [{ type: 'text', text: 'wait' }] })).result, { outcome: 'startedNewTurn' });
  assert.deepEqual((await c.request('_session/steering', { sessionId: sid,
    prompt: [{ type: 'text', text: 'hold' }] })).result, { outcome: 'injected' });
  await c.request('session/cancel', { sessionId: sid });
  const next = await c.request('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: '你好' }] });
  assert.equal(next.result.stopReason, 'end_turn');
  assert.ok(!c.records.some(record => record.params?.update?.content?.text?.includes('hold')));
});

test('取消清除尚未消费的 steering 并结束原提示', async t => {
  const c = await client(t);
  const sid = await session(c);
  const first = c.request('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: 'wait' }] });
  assert.deepEqual((await c.request('_session/steering', { sessionId: sid,
    prompt: [{ type: 'text', text: 'hold' }] })).result, { outcome: 'injected' });
  await c.request('session/cancel', { sessionId: sid });
  assert.equal((await first).result.stopReason, 'cancelled');
  const next = await c.request('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: '你好' }] });
  assert.equal(next.result.stopReason, 'end_turn');
  assert.ok(!c.records.some(record => record.params?.update?.content?.text?.includes('hold')));
});

test('steering 参数校验、失败响应与回合结束竞态', async () => {
  const updates = [];
  const agent = new Agent({ send: record => updates.push(record) });
  agent.initialized = true;
  let release;
  let submissions = 0;
  const session = { id: 'test', turn: null, pi: { request: async () => {
    if (++submissions === 1) {
      agent.event(session, { type: 'agent_start' });
      return { disposition: 'started' };
    }
    if (submissions === 2) {
      agent.event(session, { type: 'agent_settled' });
      return new Promise(resolve => { release = resolve; });
    }
    throw new Error('提交失败');
  } } };
  agent.sessions.set(session.id, session);
  const params = { sessionId: session.id, prompt: [{ type: 'text', text: '继续' }] };
  await assert.rejects(agent.dispatch('_session/steering', { ...params, prompt: [] }), /必须包含内容/);
  await assert.rejects(agent.dispatch('_session/steering', { ...params, sessionId: 'missing' }), /会话不存在/);
  let completed = false;
  const first = agent.dispatch('session/prompt', params).then(result => { completed = true; return result; });
  const steer = agent.dispatch('_session/steering', params);
  // 等待第二条提交抵达可控的 RPC 替身。
  while (!release) await new Promise(resolve => setImmediate(resolve));
  assert.equal(completed, false);
  release({ disposition: 'started' });
  assert.deepEqual(await steer, { outcome: 'startedNewTurn' });
  assert.equal(completed, false);
  assert.deepEqual(await agent.dispatch('_session/steering', params), { outcome: 'failed' });
  assert.ok(session.turn);
  agent.event(session, { type: 'agent_start' });
  agent.event(session, { type: 'agent_settled' });
  assert.equal((await first).stopReason, 'end_turn');
  assert.equal(session.turn, null);
  assert.deepEqual(await agent.dispatch('_session/steering', params), { outcome: 'failed' });
  assert.equal(session.turn, null);
  assert.match(updates.at(-1).params.update.content.text, /执行失败：提交失败/);
});

test('并发提示拒绝、取消和进程异常退出', async t => {
  const c = await client(t);
  const sid = await session(c);
  const first = c.request('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: 'wait' }] });
  assert.equal((await c.request('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: 'wait' }] })).error.code, -32602);
  c.send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: sid } });
  assert.equal((await first).result.stopReason, 'cancelled');
  assert.match((await c.request('session/prompt', { sessionId: sid,
    prompt: [{ type: 'text', text: 'crash' }] })).error.message, /退出/);
});

test('IDEA 的 MCP 配置传入独立 pi 会话', async t => {
  const c = await client(t);
  const sid = await session(c, [{ name: 'idea', type: 'http', url: 'http://localhost:1234/mcp',
    headers: [{ name: 'Authorization', value: 'test' }] },
  { name: 'local', command: process.execPath, args: ['server.js'], env: [{ name: 'LANG', value: 'zh_CN' }] }]);
  await c.request('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: 'mcp' }] });
  const text = c.records.find(r => r.params?.update?.sessionUpdate === 'agent_message_chunk').params.update.content.text;
  const config = JSON.parse(text);
  assert.equal(config.mcpServers.idea.headers.Authorization, 'test');
  assert.equal(config.mcpServers.local.env.LANG, 'zh_CN');
});

test('IDEA 可读取模型，并通过新旧接口切换到正确提供商', async t => {
  const c = await client(t);
  const sid = await session(c);
  const created = c.records.find(r => r.result?.sessionId === sid).result;
  assert.equal(created.models.currentModelId, 'test/first');
  assert.deepEqual(created.models.availableModels.map(model => model.modelId), ['test/first', 'test/second', 'other/first']);
  const changed = await c.request('session/set_config_option', { sessionId: sid, configId: 'model', value: 'test/second' });
  assert.equal(changed.result.configOptions[0].currentValue, 'test/second');
  assert.deepEqual((await c.request('session/set_model', { sessionId: sid, modelId: 'other/first' })).result, {});
  assert.equal((await c.request('session/set_model', { sessionId: sid, modelId: 'missing' })).error.code, -32602);
  assert.equal((await c.request('session/set_config_option', { sessionId: sid, configId: 'unknown', value: 'test/first' })).error.code, -32602);
  await c.request('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: 'model' }] });
  const chunk = c.records.find(r => r.params?.update?.sessionUpdate === 'agent_message_chunk');
  assert.equal(chunk.params.update.content.text, 'other/first');
  const updates = c.records.filter(r => r.params?.update?.sessionUpdate === 'config_option_update');
  assert.equal(updates.at(-1).params.update.configOptions[0].currentValue, 'other/first');
});

test('推理级别切换实际传入 pi，切换模型后刷新支持范围', async t => {
  const c = await client(t);
  const sid = await session(c);
  const changed = await c.request('session/set_config_option', { sessionId: sid, configId: 'thinking', value: 'max' });
  assert.equal(changed.result.configOptions[1].currentValue, 'max');
  assert.equal(changed.result.configOptions[0].currentValue, 'test/first');
  await c.request('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: 'thinking' }] });
  assert.equal(c.records.find(r => r.params?.update?.sessionUpdate === 'agent_message_chunk').params.update.content.text, 'max');
  const second = await c.request('session/set_config_option', { sessionId: sid, configId: 'model', value: 'test/second' });
  assert.equal(second.result.configOptions[1].currentValue, 'high');
  assert.ok(!second.result.configOptions[1].options.some(option => option.value === 'max'));
  assert.equal((await c.request('session/set_config_option', { sessionId: sid, configId: 'thinking', value: 'max' })).error.code, -32602);
  await c.request('session/set_model', { sessionId: sid, modelId: 'other/first' });
  const update = c.records.filter(r => r.params?.update?.sessionUpdate === 'config_option_update').at(-1).params.update;
  assert.deepEqual(update.configOptions[1].options.map(option => option.value), ['off']);
  assert.equal(update.configOptions[1].currentValue, 'off');
  assert.equal((await c.request('session/set_config_option', { sessionId: sid, configId: 'thinking', value: 'high' })).error.code, -32602);
});

test('本机 pi 启动及扩展握手（显式启用，不调用模型）', { skip: !process.env.PI_ACP_SMOKE }, async t => {
  const c = await client(t, true);
  const sid = await session(c);
  const created = c.records.find(r => r.result?.sessionId === sid).result;
  const thinking = created.configOptions.find(option => option.id === 'thinking');
  const value = thinking.options.at(-1).value;
  const changed = await c.request('session/set_config_option', { sessionId: sid, configId: 'thinking', value });
  assert.equal(changed.result.configOptions.find(option => option.id === 'thinking').currentValue, value);
});

for (const real of [false, true]) {
  test(`历史列表、分支回放及跨进程恢复${real ? '（本机 pi）' : ''}`, { skip: real && !process.env.PI_ACP_SMOKE }, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'pi-acp-history-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const c = await client(t, real, real ? join(directory, 'unused') : directory, real ? ['--session-dir', directory] : []);
    await session(c);
    const sid = randomUUID();
    const timestamp = new Date().toISOString();
    const entries = [
      { type: 'session', version: 3, id: sid, cwd: root, timestamp },
      { type: 'message', id: 'user', parentId: null, timestamp, message: { role: 'user', content: '历史问题', timestamp: Date.now() } },
      { type: 'message', id: 'old', parentId: 'user', timestamp, message: { role: 'assistant', content: [{ type: 'text', text: '放弃的分支' }] } },
      { type: 'message', id: 'reply', parentId: 'user', timestamp, message: { role: 'assistant', content: [
        { type: 'thinking', thinking: '历史思考' }, { type: 'text', text: '历史回答' },
        { type: 'toolCall', id: 'history-tool', name: 'read', arguments: { path: 'a.txt' } },
      ] } },
      { type: 'message', id: 'tool', parentId: 'reply', timestamp, message: { role: 'toolResult', toolCallId: 'history-tool', toolName: 'read',
        content: [{ type: 'text', text: '历史工具输出' }], isError: false } },
      { type: 'session_info', id: 'name', parentId: 'tool', timestamp, name: '历史会话标题' },
    ];
    await writeFile(join(directory, 'history.jsonl'), entries.map(entry => JSON.stringify(entry)).join('\n') + '\n');
    const otherId = randomUUID();
    await writeFile(join(directory, 'other.jsonl'), JSON.stringify({ ...entries[0], id: otherId, cwd: tmpdir() }) + '\n');
    const listed = await c.request('session/list', { cwd: root });
    assert.ok(listed.result, JSON.stringify(listed));
    const saved = listed.result.sessions.find(info => info.sessionId === sid);
    assert.equal(saved.title, '历史会话标题');
    assert.equal(saved.cwd, root);
    assert.ok(!('path' in saved));
    assert.ok(!listed.result.sessions.some(info => info.sessionId === otherId));
    const all = await c.request('session/list', {});
    assert.ok(all.result.sessions.some(info => info.sessionId === otherId));
    assert.equal((await c.request('session/list', { cwd: '.' })).error.code, -32602);
    assert.equal((await c.request('session/list', { cursor: 'invalid' })).error.code, -32602);
    assert.equal((await c.request('session/load', { sessionId: otherId, cwd: root, mcpServers: [] })).error.code, -32602);
    assert.equal((await c.request('session/load', { sessionId: '../history.jsonl', cwd: root, mcpServers: [] })).error.code, -32602);
    const loaded = await c.request('session/load', { sessionId: sid, cwd: root, mcpServers: [] });
    assert.ok(loaded.result?.configOptions, JSON.stringify(loaded));
    assert.ok(!('sessionId' in loaded.result));
    const updates = c.records.filter(record => record.params?.sessionId === sid).map(record => record.params.update);
    assert.deepEqual(updates.filter(update => update.content?.type === 'text').map(update => update.content.text), ['历史问题', '历史思考', '历史回答']);
    assert.equal(updates[0].sessionUpdate, 'user_message_chunk');
    assert.equal(updates[0].messageId, 'user');
    assert.ok(updates.some(update => update.sessionUpdate === 'session_info_update' && update.title === '历史会话标题'));
    assert.ok(updates.some(update => update.sessionUpdate === 'tool_call' && update.toolCallId === 'history-tool'));
    assert.ok(updates.some(update => update.status === 'completed' && update.content[0].content.text === '历史工具输出'));
    assert.ok(c.records.indexOf(c.records.find(record => record.params?.sessionId === sid)) < c.records.indexOf(loaded));
    assert.ok((await c.request('session/load', { sessionId: sid, cwd: root, mcpServers: [] })).result);
    if (!real) {
      assert.equal((await c.request('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: '继续历史' }] })).result.stopReason, 'end_turn');
      const restarted = await client(t, false, directory);
      await restarted.request('initialize', { protocolVersion: 1 });
      assert.ok((await restarted.request('session/load', { sessionId: sid, cwd: root, mcpServers: [] })).result);
      assert.ok(restarted.records.some(record => record.params?.update?.content?.text === '继续历史'));
    }
  });
}

test('拒绝用 --no-session 禁用 ACP 会话持久化', async t => {
  const c = await client(t, false, undefined, ['--no-session']);
  await c.request('initialize', { protocolVersion: 1 });
  const created = await c.request('session/new', { cwd: root, mcpServers: [] });
  assert.match(created.error.message, /持久会话/);
});

test('新会话持久保存并可由另一个适配器发现和恢复', async t => {
  const c = await client(t);
  const sid = await session(c);
  await c.request('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text: '保存此问题' }] });
  const reopened = await client(t, false, c.directory);
  await reopened.request('initialize', { protocolVersion: 1 });
  assert.ok((await reopened.request('session/list', { cwd: root })).result.sessions.some(info => info.sessionId === sid));
  assert.ok((await reopened.request('session/load', { sessionId: sid, cwd: root, mcpServers: [] })).result);
  assert.ok(reopened.records.some(record => record.params?.update?.content?.text === '保存此问题'));
});
