// ── Crypto 单元测试：canonical answers / PBKDF2 与 node crypto 对照 / AES-GCM 往返 ──
import test from 'node:test';
import assert from 'node:assert/strict';
import { pbkdf2Sync } from 'node:crypto';
import {
  serializeCanonicalAnswers,
  pbkdf2,
  aesGcmEncrypt,
  aesGcmDecrypt,
  deriveHumanFragments,
} from '../src/lib/crypto.js';

const SECRET = 'unit-test-secret-abcdefghijklmnopqrstuvwxyz0123456789';

test('canonical answers 序列化规范', () => {
  assert.equal(
    serializeCanonicalAnswers(['YES', 'NO', 'yes', ' no ']),
    'Q1:YES\nQ2:NO\nQ3:YES\nQ4:NO\n'
  );
  assert.throws(() => serializeCanonicalAnswers(['YES', 'MAYBE']));
  assert.throws(() => serializeCanonicalAnswers('NOT_ARRAY'));
});

test('PBKDF2-HMAC-SHA256 与 node:crypto 结果一致（标准向量）', async () => {
  const password = 'Q1:YES\nQ2:NO\nQ3:YES\nQ4:YES\n';
  const salt = Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  const iters = 4096;
  const length = 32;
  const web = await pbkdf2({ password, salt, iterations: iters, length });
  const nodeBuf = pbkdf2Sync(password, Buffer.from(salt), iters, length, 'sha256');
  assert.equal(Buffer.from(web).toString('hex'), nodeBuf.toString('hex'));
});

test('AES-256-GCM 加解密往返（含中文 + 长文本）', async () => {
  const keyBytes = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aad = new TextEncoder().encode('redpacket:2026-09-redpacket-01');
  const plaintext = 'hello 红包 FINAL_DATA ' + 'x'.repeat(500);
  const ct = await aesGcmEncrypt({ keyBytes, iv, aad, plaintext });
  const pt = await aesGcmDecrypt({ keyBytes, iv, aad, ciphertext: ct });
  assert.equal(pt, plaintext);
});

test('AAD 不同则解密失败（AEAD 完整性）', async () => {
  const keyBytes = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aad = new TextEncoder().encode('A');
  const ct = await aesGcmEncrypt({ keyBytes, iv, aad, plaintext: 'secret' });
  await assert.rejects(
    () => aesGcmDecrypt({ keyBytes, iv, aad: new TextEncoder().encode('B'), ciphertext: ct }),
    /error/i
  );
});

test('Human fragments 派生确定且数量等于题目数', async () => {
  const answers = Array(8).fill('YES');
  const f = await deriveHumanFragments(SECRET, { version: 'v', nonce: 'n0', answers });
  assert.equal(f.length, 8);
  const f2 = await deriveHumanFragments(SECRET, { version: 'v', nonce: 'n0', answers });
  assert.deepEqual(f, f2);
});
