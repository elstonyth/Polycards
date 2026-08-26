# Plan 127: Stop the turbo cache evicting the repo, close the typecheck-hook blind spots, and document the four GlobePay URL variables

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If a
> STOP condition occurs, stop and report — do not improvise. Do NOT update
> `plans/README.md`; the reviewer maintains it.
>
> **Drift check (run first)**:
> `git diff --stat affaab51..HEAD -- .github/workflows/ci.yml .claude/hooks/ tsconfig.json package.json eslint.config.mjs`
> On any change, re-read the file and compare against the "Current state"
> excerpts below. On a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED — changes CI caching and job timeouts; a wrong move here reddens every build
- **Depends on**: none
- **Category**: dx / ci
- **Planned at**: commit `affaab51`, 2026-08-26

## Why this matters

Four toolchain defects, each of which makes some other gate quietly weaker:

1. **The turbo cache is evicting everything else.** GitHub caps a repo's Actions
   cache at 10 GB. This repo is at **12.46 GB across 26 entries**, so LRU
   eviction is running continuously. Nine `turbo-Linux-<sha>` entries at ~900 MB
   each account for ~8.1 GB of that — because the turbo cache key is
   `github.sha`, minting a fresh ~900 MB entry per commit that can never be hit
   by key. This is the mechanism behind a problem the CI file has documented for
   13 audit rounds without explaining: the `bnm2-*` node_modules cache "has no
   stored entry at all", which is why backend jobs kept paying a ~16-minute cold
   install and why the timeouts were raised to 25–30 minutes.
2. **The edit-time typecheck hook silently passes for three TS projects.** It
   buckets any path containing `/backend/` (that is not admin) into
   `backend/packages/api`'s tsconfig — whose program does not contain
   `packages/odds-math`, `packages/pokemon` or `apps/vendor`. Editing
   `@acme/odds-math` — the odds and money package, a real workspace dependency
   that is built ahead of every test job — runs tsc over a program with none of
   your files in it and reports **pass**. The hook's own comment documents this
   exact bug class as fixed for admin, and left open for the two packages that
   matter more.
3. **Four GlobePay URL variables the payment paths hard-require are absent from
   the tracked env template.** An operator provisioning from the template gets a
   silently dead money channel: top-ups throw "Top-ups are temporarily
   unavailable" and withdrawal approvals throw "The payout channel is closed",
   and neither error names a variable.
4. **The format gate covers two directories.** `format:check` runs
   `prettier --check src scripts`, so `tests/**`, the workflow YAML,
   `next.config.ts` and `.claude/hooks/*.js` are ungated — and `npm run check`,
   the one-command local gate, omits **both** `format:check` and `npm test`, so
   it is weaker than CI on two axes. Separately, the root `tsconfig` lacks the
   nested-worktree excludes that `eslint.config.mjs` already documents and
   applies, so `npm run typecheck` and the Stop hook traverse any worktree copy.

## Current state

### 1. The turbo cache key

The same block appears four times, once per backend job (lines 143, 221, 385,
485 of `.github/workflows/ci.yml`):

```yaml
# turbo writes its local cache to backend/.turbo; without restoring it every
# lint/check-types/build task reruns cold. github.sha key + os restore-key
# means each run seeds from the newest prior cache and saves its own.
- name: Cache turbo
  uses: actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6
  with:
    path: backend/.turbo
    key: turbo-${{ runner.os }}-${{ github.sha }}
    restore-keys: |
      turbo-${{ runner.os }}-
```

Contrast the two caches in the same file that are keyed correctly — on content,
not on the commit:

```yaml
- name: Cache yarn (berry global cache)
  uses: actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6
  with:
    path: ~/.yarn/berry/cache
    key: yarn-${{ runner.os }}-${{ hashFiles('backend/yarn.lock') }}
    restore-keys: yarn-${{ runner.os }}-
```

```yaml
key: bnm2-${{ runner.os }}-node22-${{ hashFiles('backend/yarn.lock') }}
```

Measured state at the time of writing (reproduce with the commands in the
verification table below): 26 entries, 12,461,179,236 bytes total; nine
`turbo-Linux-<sha>` entries between 893 MB and 909 MB.

### 2. The typecheck hooks

`.claude/hooks/_tslib.js` defines exactly three projects. Abridged, with the
comment that names the bug class:

