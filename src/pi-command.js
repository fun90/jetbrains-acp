import { fileURLToPath } from 'node:url';

export function resolvePi(command, args = []) {
  if (command) return { command, args };
  const entry = new URL('./cli.js', import.meta.resolve('@earendil-works/pi-coding-agent/rpc-entry'));
  return { command: process.execPath, args: [fileURLToPath(entry), ...args] };
}
