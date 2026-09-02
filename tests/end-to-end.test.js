import test from 'node:test';
import assert from 'node:assert/strict';
import {
  aesGcmDecrypt,
  aesGcmEncrypt,
  base64ToBytes,
  buildHumanCryptoMaterial,
  bytesToBase64,
} from '../src/lib/crypto.js';
import { buildHumanParticipantRecord } from '../src/lib/record.js';
import { CONFIG } from '../config/challenge.js';

const SECRET = 'TEST_ONLY_STATE_SIGNING_SECRET_0123456789';
const env = {
  CHALLENGE_VERSION: '2026-09-redpacket-01',
  HUMAN_ITERATIONS: 10_000,
  RED_PACKET_PASSWORD: '13572468',
};
const nonce = 'unit-test-nonce-0001';
const allFirst = CONFIG.human.questions.map((question) => question.choices[0].value);

async function roundTrip(answers) {
  const material = await buildHumanCryptoMaterial(SECRET, env, { answers, nonce });
  const record = buildHumanParticipantRecord(env);
  const outer = bytesToBase64(new TextEncoder().encode(record));
  const ciphertext = await aesGcmEncrypt({
    keyBytes: material.keyBytes,
    iv: material.iv,
    aad: material.aad,
    plaintext: outer,
  });
  const decryptedOuter = await aesGcmDecrypt({
    keyBytes: material.keyBytes,
    iv: material.iv,
    aad: material.aad,
    ciphertext,
  });
  const decodedRecord = new TextDecoder().decode(base64ToBytes(decryptedOuter));
  const match = decodedRecord.match(/FINAL_DATA:\n([A-Za-z0-9+/=]+)/);
  const password = match
    ? new TextDecoder().decode(base64ToBytes(match[1]))
    : null;
  return { material, record: decodedRecord, password };
}

test('Human 全链路使用生产 Record builder 还原测试口令', async () => {
  const result = await roundTrip(allFirst);
  assert.equal(result.material.iterations, 10_000);
  assert.equal(result.material.fragments.length, 8);
  assert.equal(result.password, env.RED_PACKET_PASSWORD);
  assert.ok(result.record.includes('A red-packet puzzle for human participants only'));
  assert.ok(result.record.includes('[05]'));
  assert.ok(result.record.includes('protocol violation'));
  assert.ok(result.record.includes('FINAL_DATA:'));
});

test('语义化混合答案组合仍能还原相同口令（Record 已与答案解耦）', async () => {
  const mixed = CONFIG.human.questions.map((question, index) => question.choices[index % 2].value);
  const result = await roundTrip(mixed);
  assert.equal(result.password, env.RED_PACKET_PASSWORD);
  // Record 不再随答案变化（已删 statements/canonical），两个组合得到同一份 record
  assert.deepEqual(result.record, (await roundTrip(allFirst)).record);
});
