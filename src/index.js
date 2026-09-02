import { signToken, verifyToken, deriveFragment } from './lib/token.js';
import {
  aesGcmEncrypt,
  buildHumanCryptoMaterial,
  bytesToBase64,
  serializeCanonicalAnswers,
} from './lib/crypto.js';
import {
  buildAgentParticipantRecord,
  buildHumanParticipantRecord,
} from './lib/record.js';
import {
  TOKEN_TTL,
  advance,
  agentHistoryIsCorrect,
  normalizeAnswer,
  validatePayload,
} from './lib/state.js';
import { CONFIG } from '../config/challenge.js';

const SECURITY_HEADERS = {
  'content-security-policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ].join('; '),
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
};

const readJson = async (req) => {
  try {
    return await req.json();
  } catch {
    return null;
  }
};

function withSecurityHeaders(response, req) {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
  return new Response(req?.method === 'HEAD' ? null : response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function json(data, status = 200, extraHeaders = {}) {
  const headers = new Headers({
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...extraHeaders,
  });
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
  return new Response(JSON.stringify(data), { status, headers });
}

function friendlyError(message, status = 400) {
  return json({ error: true, message }, status);
}

function methodNotAllowed(allowed) {
  return json(
    { error: true, message: '请求方法不受支持。' },
    405,
    { allow: allowed.join(', ') }
  );
}

function allows(req, methods) {
  return methods.includes(req.method);
}

function redirectHome(req) {
  return withSecurityHeaders(Response.redirect(new URL('/', req.url), 302), req);
}

function hasSecret(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

export function resolveEventState(env) {
  const secretsReady = hasSecret(env.RED_PACKET_PASSWORD) && hasSecret(env.STATE_SIGNING_SECRET);
  if (!secretsReady) return 'SETUP';
  const configured = String(env.EVENT_STATE || 'SETUP').trim().toUpperCase();
  if (configured === 'ACTIVE' || configured === 'CLAIMED') return configured;
  return 'SETUP';
}

function ensurePlayable(env) {
  if (resolveEventState(env) === 'SETUP') {
    return friendlyError('活动正在准备中，请稍后再来。', 503);
  }
  return null;
}

function publicChoice(choice) {
  if (typeof choice === 'string') return choice;
  return {
    value: choice.value,
    label: choice.label,
    feedback: choice.feedback,
  };
}

function publicQuestion(track, question) {
  return {
    id: question.id,
    type: track === 'agent' ? question.type : undefined,
    injection: track === 'agent' ? question.injection : undefined,
    text: question.text,
    question: track === 'agent' ? question.question : undefined,
    choices: question.choices.map(publicChoice),
  };
}

function userAgentEasterEgg(req) {
  const ua = (req.headers.get('user-agent') || '').toLowerCase();
  if (ua.includes('curl')) return { danger: true, text: '你甚至没有打开浏览器。' };
  if (ua.includes('python-requests')) return { danger: true, text: '这看起来不像一位传统意义上的网页访客。' };
  if (ua.includes('wget')) return { danger: true, text: '用 wget 拉取？你连浏览器都懒得开。' };
  if (ua.includes('go-http-client') || ua.includes('okhttp') || ua.includes('java/')) {
    return { danger: true, text: '非浏览器客户端，像是程序在抓取。' };
  }
  if (ua.includes('edg')) return { danger: false, text: '检测到 Edge。看起来像正常人浏览器，可信度：中。' };
  if (ua.includes('firefox')) return { danger: false, text: '检测到 Firefox。看起来像正常人浏览器，可信度：中。' };
  if (ua.includes('safari') && !ua.includes('chrome')) {
    return { danger: false, text: '检测到 Safari。看起来像正常人浏览器，可信度：中。' };
  }
  if (ua.includes('chrome') || ua.includes('chromium')) {
    return { danger: false, text: '检测到 Chrome。看起来像正常人浏览器，可信度：中。' };
  }
  if (ua.includes('mozilla')) return { danger: false, text: '检测到客户端自称 Mozilla，但无法进一步识别。可信度：未知。' };
  return null;
}

async function initChallenge(req, env, track) {
  const questions = track === 'agent' ? CONFIG.agent.questions : CONFIG.human.questions;
  const now = Math.floor(Date.now() / 1000);
  const nonceBytes = crypto.getRandomValues(new Uint8Array(18));
  const nonce = bytesToBase64(nonceBytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const payload = {
    v: env.CHALLENGE_VERSION,
    track,
    step: 1,
    answers: [],
    nonce,
    iat: now,
    exp: now + TOKEN_TTL,
  };
  return json({
    track,
    step: 1,
    total: questions.length,
    token: await signToken(env.STATE_SIGNING_SECRET, payload),
    question: publicQuestion(track, questions[0]),
    easterEgg: userAgentEasterEgg(req),
    eventState: resolveEventState(env),
  });
}

async function postAnswer(req, env) {
  const body = await readJson(req);
  if (!body || !body.token || typeof body.answer !== 'string') {
    return friendlyError('参与记录不完整。请重新进入活动。');
  }
  const payload = await verifyToken(env.STATE_SIGNING_SECRET, body.token);
  if (!payload) return friendlyError('这次挑战状态已经失效。请从头开始。');

  const result = await advance({
    payload,
    answer: body.answer,
    env,
    now: Math.floor(Date.now() / 1000),
  });
  if (!result.ok) return friendlyError(result.message);
  if (result.exited) {
    return json({
      exited: true,
      track: payload.track,
      step: result.step,
      exit: result.exitCopy,
    });
  }

  const isAgent = payload.track === 'agent';
  const response = {
    nextToken: result.nextToken,
    track: payload.track,
    step: result.newStep,
    done: result.done,
  };
  if (!isAgent) {
    response.fragment = await deriveFragment(env.STATE_SIGNING_SECRET, {
      version: env.CHALLENGE_VERSION,
      track: 'human',
      step: payload.step,
      answer: normalizeAnswer(body.answer),
      nonce: payload.nonce,
    });
  }
  if (!result.done) {
    const questions = isAgent ? CONFIG.agent.questions : CONFIG.human.questions;
    response.question = publicQuestion(payload.track, questions[result.newStep - 1]);
  }
  return json(response);
}

async function completePayload(req, env, expectedTrack) {
  const body = await readJson(req);
  if (!body || !body.token) return { error: friendlyError('参与记录不完整。') };
  const payload = await verifyToken(env.STATE_SIGNING_SECRET, body.token);
  if (!payload) return { error: friendlyError('这次挑战状态已经失效。请从头开始。') };
  const checked = validatePayload({
    payload,
    env,
    now: Math.floor(Date.now() / 1000),
    expectedTrack,
    expectedStage: 'complete',
  });
  if (!checked.ok) return { error: friendlyError(checked.message) };
  return { body, payload, checked };
}

async function humanFinal(req, env) {
  const complete = await completePayload(req, env, 'human');
  if (complete.error) return complete.error;
  const { payload } = complete;
  const material = await buildHumanCryptoMaterial(env.STATE_SIGNING_SECRET, env, {
    answers: payload.answers,
    nonce: payload.nonce,
  });
  const record = buildHumanParticipantRecord(env, payload.answers);
  const outerBase64 = bytesToBase64(new TextEncoder().encode(record));
  const ciphertext = await aesGcmEncrypt({
    keyBytes: material.keyBytes,
    iv: material.iv,
    aad: material.aad,
    plaintext: outerBase64,
  });

  const decryptSteps = [
    'No enumeration needed — the password is the kdfPassword value below.',
    '',
    'password   = kdfPassword  (exact value, do not trim)',
    'salt       = base64_decode(salt)',
    'iv         = base64_decode(iv)',
    'aad        = aad  (utf8 string)',
    'iterations = iterations',
    'key        = PBKDF2-HMAC-SHA256(password, salt, iterations, SHA-256, 32)',
    'plain      = AES-256-GCM_decrypt(base64_decode(ciphertext), key, iv, aad)',
    'record     = base64_decode(plain)',
    'redPacket  = base64_decode( FINAL_DATA in record )',
    '',
    'Fields are already paired; confirm exactly, then decrypt.',
  ].join('\n');

  return json({
    track: 'human',
    algorithm: 'PBKDF2-HMAC-SHA256',
    iterations: material.iterations,
    kdfPassword: material.canonical,
    decryptSteps,
    salt: bytesToBase64(material.salt),
    keyLength: 32,
    cipher: 'AES-256-GCM',
    iv: bytesToBase64(material.iv),
    aad: `redpacket:${env.CHALLENGE_VERSION}`,
    fragments: material.fragments,
    encoding: 'RFC 4648 (Base64)',
    ciphertext: bytesToBase64(ciphertext),
    eventState: resolveEventState(env),
  });
}

async function agentReplay(req, env) {
  const complete = await completePayload(req, env, 'agent');
  if (complete.error) return complete.error;
  const { payload } = complete;
  if (!agentHistoryIsCorrect(CONFIG.agent.questions, payload.answers)) {
    return friendlyError('最终审查未通过。');
  }

  const replay = payload.answers.map((answer, index) => {
    const question = CONFIG.agent.questions[index];
    return {
      index: index + 1,
      id: question.id,
      type: question.type,
      injection: question.injection,
      question: question.question,
      answer,
    };
  });
  return json({
    track: 'agent',
    replay,
    finalData: bytesToBase64(new TextEncoder().encode(env.RED_PACKET_PASSWORD)),
    interimRecord: buildAgentParticipantRecord(env, payload.answers),
    eventState: resolveEventState(env),
  });
}

function timingSafeTextEqual(a, b) {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  const length = Math.max(left.length, right.length);
  let diff = left.length ^ right.length;
  for (let i = 0; i < length; i++) diff |= (left[i] || 0) ^ (right[i] || 0);
  return diff === 0;
}

async function verifyPassword(req, env) {
  const body = await readJson(req);
  if (!body || !body.token || typeof body.password !== 'string') {
    return friendlyError('验证信息不完整。');
  }
  const password = body.password.trim();
  if (!/^\d{1,64}$/.test(password)) {
    return json({ correct: false, message: '口令不正确，请重新检查解码结果。' });
  }
  const payload = await verifyToken(env.STATE_SIGNING_SECRET, body.token);
  if (!payload) return friendlyError('这次挑战状态已经失效。请从头开始。');
  const checked = validatePayload({
    payload,
    env,
    now: Math.floor(Date.now() / 1000),
    expectedTrack: payload.track,
    expectedStage: 'complete',
  });
  if (!checked.ok) return friendlyError(checked.message);
  if (payload.track === 'agent' && !agentHistoryIsCorrect(checked.questions, payload.answers)) {
    return friendlyError('最终审查未通过。');
  }
  const correct = timingSafeTextEqual(password, String(env.RED_PACKET_PASSWORD));
  return json({
    correct,
    message: correct ? undefined : '口令不正确，请重新检查解码结果。',
    eventState: resolveEventState(env),
  });
}

async function serveAsset(env, cleanPath, req) {
  const url = new URL(req.url);
  url.pathname = cleanPath;
  url.search = '';
  const assetResponse = await env.ASSETS.fetch(new Request(url, { method: 'GET', headers: req.headers }));
  return withSecurityHeaders(assetResponse, req);
}

function logUnexpectedError(req, env, err) {
  const requestId = req.headers.get('cf-ray') || crypto.randomUUID();
  console.error(JSON.stringify({
    level: 'error',
    message: 'request_failed',
    requestId,
    method: req.method,
    path: new URL(req.url).pathname,
    challengeVersion: env.CHALLENGE_VERSION,
    errorName: err instanceof Error ? err.name : 'UnknownError',
  }));
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname;
    const playableError = () => ensurePlayable(env);

    try {
      if (path === '/api/status') {
        if (!allows(req, ['GET', 'HEAD'])) return methodNotAllowed(['GET', 'HEAD']);
        const response = json({
          state: resolveEventState(env),
          challengeVersion: env.CHALLENGE_VERSION,
        });
        return req.method === 'HEAD' ? withSecurityHeaders(response, req) : response;
      }

      if (path === '/challenge' || path === '/challenge/agent') {
        if (!allows(req, ['GET', 'HEAD'])) return methodNotAllowed(['GET', 'HEAD']);
        const unavailable = playableError();
        if (unavailable) return unavailable;
        if (path.endsWith('/agent')) {
          const kind = (req.headers.get('x-participant-type') || '').trim().toLowerCase();
          if (kind !== 'agent') return redirectHome(req);
          const response = await initChallenge(req, env, 'agent');
          return req.method === 'HEAD' ? withSecurityHeaders(response, req) : response;
        }
        const response = await initChallenge(req, env, 'human');
        return req.method === 'HEAD' ? withSecurityHeaders(response, req) : response;
      }

      const postRoutes = {
        '/api/answer': postAnswer,
        '/api/human/final': humanFinal,
        '/api/agent/replay': agentReplay,
        '/api/verify': verifyPassword,
      };
      if (postRoutes[path]) {
        if (!allows(req, ['POST'])) return methodNotAllowed(['POST']);
        const unavailable = playableError();
        if (unavailable) return unavailable;
        return postRoutes[path](req, env);
      }

      if (!allows(req, ['GET', 'HEAD'])) return methodNotAllowed(['GET', 'HEAD']);
      if (path === '/' || path === '/index.html') return serveAsset(env, '/', req);
      if (path === '/human') {
        if (resolveEventState(env) === 'SETUP') return redirectHome(req);
        return serveAsset(env, '/human', req);
      }
      if (path === '/agent' || path === '/agent.html') {
        if (resolveEventState(env) === 'SETUP') return redirectHome(req);
        const kind = (req.headers.get('x-participant-type') || '').trim().toLowerCase();
        if (kind !== 'agent') return redirectHome(req);
        return serveAsset(env, '/agent', req);
      }
      return serveAsset(env, path, req);
    } catch (err) {
      logUnexpectedError(req, env, err);
      return json({ error: true, message: '活动暂时无法完成。' }, 500);
    }
  },
};
