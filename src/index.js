#!/usr/bin/env node
import { Agent } from './agent.js';
import { readJsonl, writeJsonl } from './jsonl.js';

const arguments_ = process.argv.slice(2);
if (arguments_.includes('--help') && !arguments_.includes('--')) {
  process.stderr.write('用法：node src/index.js [--pi-command /绝对路径/pi] [-- pi 参数]\n');
  process.exit(0);
}
let command = process.env.PI_ACP_PI_COMMAND || 'pi';
let args = [];
while (arguments_.length) {
  const option = arguments_.shift();
  if (option === '--pi-command' && arguments_.length) command = arguments_.shift();
  else if (option === '--') { args = arguments_; break; }
  else { process.stderr.write(`未知参数：${option}\n`); process.exit(1); }
}
const agent = new Agent({ command, args, send: record => writeJsonl(process.stdout, record) });
readJsonl(process.stdin, record => { void agent.receive(record); }, () => {
  writeJsonl(process.stdout, { jsonrpc: '2.0', id: null,
    error: { code: -32700, message: 'JSON 解析失败' } });
});
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await agent.close();
  process.exit(0);
}
process.stdin.on('end', stop);
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
process.stdout.on('error', stop);