```js
// .claude/hooks/_tslib.js (abridged)
  backend: {
    label: "backend/packages/api",
    cwd: path.join(REPO, "backend", "packages", "api"),
    tsc: path.join(REPO, "backend", "node_modules", "typescript", "bin", "tsc"),
    tsconfig: path.join(REPO, "backend", "packages", "api", "tsconfig.json"),
    cache: path.join(REPO, "backend", "packages", "api", "node_modules", ".cache", "tsc-hook.tsbuildinfo"),
  },
  // The admin dashboard (Vite SPA) is a SEPARATE TS project from the API — its
  // files aren't in backend/packages/api's program, so without this entry every
  // edit under backend/apps/admin/** was silently type-unchecked (both hooks
  // routed "/backend/" -> the api bucket). tsc is the workspace-hoisted binary.
  admin: {
    label: "backend/apps/admin",
    cwd: path.join(REPO, "backend", "apps", "admin"),
    tsc: path.join(REPO, "backend", "node_modules", "typescript", "bin", "tsc"),
    tsconfig: path.join(REPO, "backend", "apps", "admin", "tsconfig.app.json"),
    cache: path.join(REPO, "backend", "apps", "admin", "node_modules", ".cache", "tsc-hook.tsbuildinfo"),
  },
```

Note the admin entry points at `tsconfig.app.json`, **not** `tsconfig.json` —
the latter is a references stub with `files: []` that type-checks zero files and
exits 0. Any new entry must point at a tsconfig that actually includes sources.

The router has three buckets:

```js
// .claude/hooks/post-edit-typecheck.js:29-36
// backend/apps/admin is its own TS project — check it before the generic
// "/backend/" bucket, which is the API package (a different tsconfig program).
const key = norm.includes('/backend/apps/admin/')
  ? 'admin'
  : norm.includes('/backend/')
    ? 'backend'
    : 'storefront';
const res = runTsc(key, { incremental: true, timeoutMs: 60000 });
```

The Stop hook has the same gap — three `runTsc` calls for six TS projects:

```js
// .claude/hooks/stop-verify.js:62-68
const results = [
  runTsc('storefront', { timeoutMs: 120000 }),
  runTsc('backend', { timeoutMs: 150000 }),
  runTsc('admin', { timeoutMs: 120000 }),
];
const vitest = runVitest({ timeoutMs: 90000 });
const failed = results.filter((r) => r.status === 'fail');
```

`@acme/odds-math` is not dormant: `backend/packages/api/package.json` declares
`"@acme/odds-math": "workspace:*"`, and `ci.yml` builds it ahead of every test
job (`corepack yarn build --filter="@acme/api^..."`).

### 3. The env template

The four required-but-undocumented keys, with where each is read and what
happens when it is missing (all four fail **closed**, which is correct — the
defect is that nothing tells the operator they exist):

| Key                            | Read at                                                          | Missing behaviour                                     |
| ------------------------------ | ---------------------------------------------------------------- | ----------------------------------------------------- |
| `GLOBEPAY_NOTIFY_URL`          | `src/api/store/credits/deposit/route.ts:38-47`                   | top-up refused, "Top-ups are temporarily unavailable" |
| `GLOBEPAY_RETURN_URL`          | same                                                             | same                                                  |
| `GLOBEPAY_WITHDRAW_NOTIFY_URL` | `src/api/admin/globepay/withdrawals/[id]/approve/route.ts:67-76` | approval refused, "The payout channel is closed"      |
| `GLOBEPAY_PAYOUT_VERIFY_URL`   | same                                                             | same                                                  |

All four appear in `.do/backend.app.yaml` and in
`docs/payments/globepay365-setup.md`, but not in the tracked template at
`backend/packages/api/` (the file named `.env.template`). That template already
documents two other GlobePay knobs — the approval threshold around line 101 and
the daily max around line 105 — so there is an obvious place to put them.

`GLOBEPAY_DEPOSIT_METHOD` has a code default and is genuinely optional. Do not
add it.

### 4. The format gate and the tsconfig excludes

```jsonc
// package.json:34-36
    "check": "npm run lint && npm run typecheck && npm run build",
    "format": "prettier --write src scripts",
    "format:check": "prettier --check src scripts",
```

```jsonc
// tsconfig.json (tail)
  "include": [
    "next-env.d.ts",
    "**/*.ts",
    "**/*.tsx",
    ".next/types/**/*.ts",
    ".next/dev/types/**/*.ts",
    "**/*.mts"
  ],
  "exclude": ["node_modules", "backend"]
```

