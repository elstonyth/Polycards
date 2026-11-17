#!/usr/bin/env node
// Decides which DigitalOcean apps a push to master must redeploy.
//
// Used by .github/workflows/deploy.yml, and by ci.yml's `changes` job to decide
// whether a PR needs the storefront checks. The rule errs toward deploying: an
// extra deploy is harmless, a missed one ships stale code. So the storefront
// is a deny-list (everything deploys except files its build never reads), and
// any doubt (no diff, unknown event) deploys both apps.
//
//   node .github/scripts/deploy-targets.mjs              CI: reads env, writes GITHUB_OUTPUT
//   node .github/scripts/deploy-targets.mjs --commit SHA  what one commit would deploy
//   node .github/scripts/deploy-targets.mjs --test        built-in self-check

import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';

// Backend app: built from backend/ (source_dir) with backend/Dockerfile.
const BACKEND_IGNORE_PREFIXES = ['backend/.claude/'];

// Storefront app: root Dockerfile, `COPY . .` minus .dockerignore, then
// `next build`, which type-checks every file tsconfig.json includes. These
// paths are never read by that build. Dockerfile and .dockerignore are NOT
// here: they are excluded from the image yet decide how it is built.
const STOREFRONT_IGNORE_PREFIXES = [
  'backend/', // tsconfig excludes it; files the storefront imports are added back below
  'docs/',
  'scripts/',
  '.github/',
  '.do/',
  '.claude/',
  '.agents/',
  '.codebuddy/',
  '.kiro/',
  '.qoder/',
  '.codex/',
  '.cursor/',
  '.windsurf/',
  '.gemini/',
  '.continue/',
  '.amazonq/',
  '.augment/',
  '.opencode/',
  '.vscode/',
  '.idea/',
  '.impeccable/',
  'plans/',
  'graphify-out/',
];
// Root-level *.md files are docs too (no source imports markdown).
const isRootMarkdown = (f) => !f.includes('/') && f.endsWith('.md');
const STOREFRONT_IGNORE_FILES = new Set([
  'LICENSE',
  '.gitleaksignore',
  'skills-lock.json',
  '.cursorrules',
  '.clinerules',
  '.windsurfrules',
  '.aider.conf.yml',
  'docker-compose.yml',
  '.gitignore',
]);

const IMPORT_RE = /from\s+['"]((?:\.\.\/)+backend\/[^'"]+)['"]/g;
// The store response types (ADR 0018): `@acme/api/store/<route>` is a tsconfig
// path to that route's types.ts.
const STORE_TYPES_RE = /from\s+['"]@acme\/api\/store\/([^'"]+)['"]/g;
const STORE_TYPES_DIR = 'backend/packages/api/src/api/store/';
const ANY_IMPORT_RE = /from\s+['"]([^'"]+)['"]/g;

const asTs = (p) => (/\.(m?ts|tsx|js|mjs)$/.test(p) ? p : `${p}.ts`);
const resolveFrom = (file, rel) =>
  asTs(normalize(join(dirname(file), rel)).replaceAll('\\', '/'));

// Every file reachable from `roots` through relative imports. A missing file
// is skipped: it fails the typecheck on its own.
function relativeClosure(roots, repoRoot) {
  const found = new Set(roots);
  // A Set visits entries added during the loop, so this walks the chain.
  for (const file of found) {
    let text;
    try {
      text = readFileSync(join(repoRoot, file), 'utf8');
    } catch {
      continue;
    }
    for (const m of text.matchAll(ANY_IMPORT_RE)) {
      if (m[1].startsWith('.')) found.add(resolveFrom(file, m[1]));
    }
  }
  return found;
}

