import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// provision-key.mjs rewrites production secret files, so it only ever runs here
// as a child process against FAKE files under os.tmpdir(): a fake repo holding
// deploy/<env file> and a fake LOCALAPPDATA holding the desk profile's env
// file. The child's LOCALAPPDATA is forced to the fake dir (see run), so the
// real Hermes profile is never reachable from these tests.
const SCRIPT = fileURLToPath(new URL('./provision-key.mjs', import.meta.url));
const NAME = 'REPORT_KEY_FINANCE';
const OLD = 'a'.repeat(64);
const OTHER = `REPORT_KEY_STORE=${'s'.repeat(64)}`;
const ANY_KEY = /[0-9a-f]{64}/;

// content: string | Buffer, or null to leave that file missing.
function setup(t, deploy, profile, desk = 'finance') {
  const root = mkdtempSync(join(tmpdir(), 'provision-key-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'repo');
  const local = join(root, 'localappdata');
  const files = [
    join(repo, 'deploy', '.env.deploy'),
    join(local, 'hermes', 'profiles', `polycards-${desk}`, '.env'),
  ];
  [deploy, profile].forEach((content, i) => {
    mkdirSync(dirname(files[i]), { recursive: true });
    if (content !== null) writeFileSync(files[i], content);
  });
  return { root, repo, local, files, desk };
}

function run(fx, { localAppData = fx.local, execArgv = [], env = {} } = {}) {
  // Windows env names are case-insensitive, so drop EVERY spelling of
  // LOCALAPPDATA before adding the fake one, and check the child gets exactly
  // that one: a leaked real value would point the script at the real profile.
  const childEnv = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => key.toUpperCase() !== 'LOCALAPPDATA',
    ),
  );
  if (localAppData) childEnv.LOCALAPPDATA = localAppData;
  assert.deepEqual(
    Object.keys(childEnv).filter((key) => key.toUpperCase() === 'LOCALAPPDATA'),
    localAppData ? ['LOCALAPPDATA'] : [],
  );
  return spawnSync(process.execPath, [...execArgv, SCRIPT, fx.desk, fx.repo], {
    env: { ...childEnv, ...env },
    encoding: 'utf8',
    timeout: 30_000,
  });
}

const snapshot = (fx) =>
  fx.files.map((file) => (existsSync(file) ? readFileSync(file) : null));

function assertNoTempFiles(fx) {
  for (const file of fx.files) {
    assert.deepEqual(
      readdirSync(dirname(file)).filter((name) => name.includes('.tmp-')),
      [],
      `a temp file was left next to ${file}`,
    );
  }
}

// A refusal: non-zero exit, the reason on stderr, no key printed, no file
// changed and no temp file left behind.
function assertRefused(fx, res, before, reason) {
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, reason);
  assert.doesNotMatch(res.stdout + res.stderr, ANY_KEY);
  assert.deepEqual(snapshot(fx), before);
  assertNoTempFiles(fx);
}

test('appends one fresh 64-hex key to both files and prints no value', (t) => {
  const fx = setup(t, 'A=1\nB=2\n', 'X=1\nY=2\n');
  const res = run(fx);
  assert.equal(res.status, 0, res.stderr);
  const [deploy, profile] = fx.files.map((file) => readFileSync(file, 'utf8'));
  const key = new RegExp(`^${NAME}=([0-9a-f]{64})$`, 'm').exec(deploy)?.[1];
  assert.ok(key, 'the deploy file ends with a fresh 64-hex key line');
  assert.equal(deploy, `A=1\nB=2\n${NAME}=${key}\n`);
  assert.equal(profile, `X=1\nY=2\n${NAME}=${key}\n`);
  assert.equal(res.stdout, `${NAME} written to 2 files (value not shown).\n`);
  assert.ok(!res.stdout.includes(key) && !res.stderr.includes(key));
  assertNoTempFiles(fx);
});

test('provisions the developer desk, which reads every report', (t) => {
  const fx = setup(t, 'A=1\n', 'X=1\n', 'developer');
  const res = run(fx);
  assert.equal(res.status, 0, res.stderr);
  const [deploy, profile] = fx.files.map((file) => readFileSync(file, 'utf8'));
  const key = /^REPORT_KEY_DEVELOPER=([0-9a-f]{64})$/m.exec(deploy)?.[1];
  assert.ok(key, 'the deploy file ends with a fresh developer key line');
  assert.equal(profile, `X=1\nREPORT_KEY_DEVELOPER=${key}\n`);
});

test('replaces an existing key line instead of duplicating it', (t) => {
  const fx = setup(
    t,
    `A=1\n${NAME}=${OLD}\n${OTHER}\nB=2\n\n\n`,
    `${NAME}=${OLD}\nX=1\n${NAME}=${OLD}\n`,
  );
  const res = run(fx);
  assert.equal(res.status, 0, res.stderr);
  const [deploy, profile] = fx.files.map((file) => readFileSync(file, 'utf8'));
  const key = new RegExp(`^${NAME}=([0-9a-f]{64})$`, 'm').exec(deploy)?.[1];
  assert.ok(key && key !== OLD, 'a new key replaced the old one');
  // Other lines (another desk's key included) stay, in order; trailing blank
  // lines go; the new key is last.
  assert.equal(deploy, `A=1\n${OTHER}\nB=2\n${NAME}=${key}\n`);
  assert.equal(profile, `X=1\n${NAME}=${key}\n`);
});

