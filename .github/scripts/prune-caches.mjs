#!/usr/bin/env node
// Deletes CodeQL overlay-base caches that no run can restore any more.
//
// CodeQL default setup saves a ~360 MB database on every master push, keyed
// `<prefix><sha>-<run>-<attempt>`, and restores by `<prefix>` alone
// (github/codeql-action src/overlay/caching.ts, getCacheSaveKey and
// getCacheRestoreKeyPrefix). A prefix restore returns the most recently
// CREATED match, so only the newest entry per prefix is ever used; the rest
// only fill the 10 GB cap until GitHub's LRU eviction drops the yarn and
// node_modules caches instead. So this keeps the newest per (ref, prefix), by
// createdAt (lastAccessedAt is not what restore picks by), and deletes the rest.
//
// Only keys that start with `codeql-overlay-base-` and end in
// `-<sha>-<run>-<attempt>` are touched; every other cache is left alone.
//
//   node .github/scripts/prune-caches.mjs           dry run: print what would go
//   node .github/scripts/prune-caches.mjs --apply   delete (CI only)
//   node .github/scripts/prune-caches.mjs --test    built-in self-check
//
// Needs `gh` with GH_TOKEN (actions: write to delete) and GH_REPO in CI.

import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';

const PREFIX = 'codeql-overlay-base-';
// The prefix CodeQL restores by ends in `<codeql version>-`, so each CLI
// version keeps its own newest entry (PR runs may pick an older version that
// still has a base database). shortcut: an old version's last entry stays
// until LRU evicts it, which is fine because it is then the least recently
// used cache; prune by version too if CLI upgrades ever pile them up.
const KEY_RE = /^(codeql-overlay-base-.+-)[0-9a-f]{40,64}-\d+-\d+$/;
// A run that started restoring before the newest entry existed may still be
// downloading an older one. CodeQL caps a restore at 10 minutes
// (MAX_CACHE_OPERATION_MS), so older entries wait until the newest is 30
// minutes old; a later hourly run deletes them.
const GRACE_MS = 30 * 60 * 1000;

export function plan(entries, now = Date.now()) {
  const groups = new Map();
  for (const e of entries) {
    const m = KEY_RE.exec(e.key);
    if (!m) continue;
    const group = `${e.ref}\n${m[1]}`;
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(e);
  }
  const keep = [];
  const remove = [];
  const held = [];
  for (const list of groups.values()) {
    list.sort(
      (a, b) =>
        Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.id - a.id,
    );
    keep.push(list[0]);
    const young = now - Date.parse(list[0].createdAt) < GRACE_MS;
    (young ? held : remove).push(...list.slice(1));
  }
  const bytes = remove.reduce((n, e) => n + e.sizeInBytes, 0);
  return { keep, remove, held, bytes };
}

const gb = (n) => `${(n / 1e9).toFixed(2)} GB`;
const mb = (n) => `${Math.round(n / 1e6)} MB`;

function listCaches() {
  const out = execFileSync(
    'gh',
    [
      'cache',
      'list',
      '--key',
      PREFIX,
      '--limit',
      '1000',
      '--json',
      'id,key,ref,sizeInBytes,createdAt,lastAccessedAt',
    ],
    { encoding: 'utf8' },
  );
  return JSON.parse(out);
}

function deleteCache(id) {
  try {
    execFileSync('gh', ['cache', 'delete', String(id)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return 'deleted';
  } catch (err) {
    // Eviction or a parallel run may have removed it first.
    const msg = `${err.stderr ?? ''}${err.stdout ?? ''}`;
    if (/404|not found|could not find/i.test(msg)) return 'already gone';
    return `FAILED: ${msg.trim() || err.message}`;
  }
}

function run(apply) {
  const p = plan(listCaches());
  const lines = [];
  for (const e of p.keep)
    lines.push(`keep   ${mb(e.sizeInBytes)}  ${e.ref}  ${e.key}`);
  for (const e of p.held)
    lines.push(`held   ${mb(e.sizeInBytes)}  ${e.ref}  ${e.key}`);
  let failed = 0;
  let freed = 0;
  for (const e of p.remove) {
    let status = 'would delete';
    if (apply) {
      // Belt and braces: plan() only returns overlay keys, check again anyway.
      if (!KEY_RE.test(e.key)) throw new Error(`refusing to delete ${e.key}`);
      status = deleteCache(e.id);
      if (status.startsWith('FAILED')) failed++;
      else if (status === 'deleted') freed += e.sizeInBytes;
    } else freed += e.sizeInBytes;
    lines.push(`${status}  ${mb(e.sizeInBytes)}  ${e.ref}  ${e.key}`);
  }
  const summary = `${apply ? 'Deleted' : 'Dry run: would delete'} ${p.remove.length - failed} of ${p.remove.length + p.keep.length + p.held.length} CodeQL overlay caches, freeing ${gb(freed)}; kept ${p.keep.length} (newest per prefix), held ${p.held.length} (newest < 30 min old).`;
  console.log(lines.join('\n'));
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `### Cache prune\n\n${summary}\n\n\`\`\`\n${lines.join('\n')}\n\`\`\`\n`,
    );
  }
  if (failed) {
    console.error(`${failed} deletes failed`);
    process.exit(1);
  }
}

