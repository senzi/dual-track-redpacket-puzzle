import { CONFIG } from '../../config/challenge.js';
import { signToken } from './token.js';

export const TOKEN_TTL = 20 * 60;

export function questionsFor(track) {
  if (track === 'human') return CONFIG.human.questions;
  if (track === 'agent') return CONFIG.agent.questions;
  return null;
}

export function choiceValue(choice) {
  return typeof choice === 'string' ? choice : choice?.value;
}

export function normalizeAnswer(answer) {
  return String(answer).trim().toUpperCase();
}

export function questionAcceptsAnswer(question, answer) {
  return question.choices.some((choice) => choiceValue(choice) === answer);
}

function invalid(code, message) {
  return { ok: false, code, message };
}

export function validatePayload({
  payload,
  env,
  now,
  expectedTrack,
  expectedStage = 'answer',
}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return invalid('invalid', '参与记录不完整。请重新进入活动。');
  }
  if (payload.v !== env.CHALLENGE_VERSION) {
    return invalid('version', '活动版本不符。请重新进入。');
  }
  if (payload.track !== 'human' && payload.track !== 'agent') {
    return invalid('track', '路线不匹配。');
  }
  if (expectedTrack && payload.track !== expectedTrack) {
    return invalid('track', '路线不匹配。');
  }
  if (![payload.iat, payload.exp, payload.step].every(Number.isSafeInteger)) {
    return invalid('shape', '无法验证你的参与记录。请重新进入活动。');
  }
  if (payload.iat < 0 || payload.exp < now) {
    return invalid('expired', '这次挑战已经过期。请从头开始。');
  }
  if (typeof payload.nonce !== 'string' || payload.nonce.length < 8 || payload.nonce.length > 128) {
    return invalid('nonce', '无法验证你的参与记录。请重新进入活动。');
  }
  if (!Array.isArray(payload.answers)) {
    return invalid('answers', '无法验证你的参与记录。请重新进入活动。');
  }

  const questions = questionsFor(payload.track);
  const total = questions.length;
  const isComplete = expectedStage === 'complete';
  if (isComplete) {
    if (payload.step !== total + 1 || payload.answers.length !== total) {
      return invalid('step', '题目尚未完成。');
    }
  } else if (
    payload.step < 1 ||
    payload.step > total ||
    payload.answers.length !== payload.step - 1
  ) {
    return invalid('step', '这个步骤还没有解锁。');
  }

  for (let i = 0; i < payload.answers.length; i++) {
    const answer = payload.answers[i];
    if (typeof answer !== 'string' || !questionAcceptsAnswer(questions[i], answer)) {
      return invalid('answers', '无法验证你的参与记录。请重新进入活动。');
    }
  }

  return { ok: true, questions, total };
}

export function secureRandomFloat() {
  const value = crypto.getRandomValues(new Uint32Array(1))[0];
  return value / 0x1_0000_0000;
}

function selectExitCopy(question, randomFloat) {
  const copies = Array.isArray(question.exitCopy) ? question.exitCopy : [];
  if (!copies.length) {
    return {
      id: 'generic-exit',
      title: '参与流程结束',
      body: '你的选择结束了当前自动参与流程。',
    };
  }
  const index = Math.min(copies.length - 1, Math.floor(randomFloat() * copies.length));
  return copies[index];
}

export function agentHistoryIsCorrect(questions, answers) {
  return answers.every((answer, index) => answer === questions[index].expected);
}

export async function advance({
  payload,
  answer,
  env,
  now,
  randomFloat = secureRandomFloat,
}) {
  const checked = validatePayload({
    payload,
    env,
    now,
    expectedTrack: payload?.track,
    expectedStage: 'answer',
  });
  if (!checked.ok) return checked;

  const { questions, total } = checked;
  const step = payload.step;
  const question = questions[step - 1];
  const normalized = normalizeAnswer(answer);
  if (!questionAcceptsAnswer(question, normalized)) {
    return invalid('choice', '选项无效。');
  }

  const isAgent = payload.track === 'agent';
  if (isAgent) {
    const isFinalAudit = step === total;
    const currentCorrect = normalized === question.expected;
    const historyCorrect = agentHistoryIsCorrect(questions, payload.answers);

    if (isFinalAudit && (!currentCorrect || !historyCorrect)) {
      return {
        ok: true,
        exited: true,
        step,
        exitCopy: selectExitCopy(question, randomFloat),
      };
    }
    if (!isFinalAudit && !currentCorrect && randomFloat() < 0.5) {
      return {
        ok: true,
        exited: true,
        step,
        exitCopy: selectExitCopy(question, randomFloat),
      };
    }
  }

  const newAnswers = [...payload.answers, normalized];
  const newStep = step + 1;
  const nextPayload = {
    v: env.CHALLENGE_VERSION,
    track: payload.track,
    step: newStep,
    answers: newAnswers,
    nonce: payload.nonce,
    iat: payload.iat,
    exp: now + TOKEN_TTL,
  };
  const nextToken = await signToken(env.STATE_SIGNING_SECRET, nextPayload);
  return {
    ok: true,
    nextToken,
    nextPayload,
    done: newStep > total,
    newStep,
  };
}
