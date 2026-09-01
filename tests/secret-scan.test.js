// ── 机密泄漏扫描：口令/签名密钥不得出现在任何可交付源码或静态资源中 ──
// 对应 PRD §44 "grep / bundle scan"。部署后应对 dist/ 做同样扫描。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url))); // 项目根

function parseDevVars() {
  const txt = readFileSync(join(ROOT, '.dev.vars'), 'utf8');
  const m = {};
  for (const line of txt.split('\n')) {
    const s = line.trim();
    if (!s || s.startsWith('#') || !s.includes('=')) continue;
    const [k, ...rest] = s.split('=');
    m[k] = rest.join('=').trim();
  }
  return m;
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

test('口令与签名密钥不出现于 src/config/public（即任何交付源码/静态资源）', () => {
  const vars = parseDevVars();
  const secret = vars.RED_PACKET_PASSWORD;
  const signSecret = vars.STATE_SIGNING_SECRET;
  assert.ok(secret && signSecret, '测试值应存在于 .dev.vars');

  const dirs = ['src', 'config', 'public'].map((d) => join(ROOT, d));
  const files = dirs.flatMap((d) => walk(d));

  for (const f of files) {
    const content = readFileSync(f, 'utf8');
    assert.ok(
      !content.includes(secret),
      `红包口令泄漏到 ${relative(ROOT, f)}`
    );
    assert.ok(
      !content.includes(signSecret),
      `签名密钥泄漏到 ${relative(ROOT, f)}`
    );
  }
  assert.ok(files.length > 0, '应扫描到至少若干文件');
});

test('两份 secret 均只在 .dev.vars（且 .dev.vars 已被 gitignore）', () => {
  const gitignore = readFileSync(join(ROOT, '.gitignore'), 'utf8');
  assert.match(gitignore, /docs\//, 'docs 目录应被忽略');
  assert.match(gitignore, /\.dev\.vars/, '.dev.vars 应被忽略');
  const devVarsSet = new Set();
  const txt = readFileSync(join(ROOT, '.dev.vars'), 'utf8');
  for (const line of txt.split('\n')) {
    const s = line.trim();
    if (s && !s.startsWith('#') && s.includes('=')) devVarsSet.add(s.split('=')[0]);
  }
  assert.ok(devVarsSet.has('RED_PACKET_PASSWORD'));
  assert.ok(devVarsSet.has('STATE_SIGNING_SECRET'));
});

test('agent 题目配置不把 expected 下发（config 里 expected 从不下发给前端）', () => {
  // public 静态资源不应包含 "expected" 字段（PRD §29）
  const publicFiles = walk(join(ROOT, 'public'));
  for (const f of publicFiles) {
    const content = readFileSync(f, 'utf8');
    assert.ok(!content.includes('expected'), `前端 ${relative(ROOT, f)} 不应出现 expected`);
  }
});
