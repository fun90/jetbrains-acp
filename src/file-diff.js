import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MAX_DIFF_BYTES = 256 * 1024;

export function toolPath(cwd, path) {
  path = path.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, ' ').replace(/^@/, '');
  if (path === '~') path = homedir();
  else if (path.startsWith('~/')) path = resolve(homedir(), path.slice(2));
  if (path.startsWith('file://')) {
    try { path = fileURLToPath(path); } catch { /* 无效 URI 留给 pi 工具报告。 */ }
  }
  return resolve(cwd, path);
}

export async function fileText(path) {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    const info = await file.stat();
    if (!info.isFile() || info.size > MAX_DIFF_BYTES) return undefined;
    const buffer = Buffer.alloc(MAX_DIFF_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > MAX_DIFF_BYTES || buffer.subarray(0, size).includes(0)) return undefined;
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, size));
  } catch (error) {
    return error.code === 'ENOENT' ? null : undefined;
  } finally {
    await file?.close();
  }
}

// ACP v1 的编辑 diff 与 codex-acp 一样，每个补丁片段分别携带旧文本和新文本。
export function patchDiffs(patch, path) {
  if (typeof patch !== 'string' || Buffer.byteLength(patch) > MAX_DIFF_BYTES) return [];
  const diffs = [];
  let hunk;
  let previous;
  for (const line of patch.split('\n')) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/.exec(line);
    if (header) {
      if (header.slice(1).some(value => value !== undefined && !Number.isSafeInteger(Number(value)))) return [];
      if (hunk && (hunk.oldCount || hunk.newCount)) return [];
      hunk = { type: 'diff', path, oldText: '', newText: '', line: Math.max(1, Number(header[3])),
        oldCount: Number(header[2] ?? 1), newCount: Number(header[4] ?? 1) };
      diffs.push(hunk);
      previous = undefined;
    } else if (hunk && line === '\\ No newline at end of file') {
      if (!previous) return [];
      if (previous !== '+') hunk.oldText = hunk.oldText.slice(0, -1);
      if (previous !== '-') hunk.newText = hunk.newText.slice(0, -1);
      previous = undefined;
    } else if (hunk && (hunk.oldCount || hunk.newCount)) {
      const sign = line[0];
      if (![' ', '+', '-'].includes(sign)) return [];
      if (sign !== '+') { hunk.oldText += line.slice(1) + '\n'; hunk.oldCount--; }
      if (sign !== '-') { hunk.newText += line.slice(1) + '\n'; hunk.newCount--; }
      if (hunk.oldCount < 0 || hunk.newCount < 0) return [];
      previous = sign;
    } else if (hunk && line !== '') return [];
  }
  if (hunk && (hunk.oldCount || hunk.newCount)) return [];
  return diffs.map(({ oldCount, newCount, ...diff }) => diff);
}

export function gitPatch(path, result) {
  const patch = result?.details?.patch;
  const snapshot = result?.details?.acpDiff;
  if (typeof patch !== 'string' || Buffer.byteLength(patch) > MAX_DIFF_BYTES) return undefined;
  const start = patch.search(/^@@ /m);
  const added = snapshot?.oldText === null;
  if (start < 0 && !(added && snapshot.newText === '')) return undefined;
  const name = (process.platform === 'win32' ? path.replaceAll('\\', '/') : path).replace(/^\/+/, '');
  const quote = value => /["\\\x00-\x1f\x7f]/.test(value)
    ? '"' + value.replace(/["\\\x00-\x1f\x7f]/g, character => {
      if (character === '"' || character === '\\') return '\\' + character;
      return '\\' + character.charCodeAt(0).toString(8).padStart(3, '0');
    }) + '"' : value;
  const oldPath = quote(`a/${name}`);
  const newPath = quote(`b/${name}`);
  const header = value => value.includes(' ') && !value.startsWith('"') ? value + '\t' : value;
  const text = `diff --git ${oldPath} ${newPath}\n` + (added ? 'new file mode 100644\n' : '') +
    (start < 0 ? '' : `--- ${added ? '/dev/null' : header(oldPath)}\n+++ ${header(newPath)}\n${patch.slice(start)}`);
  return Buffer.byteLength(text) <= MAX_DIFF_BYTES ? { text, kind: added ? 'add' : 'update' } : undefined;
}

export function fileDiffs(tool, result, isError = false) {
  if (isError || !tool?.locations?.[0] || !['edit', 'write'].includes(tool.title)) return [];
  const { path } = tool.locations[0];
  const snapshot = result?.details?.acpDiff;
  if (tool.title === 'write') {
    if (!snapshot || snapshot.path !== path ||
        !(snapshot.oldText === null || typeof snapshot.oldText === 'string') ||
        typeof snapshot.newText !== 'string' ||
        Buffer.byteLength((snapshot.oldText ?? '') + snapshot.newText) > MAX_DIFF_BYTES ||
        snapshot.oldText === snapshot.newText) return [];
    return [{ type: 'diff', path, oldText: snapshot.oldText, newText: snapshot.newText, line: 1 }];
  }
  return patchDiffs(result?.details?.patch, path);
}
