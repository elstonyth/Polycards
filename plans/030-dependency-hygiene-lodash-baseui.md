# Plan 030: Dependency hygiene — fix the phantom lodash pin (backend) and drop the unused @base-ui/react (storefront)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat dbce0561..HEAD -- backend/package.json backend/yarn.lock package.json package-lock.json README.md`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW-MED (lockfile regeneration; both changes are mechanical but require network installs — run them in an isolated worktree, never the operator's main tree)
- **Depends on**: none
- **Category**: dependencies / security
- **Planned at**: commit `dbce0561`, 2026-07-13

## Why this matters

**Backend**: `backend/package.json:21` directly pins `"lodash": "^4.18.1"`.
Lodash's public release line stops at **4.17.21** — 4.18.x does not exist on
the npm registry. Yet `backend/yarn.lock` resolves `lodash@npm:^4.18.1` to
`version 4.18.1` with a checksum, and the untouched transitive `~4.17.0`
descriptor to `4.17.23` (also unpublished). There is no
`npmRegistryServer` in `backend/.yarnrc.yml` and no `resolutions` override —
so the lockfile claims public-registry versions the public registry doesn't
have. Two concrete costs: (1) **reproducibility** — a clean
`yarn install --immutable` against real npm risks "no candidates
found"/checksum mismatch the day yarn actually revalidates these entries;
(2) **dependency-confusion surface** — a semver floor the real maintainer
will never publish means anyone who publishes `lodash@4.18.1` to public npm
satisfies this manifest. Correcting the pin to the real line closes both.

**Storefront**: `package.json` declares `@base-ui/react` as a runtime
dependency, and the README calls it the UI-primitive foundation — but a
repo-wide search finds **zero** import sites (`src/components/ui/` collapsed
to a single Tailwind-only `pill.tsx`). Dead weight in every install and a
stale architecture claim.

## Current state

Verified at `dbce0561`:

- `backend/package.json:21` → `"lodash": "^4.18.1"` (the only lodash
  requester at `^4.18.1` — `grep -rn '"lodash"' backend/packages/*/package.json backend/apps/*/package.json backend/package.json` matches only this line; `@types/lodash: ^4.17.24` at line 33 is fine).
- `backend/yarn.lock:12672-12682`:

```
"lodash@npm:^4.17.21, lodash@npm:^4.18.1":
  version: 4.18.1
  resolution: "lodash@npm:4.18.1"
  ...
"lodash@npm:~4.17.0":
  version: 4.17.23
  resolution: "lodash@npm:4.17.23"
```

- `backend/.yarnrc.yml` — only `nodeLinker`/`nmHoistingLimits`; no registry
  override, no `resolutions` in any manifest.
- Root `package.json` dependencies include `"@base-ui/react": "^1.6.0"`;
  `grep -rn "@base-ui" src/` → no matches; `src/components/ui/` contains
  only `pill.tsx` (imports just `@/lib/utils`).
- `README.md:19` (tech-stack table): "shadcn-style components on
  `@base-ui/react` · Lucide icons".

## Commands you will need

| Purpose                 | Command (working dir)                                              | Expected on success        |
| ----------------------- | ------------------------------------------------------------------ | -------------------------- |
| Backend install/regen   | `corepack yarn install` (in `backend/`)                            | exit 0, yarn.lock updated  |
| Backend immutable check | `corepack yarn install --immutable` (in `backend/`)                | exit 0, no changes         |
| Backend gates           | `corepack yarn check-types && corepack yarn build` (in `backend/`) | exit 0                     |
| Storefront install      | `npm install` (repo root)                                          | exit 0                     |
| Storefront gate         | `npm run check` (repo root)                                        | lint+typecheck+build green |
| Storefront units        | `npm test` (repo root)                                             | all pass                   |

## Scope

**In scope** (the only files you should modify — lockfiles change via the
package managers, never by hand):

- `backend/package.json` (the lodash line only)
- `backend/yarn.lock` (regenerated)
- `package.json` (remove `@base-ui/react` only)
- `package-lock.json` (regenerated)
- `README.md` (the one tech-stack line)
- `plans/README.md` — status row

**Out of scope** (do NOT touch):

- Any other dependency bump — `corepack yarn install` after a one-line pin
  change should produce a **small** lock diff; if it rewrites hundreds of
  unrelated entries, see STOP.
- `@types/lodash` — its 4.17.x line is real.
- `backend/.yarnrc.yml` — unless you discover a private mirror is
  intentional (STOP and report instead; the fix would then be documenting
  the mirror, not changing versions).
