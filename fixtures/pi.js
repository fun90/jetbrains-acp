import { readJsonl, writeJsonl } from '../src/jsonl.js';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
const option = name => process.argv.includes(name) ? process.argv[process.argv.lastIndexOf(name) + 1] : undefined;
const directory = process.env.PI_CODING_AGENT_SESSION_DIR;
const sessionPath = process.argv.includes('--session') ? option('--session') : join(directory, `${option('--session-id') || randomUUID()}.jsonl`);
let entries = process.argv.includes('--session') ? readFileSync(sessionPath, 'utf8').trim().split('\n').map(JSON.parse) : [
  { type: 'session', version: 3, id: process.argv.includes('--session-id') ? option('--session-id') : randomUUID(), cwd: process.cwd(), timestamp: new Date().toISOString() },
];
const persist = () => {
  if (!process.argv.includes('--no-session')) writeFileSync(sessionPath, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n');
};
const append = message => {
  entries.push({ type: 'message', id: randomUUID(), parentId: entries.length > 1 ? entries.at(-1).id : null,
    timestamp: new Date().toISOString(), message });
  persist();
};
const send = record => writeJsonl(process.stdout, record);
let permission;
let waiting;
const models = [{ provider: 'test', id: 'first', name: '第一个模型' },
  { provider: 'test', id: 'second', name: '第二个模型' },
  { provider: 'other', id: 'first', name: '同名模型' }];
let model = models[0];
let thinkingLevel = 'medium';
const thinkingLevels = () => model.provider === 'other' ? ['off']
  : ['off', 'minimal', 'low', 'medium', 'high', ...(model.id === 'first' ? ['xhigh', 'max'] : [])];
readJsonl(process.stdin, request => {
  const response = data => send({ type: 'response', id: request.id, success: true, data });
  if (request.type === 'get_state') response({ sessionId: entries[0].id, sessionFile: process.argv.includes('--no-session') ? undefined : sessionPath, model, thinkingLevel });
  else if (request.type === 'get_entries') response({ entries: entries.slice(1), leafId: entries.length > 1 ? entries.at(-1).id : null });
  else if (request.type === 'get_available_models') response({ models });
  else if (request.type === 'get_available_thinking_levels') response({ levels: thinkingLevels() });
  else if (request.type === 'set_thinking_level') {
    thinkingLevel = request.level;
    send({ type: 'thinking_level_changed', level: thinkingLevel });
    response();
  }
  else if (request.type === 'set_model') {
    model = models.find(model => model.provider === request.provider && model.id === request.modelId);
    if (!thinkingLevels().includes(thinkingLevel)) thinkingLevel = thinkingLevels().at(-1);
    response(model);
  }
  else if (request.type === 'prompt' && request.message === '/__acp_check') {
    send({ type: 'extension_ui_request', method: 'notify', message: 'PI_ACP_READY' });
    response({ disposition: 'handled' });
  } else if (request.type === 'prompt' && request.message.startsWith('/__acp_list')) {
    const sessions = readdirSync(directory).filter(file => file.endsWith('.jsonl')).map(file => {
      const path = join(directory, file);
      const saved = readFileSync(path, 'utf8').trim().split('\n').map(JSON.parse);
      const header = saved[0];
      return { sessionId: header.id, cwd: header.cwd, title: saved.find(entry => entry.type === 'session_info')?.name || '测试会话',
        updatedAt: saved.at(-1).timestamp, path };
    }).filter(session => request.message.endsWith(' all') || resolve(session.cwd) === process.cwd());
    send({ type: 'extension_ui_request', method: 'notify', message: `PI_ACP_SESSIONS:${JSON.stringify(sessions)}` });
    response({ disposition: 'handled' });
  } else if (request.type === 'prompt') {
    append({ role: 'user', content: request.message });
    send({ type: 'message_start', message: { role: 'assistant' } });
    if (request.message === 'permission') {
      permission = true;
      send({ type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'write', args: { path: 'a.txt', content: '你好' } });
      send({ type: 'extension_ui_request', id: 'ui-1', method: 'confirm', title: 'PI_ACP_PERMISSION',
        message: JSON.stringify({ toolCallId: 'call-1', toolName: 'write', args: { path: 'a.txt' } }) });
    } else if (request.message === 'wait') waiting = true;
    else if (request.message === 'crash') process.exit(2);
    else if (request.message === 'handled') { response({ disposition: 'handled' }); return; }
    else {
      const text = request.message === 'mcp' ? readFileSync(process.env.PI_ACP_CONFIG, 'utf8')
        : request.message === 'model' ? `${model.provider}/${model.id}`
          : request.message === 'thinking' ? thinkingLevel : '你好\u2028世界';
      append({ role: 'assistant', content: [{ type: 'text', text }] });
      send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: text } });
      send({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop' } });
      // 故意先结束低层运行，稍后才报告真正完成。
      send({ type: 'agent_end', willRetry: true });
      setTimeout(() => send({ type: 'agent_settled', aborted: false }), 80);
    }
    response({ disposition: 'started' });
  } else if (request.type === 'extension_ui_response' && permission) {
    permission = false;
    send({ type: 'tool_execution_end', toolCallId: 'call-1', toolName: 'write', isError: !request.confirmed,
      result: { content: [{ type: 'text', text: request.confirmed ? '已执行' : '已拒绝' }] } });
    send({ type: 'agent_settled', aborted: !request.confirmed && !!request.cancelled });
  } else if (request.type === 'clear_queue') response({ steering: [], followUp: [] });
  else if (request.type === 'abort') {
    response();
    if (waiting || permission) {
      waiting = permission = false;
      send({ type: 'agent_settled', aborted: true });
    }
  }
}, () => process.exit(1));
