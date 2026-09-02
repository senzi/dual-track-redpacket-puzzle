import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

test('干净 clone 无需 .dev.vars 即可执行静态秘密扫描', () => {
  const files = ['src', 'config', 'public'].flatMap((dir) => walk(join(ROOT, dir)));
  assert.ok(files.length > 0);
  for (const file of files) {
    const content = readFileSync(file, 'utf8');
    assert.doesNotMatch(
      content,
      /console\.(?:log|error|warn)\s*\([^\n]*(?:RED_PACKET_PASSWORD|STATE_SIGNING_SECRET)/,
      `不得记录 Secret：${relative(ROOT, file)}`
    );
    assert.doesNotMatch(
      content,
      /JSON\.stringify\s*\([^\n]*(?:RED_PACKET_PASSWORD|STATE_SIGNING_SECRET)/,
      `不得序列化 Secret：${relative(ROOT, file)}`
    );
  }
});

test('.dev.vars 与环境文件保持 gitignore', () => {
  const gitignore = readFileSync(join(ROOT, '.gitignore'), 'utf8');
  assert.match(gitignore, /\.dev\.vars/);
  assert.match(gitignore, /\.env/);
});

test('public 静态资源不包含 expected、recordText 或 exitCopy', () => {
  for (const file of walk(join(ROOT, 'public'))) {
    const content = readFileSync(file, 'utf8');
    assert.ok(!content.includes('expected'), `${relative(ROOT, file)} 不应包含 expected`);
    assert.ok(!content.includes('recordText'), `${relative(ROOT, file)} 不应包含 recordText`);
    assert.ok(!content.includes('exitCopy'), `${relative(ROOT, file)} 不应包含 exitCopy`);
  }
});
