# Plan 105: Clear the nanoid high advisory on the storefront build path

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `npm audit --omit=dev` (repo root). If nanoid no
> longer appears, the advisory cleared upstream — mark this plan DONE
> (no change needed) in `plans/README.md` and stop.

## Status

- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: deps
- **Planned at**: commit `5c74ce17`, 2026-08-15

## Why this matters

`npm audit --omit=dev` at the repo root reports exactly one high advisory:
`nanoid <3.3.18` (GHSA-2v37-7h3g-55p8, infinite loop on zero-size generators).
Installed: 3.3.16, reached via `next@16.2.12 → postcss@8.5.23 → nanoid`. Real
exposure is low (build-toolchain only; the vulnerable path needs `size: 0`,
which nothing here passes) — but it is the single high keeping the root audit
red, and it is a patch-level transitive bump `next` does not pin against. This
repo's recorded dependency lessons apply: alerts only recompute on the default
branch, and a closed Dependabot PR is not a fixed CVE — verify the tree, not
the dashboard.

## Current state

- `npm ls nanoid --omit=dev` (verified at plan time):

```
polycards-game@1.0.0-rc
`-- next@16.2.12
  `-- postcss@8.5.23
    `-- nanoid@3.3.16
```

- Root `package.json` already has an `overrides` block (`postcss: ^8.5.23`,
  `sharp: $sharp`) — the pattern to extend if `npm audit fix` alone doesn't
  take.
- Build command: `npm run build` (webpack flag included via the script).

## Commands you will need

| Purpose    | Command                           | Expected                      |
| ---------- | --------------------------------- | ----------------------------- |
| Audit      | `npm audit --omit=dev`            | AFTER: 0 high                 |
| Fix        | `npm audit fix` (NEVER `--force`) | lockfile-only change          |
| Tree check | `npm ls nanoid --omit=dev`        | nanoid ≥3.3.18                |
| Full gate  | `npm run check`                   | exit 0 (lint+typecheck+build) |
| Tests      | `npm test`                        | all pass                      |

## Scope

**In scope**: `package-lock.json`; `package.json` ONLY if an `overrides` entry
(`"nanoid": "^3.3.18"`) is required because `npm audit fix` can't satisfy the
range.

**Out of scope**: every other dependency; `--force` anything; the backend
lockfile (its known advisories are Medusa-pinned and recorded as blocked —
mikro-orm, react-router, brace-expansion; do not touch).

## Git workflow

- Branch: `advisor/105-nanoid-bump`
- One commit: `chore(deps): bump transitive nanoid past GHSA-2v37-7h3g-55p8`.
- No push/PR without operator instruction.

## Steps

### Step 1: patch bump

`npm audit fix`. Inspect `git diff package-lock.json` — the change should be
nanoid version+integrity lines (and at most sibling metadata). If nanoid is
still <3.3.18 (`npm ls nanoid --omit=dev`), add the override to `package.json`
and run `npm install`.

**Verify**: `npm audit --omit=dev` → 0 high; `npm ls nanoid --omit=dev` →
≥3.3.18.

### Step 2: prove the build

`npm run check` (build included — postcss runs inside it) and `npm test`.

**Verify**: both exit 0.

## Test plan

No new tests — the gate is the audit result plus the full existing check/test
suite passing on the bumped tree.

## Done criteria

- [ ] `npm audit --omit=dev` reports 0 high
- [ ] `npm run check` and `npm test` green
- [ ] Diff touches only the lockfile (+ the override if needed)
- [ ] `plans/README.md` row updated

## STOP conditions

- `npm audit fix` wants to change anything besides nanoid's subtree — abort
  the fix (`git checkout package-lock.json`), use the targeted override path
  only.
- The override breaks `npm run build` (postcss incompatibility — not expected
  for a patch range) — revert and report; the advisory then waits for the next
  Next bump, recorded as blocked.

## Maintenance notes

- Remove the override (if added) at the next `next` major/minor that carries
  postcss with nanoid ≥3.3.18 — check with `npm ls nanoid` after Next bumps.
