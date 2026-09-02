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

const choices = (index) => CONFIG.human.questions[index].choices;
const allFirst = CONFIG.human.questions.map((question) => question.choices[0].value);

async function roundTrip(answers) {
  const material = await buildHumanCryptoMaterial(SECRET, env, { answers, nonce });
  const record = buildHumanParticipantRecord(env, answers);
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
  assert.match(result.record, /Q1 \/ SELF_CONFIRMED/);
  assert.match(result.record, /The participant stated that they were acting personally/);
});

test('语义化混合答案组合仍能还原相同口令并改变 Record', async () => {
  const mixed = CONFIG.human.questions.map((question, index) => question.choices[index % 2].value);
  const result = await roundTrip(mixed);
  assert.equal(result.password, env.RED_PACKET_PASSWORD);
  assert.match(result.record, new RegExp(choices(1)[1].recordText.replace(/[.*+?^$()|[\]\\]/g, '\\$&')));
  assert.notEqual(result.record, (await roundTrip(allFirst)).record);
});
