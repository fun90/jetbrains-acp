#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import { resolvePi } from './pi-command.js';
import { ProtocolAgent } from './protocol.js';
import { readJsonl, writeJsonl } from './jsonl.js';

const arguments_ = process.argv.slice(2);
if (arguments_.includes('--help') && !arguments_.includes('--')) {
  process.stderr.write('用法：node src/index.js [--setup] [--pi-command /绝对路径/pi] [-- pi 参数]\n');
  process.exit(0);
}
let command = process.env.PI_ACP_PI_COMMAND;
let setup = process.env.PI_ACP_SETUP === '1';
let args = [];
while (arguments_.length) {
  const option = arguments_.shift();
  if (option === '--setup') setup = true;
  else if (option === '--pi-command' && arguments_.length) command = arguments_.shift();
  else if (option === '--') { args = arguments_; break; }
  else { process.stderr.write(`未知参数：${option}\n`); process.exit(1); }
}
({ command, args } = resolvePi(command, args));
if (setup) {
  process.stderr.write('在 pi 中输入 /login 选择模型提供商并完成登录；完成后退出 pi，返回 IDE 继续。\n');
  const child = spawn(command, args, { stdio: 'inherit' });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
  child.on('error', error => {
    process.stderr.write(`无法启动 pi：${error.message}\n`);
    process.exit(1);
  });
  // shortcut: 登录结果沿用 pi 的退出码，pi 提供独立登录命令后改用登录专用流程。
  child.on('exit', (code, signal) => process.exit(code ?? (128 + constants.signals[signal])));
  await new Promise(() => {});
}
const agent = new ProtocolAgent({ command, args, send: record => writeJsonl(process.stdout, record) });
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
