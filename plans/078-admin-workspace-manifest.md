# Plan 078: `apps/admin` declares the dependencies it imports

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 0f14da91..HEAD -- backend/apps/admin/package.json backend/package.json .github/dependabot.yml backend/yarn.lock`
> On a mismatch with the "Current state" excerpts, treat it as a STOP condition.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW/MED — a version disagreeing with the root resolution would duplicate installs; pinning to the already-resolved versions and proving the lock stays coherent removes that
- **Depends on**: none
- **Category**: deps
- **Planned at**: commit `0f14da91`, 2026-08-02

## Why this matters

`backend/apps/admin` imports seven packages it never declares — ~101 import
sites across 36 files resolved purely by yarn-workspace hoisting from
`backend/package.json`. The React-18 constraint this repo actively defends
(Dependabot PR #279 broke the react/react-dom pair; round 8 re-paired it and
added semver-major ignores) is expressed in a manifest that isn't the one the
admin app builds from. Concretely: bumping or removing `react-i18next` or
`@tanstack/react-query` at the backend root breaks the admin build with no
manifest signal, and the admin app cannot be reasoned about (or extracted)
independently.

## Current state

`backend/apps/admin/package.json:13-17` — the entire dependencies block:

```json
"dependencies": {
  "@acme/api": "workspace:*",
  "@acme/odds-math": "workspace:*",
  "@acme/pokemon": "workspace:*",
  "@mercurjs/admin": "2.1.6"
}
```

Undeclared-but-imported (site counts from the audit): `@medusajs/ui` (29),
`react` (21), `@medusajs/icons` (19), `react-router-dom` (15),
`react-i18next` (14), `@tanstack/react-query` (2), `react-dom` (1).

`backend/package.json` (root) currently supplies, among others:

```json
"@medusajs/ui": "4.1.1",
"@tanstack/react-query": "5.101.4",
"react": "^18.3.1",
"react-dom": "^18.3.1",
"react-i18next": "13.5.0",
"react-router-dom": "6.30.4",
```

(`@medusajs/icons` is declared elsewhere in that manifest or hoisted from
`@medusajs/*` — locate its resolved version in `backend/yarn.lock` in Step 1.)

`.github/dependabot.yml` — the `/backend` entry carries react/react-dom
semver-major ignores (comment at `~:64-72` explains the #279 half-bump). Note
Dependabot updates **per-directory manifests**; a `/backend` entry does not
automatically cover `backend/apps/admin/package.json`.

## Commands you will need

| Purpose            | Command (from `backend/`)                                                                                                                                                                 | Expected                                         |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Resolved versions  | `corepack yarn why react react-dom @medusajs/ui @medusajs/icons react-router-dom react-i18next @tanstack/react-query`                                                                     | one resolution each                              |
| Install after edit | `corepack yarn install`                                                                                                                                                                   | exit 0; lock diff limited to the new descriptors |
| Dedupe check       | `corepack yarn dedupe --check`                                                                                                                                                            | exit 0 (no duplicates introduced)                |
| Admin build        | from `backend/apps/admin`: `corepack yarn build` (global TS7 gotcha: verify types with `node ../../node_modules/typescript/bin/tsc -p tsconfig.json --noEmit` if tsc output looks insane) | exit 0                                           |

## Scope

**In scope**:

- `backend/apps/admin/package.json`
- `backend/yarn.lock` (mechanical result of install — new descriptor entries only)
- `.github/dependabot.yml` (one added directory entry, Step 3)

**Out of scope**:

- `backend/package.json` — do NOT remove the root's copies of these deps (the
  other workspaces and the hoist layout depend on them; deduplication of the
  root manifest is a separate decision).
- Any version BUMP of anything. This plan only declares what already resolves.
- `backend/apps/vendor` (dormant).

## Git workflow

- Branch: `advisor/078-admin-manifest`
- Conventional commit, e.g. `chore(admin): declare the app's real dependencies in its own manifest`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Pin to the already-resolved versions

Read the resolved version of each of the seven packages from
`backend/yarn.lock` (or `yarn why`). Add them to
`backend/apps/admin/package.json` `dependencies` using **the same range
specifiers the root uses** (e.g. `"react": "^18.3.1"`, exact pins where the
root pins exactly, like `"@medusajs/ui": "4.1.1"`) so both workspaces resolve
to the identical lock entry.

**Verify**: `corepack yarn install` exits 0, and
`git diff --stat backend/yarn.lock` shows a small diff (descriptor additions,
no new package versions); `corepack yarn dedupe --check` exits 0.

### Step 2: Prove the admin build and tests

From `backend/apps/admin`: `corepack yarn build` → exit 0;
`corepack yarn test` → all pass. From `backend/`: `corepack yarn check-types`
(turbo) → green across workspaces.

**Verify**: all three commands exit 0.

### Step 3: Extend the Dependabot guard to the new manifest

Add a `package-ecosystem: npm` entry for directory
`/backend/apps/admin` to `.github/dependabot.yml`, mirroring the `/backend`
entry's react/react-dom semver-major ignores AND the `@medusajs/*` /
`@mercurjs/*` minor+major ignores (the lockstep rationale in the existing
comment applies identically — reference it rather than duplicating the full
comment). Keep the same schedule/grouping style as the existing entries.

**Verify**: YAML parses — `node -e "const yaml=require('js-yaml');yaml.load(require('fs').readFileSync('.github/dependabot.yml','utf8'));console.log('ok')"`
(js-yaml is available transitively; if not, any YAML parse works, e.g.
`python -c "import yaml,sys;yaml.safe_load(open('.github/dependabot.yml'))"`).

## Test plan

No new test files — the verification gates (install coherence, dedupe check,
admin build, workspace typecheck) are the proof. State each command's result
in the report.

## Done criteria

- [ ] All seven packages declared in `backend/apps/admin/package.json` at
      root-matching ranges
- [ ] `corepack yarn install` clean; lock diff descriptor-only;
      `yarn dedupe --check` exits 0
- [ ] Admin build + admin vitest + workspace typecheck green
- [ ] Dependabot entry for `/backend/apps/admin` with the mirrored ignores
- [ ] No files outside scope modified; `plans/README.md` row updated

## STOP conditions

- `yarn install` resolves any of the seven to a DIFFERENT version than the
  root's (duplicate install) — report; do not force with resolutions.
- The lock diff includes version changes to unrelated packages.
- `@medusajs/icons` turns out to be reachable only as a transitive of
  `@mercurjs/admin` with no root declaration — then declare it at its
  resolved version and note that in the report (still in scope), but STOP if
  its resolved version conflicts with what `@mercurjs/admin` expects.

## Maintenance notes

- Future imports into `apps/admin` should come with a manifest entry; a
  depcheck-style lint is deliberately not added (one-time correction; add
  tooling only if the drift recurs).
- Reviewer: confirm zero version changes in the lock beyond added
  descriptors, and that the Dependabot entry's ignores exactly mirror the
  `/backend` ones (a partial mirror re-creates the #279 trap on the new
  manifest).
