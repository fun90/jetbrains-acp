import { isAbsolute } from 'node:path';
import { invalid } from './shared.js';

// ACP 请求参数到 pi 配置与提示的转换，纯函数。
export function convertMcp(servers) {
  if (!Array.isArray(servers)) throw invalid('mcpServers 必须是数组');
  const result = Object.create(null);
  const names = new Set();
  for (const server of servers) {
    if (!server || typeof server.name !== 'string' || !/^[\w-]+$/.test(server.name)) {
      throw invalid('MCP 名称只允许字母、数字、下划线和连字符');
    }
    const key = server.name.replaceAll('-', '_');
    if (names.has(key)) throw invalid('MCP 名称重复');
    names.add(key);
    if (server.type === 'http') {
      if (typeof server.url !== 'string' || !/^https?:\/\//.test(server.url) ||
          !Array.isArray(server.headers) || server.headers.some(h =>
            !h || typeof h.name !== 'string' || typeof h.value !== 'string')) {
        throw invalid('HTTP MCP 配置无效');
      }
      result[server.name] = { url: server.url,
        headers: Object.fromEntries(server.headers.map(h => [h.name, h.value])), exposure: 'direct' };
    } else if (!server.type || server.type === 'stdio') {
      if (typeof server.command !== 'string' || !isAbsolute(server.command) ||
          !Array.isArray(server.args) || server.args.some(a => typeof a !== 'string') ||
          !Array.isArray(server.env) || server.env.some(e =>
            !e || typeof e.name !== 'string' || typeof e.value !== 'string')) {
        throw invalid('stdio MCP 需要绝对命令路径、args 和 env 数组');
      }
      result[server.name] = { command: server.command, args: server.args,
        env: Object.fromEntries(server.env.map(e => [e.name, e.value])), exposure: 'direct' };
    } else throw invalid(`不支持 MCP 传输：${server.type}`);
  }
  return result;
}

export function convertPrompt(blocks) {
  if (!Array.isArray(blocks) || !blocks.length) throw invalid('prompt 必须包含内容');
  const text = [];
  const images = [];
  for (const block of blocks) {
    if (block?.type === 'text' && typeof block.text === 'string') text.push(block.text);
    else if (block?.type === 'image' && typeof block.data === 'string' &&
             typeof block.mimeType === 'string' && block.mimeType.startsWith('image/')) {
      images.push({ type: 'image', data: block.data, mimeType: block.mimeType });
    } else if (block?.type === 'resource' && typeof block.resource?.text === 'string') {
      text.push(`文件上下文（${block.resource.uri}）：\n${block.resource.text}`);
    } else if (block?.type === 'resource_link' && typeof block.uri === 'string') {
      text.push(`引用资源：${block.uri}`);
    } else throw invalid(`不支持的提示内容：${block?.type}`);
  }
  return { message: text.join('\n\n'), ...(images.length ? { images } : {}) };
}
