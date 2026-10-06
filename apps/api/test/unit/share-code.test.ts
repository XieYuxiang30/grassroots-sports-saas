import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildShareUrl, generateShareCode, normalizeShareCode, parseShareCode } from '../../src/common/share-code';

/**
 * 分享码测试。
 * 现场用法是「大屏投二维码 + 计分员口头报码」，所以既要能扫，也要能手输。
 */
describe('分享码（扫码进房）', () => {
  it('生成的码长度固定、字符集不含易混字符', () => {
    for (let index = 0; index < 200; index += 1) {
      const code = generateShareCode();
      assert.equal(code.length, 6);
      assert.match(code, /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/, `出现了易混字符：${code}`);
    }
  });

  it('生成器可注入随机源（可复现）', () => {
    const sequence = [0, 0.1, 0.2, 0.3, 0.4, 0.5];
    let cursor = 0;
    const code = generateShareCode(() => sequence[cursor++ % sequence.length]!);
    assert.equal(code.length, 6);
  });

  it('大小写与空格不敏感', () => {
    assert.equal(normalizeShareCode(' ab12cd '), 'AB12CD');
  });

  it('支持三种真实入口：纯码 / ?code= 链接 / /m/ 短链', () => {
    assert.equal(parseShareCode('AB12CD'), 'AB12CD');
    assert.equal(parseShareCode('ab12cd'), 'AB12CD');
    assert.equal(parseShareCode('https://hoop.example.com/live?code=AB12CD&from=qr'), 'AB12CD');
    assert.equal(parseShareCode('https://hoop.example.com/m/AB12CD'), 'AB12CD');
  });

  it('无法识别的输入返回 null（不猜）', () => {
    assert.equal(parseShareCode(''), null);
    assert.equal(parseShareCode('AB'), null);
    assert.equal(parseShareCode('https://hoop.example.com/'), null);
  });

  it('拼分享链接时不会出现双斜杠', () => {
    assert.equal(buildShareUrl('https://hoop.example.com/', 'AB12CD'), 'https://hoop.example.com/m/AB12CD');
    assert.equal(buildShareUrl('https://hoop.example.com', 'AB12CD'), 'https://hoop.example.com/m/AB12CD');
  });
});
