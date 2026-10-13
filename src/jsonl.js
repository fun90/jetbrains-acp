// 只按 LF 分帧，保留 JSON 字符串内合法的 Unicode 分隔符。
export function readJsonl(stream, onRecord, onError) {
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', chunk => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, end).replace(/\r$/, '');
      buffer = buffer.slice(end + 1);
      if (!line.trim()) continue;
      try { onRecord(JSON.parse(line)); } catch (error) { onError(error); }
    }
  });
  stream.on('end', () => {
    if (buffer.trim()) onError(new Error('JSONL 记录缺少换行结束符'));
  });
}

export function writeJsonl(stream, record) {
  return stream.write(JSON.stringify(record) + '\n');
}
