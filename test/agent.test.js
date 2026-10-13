import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { readJsonl, writeJsonl } from '../src/jsonl.js';
import { convertMcp, convertPrompt } from '../src/agent.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const fixture = fileURLToPath(new URL('../fixtures/pi.js', import.meta.url));

async function client(t, real = false) {
  const child = spawn(process.execPath, ['src/index.js', '--pi-command', real ? (process.env.PI_ACP_PI_COMMAND || 'pi') : process.execPath,
    '--', ...(real ? ['--offline', '--no-extensions', '--no-skills', '--no-context-files', '--no-mcp'] : [fixture])],
  { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
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
  });
  return { child, records, request, send, wait };
}

async function session(c, mcpServers = []) {
  const initialized = await c.request('initialize', { protocolVersion: 1 });
  assert.equal(initialized.result.protocolVersion, 1);
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