Bare `exclude` entries resolve relative to the tsconfig's own directory, so a
nested worktree copy's `node_modules` and `backend/` are **not** excluded.
`eslint.config.mjs` already solved this and documents why:

```js
// eslint.config.mjs:14-40 (abridged)
    // scripts/serve-standalone.ps1 copies the standalone bundle here
    // (gitignored) — without this, lint after a local serve reports thousands
    // of phantom problems in build output.
    '.next-serve/**',
    /* ... */
    // The Medusa + Mercur backend is a separate project with its own toolchain.
    'backend/**',
    // Claude Code session worktrees are full repo copies nested under the
    // project root; without this their backend/ files leak past the ignore
    // above (different path prefix) and fail lint mid-session.
    '.claude/worktrees/**',
    // superpowers `using-git-worktrees` worktrees live here (gitignored). They
    // are full repo copies too — without this, `npm run lint` from the main
    // checkout traverses the nested copy and reports thousands of phantom
    // problems. CI is unaffected (fresh checkout has no .worktrees/).
    '.worktrees/**',
    // Scratch / orphaned tool worktree copies (gitignored) — same nested-repo
    // pollution as above. CI never sees these.
    '.clone/**',
```

### Conventions to match

- `.github/workflows/*.yml` pins every action to a full commit SHA with a
  trailing `# vN` comment. Never replace a pinned SHA with a tag.
- The CI file's comments carry measured numbers and the reason for each choice.
  When you change a mechanism, **rewrite its comment to the new truth** — a
  stale explanation is worse than none here, because it is the first thing the
  next person reads.
- Hook files are plain CommonJS `.js` under `.claude/hooks/`, 2-space indent,
  double-quoted strings. Match the surrounding style, not the storefront's.

## Commands you will need

Run from the repo root unless stated.

| Purpose           | Command                                                                                                                                                   | Expected on success                                            |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Cache usage       | `gh api repos/elstonyth/Polycards/actions/cache/usage`                                                                                                    | JSON with `active_caches_size_in_bytes`                        |
| Cache entries     | `gh api "repos/elstonyth/Polycards/actions/caches?per_page=100" --jq '.actions_caches[] \| "\(.size_in_bytes)\t\(.key)"' \| sort -rn`                     | one line per entry                                             |
| YAML parses       | `node -e "require('fs').readFileSync('.github/workflows/ci.yml','utf8')" && python -c "import yaml,sys;yaml.safe_load(open('.github/workflows/ci.yml'))"` | exit 0 (skip the python leg if python is unavailable — say so) |
| Typecheck         | `npm run typecheck`                                                                                                                                       | exit 0                                                         |
| Lint              | `npm run lint`                                                                                                                                            | exit 0                                                         |
| Format check      | `npm run format:check`                                                                                                                                    | exit 0                                                         |
| Unit tests        | `npm test`                                                                                                                                                | all pass                                                       |
| Build             | `npm run build`                                                                                                                                           | exit 0                                                         |
| Backend typecheck | `corepack yarn check-types` (from `backend/`)                                                                                                             | exit 0                                                         |

`gh` is authenticated in this environment; the two cache commands are read-only.
Do **not** delete any cache entry — that is the operator's call, not yours.

## Scope

**In scope** (the only files you may modify):

- `.github/workflows/ci.yml`
- `.claude/hooks/_tslib.js`
- `.claude/hooks/post-edit-typecheck.js`
- `.claude/hooks/stop-verify.js`
- `backend/packages/api/.env.template`
- `package.json`
- `tsconfig.json`
- `.prettierignore`

**Out of scope** (do NOT touch, even though they look related):

- `.github/workflows/e2e.yml`, `prod-smoke.yml`, `dependency-review.yml` — the
  nightly-only and dispatch-only designs are deliberate.
- Branch-protection settings — the operator is changing those by hand. Do not
  call the protection API.
- `.claude/settings.json` — the hook _wiring_ is correct; only the hook
  _implementations_ have gaps.
- Any `.env`, `.env.local` or other untracked env file. You are editing the
  tracked `.env.template` only, and you add **key names with comments, never
  values**.
- `backend/eslint.config.*` and the fact that backend eslint does not cover
  `packages/api`. Real, recorded, and a separate piece of work.
- Deleting cache entries, or any `gh api` call that is not a GET.

## Git workflow