// The backend files storefront code imports: `direct` by relative path (two
// parity tests), `storeTypes` as `@acme/api/store/<route>`.
function storefrontBackendRoots(repoRoot) {
  const listed = execFileSync('git', ['ls-files', 'src', 'tests', 'tools'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  const direct = new Set();
  const storeTypes = new Set();
  for (const file of listed.split('\n')) {
    if (!/\.(m?ts|tsx)$/.test(file)) continue;
    const text = readFileSync(join(repoRoot, file), 'utf8');
    for (const m of text.matchAll(IMPORT_RE)) {
      direct.add(resolveFrom(file, m[1]));
    }
    for (const m of text.matchAll(STORE_TYPES_RE)) {
      storeTypes.add(`${STORE_TYPES_DIR}${m[1]}/types.ts`);
    }
  }
  return { direct, storeTypes };
}

// Backend files the storefront typecheck reads: the ones storefront code
// imports and, transitively, the backend files those import. A change to any
// of them must run the storefront checks and redeploy it.
export function backendFilesImportedByStorefront(repoRoot = '.') {
  const { direct, storeTypes } = storefrontBackendRoots(repoRoot);
  return relativeClosure([...direct, ...storeTypes], repoRoot);
}

// The storefront's CI job and Docker build install only the root packages, so
// a store types file whose chain reaches a package (`@medusajs/*`, …) passes
// locally and fails there. Returns each such import as `file: specifier`.
export function storeTypesPackageImports(repoRoot = '.') {
  const bad = [];
  const { storeTypes } = storefrontBackendRoots(repoRoot);
  for (const file of relativeClosure(storeTypes, repoRoot)) {
    const text = readFileSync(join(repoRoot, file), 'utf8');
    for (const m of text.matchAll(ANY_IMPORT_RE)) {
      if (!m[1].startsWith('.')) bad.push(`${file}: ${m[1]}`);
    }
  }
  return bad;
}

const firstMatch = (files, pred) => files.find(pred) ?? null;

export function decide(files, storefrontBackendFiles = new Set()) {
  const backendHit = firstMatch(
    files,
    (f) =>
      f.startsWith('backend/') &&
      !BACKEND_IGNORE_PREFIXES.some((p) => f.startsWith(p)),
  );
  const storefrontHit = firstMatch(files, (f) => {
    if (storefrontBackendFiles.has(f)) return true;
    if (STOREFRONT_IGNORE_FILES.has(f) || isRootMarkdown(f)) return false;
    return !STOREFRONT_IGNORE_PREFIXES.some((p) => f.startsWith(p));
  });
  return {
    backend: backendHit !== null,
    storefront: storefrontHit !== null,
    reasons: { backend: backendHit, storefront: storefrontHit },
  };
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' });
const lines = (s) => s.split('\n').filter(Boolean);

function planFromEnv(env) {
  if (env.GITHUB_EVENT_NAME === 'workflow_dispatch') {
    const t = env.TARGET || 'both';
    const why = `manual run (target=${t})`;
    return {
      backend: t === 'both' || t === 'backend',
      storefront: t === 'both' || t === 'storefront',
      reasons: { backend: why, storefront: why },
    };
  }
  // Each app is diffed from the commit it is actually running (LIVE_BACKEND,
  // LIVE_STOREFRONT, read from DigitalOcean), so a push after a failed or
  // skipped deploy still ships everything since. Without a live commit it
  // falls back to the push's own range (BEFORE..SHA).
  const sha = env.SHA || 'HEAD';
  const imported = backendFilesImportedByStorefront();
  const plan = { reasons: {} };
  for (const app of ['backend', 'storefront']) {
    const live = env[`LIVE_${app.toUpperCase()}`] || '';
    const base = live || env.BEFORE || '';
    const from = live ? 'live' : 'previous push';
    if (!base || /^0+$/.test(base)) {
      plan[app] = true;
      plan.reasons[app] = 'no commit to diff against';
      continue;
    }
    let files;
    try {
      // --no-renames lists a moved file at both paths, so moving a build input
      // into an ignored folder still counts as a change to the app.
      files = lines(git('diff', '--name-only', '--no-renames', base, sha));
    } catch {
      plan[app] = true;
      plan.reasons[app] =
        `could not diff ${base.slice(0, 9)}..${sha.slice(0, 9)} (force-push or missing history)`;
      continue;
    }
    const d = decide(files, imported);
    plan[app] = d[app];
    plan.reasons[app] = d.reasons[app]
      ? `${d.reasons[app]}; vs ${from} ${base.slice(0, 9)}`
      : `nothing it builds from changed since ${from} ${base.slice(0, 9)}`;
  }
  return plan;
}

function report(plan) {
  for (const app of ['backend', 'storefront']) {
    const why = plan.reasons[app];
    console.log(
      `${app}: ${plan[app] ? 'deploy' : 'skip'}${why ? ` (${why})` : ' (no file it builds from changed)'}`,
    );
  }
}

function selfTest() {
  const imported = new Set(['backend/packages/api/src/utils/real-name.ts']);
  const cases = [
    [['skills-lock.json', '.agents/skills/x/SKILL.md'], false, false],
    [['backend/packages/api/src/x.ts', 'docs/adr/0017.md'], true, false],
    [['backend/apps/admin/src/routes/x.tsx', 'CONTEXT.md'], true, false],
    [['src/app/page.tsx'], false, true],
    [['Dockerfile'], false, true],
    [['.dockerignore'], false, true],
    [['package-lock.json'], false, true],
    [['tools/desk-reports/tools.mjs'], false, true],
    [
      [
        'slot-machine-redesign.md',
        '.gitleaksignore',
        'plans/x.md',
        '.impeccable/m.png',
      ],
      false,
      false,
    ],
    [['src/content/notes.md'], false, true],
    [['backend/packages/api/src/utils/real-name.ts'], true, true],
    [['backend/.claude/skills/x/SKILL.md'], false, false],
    [
      ['.github/workflows/deploy.yml', 'scripts/serve-standalone.ps1'],
      false,
      false,
    ],
    [[], false, false],
  ];
  let failed = 0;
  for (const [files, wantB, wantS] of cases) {
    const got = decide(files, imported);
    if (got.backend !== wantB || got.storefront !== wantS) {
      failed++;
      console.error(
        `FAIL ${JSON.stringify(files)} -> backend=${got.backend} storefront=${got.storefront}, want ${wantB}/${wantS}`,
      );
    }
  }
  const real = backendFilesImportedByStorefront();
  const scanWants = [
    'backend/packages/api/src/utils/real-name.ts',
    'backend/packages/api/src/api/store/vault/types.ts',
  ];
  for (const want of scanWants) {
    if (!real.has(want)) {
      failed++;
      console.error(`FAIL import scan missed ${want}`);
    }
  }
  for (const bad of storeTypesPackageImports()) {
    failed++;
    console.error(`FAIL store types file imports a package: ${bad}`);
  }
  // Live-commit diffs on real master history (#1048 9f9026d .. #1052 6753561).
  const live = [
    // skills-only push while both apps are live on #1051: nothing to deploy
    [
      { SHA: '6753561', LIVE_BACKEND: 'a94353f', LIVE_STOREFRONT: 'a94353f' },
      false,
      false,
    ],
    // same push, but the backend is still on #1049: it must catch up on #1050/#1051
    [
      { SHA: '6753561', LIVE_BACKEND: 'e99ced5', LIVE_STOREFRONT: 'a94353f' },
      true,
      false,
    ],
    // storefront live on #1047 misses #1048's src/ change
    [
      { SHA: '6753561', LIVE_BACKEND: '6753561', LIVE_STOREFRONT: '80fdd9b' },
      false,
      true,
    ],
  ];
  for (const [env, wantB, wantS] of live) {
    const got = planFromEnv(env);
    if (got.backend !== wantB || got.storefront !== wantS) {
      failed++;
      console.error(
        `FAIL live ${JSON.stringify(env)} -> backend=${got.backend} storefront=${got.storefront}, want ${wantB}/${wantS}`,
      );
    }
  }
  console.log(
    failed
      ? `${failed} failed`
      : `all ${cases.length + scanWants.length + 1 + live.length} checks passed`,
  );
  process.exit(failed ? 1 : 0);
}

const args = process.argv.slice(2);
if (args[0] === '--test') {
  selfTest();
} else if (args[0] === '--commit') {
  // Diff against the first parent so merge commits list their changes too;
  // a root commit has no parent, so fall back to listing its whole tree.
  let files;
  try {
    files = lines(
      git('diff', '--name-only', '--no-renames', `${args[1]}^1`, args[1]),
    );
  } catch {
    files = lines(
      git(
        'diff-tree',
        '--root',
        '--no-commit-id',
        '--name-only',
        '-r',
        args[1],
      ),
    );
  }
  report(decide(files, backendFilesImportedByStorefront()));
} else {
  const plan = planFromEnv(process.env);
  report(plan);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `backend=${plan.backend}\nstorefront=${plan.storefront}\n`,
    );
  }
}
