// ── Token 单元测试：签发/验证/篡改/错误签名/畸形输入/Fragment 派生 ──
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  signToken,
  verifyToken,
  deriveFragment,
} from '../src/lib/token.js';

const SECRET = 'unit-test-secret-abcdefghijklmnopqrstuvwxyz0123456789';

function payload(over = {}) {
  return {
    v: '2026-09-redpacket-01',
    track: 'human',
    step: 1,
    answers: [],
    nonce: 'n0',
    iat: 1788260000,
    exp: 1788263600,
    ...over,
  };
}

test('token 签发/验证 往返一致', async () => {
  const tok = await signToken(SECRET, payload());
  const got = await verifyToken(SECRET, tok);
  assert.deepEqual(got, payload());
});

test('篡改 token 载荷部分被拒绝', async () => {
  const tok = await signToken(SECRET, payload({ step: 2 }));
  const idx = tok.indexOf('.');
  // 翻转载荷区最后一个字符，签名字段不变 -> 应拒绝
  const part = tok[idx - 1];
  const flipped = part === 'A' ? 'B' : 'A';
  const tampered = tok.slice(0, idx - 1) + flipped + tok.slice(idx);
  assert.equal(await verifyToken(SECRET, tampered), null);
});

test('错误密钥验证被拒绝', async () => {
  const tok = await signToken(SECRET, payload());
  assert.equal(await verifyToken('wrong-secret', tok), null);
});

test('畸形/空 token 被拒绝', async () => {
  assert.equal(await verifyToken(SECRET, ''), null);
  assert.equal(await verifyToken(SECRET, 'abc'), null);
  assert.equal(await verifyToken(SECRET, 'a.b.c'), null);
  assert.equal(await verifyToken(SECRET, '.abc'), null);
  assert.equal(await verifyToken(SECRET, 'abc.'), null);
  assert.equal(await verifyToken(SECRET, null), null);
});

test('fragment 派生确定且随输入变化', async () => {
  const args = { version: 'v', track: 'human', step: 1, answer: 'YES', nonce: 'n' };
  const a = await deriveFragment(SECRET, args);
  const b = await deriveFragment(SECRET, args);
  assert.equal(a, b);
  assert.equal(a.length, 4); // 默认 2 字节 hex
  const c = await deriveFragment(SECRET, { ...args, answer: 'NO' });
  assert.notEqual(a, c);
});
