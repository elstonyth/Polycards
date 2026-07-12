# Plan 019: Make CI type-check `backend/packages/api`

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat e9ce6968..HEAD -- backend/packages/api/package.json backend/turbo.json .github/workflows/ci.yml`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: dx
- **Planned at**: commit `e9ce6968`, 2026-07-12

## Why this matters

The CI backend gate runs `corepack yarn check-types`, which is a Turborepo task
that only executes in packages that **define** a `check-types` script.
`backend/packages/api` — the largest TypeScript surface in the repo (all API
routes, workflows, and the 4,200-line packs service) — defines no such script,
so CI silently skips it. `medusa build` is SWC transpile-only and does not
type-check. The repo's own Stop hook comment records the consequence: _"a red
build can survive an entire session unseen (it did once)."_ Today the only api
type-check is a local Claude Code Stop hook (`.claude/hooks/stop-verify.js`,
`runTsc("backend")`) — contributors not using Claude Code, and CI itself, get
no TypeScript check on the api package.

## Current state

- `backend/packages/api/package.json` — scripts block (verified 2026-07-12):
  `build`, `seed`, `deploy:init`, `deploy:migrate-user`, `start`, `dev`,
  `test:integration:http`, `test:integration:modules`, `test:unit`.
  **No `check-types`.**
- `backend/turbo.json` — the task exists and cascades:
  ```json
  "check-types": { "dependsOn": ["^check-types"] }
  ```
  Turbo only runs it where a package defines the script. `odds-math` and
  `pokemon` packages define one (`backend/packages/odds-math/package.json`,
  `backend/packages/pokemon/package.json`); admin/vendor are covered by their
  `build` (`tsc -b && vite build`). Only api is a hole.
- `.github/workflows/ci.yml` (backend-quality job, ~line 134):
  ```yaml
  - name: Type check
    working-directory: backend
    run: corepack yarn check-types
  ```
  No CI change is needed — once api defines the script, this existing step
  picks it up.
- `backend/packages/api/tsconfig.json` exists with `include`/`exclude`
  configured (verified).
- `.claude/hooks/stop-verify.js:4-7` — the hook that currently compensates
  locally: _"`medusa develop`/`medusa exec`/`next dev` are SWC transpile-only
  and DO NOT type-check, so a red build can survive an entire session unseen
  (it did once)."_ Because this hook has been blocking sessions on backend
  type errors, the api package is expected to currently type-check clean.

## Commands you will need

| Purpose                | Command                                                | Expected on success                  |
| ---------------------- | ------------------------------------------------------ | ------------------------------------ |
| Install (backend)      | `cd backend && corepack yarn install --immutable`      | exit 0                               |
| New script directly    | `cd backend/packages/api && corepack yarn check-types` | exit 0, no errors                    |
| Turbo pipeline         | `cd backend && corepack yarn check-types`              | api appears in the task list, exit 0 |
| Backend build (sanity) | `cd backend && corepack yarn build`                    | exit 0                               |

## Scope

**In scope** (the only files you should modify):

- `backend/packages/api/package.json` — add one script.

**Out of scope** (do NOT touch, even though they look related):

- `.github/workflows/ci.yml` — the existing step picks the script up; no edit.
- `backend/turbo.json` — task already defined.
- `.claude/hooks/stop-verify.js` — keep as fast local feedback; unrelated.
- Any `.ts` source fix beyond the trivial threshold in the STOP conditions.

## Git workflow

- Branch: `advisor/019-backend-api-ci-typecheck` (repo convention:
  `advisor/NNN-<slug>`, see branch `advisor/009-card-edit-markup-bound`).
- Commit style: conventional commits, e.g. `ci(backend): type-check packages/api via turbo check-types`.
- Do NOT push or open a PR unless the operator instructed it.
- **Coordination note**: several agent worktrees are active on this repo
  (plans 009–018). None touch `backend/packages/api/package.json` scripts, so
  merge conflict risk is minimal.

## Steps

### Step 1: Add the `check-types` script

In `backend/packages/api/package.json`, add to `"scripts"`:

```json
"check-types": "tsc --noEmit"
```

Match the exact key name `check-types` (that is the turbo task name; `odds-math`
uses the same key — mirror it).

**Verify**: `cd backend/packages/api && corepack yarn check-types` → exit 0,
no output errors. If it reports type errors, see STOP conditions.

### Step 2: Confirm turbo picks it up

**Verify**: `cd backend && corepack yarn check-types` → the turbo output lists
the api package (e.g. `@mercurjs/api:check-types` or the package's actual name
from its package.json `name` field) among executed tasks, and exits 0.

### Step 3: Confirm the build is unaffected

**Verify**: `cd backend && corepack yarn build` → exit 0 (no behavior change
expected; this guards against a tsconfig interaction).

## Test plan

No new tests — this plan adds a static gate, not behavior. The verification
gates above are the test.

## Done criteria

- [ ] `backend/packages/api/package.json` contains a `check-types` script
- [ ] `cd backend && corepack yarn check-types` exits 0 and includes the api package
- [ ] `cd backend && corepack yarn build` exits 0
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `tsc --noEmit` in the api package reports **more than 5 pre-existing type
  errors**, or any error that requires changing runtime behavior to fix. (Up to
  5 trivially mechanical fixes — a missing type import, an obvious annotation —
  may be made; list them in your report.)
- The api `tsconfig.json` proves unusable for a `--noEmit` check (e.g. it
  errors on Medusa's generated `.medusa` types). Do not start editing
  tsconfig include/exclude beyond adding an obvious generated-artifacts
  exclude — report instead.
- Turbo does not pick up the script after Step 1 (name mismatch or pipeline
  filter you'd have to modify).

## Maintenance notes

- Once this lands, a red type error in api fails CI's existing "Type check"
  step — expect occasional CI failures that used to be invisible; that is the
  point.
- The local Stop hook (`stop-verify.js`) stays as fast in-session feedback;
  if the hook and CI ever disagree, trust CI (`tsc` against the committed
  tsconfig) and fix the hook's `_tslib.js` invocation.
- Reviewer scrutiny: only that the script string is `tsc --noEmit` and no
  tsconfig semantics changed.
