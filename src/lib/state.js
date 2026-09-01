// ── 状态机：纯函数判定 + 推进（可独立测试）──
// 参考 PRD §6 / §14 / §21 / §30。约定：token.step 为 1 起的当前题号；
// 答完最后一题 -> newStep = total+1 表示 complete。

import { CONFIG } from '../../config/challenge.js';
import { signToken } from './token.js';

export const TOKEN_TTL = 3600;

export function questionsFor(track) {
  return track === 'agent' ? CONFIG.agent.questions : CONFIG.human.questions;
}

// 校验并推进。返回：
//  { ok:false, code, message }                     —— 校验失败
//  { ok:true, exited:true, step }                  —— Agent 弱模式 B 答错（退出语义）
//  { ok:true, nextToken, nextPayload, done, newStep } —— 成功推进
export async function advance({ payload, answer, env, now }) {
  const version = env.CHALLENGE_VERSION;

  if (!payload) return { ok: false, code: 'invalid', message: '参与记录不完整。请重新进入活动。' };
  if (payload.exp < now) return { ok: false, code: 'expired', message: '这次挑战已经过期。请从头开始。' };
  if (payload.v !== version) return { ok: false, code: 'version', message: '活动版本不符。请重新进入。' };
  if (payload.track !== 'human' && payload.track !== 'agent')
    return { ok: false, code: 'track', message: '路线不匹配。' };

  const isAgent = payload.track === 'agent';
  const questions = questionsFor(payload.track);
  const total = questions.length;
  const step = payload.step;

  // 跳关 / 倒退防护：step 必须是 1..total 之间的当前题号（PRD §21）
  if (step < 1 || step > total) return { ok: false, code: 'step', message: '这个步骤还没有解锁。' };
  if (!Array.isArray(payload.answers) || payload.answers.length !== step - 1)
    return { ok: false, code: 'answers', message: '无法验证你的参与记录。请重新进入活动。' };

  const q = questions[step - 1];
  const norm = String(answer).trim().toUpperCase();
  if (!q.choices.includes(norm)) return { ok: false, code: 'choice', message: '选项无效。' };

  // Agent 弱模式 B：答错（非 expected）走退出语义，不显示 WRONG（PRD §30）
  if (isAgent && norm !== q.expected) {
    return { ok: true, exited: true, step };
  }

  const newAnswers = [...payload.answers, norm];
  const newStep = step + 1;
  const now2 = now;
  const nextPayload = {
    v: version,
    track: payload.track,
    step: newStep,
    answers: newAnswers,
    nonce: payload.nonce,
    iat: payload.iat, // 保留原签发时间，避免无限续期
    exp: now2 + TOKEN_TTL,
  };
  const nextToken = await signToken(env.STATE_SIGNING_SECRET, nextPayload);
  const done = newStep > total;
  return { ok: true, nextToken, nextPayload, done, newStep };
}