test('keeps the line endings each file already uses', (t) => {
  const fx = setup(t, 'A=1\r\nB=2\r\n', 'X=1\nY=2\n');
  const res = run(fx);
  assert.equal(res.status, 0, res.stderr);
  const [deploy, profile] = fx.files.map((file) => readFileSync(file, 'utf8'));
  const key = new RegExp(`^${NAME}=([0-9a-f]{64})\\r$`, 'm').exec(deploy)?.[1];
  assert.ok(key, 'the CRLF file got a CRLF key line');
  assert.equal(deploy, `A=1\r\nB=2\r\n${NAME}=${key}\r\n`);
  assert.equal(profile, `X=1\nY=2\n${NAME}=${key}\n`);
});

// Whichever file is bad, NEITHER may be written: the check is over both files
// before the first write, not per file. UTF-16LE without a BOM decodes as
// valid UTF-8 full of NULs (only the NUL check catches it); a lone 0xE9 decodes
// to U+FFFD. The canary must never be echoed back.
const NOT_UTF8 = [
  ['UTF-16', Buffer.from('A=1\nB=2\n', 'utf16le')],
  [
    'invalid UTF-8',
    Buffer.concat([Buffer.from('CANARY=zz9\n'), Buffer.from([0xe9, 0x0a])]),
  ],
];
for (const [label, bad] of NOT_UTF8) {
  for (const [index, which] of ['deploy', 'profile'].entries()) {
    test(`refuses a ${label} ${which} file and writes neither file`, (t) => {
      const good = 'A=1\nB=2\n';
      const fx = setup(t, index === 0 ? bad : good, index === 1 ? bad : good);
      const before = snapshot(fx);
      const res = run(fx);
      assertRefused(fx, res, before, /not UTF-8/);
      assert.ok(res.stderr.includes(fx.files[index]), 'names the bad file');
      assert.doesNotMatch(res.stdout + res.stderr, /zz9/);
    });
  }
}

for (const [index, which] of ['deploy', 'profile'].entries()) {
  test(`refuses a missing ${which} file before writing anything`, (t) => {
    const fx = setup(
      t,
      index === 0 ? null : 'A=1\n',
      index === 1 ? null : 'X=1\n',
    );
    const before = snapshot(fx);
    assertRefused(fx, run(fx), before, /missing/);
  });
}

test('says LOCALAPPDATA is unset instead of throwing a TypeError', (t) => {
  const fx = setup(t, 'A=1\n', 'X=1\n');
  const before = snapshot(fx);
  const res = run(fx, { localAppData: null });
  assertRefused(fx, res, before, /LOCALAPPDATA is not set/);
  assert.doesNotMatch(res.stderr, /TypeError/);
});

// A preload that makes one fs call fail for the PROFILE file, as a rename does
// on Windows while another process holds the target open.
const FAIL_PRELOAD = `
const fs = require('node:fs');
const op = process.env.FAIL_OP;
const real = fs[op];
fs[op] = (...args) => {
  const target = String(op === 'renameSync' ? args[1] : args[0]);
  if (target.startsWith(process.env.FAIL_FILE)) {
    throw Object.assign(new Error('EPERM: simulated'), { code: 'EPERM' });
  }
  return real(...args);
};
require('node:module').syncBuiltinESMExports();
`;

for (const [op, stage] of [
  ['writeFileSync', 'staging'],
  ['renameSync', 'swapping in'],
]) {
  test(`a failure while ${stage} the profile file cleans up and says to run again`, (t) => {
    const fx = setup(t, 'A=1\n', 'X=1\n');
    const before = snapshot(fx);
    const preload = join(fx.root, 'fail.cjs');
    writeFileSync(preload, FAIL_PRELOAD);
    const res = run(fx, {
      execArgv: ['--require', preload],
      env: { FAIL_OP: op, FAIL_FILE: fx.files[1] },
    });
    assert.notEqual(res.status, 0);
    assert.ok(res.stderr.includes(fx.files[1]), 'names the file that failed');
    assert.match(res.stderr, /run this script again/i);
    assert.match(res.stderr, /rotates both/);
    assert.doesNotMatch(res.stdout + res.stderr, ANY_KEY);
    assertNoTempFiles(fx);
    const after = snapshot(fx);
    assert.deepEqual(after[1], before[1], 'the failed file is untouched');
    if (op === 'writeFileSync') {
      // Both new files are staged before either is swapped in, so a staging
      // failure changes nothing at all.
      assert.deepEqual(after[0], before[0]);
    } else {
      // Only a failure between the two swaps can leave the keys different.
      assert.match(
        after[0].toString(),
        new RegExp(`^A=1\\n${NAME}=[0-9a-f]{64}\\n$`),
      );
    }
  });
}
