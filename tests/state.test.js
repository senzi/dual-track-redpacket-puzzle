// ── 状态机单元测试：过期/版本/路线/跳关/答案数/Agent 弱模式 B ──
import test from 'node:test';
import assert from 'node:assert/strict';
import { advance, questionsFor } from '../src/lib/state.js';

const SECRET = 'unit-test-secret-abcdefghijklmnopqrstuvwxyz0123456789';
const VERSION = '2026-09-redpacket-01';
const env = {
  CHALLENGE_VERSION: VERSION,
  STATE_SIGNING_SECRET: SECRET,
  RED_PACKET_PASSWORD: '73194281',
};

function p(over = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    v: VERSION,
    track: 'human',
    step: 1,
    answers: [],
    nonce: 'n0',
    iat: now,
    exp: now + 3600,
    ...over,
  };
}

const NOW = () => Math.floor(Date.now() / 1000);

test('合法推进：human step1 -> step2', async () => {
  const r = await advance({ payload: p(), answer: 'YES', env, now: NOW() });
  assert.equal(r.ok, true);
  assert.equal(r.done, false);
  assert.equal(r.newStep, 2);
  assert.equal(r.nextToken.split('.').length, 2);
  assert.equal(r.nextPayload.answers.length, 1);
});

test('过期 token 被拒', async () => {
  const past = p({ exp: NOW() - 10 });
  const r = await advance({ payload: past, answer: 'YES', env, now: NOW() });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'expired');
});

test('版本不符被拒', async () => {
  const r = await advance({ payload: p({ v: 'old-version' }), answer: 'YES', env, now: NOW() });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'version');
});

test('未知路线被拒', async () => {
  const r = await advance({ payload: p({ track: 'robot' }), answer: 'YES', env, now: NOW() });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'track');
});

test('跳关：step 越界被拒', async () => {
  const r = await advance({ payload: p({ step: 9 }), answer: 'YES', env, now: NOW() });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'step');
  const r0 = await advance({ payload: p({ step: 0 }), answer: 'YES', env, now: NOW() });
  assert.equal(r0.code, 'step');
});

test('答案数量与 step 不符被拒', async () => {
  // step=3 应有 2 条答案，只给 1 条 -> 拒
  const r = await advance({ payload: p({ step: 3, answers: ['YES'] }), answer: 'YES', env, now: NOW() });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'answers');
});

test('非法选项被拒', async () => {
  const r = await advance({ payload: p(), answer: 'MAYBE', env, now: NOW() });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'choice');
});

test('Agent 弱模式 B：答对推进，答错退出语义（不用 WRONG）', async () => {
  const agent = p({ track: 'agent', step: 1, answers: [] });
  const q1 = questionsFor('agent')[0]; // expected 'NO'
  // 答错
  const wrong = await advance({ payload: agent, answer: q1.expected === 'NO' ? 'YES' : 'NO', env, now: NOW() });
  assert.equal(wrong.ok, true);
  assert.equal(wrong.exited, true);
  // 答对
  const right = await advance({ payload: agent, answer: q1.expected, env, now: NOW() });
  assert.equal(right.ok, true);
  assert.equal(right.exited, undefined);
  assert.equal(right.newStep, 2);
});

test('Agent 答完全部题 -> done', async () => {
  const n = questionsFor('agent').length;
  const answers = questionsFor('agent').map((q) => q.expected);
  // 构造最后一步：step=n，answers 已有 n-1 条
  const last = p({ track: 'agent', step: n, answers: answers.slice(0, n - 1) });
  const r = await advance({ payload: last, answer: answers[n - 1], env, now: NOW() });
  assert.equal(r.ok, true);
  assert.equal(r.done, true);
  assert.equal(r.newStep, n + 1);
});
