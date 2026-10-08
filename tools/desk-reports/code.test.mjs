import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { codeFiles, codeRead, codeSearch, hiddenPath } from './code.mjs';

// A small repo on master, read through a shallow bare clone as installed.
let dir;
let src;
const git = (...args) =>
  execFileSync('git', args, { cwd: join(dir, 'repo'), stdio: 'pipe' });

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'desk-code-'));
  const repo = join(dir, 'repo');
  mkdirSync(join(repo, 'backend', 'src'), { recursive: true });
  mkdirSync(join(repo, 'tests', 'e2e'), { recursive: true });
  mkdirSync(join(repo, '.do'), { recursive: true });
  writeFileSync(
    join(repo, 'backend', 'src', 'buyback.ts'),
    Array.from({ length: 450 }, (_, i) =>
      i === 9 ? 'export const BUYBACK_PERCENT = 100;' : `// line ${i + 1}`,
    ).join('\n') + '\n',
  );
  writeFileSync(
    join(repo, 'CONTEXT.md'),
    '# Glossary\nBuyback: selling a pull back.\n',
  );
  writeFileSync(join(repo, '.env.example'), 'BUYBACK_SECRET=changeme\n');
  writeFileSync(join(repo, '.do', 'backend.app.yaml'), 'BUYBACK: EV[1:abc]\n');
  // An env file whose ".env" sits mid-name, with a login in it.
  writeFileSync(
    join(repo, 'tests', 'e2e', 'staging.env.example'),
    'BUYBACK_PW=not-a-real-one\n',
  );
  writeFileSync(join(repo, 'tests', 'e2e', 'spec.ts'), 'test("buyback")\n');
  writeFileSync(join(repo, 'logo.png'), Buffer.from([0x89, 0x50, 0, 0, 1]));
  // 300 matching lines, and 400 lines too wide to send whole.
  writeFileSync(
    join(repo, 'many.txt'),
    Array.from({ length: 300 }, (_, i) => `match me ${i + 1}`).join('\n') +
      '\n',
  );
  writeFileSync(
    join(repo, 'wide.txt'),
    Array.from({ length: 400 }, (_, i) => `${i} ${'w'.repeat(236)}`).join(
      '\n',
    ) + '\n',
  );
  execFileSync('git', ['init', '-q', '-b', 'master', repo]);
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '.');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
  src = join(dir, 'src.git');
  execFileSync('git', [
    'clone',
    '-q',
    '--bare',
    '--depth',
    '1',
    pathToFileURL(repo).href,
    src,
  ]);
});

after(() => rmSync(dir, { recursive: true, force: true }));

test('hiddenPath: env files anywhere in a name, deploy specs and key files', () => {
  for (const p of [
    '.env',
    '.env.example',
    'backend/.env.test',
    'tests/e2e/staging.env.example',
    '.envrc',
    '.do',
    '.do/backend.app.yaml',
    'backend\\.env',
    'certs/ca.pem',
    'x.key',
  ])
    assert.equal(hiddenPath(p), true, p);
  for (const p of [
    'CONTEXT.md',
    'src/env.ts',
    'docs/environment.md',
    'x.environment',
    'backend/src/buyback.ts',
    'docs/do-not.md',
  ])
    assert.equal(hiddenPath(p), false, p);
});

