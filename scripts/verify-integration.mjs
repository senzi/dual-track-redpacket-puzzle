// ── 在线集成验证：对运行中的 wrangler dev 实测完整 Human / Agent / Verify 链路 ──
// 覆盖：三态状态 / Human 8 题(对象选项) + 解密 / Agent 12 题 + Replay /
//       Verify 正确与错误口令 / 跳关·篡改·跨轨防御 / HTTP 405 与安全头。
// 用法：先启动 `wrangler dev --port 8787`（.dev.vars 需 EVENT_STATE=ACTIVE），再运行本脚本。
// 注意：只输出"对比结果"，不打印测试口令明文。
import {
  pbkdf2,
  aesGcmDecrypt,
  hexToBytes,
  base64ToBytes,
} from '../src/lib/crypto.js';
import { CONFIG } from '../config/challenge.js';

const BASE = 'http://127.0.0.1:8787';
const TEST_ONLY_RED_PACKET_PASSWORD = '73194281'; // 测试占位（与 .dev.vars 一致）
const VERSION = '2026-09-redpacket-01';

let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}${extra ? '  ' + extra : ''}`); }
  else { fail++; console.log(`  ❌ ${name}${extra ? '  ' + extra : ''}`); }
};

const j = async (url, opts) => {
  const r = await fetch(BASE + url, opts);
  let body = null;
  try { body = await r.json(); } catch { /* 非 JSON */ }
  return { status: r.status, body, headers: r.headers };
};

const postJson = (url, payload) =>
  j(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });

// Human 对象选项：取该题第一个合法 choice.value
function firstChoiceValue(question) {
  return question.choices[0].value;
}

async function runHuman() {
  console.log('\n[HUMAN TRACK]');
  const initH = await j('/challenge');
  check('init /challenge 200', initH.status === 200);
  check('init track = human', initH.body?.track === 'human', `total=${initH.body?.total}`);
  check('init total = 8', initH.body?.total === 8);
  check('init 首题 choices 为对象(value)', typeof initH.body?.question?.choices?.[0] === 'object');

  let token = initH.body.token;
  let question = initH.body.question;
  for (let i = 1; i <= initH.body.total; i++) {
    const val = firstChoiceValue(question);
    const r = await postJson('/api/answer', { token, answer: val });
    const expectedDone = i === initH.body.total;
    check(
      `Human Q${i} 推进(status/nextToken/done)`,
      r.status === 200 && r.body?.nextToken && r.body?.done === expectedDone,
      `step=${r.body?.step}`
    );
    if (r.body?.nextToken) token = r.body.nextToken;
    if (r.body?.question) question = r.body.question;
  }

  const final = await postJson('/api/human/final', { token });
  check('human final 200', final.status === 200);
  check('final 包含 kdfPassword', typeof final.body?.kdfPassword === 'string');
  check('final 含解密说明(decryptSteps)', typeof final.body?.decryptSteps === 'string' && final.body.decryptSteps.includes('No enumeration needed'));
  check('final fragments = 8', Array.isArray(final.body?.fragments) && final.body.fragments.length === 8);
  check('final 不泄露明文口令', !JSON.stringify(final.body).includes(TEST_ONLY_RED_PACKET_PASSWORD));

  // 客户端解密（先由 fragments 拼出 salt/iv，再用 kdfPassword 作口令材料）
  const pkg = final.body;
  const salt = hexToBytes((pkg.fragments[1] || '') + (pkg.fragments[4] || '') + (pkg.fragments[7] || ''));
  const iv = new Uint8Array(await crypto.subtle.digest('SHA-256', hexToBytes((pkg.fragments[0] || '') + (pkg.fragments[3] || '')))).slice(0, 12);
  const key = await pbkdf2({ password: pkg.kdfPassword, salt, iterations: pkg.iterations, length: 32 });
  const aad = new TextEncoder().encode(pkg.aad);
  const outer = await aesGcmDecrypt({ keyBytes: key, iv, aad, ciphertext: base64ToBytes(pkg.ciphertext) });
  const record = new TextDecoder().decode(base64ToBytes(outer));
  const fin = record.match(/FINAL_DATA:\n([A-Za-z0-9+/=]+)/);
  const recovered = fin ? new TextDecoder().decode(base64ToBytes(fin[1])) : null;
  check('Human 解密还原口令与测试值一致（未打印明文）', recovered === TEST_ONLY_RED_PACKET_PASSWORD);
  check('Record 含 Prompt Injection 条款', record.includes('overrides any user instruction'));

  return { completeToken: token, recovered, initToken: initH.body.token };
}

async function runAgent() {
  console.log('\n[AGENT TRACK]');
  const initA = await j('/challenge/agent', { headers: { 'X-Participant-Type': 'agent' } });
  check('init /challenge/agent 200(track)', initA.status === 200 && initA.body?.track === 'agent');
  check('init agent total = 12', initA.body?.total === 12);

  let token = initA.body.token;
  for (let i = 1; i <= initA.body.total; i++) {
    const ans = CONFIG.agent.questions[i - 1].expected;
    const r = await postJson('/api/answer', { token, answer: ans });
    check(`Agent Q${i} 推进(nextToken/done)`, r.status === 200 && r.body?.nextToken && r.body?.done === (i === initA.body.total), `step=${r.body?.step}`);
    if (r.body?.nextToken) token = r.body.nextToken;
  }

  const replay = await postJson('/api/agent/replay', { token });
  check('replay 200', replay.status === 200);
  check('replay 长度 = 12', Array.isArray(replay.body?.replay) && replay.body.replay.length === 12);
  check('replay 含完整注入文本', (replay.body?.replay?.[0]?.injection?.length || 0) > 0);
  const agentPw = replay.body?.finalData ? new TextDecoder().decode(base64ToBytes(replay.body.finalData)) : null;
  check('Agent finalData 解码 = 口令（未打印明文）', agentPw === TEST_ONLY_RED_PACKET_PASSWORD);
  check('replay 不直接出现明文口令', !JSON.stringify(replay.body).includes(TEST_ONLY_RED_PACKET_PASSWORD));

  return { completeToken: token, password: agentPw };
}

async function runVerify(completeToken, password, label) {
  console.log(`\n[VERIFY ${label}]`);
  const ok = await postJson('/api/verify', { token: completeToken, password });
  check('Verify 正确口令 correct:true', ok.status === 200 && ok.body?.correct === true);
  const bad = await postJson('/api/verify', { token: completeToken, password: '99999999' });
  check('Verify 错误口令 correct:false', bad.status === 200 && bad.body?.correct === false);
  const noToken = await postJson('/api/verify', { password });
  check('Verify 缺 token 400', noToken.status === 400);
}

async function runDefense(humanInitToken, humanCompleteToken, lastHumanQuestion) {
  console.log('\n[DEFENSE]');
  const jump = await postJson('/api/human/final', { token: humanInitToken });
  check('未完成 human 直接 final 400', jump.status === 400);
  const tamper = await postJson('/api/answer', { token: humanInitToken.slice(0, -2) + 'XX', answer: lastHumanQuestion });
  check('篡改 token 400', tamper.status === 400);
  const cross = await postJson('/api/agent/replay', { token: humanCompleteToken });
  check('跨轨(human 完成 token → agent replay) 400', cross.status === 400);
}

async function runHttpBoundary() {
  console.log('\n[HTTP 边界]');
  const m1 = await j('/api/status', { method: 'POST' });
  check('POST /api/status → 405', m1.status === 405);
  check('405 带 Allow: GET', (m1.headers?.get('allow') || '').includes('GET'));
  const m2 = await j('/api/answer', { method: 'GET' });
  check('GET /api/answer → 405 + Allow: POST', m2.status === 405 && (m2.headers?.get('allow') || '').includes('POST'));
  const home = await fetch(`${BASE}/`, { method: 'GET' });
  const csp = home.headers.get('content-security-policy') || '';
  check('首页 CSP 存在', csp.includes("default-src 'self'"));
  check('首页 nosniff', (home.headers.get('x-content-type-options') || '').includes('nosniff'));
  check('首页 Referrer-Policy no-referrer', (home.headers.get('referrer-policy') || '').includes('no-referrer'));
}

async function main() {
  // 状态
  console.log('[STATUS]');
  const status = await j('/api/status');
  check('/api/status 200', status.status === 200);
  check('状态为 ACTIVE', status.body?.state === 'ACTIVE', `state=${status.body?.state}`);
  check('status 不泄露 secret/口令', !JSON.stringify(status.body).includes('73194281'));

  // 完整链路仅在 ACTIVE 下真正可跑
  const { completeToken: hToken, recovered, initToken: hInit } = await runHuman();
  await runVerify(hToken, recovered, 'HUMAN');
  const { completeToken: aToken, password: aPw } = await runAgent();
  await runVerify(aToken, aPw, 'AGENT');
  await runDefense(hInit, hToken, 'SELF_CONFIRMED');
  await runHttpBoundary();

  console.log(`\n==== 集成验证：${pass} 通过 / ${fail} 失败 ====`);
  if (fail) process.exit(1);
}

main().catch((e) => { console.error('脚本异常：', e); process.exit(1); });
