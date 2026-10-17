import { accessSync, constants } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { t } from '../src/i18n.js';

const requested = process.argv[2] || process.env.PI_ACP_PI_COMMAND;
const candidates = !requested ? [] : isAbsolute(requested) ? [requested]
  : (process.env.PATH || '').split(delimiter).map(directory => join(directory, requested));
const command = candidates.find(path => {
  try { accessSync(path, constants.X_OK); return true; } catch { return false; }
});
if (requested && !command) {
  process.stderr.write(`${t('piNotFound')}\n`);
  process.exit(1);
}
console.log(JSON.stringify({ agent_servers: { pi: {
  command: process.execPath,
  args: [fileURLToPath(new URL('../src/index.js', import.meta.url)),
    ...(command ? ['--pi-command', resolve(command)] : [])],
  use_idea_mcp: true, use_custom_mcp: true,
} } }, null, 2));
