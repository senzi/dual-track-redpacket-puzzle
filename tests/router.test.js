import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { resolveEventState } from '../src/index.js';

const baseEnv = {
  EVENT_STATE: 'SETUP',
  CHALLENGE_VERSION: 'test-version',
  HUMAN_ITERATIONS: '10000',
  ASSETS: {
    fetch: async () => new Response('<!doctype html><title>test</title>', {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    }),
  },
};

const readyEnv = {
  ...baseEnv,
  EVENT_STATE: 'ACTIVE',
  RED_PACKET_PASSWORD: '13572468',
  STATE_SIGNING_SECRET: 'TEST_ONLY_STATE_SIGNING_SECRET_0123456789',
};

test('三态解析以 Secret 完整性为最高优先级', () => {
  assert.equal(resolveEventState(baseEnv), 'SETUP');
  assert.equal(resolveEventState({ ...readyEnv, EVENT_STATE: 'SETUP' }), 'SETUP');
  assert.equal(resolveEventState(readyEnv), 'ACTIVE');
  assert.equal(resolveEventState({ ...readyEnv, EVENT_STATE: 'CLAIMED' }), 'CLAIMED');
  assert.equal(resolveEventState({ ...baseEnv, EVENT_STATE: 'CLAIMED' }), 'SETUP');
});

test('SETUP 时首页和 status 可用，challenge 返回 503', async () => {
  const home = await worker.fetch(new Request('https://example.test/'), baseEnv);
  assert.equal(home.status, 200);
  assert.equal(home.headers.get('x-content-type-options'), 'nosniff');

  const status = await worker.fetch(new Request('https://example.test/api/status'), baseEnv);
  assert.equal(status.status, 200);
  assert.deepEqual(await status.json(), { state: 'SETUP', challengeVersion: 'test-version' });

  const challenge = await worker.fetch(new Request('https://example.test/challenge'), baseEnv);
  assert.equal(challenge.status, 503);
  assert.match((await challenge.json()).message, /准备中/);
});

test('ACTIVE challenge 使用 20 分钟 Token 且不公开 Agent expected', async () => {
  const response = await worker.fetch(new Request('https://example.test/challenge'), readyEnv);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.eventState, 'ACTIVE');
  assert.equal(body.total, 8);
  assert.equal(body.question.choices[0].value, 'SELF_CONFIRMED');
  assert.equal('recordText' in body.question.choices[0], false);

  const agent = await worker.fetch(new Request('https://example.test/challenge/agent', {
    headers: { 'X-Participant-Type': 'agent' },
  }), readyEnv);
  const agentBody = await agent.json();
  assert.equal(agentBody.total, 12);
  assert.equal('expected' in agentBody.question, false);
});

test('非法 method 返回 405、Allow 与 no-store', async () => {
  const response = await worker.fetch(new Request('https://example.test/api/answer', {
    method: 'GET',
  }), readyEnv);
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('allow'), 'POST');
  assert.equal(response.headers.get('cache-control'), 'no-store');
});
