import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { messages, t } from '../src/i18n.js';

test('中英文字典键一致，源码引用的键都存在', () => {
  assert.deepEqual(Object.keys(messages.en).sort(), Object.keys(messages.zh).sort());
  const files = [...readdirSync('src').map(name => `src/${name}`), 'extensions/acp.ts', 'scripts/config.js'];
  for (const file of files) {
    for (const [, key] of readFileSync(file, 'utf8').matchAll(/\b(?:t|logError)\('(\w+)'/g)) {
      assert.ok(key in messages.zh, `${file}: ${key}`);
    }
  }
});

test('文案按语言切换并原样插入含 $ 的变量', () => {
  const saved = process.env.LC_ALL;
  try {
    process.env.LC_ALL = 'en_US.UTF-8';
    assert.equal(t('statusTokens', { tokens: 3, cost: '$&' }), 'Total tokens: 3, cost: $$&');
    process.env.LC_ALL = 'zh_CN.UTF-8';
    assert.equal(t('piExited', { reason: 1 }), 'pi 已退出（1）');
  } finally { process.env.LC_ALL = saved; }
});