- Branch: `advisor/127-ci-cache-hooks-env`, cut from `origin/master`.
- Conventional commits. Keep the Step 5 reformat as its **own commit** so the
  functional diff stays reviewable.
- Do NOT push or open a PR — the reviewer does that.

## Steps

### Step 1: Record the baseline

Run the two cache commands from the table and paste the output into your final
report. This is the before-picture that makes Step 2's effect measurable, and
the reviewer will compare against it.

**Verify**: both commands return JSON; you have a total byte count and a
per-key listing.

### Step 2: Key the turbo cache on the lockfile

In all **four** turbo cache blocks in `.github/workflows/ci.yml`, change:

```yaml
key: turbo-${{ runner.os }}-${{ github.sha }}
```

to a lockfile-content key, matching the shape the `yarn` and `bnm2` caches
already use:

```yaml
key: turbo-${{ runner.os }}-${{ hashFiles('backend/yarn.lock') }}
```

Keep the `restore-keys: turbo-${{ runner.os }}-` fallback exactly as it is — it
is what lets a lockfile change still seed from the previous entry.

Then **rewrite the comment above each block**. The current text ("github.sha key

- os restore-key means each run seeds from the newest prior cache and saves its
  own") describes the behaviour you are removing. The new comment should say: keyed
  on the lockfile so the four backend jobs share ONE entry instead of minting a
  ~900 MB entry per commit; the per-commit key was pushing the repo past GitHub's
  10 GB cache cap and evicting the `bnm2` node_modules entry, which is what made
  backend installs cold.

All four blocks must end up identical. `grep -c` will check that.

**Verify**:

- `grep -c 'turbo-\${{ runner.os }}-\${{ hashFiles' .github/workflows/ci.yml` → `4`
- `grep -c 'github.sha' .github/workflows/ci.yml` → `0`
- YAML still parses (see command table)

### Step 3: Close the typecheck-hook blind spots

In `.claude/hooks/_tslib.js`, add three entries to `PROJECTS`, each modelled on
the existing `admin` entry:

- `oddsMath` → `backend/packages/odds-math`, label `backend/packages/odds-math`
- `pokemon` → `backend/packages/pokemon`, label `backend/packages/pokemon`
- `vendor` → `backend/apps/vendor`, label `backend/apps/vendor`

For each, use `backend/node_modules/typescript/bin/tsc` as the binary (the
workspace-hoisted copy, same as `backend` and `admin`) and give each its own
`tsBuildInfoFile` cache path under that package's `node_modules/.cache/`, so the
incremental builds never collide.

**Check each package's tsconfig before wiring it.** `apps/vendor` likely needs
`tsconfig.app.json` for the same references-stub reason admin does. Run
`node_modules/.bin/tsc -p <the tsconfig you chose> --listFiles | grep -c "src/"`
from that package directory: a count of `0` means you picked the stub and the
check would be vacuous — pick the one that lists real files, and say in your
report which tsconfig you chose for each and what the file count was.

In `.claude/hooks/post-edit-typecheck.js`, extend the bucket chain
**most-specific-first**, so the new package paths are tested before the generic
`/backend/` fallback. Add a comment naming the bug class, matching the tone of
the existing admin comment.

In `.claude/hooks/stop-verify.js`, add the three new `runTsc` calls to the
`results` array. Give them the same 120000 ms timeout the other package-scale
checks use.

**Verify**:

- `node -e "require('./.claude/hooks/_tslib.js'); console.log('ok')"` → prints `ok`
- `node --check .claude/hooks/post-edit-typecheck.js && node --check .claude/hooks/stop-verify.js` → exit 0
- Prove the routing works: run the post-edit hook by hand against a path in each
  new package and confirm it selects the right project. If the hook reads its
  input from stdin as JSON (read the file to confirm the shape), feed it a
  synthetic payload naming e.g.
  `backend/packages/odds-math/src/<an existing file>.ts` and confirm it does not
  route to the api bucket. Report exactly how you proved it.

### Step 4: Document the four GlobePay URL variables

In `backend/packages/api/.env.template`, add the four keys from the table in
"Current state", placed next to the two existing GlobePay knobs (around lines
101–105).

**Add key names and explanatory comments only. Never a value** — not a real one,
not a plausible-looking placeholder that could be mistaken for one. Follow the
file's existing comment style. Each entry should say which channel it opens and
that the channel is refused when it is unset.

**Verify**:

- `grep -c 'GLOBEPAY_NOTIFY_URL\|GLOBEPAY_RETURN_URL\|GLOBEPAY_WITHDRAW_NOTIFY_URL\|GLOBEPAY_PAYOUT_VERIFY_URL' backend/packages/api/.env.template` → `4`
- `git diff backend/packages/api/.env.template` contains no `=` followed by a
  non-empty value on the four new lines

### Step 5: Widen the format gate, and make `check` match CI

Two edits to `package.json`:

1. Widen `format` and `format:check` to **code files only**, leaving markdown
   entirely alone. Use an explicit extension glob, not `.`:

   ```jsonc
   "format": "prettier --write \"**/*.{ts,tsx,mjs,cjs,js,json,yml,yaml,css}\"",
   "format:check": "prettier --check \"**/*.{ts,tsx,mjs,cjs,js,json,yml,yaml,css}\"",
   ```

   **Why not `prettier --check .`**: `git ls-files '*.md'` returns 235 tracked
   markdown files, ~130 of them hand-wrapped plan documents under `plans/`, plus
   `CLAUDE.md`, `AGENTS.md`, `CONTEXT.md`, `DESIGN.md`, `PRODUCT.md` and
   `README.md`. `.prettierignore` already excludes `docs/`, `backend/`, `.do/`,
   `public/` and `graphify-out/` — but **not** `plans/` and not the root
   markdown. A repo-wide pass would reflow all of it, destroying deliberate
   prose wrapping and burying the real diff. The extension glob still closes the
   gap the finding named: `tests/**`, `.github/workflows/*.yml`,
   `next.config.ts`, `eslint.config.mjs`, `vitest.config.ts` and
   `.claude/hooks/*.js` all become gated.

   Extend `.prettierignore` with `.next-serve/`, `.worktrees/`,
   `.claude/worktrees/`, `.clone/`, `*.tsbuildinfo` and `package-lock.json`. Do
   **not** re-add `docs/`, `backend/`, `.do/`, `public/` or `graphify-out/` —
   they are already there and re-adding them is churn.

2. Change `check` to `npm run lint && npm run format:check && npm run typecheck && npm test && npm run build`, so the one-command local gate matches what CI actually runs.

Run `npm run format` once. **Commit the resulting reformat separately** from the
`package.json` change, with a message that says it is a mechanical
prettier-widening pass and no logic changed. If the reformat touches more than
~50 files, stop and report the count before committing — that is worth the
reviewer's decision, not yours.

**Verify**:

- `npm run format:check` → exit 0
- `npm run lint` → exit 0
- `npm test` → all pass
- `git diff --stat` on the reformat commit shows only whitespace/formatting
  churn (spot-check three files with `git show -w` and confirm they are empty
  under `-w`; report any that are not)

### Step 6: Give the tsconfig the excludes ESLint already has

In `tsconfig.json`, extend `exclude` from `["node_modules", "backend"]` to also
cover `.next-serve/**`, `.claude/worktrees/**`, `.worktrees/**` and `.clone/**`.
Add a one-line comment (JSON does not take comments — put the explanation in the
commit message instead) noting this mirrors `eslint.config.mjs`'s ignore list
and why: a nested worktree copy is a full second checkout and bare `exclude`
entries do not reach it.

**Verify**:

- `npm run typecheck` → exit 0
- `node -e "JSON.parse(require('fs').readFileSync('tsconfig.json','utf8'));console.log('ok')"` → prints `ok`

### Step 7: DO NOT lower the CI timeouts

The audit that produced this plan found the four backend timeouts sit roughly 5×
above measured wall-clock (`backend-quality` 2m48s against a 30-minute timeout,
worst `integration-http` shard 5m40s against 30), and `ci.yml:104-113` states its
own revert condition: "Drop this back to 20 once a bnm2 entry exists on master."

**Do not do it in this plan.** Lowering the timeouts is only safe _while_ Step 2
holds the cache, and Step 2's effect cannot be observed until this branch has
merged and a few commits have run against the new key. Lowering them now, on the
same branch that changes the key, risks a cold install being killed mid-step —
which reads as a red build caused by the diff, the exact failure the raised
timeouts were introduced to stop.

Instead: leave every `timeout-minutes` value untouched, and **amend the comment
block at `ci.yml:104-113`** to record (a) the measured durations above, (b) that
the cache key was the real cause, and (c) that the revert to 20 is safe once a
`bnm2` entry has survived several commits on master. That turns a stale cost
model into a live one with a checkable trigger.

**Verify**: `grep -n 'timeout-minutes' .github/workflows/ci.yml` returns the
same seven values as before your change: `5, 15, 30, 25, 30, 30, 10`.

### Step 8: Full green

**Verify**, in order:

1. `npm run typecheck` → exit 0
2. `npm run lint` → exit 0
3. `npm run format:check` → exit 0
4. `npm test` → all pass
5. `npm run build` → exit 0
6. `corepack yarn check-types` from `backend/` → exit 0
7. `git status --porcelain` → only the in-scope files

## Test plan

This plan changes tooling, not product logic, so its proofs are executable
checks rather than new test files:

- **Turbo key**: the four `grep -c` assertions in Step 2 plus a YAML parse.
- **Hook routing**: the hand-run proof in Step 3 — the executor must demonstrate
  that a path in each newly-added package selects that package's project and not
  the api bucket, and report how.
- **Non-vacuous project entries**: the `--listFiles | grep -c "src/"` check in
  Step 3. A `0` means the entry checks nothing.
- **Format widening**: `git show -w` on three files from the reformat commit
  must be empty, proving the pass was whitespace-only.

Do not write unit tests for the hook files; this repo has none for them and the
executable checks above are the established proof style.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `grep -c 'github.sha' .github/workflows/ci.yml` returns `0`
- [ ] `grep -c "turbo-\${{ runner.os }}-\${{ hashFiles" .github/workflows/ci.yml` returns `4`
- [ ] `grep -n 'timeout-minutes' .github/workflows/ci.yml` returns exactly `5, 15, 30, 25, 30, 30, 10` — unchanged
- [ ] `node --check` passes on all three hook files
- [ ] For each of the three new hook projects, you report the tsconfig chosen and a `--listFiles | grep -c "src/"` count **greater than 0**
- [ ] You report exactly how you proved the post-edit hook routes each new package to its own project
- [ ] `grep -c 'GLOBEPAY_NOTIFY_URL\|GLOBEPAY_RETURN_URL\|GLOBEPAY_WITHDRAW_NOTIFY_URL\|GLOBEPAY_PAYOUT_VERIFY_URL' backend/packages/api/.env.template` returns `4`, and no value appears on any of the four lines
- [ ] `npm run check` (the widened one) exits 0
- [ ] `npm run build` exits 0
- [ ] `corepack yarn check-types` (from `backend/`) exits 0
- [ ] The reformat is in its own commit and `git show -w` is empty for three spot-checked files
- [ ] `git show --stat <reformat-sha> -- '*.md'` is **empty** — no markdown file was reformatted
- [ ] `git status --porcelain` lists only files from the In-scope list

## STOP conditions

Stop and report back — do not improvise — if:

- Any "Current state" excerpt does not match the live code.
- A newly-added hook project's tsconfig lists **zero** `src/` files under every
  candidate tsconfig — that means the package's TS layout is not what this plan
  assumes. Report the layout; do not wire a vacuous check.
- `npm run format` touches more than ~50 files. Report the count and wait.
- `npm run format:check` cannot be made to pass because prettier disagrees with
  a generated or vendored file you cannot ignore cleanly. Report the file.
- You find yourself wanting to delete a cache entry, change branch protection,
  or lower a timeout. All three are explicitly out of scope; report the
  temptation rather than acting on it.
- `hashFiles('backend/yarn.lock')` turns out not to be a valid expression in
  this workflow's context (it is used already at two other keys, so it should
  be — but if a run rejects it, stop).

## Maintenance notes

- **For the reviewer**: the highest-value check is Step 3's non-vacuity proof.
  An entry pointed at a references stub (`files: []`) passes `node --check`,
  passes every grep, runs tsc, and checks nothing — which is the exact bug the
  admin entry was added to fix, reintroduced. Demand the `--listFiles` count.
- After this merges, watch the cache: once a `bnm2-*` entry has survived several
  commits on master, the four backend timeouts can drop back to the documented
  20 minutes. That is deliberately a separate change — see Step 7.
- The widened `format:check` will start catching workflow YAML and `tests/**`.
  Expect the first few PRs after this to hit it; that is the gate working.
- Deliberately not covered here and still open: backend eslint does not cover
  `packages/api` at all (no config there, no `lint` script), so the backend is
  gated by tsc and jest alone. Recorded in round 14, not fixed in this plan.
