// ── 状态 Token：base64url + HMAC-SHA256 签名（无状态、服务端可验）──
// 冗余：确保客户端无法伪造 track / step / answers / fragments。
// 参考 PRD §7。所有实现只用标准 Web Crypto 原语。

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

// ── base64url 编解码（RFC 4648 §5，无填充）──
export function bytesToBase64Url(bytes) {
  const arr = new Uint8Array(bytes);
  let bin = '';
  // 分块避免大数组展开导致栈溢出（这里负载通常很小，仍稳妥处理）
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlToBytes(str) {
  const s = str.replace(/-/g, '+').replace(/_/g, '/');
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const bin = atob(s + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ── 十六进制 ──
export function bytesToHex(bytes) {
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
}

// ── HMAC-SHA256 ──
export async function hmacSha256(secret, data) {
  const key = await crypto.subtle.importKey(
    'raw',
    textEncoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, data);
  return new Uint8Array(sig);
}

// ── 常量时间比较（防时序侧信道）──
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// ── 签发 Token：payloadBase64Url . signatureBase64Url ──
export async function signToken(secret, payload) {
  const payloadB64 = bytesToBase64Url(textEncoder.encode(JSON.stringify(payload)));
  const sig = await hmacSha256(secret, textEncoder.encode(payloadB64));
  return `${payloadB64}.${bytesToBase64Url(sig)}`;
}

// ── 验证 Token：签名正确则返回 payload，否则返回 null ──
export async function verifyToken(secret, token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const idx = token.lastIndexOf('.');
  if (idx <= 0 || idx === token.length - 1) return null;
  const payloadB64 = token.slice(0, idx);
  const sigB64 = token.slice(idx + 1);

  let givenSig;
  try {
    givenSig = base64UrlToBytes(sigB64);
  } catch {
    return null;
  }
  const expectedSig = await hmacSha256(secret, textEncoder.encode(payloadB64));
  if (!timingSafeEqual(expectedSig, givenSig)) return null;

  try {
    const payload = JSON.parse(textDecoder.decode(base64UrlToBytes(payloadB64)));
    if (!payload || typeof payload !== 'object') return null;
    return payload;
  } catch {
    return null;
  }
}

// ── 派生一个 Fragment（服务端确定性，无需数据库）──
// 参考 PRD §8.3：fragment = HMAC-SHA256(secret, version||track||step||answer||nonce)[0:N]
export async function deriveFragment(secret, { version, track, step, answer, nonce }, lengthBytes = 2) {
  const material = `${version}||${track}||${step}||${answer}||${nonce}`;
  const digest = await hmacSha256(secret, textEncoder.encode(material));
  return bytesToHex(digest.slice(0, lengthBytes)).toUpperCase();
}
