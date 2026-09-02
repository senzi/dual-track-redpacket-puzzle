// ── Human Crypto：canonical answers / KDF / AES-256-GCM / Payload 构造 ──
// 参考 PRD §8.2 / §19 / §20。只为制造人类计算摩擦，使用标准 Web Crypto 原语。

import { deriveFragment } from './token.js';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

// ── canonicalAnswers：把答案数组序列化为确定性字符串 ──
// Q 号固定 / 稳定 choice value / UTF-8 / LF 分隔 / 固定末尾换行。
export function serializeCanonicalAnswers(answers) {
  if (!Array.isArray(answers)) throw new Error('answers must be array');
  const normalized = answers.map((a, i) => {
    const norm = String(a).trim().toUpperCase();
    if (!/^[A-Z0-9_-]{1,48}$/.test(norm)) throw new Error(`invalid answer at ${i}: ${a}`);
    return `Q${i + 1}:${norm}`;
  });
  // 末尾固定一个 LF（先验证，避免歧义）
  return normalized.join('\n') + '\n';
}

// ── PBKDF2-HMAC-SHA256 ──
export async function pbkdf2({ password, salt, iterations = 800000, length = 32 }) {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    textEncoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt: salt,
      iterations: iterations,
    },
    keyMaterial,
    length * 8
  );
  return new Uint8Array(bits);
}

// ── AES-256-GCM 加密（AEAD）──
export async function aesGcmEncrypt({ keyBytes, iv, aad, plaintext }) {
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'AES-GCM' },
    false,
    ['encrypt']
  );
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 },
    key,
    textEncoder.encode(plaintext)
  );
  return new Uint8Array(ct); // ciphertext || authTag
}

// ── AES-256-GCM 解密 ──
export async function aesGcmDecrypt({ keyBytes, iv, aad, ciphertext }) {
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'AES-GCM' },
    false,
    ['decrypt']
  );
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 },
    key,
    ciphertext
  );
  return textDecoder.decode(pt);
}

// ── 根据 Human 实际答案派生 fragments（服务端即时重算，确定性命中）──
export async function deriveHumanFragments(secret, { version, nonce, answers }) {
  const frags = [];
  for (let i = 0; i < answers.length; i++) {
    const frag = await deriveFragment(secret, {
      version,
      track: 'human',
      step: i + 1,
      answer: answers[i],
      nonce,
    });
    frags.push(frag);
  }
  return frags;
}

// ── Human Target 参数构造（真实值结合 fragment，符合 PRD §8.4 / §19 示例）──
// 返回 { passwordMaterial, salt, iterations, keyBytes, nonce, aad, ciphertext }
export async function buildHumanCryptoMaterial(secret, env, { answers, nonce }) {
  const version = env.CHALLENGE_VERSION;
  const fragments = await deriveHumanFragments(secret, { version, nonce, answers });

  const canonical = serializeCanonicalAnswers(answers);
  const passwordMaterial = canonical; // UTF8(canonicalAnswers)

  // Salt = fragment_2 || fragment_5 || fragment_8（参考 PRD 示例；按题序取片段拼 hex）
  const saltHex =
    (fragments[1] || '') + (fragments[4] || '') + (fragments[7] || '');
  const salt = hexToBytes(saltHex);

  // Iterations 走可配置（默认 800000，便于调试可降）
  const parsedIterations = Number.parseInt(String(env.HUMAN_ITERATIONS || '800000'), 10);
  if (!Number.isSafeInteger(parsedIterations) || parsedIterations < 10_000 || parsedIterations > 2_000_000) {
    throw new Error('invalid HUMAN_ITERATIONS');
  }
  const iterations = parsedIterations;

  const keyBytes = await pbkdf2({
    password: passwordMaterial,
    salt,
    iterations,
    length: 32,
  });

  // Nonce = SHA256(fragment_1 || fragment_4)[0:12]
  const nonceHash = await crypto.subtle.digest(
    'SHA-256',
    hexToBytes((fragments[0] || '') + (fragments[3] || ''))
  );
  const iv = new Uint8Array(nonceHash).slice(0, 12);

  const aad = textEncoder.encode(`redpacket:${version}`);
  return { fragments, salt, iterations, keyBytes, iv, aad, canonical };
}

export function hexToBytes(hex) {
  const clean = hex.length % 2 === 0 ? hex : '0' + hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

// base64 标准（带填充），用于展示最终 FINAL_DATA / outer payload
export function bytesToBase64(bytes) {
  const arr = new Uint8Array(bytes);
  let bin = '';
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin);
}

export function base64ToBytes(str) {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