- Anything in `src/` — `pill.tsx` and friends work; only the manifest and
  README line change.

## Git workflow

- Branch: `advisor/030-dep-hygiene`
- Two commits, one per surface: `fix(backend): pin lodash to the real 4.17
line (regenerate lock)` and `chore(storefront): drop unused
@base-ui/react`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Correct the backend pin and regenerate

1. `backend/package.json:21` → `"lodash": "^4.17.21"`.
2. From `backend/`: `corepack yarn install`.
3. Inspect: `grep -n "lodash@npm" backend/yarn.lock` — the `^4.17.21`
   descriptor must resolve to `4.17.21`; the `~4.17.0` transitive should
   also land on `4.17.21`. `grep -c "4\.18\.1\|4\.17\.23" backend/yarn.lock`
   → 0.

**Verify**: `corepack yarn install --immutable` → exit 0 with no lockfile
drift; `git diff --stat backend/yarn.lock` shows a small, lodash-scoped
diff.

### Step 2: Prove the backend still builds and tests

**Verify**: `corepack yarn check-types && corepack yarn build` (in
`backend/`) → exit 0. If lodash is exercised anywhere at runtime it's
transitive utility usage — 4.17.21 is API-compatible with anything a
"4.18.1" could have offered (no such public API exists). Optionally run
`corepack yarn test:integration:smoke` (in `backend/packages/api`,
containers running) for extra confidence.

### Step 3: Remove @base-ui/react from the storefront

1. Confirm nothing new imports it since planning:
   `grep -rn "@base-ui" src/ scripts/ tests/` → no matches (if any match:
   STOP).
2. `npm ls @base-ui/react` → only the root direct dep (no other requirer).
   If some package peer-depends on it, STOP.
3. Remove the `"@base-ui/react"` line from `package.json` dependencies;
   `npm install` to regenerate `package-lock.json`.
4. `grep -c "@base-ui" package-lock.json` → 0.
5. `README.md:19`: change the UI-primitives cell to reflect reality, e.g.
   "shadcn-style components (Tailwind-only, `src/components/ui`) · Lucide
   icons".

**Verify**: `npm run check` → lint + typecheck + prod build all green;
`npm test` → all pass.

## Test plan

No new tests — the gates are the existing build/typecheck/test suites on
both surfaces, run in Steps 2 and 3. The regression this plan protects
against is install-time, and `--immutable` re-install is its test.

## Done criteria

Machine-checkable; ALL must hold:

- [ ] `grep -n '"lodash"' backend/package.json` → `"^4.17.21"`
- [ ] `grep -c "4\.18\.1" backend/yarn.lock` → 0 (and no `lodash@npm:4.17.23` entry)
- [ ] `corepack yarn install --immutable` (backend/) exits 0
- [ ] `corepack yarn check-types && corepack yarn build` (backend/) exit 0
- [ ] `grep -c "@base-ui" package.json package-lock.json src/ -r` → 0 matches total
- [ ] `npm run check` and `npm test` exit 0
- [ ] README tech-stack line no longer claims `@base-ui/react`
- [ ] Only in-scope files modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `corepack yarn install` **succeeds in fetching** a `lodash@4.18.x` from
  the network — that means a registry/mirror IS serving phantom versions;
  this becomes a supply-chain investigation (where is that package coming
  from, what's in it), not a pin fix. Capture `yarn config get
npmRegistryServer` and the resolution URL; do not install further.
- The lock regeneration produces a diff touching more than lodash + its
  integrity metadata (yarn deciding to re-resolve the world) — the operator
  should see that diff before it lands.
- `npm ls @base-ui/react` shows another requirer, or any `@base-ui` import
  exists outside `package.json`/lockfile/README.
- Any install step needs `--force`/`--legacy-peer-deps` to pass.

## Maintenance notes

- Where did `^4.18.1` come from? `backend/package.json` is the
  `create-mercur` monorepo root — the pin likely arrived with a template
  update or a hallucinated bump. After this plan, any future lockfile entry
  resolving a version the registry doesn't list should be treated as a
  red flag in review (it survived here since the lock was generated).
- If the operator intentionally runs a private npm mirror (STOP case),
  document it in `backend/.yarnrc.yml` (`npmRegistryServer`) so the lock's
  provenance is explicit.
- The gitleaks + audit CI jobs don't catch phantom-version pins; nothing
  automated guards this class. Cheap habit: `npm audit` / lock-diff review
  on dependency PRs.
