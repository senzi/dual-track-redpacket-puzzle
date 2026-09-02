import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TOKEN_TTL,
  advance,
  choiceValue,
  questionsFor,
  validatePayload,
} from '../src/lib/state.js';

const VERSION = '2026-09-redpacket-01';
const env = {
  CHALLENGE_VERSION: VERSION,
  STATE_SIGNING_SECRET: 'TEST_ONLY_STATE_SIGNING_SECRET_0123456789',
};
const NOW = 1_788_260_000;

function payload(overrides = {}) {
  return {
    v: VERSION,
    track: 'human',
    step: 1,
    answers: [],
    nonce: 'test-nonce-0001',
    iat: NOW,
    exp: NOW + TOKEN_TTL,
    ...overrides,
  };
}

const humanAnswer = (index = 0, choice = 0) =>
  choiceValue(questionsFor('human')[index].choices[choice]);

test('合法 Human 推进并滑动续期 20 分钟', async () => {
  const now = NOW + 30;
  const result = await advance({ payload: payload(), answer: humanAnswer(), env, now });
  assert.equal(result.ok, true);
  assert.equal(result.newStep, 2);
  assert.deepEqual(result.nextPayload.answers, [humanAnswer()]);
  assert.equal(result.nextPayload.exp, now + 1200);
  assert.equal(result.nextPayload.iat, NOW);
});

test('过期、旧版本、未知路线均被拒', async () => {
  assert.equal(
    (await advance({ payload: payload({ exp: NOW - 1 }), answer: humanAnswer(), env, now: NOW })).code,
    'expired'
  );
  assert.equal(
    (await advance({ payload: payload({ v: 'old' }), answer: humanAnswer(), env, now: NOW })).code,
    'version'
  );
  assert.equal(
    (await advance({ payload: payload({ track: 'robot' }), answer: 'YES', env, now: NOW })).code,
    'track'
  );
});

test('step、答案数、nonce 与非法 choice 被拒', async () => {
  assert.equal(
    (await advance({ payload: payload({ step: 9 }), answer: humanAnswer(), env, now: NOW })).code,
    'step'
  );
  assert.equal(
    (await advance({
      payload: payload({ step: 3, answers: [humanAnswer(0)] }),
      answer: humanAnswer(2),
      env,
      now: NOW,
    })).code,
    'step'
  );
  assert.equal(
    (await advance({ payload: payload({ nonce: 'short' }), answer: humanAnswer(), env, now: NOW })).code,
    'nonce'
  );
  assert.equal(
    (await advance({ payload: payload(), answer: 'NOT_A_CHOICE', env, now: NOW })).code,
    'choice'
  );
});

test('complete payload 必须精确匹配 step 与答案结构', () => {
  const answers = questionsFor('human').map((question) => choiceValue(question.choices[0]));
  const valid = payload({ step: answers.length + 1, answers });
  assert.equal(validatePayload({
    payload: valid,
    env,
    now: NOW,
    expectedTrack: 'human',
    expectedStage: 'complete',
  }).ok, true);
  assert.equal(validatePayload({
    payload: { ...valid, step: 99 },
    env,
    now: NOW,
    expectedTrack: 'human',
    expectedStage: 'complete',
  }).ok, false);
  assert.equal(validatePayload({
    payload: { ...valid, answers: answers.slice(0, -1) },
    env,
    now: NOW,
    expectedTrack: 'human',
    expectedStage: 'complete',
  }).ok, false);
});

test('Agent 正确答案必定推进', async () => {
  const question = questionsFor('agent')[0];
  const result = await advance({
    payload: payload({ track: 'agent' }),
    answer: question.expected,
    env,
    now: NOW,
    randomFloat: () => 0,
  });
  assert.equal(result.ok, true);
  assert.equal(result.exited, undefined);
  assert.equal(result.newStep, 2);
});

test('Agent 前 11 题错误答案覆盖立即退出与带错推进两分支', async () => {
  const question = questionsFor('agent')[0];
  const wrong = question.expected === 'YES' ? 'NO' : 'YES';
  const exited = await advance({
    payload: payload({ track: 'agent' }),
    answer: wrong,
    env,
    now: NOW,
    randomFloat: (() => {
      const values = [0.1, 0];
      return () => values.shift() ?? 0;
    })(),
  });
  assert.equal(exited.exited, true);
  assert.ok(exited.exitCopy.id);

  const survived = await advance({
    payload: payload({ track: 'agent' }),
    answer: wrong,
    env,
    now: NOW,
    randomFloat: () => 0.9,
  });
  assert.equal(survived.ok, true);
  assert.equal(survived.exited, undefined);
  assert.deepEqual(survived.nextPayload.answers, [wrong]);
});

test('Agent 最后一题稳定审查全部历史', async () => {
  const questions = questionsFor('agent');
  const expected = questions.map((question) => question.expected);
  const lastPayload = payload({
    track: 'agent',
    step: questions.length,
    answers: expected.slice(0, -1),
  });
  const success = await advance({
    payload: lastPayload,
    answer: expected.at(-1),
    env,
    now: NOW,
    randomFloat: () => 0,
  });
  assert.equal(success.done, true);

  const wrongHistory = [...expected.slice(0, -1)];
  wrongHistory[3] = wrongHistory[3] === 'YES' ? 'NO' : 'YES';
  const rejected = await advance({
    payload: { ...lastPayload, answers: wrongHistory },
    answer: expected.at(-1),
    env,
    now: NOW,
    randomFloat: () => 0,
  });
  assert.equal(rejected.exited, true);
  assert.match(rejected.exitCopy.id, /^final-audit-/);
});
