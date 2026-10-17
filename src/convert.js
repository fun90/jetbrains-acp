import { isAbsolute } from 'node:path';
import { invalid } from './shared.js';
import { t } from './i18n.js';

// ACP 请求参数到 pi 配置与提示的转换，纯函数。
export function convertMcp(servers) {
  if (!Array.isArray(servers)) throw invalid(t('mcpServersArray'));
  const result = Object.create(null);
  const names = new Set();
  for (const server of servers) {
    if (!server || typeof server.name !== 'string' || !/^[\w-]+$/.test(server.name)) {
      throw invalid(t('mcpNameInvalid'));
    }
    const key = server.name.replaceAll('-', '_');
    if (names.has(key)) throw invalid(t('mcpNameDuplicate'));
    names.add(key);
    if (server.type === 'http') {
      if (typeof server.url !== 'string' || !/^https?:\/\//.test(server.url) ||
          !Array.isArray(server.headers) || server.headers.some(h =>
            !h || typeof h.name !== 'string' || typeof h.value !== 'string')) {
        throw invalid(t('httpMcpInvalid'));
      }
      result[server.name] = { url: server.url,
        headers: Object.fromEntries(server.headers.map(h => [h.name, h.value])), exposure: 'direct' };
    } else if (!server.type || server.type === 'stdio') {
      if (typeof server.command !== 'string' || !isAbsolute(server.command) ||
          !Array.isArray(server.args) || server.args.some(a => typeof a !== 'string') ||
          !Array.isArray(server.env) || server.env.some(e =>
            !e || typeof e.name !== 'string' || typeof e.value !== 'string')) {
        throw invalid(t('stdioMcpInvalid'));
      }
      result[server.name] = { command: server.command, args: server.args,
        env: Object.fromEntries(server.env.map(e => [e.name, e.value])), exposure: 'direct' };
    } else throw invalid(t('mcpTransportUnsupported', { type: server.type }));
  }
  return result;
}

export function convertPrompt(blocks) {
  if (!Array.isArray(blocks) || !blocks.length) throw invalid(t('promptEmpty'));
  const text = [];
  const images = [];
  for (const block of blocks) {
    if (block?.type === 'text' && typeof block.text === 'string') text.push(block.text);
    else if (block?.type === 'image' && typeof block.data === 'string' &&
             typeof block.mimeType === 'string' && block.mimeType.startsWith('image/')) {
      images.push({ type: 'image', data: block.data, mimeType: block.mimeType });
    } else if (block?.type === 'resource' && typeof block.resource?.text === 'string') {
      text.push(t('fileContext', { uri: block.resource.uri, text: block.resource.text }));
    } else if (block?.type === 'resource_link' && typeof block.uri === 'string') {
      text.push(t('resourceLink', { uri: block.uri }));
    } else throw invalid(t('promptContentUnsupported', { type: block?.type }));
  }
  return { message: text.join('\n\n'), ...(images.length ? { images } : {}) };
}
