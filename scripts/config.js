import { accessSync, constants } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const requested = process.argv[2] || process.env.PI_ACP_PI_COMMAND;
const candidates = !requested ? [] : isAbsolute(requested) ? [requested]
  : (process.env.PATH || '').split(delimiter).map(directory => join(directory, requested));
const command = candidates.find(path => {
  try { accessSync(path, constants.X_OK); return true; } catch { return false; }
});
if (requested && !command) {
  process.stderr.write('未找到 pi，请传入 pi 可执行文件的绝对路径。\n');
  process.exit(1);
}
console.log(JSON.stringify({ agent_servers: { pi: {
  command: process.execPath,
  args: [fileURLToPath(new URL('../src/index.js', import.meta.url)),
    ...(command ? ['--pi-command', resolve(command)] : [])],
  use_idea_mcp: true, use_custom_mcp: true,
} } }, null, 2));