function selfTest() {
  const sha = (c) => c.repeat(40);
  const js = (s, run, t, id, ref = 'refs/heads/master', ver = '2.27.4') => ({
    id,
    ref,
    key: `codeql-overlay-base-database-1-c801913f1ee29663-javascript-${ver}-${sha(s)}-${run}-1`,
    sizeInBytes: 100,
    createdAt: t,
  });
  const py = (s, run, t, id) => ({
    id,
    ref: 'refs/heads/master',
    key: `codeql-overlay-base-database-1-d953d79b74456ce0-python-2.27.4-${sha(s)}-${run}-1`,
    sizeInBytes: 5,
    createdAt: t,
  });
  const other = (key, id) => ({
    id,
    ref: 'refs/heads/master',
    key,
    sizeInBytes: 500,
    createdAt: '2026-11-01T00:00:00Z',
  });
  const T = (h) => `2026-11-16T0${h}:00:00Z`;
  const ids = (list) => list.map((e) => e.id).sort((a, b) => a - b);
  const cases = [
    ['empty list', [], [], []],
    [
      'keeps newest per prefix, groups languages apart',
      [
        js('a', 1, T(1), 1),
        js('b', 2, T(3), 2),
        py('a', 1, T(1), 3),
        py('b', 2, T(2), 4),
        js('c', 3, T(2), 5),
      ],
      [2, 4],
      [1, 3, 5],
    ],
    [
      'picks by createdAt, not by id or list order',
      [js('a', 9, T(5), 1), js('b', 1, T(1), 9)],
      [1],
      [9],
    ],
    [
      'createdAt tie falls back to the higher id',
      [js('a', 1, T(1), 7), js('b', 2, T(1), 8)],
      [8],
      [7],
    ],
    [
      'refs are separate groups',
      [
        js('a', 1, T(1), 1),
        js('b', 2, T(2), 2),
        js('c', 3, T(1), 3, 'refs/pull/5/merge'),
      ],
      [2, 3],
      [1],
    ],
    [
      'CodeQL versions are separate groups',
      [
        js('a', 1, T(1), 1, undefined, '2.27.3'),
        js('b', 2, T(2), 2),
        js('c', 3, T(3), 3),
      ],
      [1, 3],
      [2],
    ],
    [
      'non-overlay and malformed keys are ignored',
      [
        other(
          'yarn-Linux-399f62c3827857e9d7025bf3ecbe78a82670478f076d490832252acaee660806',
          1,
        ),
        other(
          'bnm2-Linux-node22-399f62c3827857e9d7025bf3ecbe78a82670478f076d490832252acaee660806',
          2,
        ),
        other(
          'turbo-Linux-399f62c3827857e9d7025bf3ecbe78a82670478f076d490832252acaee660806',
          3,
        ),
        other(
          'node-cache-Linux-x64-npm-19352821c65fcabe5124dceee793a1bab59d75f4a020ed270cd8c5f2ff2e51e7',
          4,
        ),
        other(
          'nextjs-Linux-06622410e16adac46870c9906a1fa56f02b80742ec22b367d2d515da90157f70',
          5,
        ),
        other('gitleaks-cache-8.24.3-linux-x64', 6),
        other(
          'codeql-overlay-base-database-1-c801913f1ee29663-javascript-2.27.4-nothex',
          7,
        ),
        other(
          `codeql-overlay-base-database-1-c801913f1ee29663-javascript-2.27.4-${sha('a')}-12`,
          8,
        ),
        other(
          `x-codeql-overlay-base-database-1-javascript-2.27.4-${sha('a')}-1-1`,
          9,
        ),
      ],
      [],
      [],
    ],
  ];
  let failed = 0;
  const later = Date.parse('2026-12-01T00:00:00Z');
  for (const [name, entries, wantKeep, wantRemove] of cases) {
    const got = plan(entries, later);
    const k = JSON.stringify(ids(got.keep));
    const r = JSON.stringify(ids(got.remove));
    if (k !== JSON.stringify(wantKeep) || r !== JSON.stringify(wantRemove)) {
      failed++;
      console.error(
        `FAIL ${name}: keep=${k} remove=${r}, want ${JSON.stringify(wantKeep)} ${JSON.stringify(wantRemove)}`,
      );
    }
  }
  // newest entry only 10 minutes old: the older one is held, not deleted
  const young = plan(
    [js('a', 1, T(1), 1), js('b', 2, T(2), 2), py('a', 1, T(1), 3)],
    Date.parse(T(2)) + 10 * 60 * 1000,
  );
  if (young.remove.length || ids(young.held).join() !== '1') {
    failed++;
    console.error(
      `FAIL grace: remove=${ids(young.remove)} held=${ids(young.held)}, want remove= held=1`,
    );
  }
  const b = plan(
    [
      js('a', 1, T(1), 1),
      js('b', 2, T(2), 2),
      py('a', 1, T(1), 3),
      py('b', 2, T(2), 4),
    ],
    later,
  ).bytes;
  if (b !== 105) {
    failed++;
    console.error(`FAIL bytes freed = ${b}, want 105`);
  }
  console.log(
    failed ? `${failed} failed` : `all ${cases.length + 2} checks passed`,
  );
  process.exit(failed ? 1 : 0);
}

const args = process.argv.slice(2);
if (args[0] === '--test') selfTest();
else run(args[0] === '--apply');