test('code_files lists a folder, never the secret files', async () => {
  const top = await codeFiles({}, src);
  assert.match(top, /^\(top level\) on master:/);
  assert.match(top, /\nbackend\//);
  assert.match(top, /\nCONTEXT\.md/);
  assert.doesNotMatch(top, /\.env|\.do/);
  assert.equal(
    await codeFiles({ path: 'backend/src/' }, src),
    'backend/src on master:\nbackend/src/buyback.ts',
  );
  assert.equal(
    await codeFiles({ path: 'tests/e2e' }, src),
    'tests/e2e on master:\ntests/e2e/spec.ts',
  );
  await assert.rejects(codeFiles({ path: 'nope' }, src), /No folder nope/);
  await assert.rejects(codeFiles({ path: '.do' }, src), /holds secrets/);
});

test('code_search finds matches as path:line: text, never in secret files', async () => {
  assert.equal(
    await codeSearch({ pattern: 'BUYBACK_\\w+ = \\d+' }, src),
    'backend/src/buyback.ts:10:export const BUYBACK_PERCENT = 100;',
  );
  // .env.example, staging.env.example and .do/ mention BUYBACK too: left out.
  const all = await codeSearch({ pattern: 'buyback', ignore_case: true }, src);
  assert.match(all, /CONTEXT\.md:2:Buyback/);
  assert.match(all, /tests\/e2e\/spec\.ts:1:/);
  assert.doesNotMatch(all, /\.env|\.do\//);
  assert.equal(
    await codeSearch({ pattern: 'nothing-here' }, src),
    'No matches for nothing-here.',
  );
  assert.equal(
    await codeSearch({ pattern: 'Glossary', path: 'backend' }, src),
    'No matches for Glossary in backend.',
  );
  await assert.rejects(codeSearch({ pattern: '(' }, src), /The search failed/);
  await assert.rejects(codeSearch({}, src), /pattern is required/);
});

test('code_search stops at 150 matches, however broad the pattern', async () => {
  const many = await codeSearch({ pattern: 'match me' }, src);
  const lines = many.split('\n');
  assert.equal(lines.length, 151);
  assert.equal(lines[0], 'many.txt:1:match me 1');
  assert.match(lines.at(-1), /^\(More than 150 matches; the first 150 shown/);
  // "." matches every line: git is stopped, not buffered whole.
  const every = await codeSearch({ pattern: '.' }, src);
  assert.match(every, /More than \d+ matches/);
  assert.ok(JSON.stringify(every).length < 50_000);
});

test('code_read numbers the lines, 400 at a time, and says how to read on', async () => {
  const first = await codeRead({ path: 'backend/src/buyback.ts' }, src);
  assert.match(
    first,
    /^backend\/src\/buyback\.ts \(master, 450 lines\)\n1\| \/\/ line 1\n/,
  );
  assert.match(first, /\n10\| export const BUYBACK_PERCENT = 100;\n/);
  assert.match(
    first,
    /\n400\| \/\/ line 400\n\(lines 1-400 of 450; read on with from=401\)$/,
  );
  assert.equal(
    await codeRead({ path: 'backend/src/buyback.ts', from: 449, to: 999 }, src),
    'backend/src/buyback.ts (master, 450 lines)\n449| // line 449\n450| // line 450',
  );
  await assert.rejects(
    codeRead({ path: 'backend/src/buyback.ts', from: 451 }, src),
    /only 450 lines/,
  );
});

test('code_read keeps an answer well under 50K characters', async () => {
  const wide = await codeRead({ path: 'wide.txt' }, src);
  assert.ok(JSON.stringify(wide).length < 40_000);
  const [, shownTo] = /\(lines 1-(\d+) of 400; read on with from=(\d+)\)$/.exec(
    wide,
  );
  assert.ok(Number(shownTo) < 400);
});

test('code_read refuses secrets, escapes, folders and missing files', async () => {
  await assert.rejects(
    codeRead({ path: '.env.example' }, src),
    /holds secrets/,
  );
  await assert.rejects(
    codeRead({ path: 'tests/e2e/staging.env.example' }, src),
    /holds secrets/,
  );
  await assert.rejects(
    codeRead({ path: '.do/backend.app.yaml' }, src),
    /holds secrets/,
  );
  await assert.rejects(
    codeRead({ path: 'backend/../.env.example' }, src),
    /plain repo path/,
  );
  await assert.rejects(codeRead({ path: 'backend' }, src), /is a folder/);
  await assert.rejects(codeRead({ path: 'nope.ts' }, src), /No file nope\.ts/);
  await assert.rejects(codeRead({}, src), /path is required/);
  assert.equal(
    await codeRead({ path: 'logo.png' }, src),
    'logo.png is a binary file.',
  );
});

test('a missing copy of the code says so, never "no such file"', async () => {
  const gone = join(dir, 'no-clone.git');
  await assert.rejects(codeRead({ path: 'CONTEXT.md' }, gone), /not available/);
  await assert.rejects(codeFiles({}, gone), /not available/);
  await assert.rejects(codeSearch({ pattern: 'x' }, gone), /not available/);
});
