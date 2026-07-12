# Plan 028: Onboarding truth round 2 — fix the guard-secrets over-block, finish .env.example, and scrub the README's dead pointers

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat dbce0561..HEAD -- README.md backend/packages/api/README.md backend/apps/admin/README.md tests/e2e/README.md tests/e2e/helpers/constants.ts .env.example`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S–M
- **Risk**: LOW
- **Depends on**: none (supersedes the BLOCKED step 1 of plan 020)
- **Category**: dx / docs
- **Planned at**: commit `dbce0561`, 2026-07-13

## Why this matters

The public README is the only onboarding doc that ships, and it currently
dead-ends at every cross-reference: the backend provisioning step invokes
`scripts/launch-stack.ps1`, which is **git-excluded** (exists only on the
operator's machine — `.git/info/exclude:46`); the "Project Structure"
section names root `AGENTS.md` / `CLAUDE.md` and the Deployment section
names `docs/HANDOFF.md`, all deliberately gitignored (`.gitignore:106-107,
122`); the README's flagship feature is "a claw machine" at `/claw`, but
that route was deleted — `/slots` is the live product. A fresh clone cannot
provision the backend from committed instructions, and the one env var with
no code fallback (`NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY` —
`src/lib/medusa.ts:18`) is still missing from `.env.example`, so every
`/store` call 401s for a new contributor.

The root cause of the `.env.example` gap is the `.claude/hooks/guard-secrets.js`
regex, which blocks agents from reading/editing **any** `.env.*` path —
including committed, secret-free templates. Round-3 plan 020 step 1 has been
BLOCKED on exactly this since 2026-07-12. Fixing the regex unblocks this
plan's own Step 2 and all future template audits.

Finally, `tests/e2e/helpers/constants.ts` commits a seeded admin-password
fallback into the repo — a hygiene item to make env-required.

## Current state

Files and facts (all verified at `dbce0561`):

- `.claude/hooks/guard-secrets.js:28-33` (untracked local config —
  `.claude/` is gitignored):

```js
const isSecretPath = (p) => {
  const s = norm(p);
  if (/(^|\/)\.env(\.[A-Za-z0-9_.-]+)?$/.test(s)) return true;
  if (/(^|\/)deploy\/[A-Za-z0-9_.-]+\.app\.yaml$/.test(s)) return true;
  return false;
};
```

The first regex matches `.env.example` and `.env.template` (committed
templates) as well as real `.env` files. The hook's own header says its
intent is live secrets.

- `src/lib/medusa.ts:3-19` — `NEXT_PUBLIC_MEDUSA_BACKEND_URL` has fallback
  `http://localhost:9000`; `NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY` has **no
  fallback** and is passed straight to the SDK.
- `README.md` (root): line ~5 "a claw machine"; line ~9 lists `/claw` among
  headline routes (no `src/app/claw` exists; `src/app/slots` does); lines
  ~52-56 tell first-time users to run `pwsh scripts/launch-stack.ps1`; line
  ~95 and ~111-113 reference `docs/research/` (gitignored); lines ~114-115
  reference root `AGENTS.md` ("single source of truth") and `CLAUDE.md`;
  line ~120 references `docs/HANDOFF.md`. The committed operational doc that
  actually exists is `.do/README.md`.
- `backend/packages/api/README.md:54-58` — prerequisites point at the same
  `launch-stack.ps1` for first-time container creation.
- `backend/apps/admin/README.md` — verbatim unmodified Vite scaffold
  boilerplate ("React + TypeScript + Vite … This template provides a
  minimal setup"), no real content about this admin app.
- `tests/e2e/README.md` — coverage table lists 3 of 9 specs
  (`customer`, `admin`, `odds-reflection`; missing `bulk-sell`,
  `card-management`, `delivery-request`, `rewards`, `ship-orders`,
  `slot-vault-room`); line ~27 references "root `CLAUDE.md`" (gitignored).
- `tests/e2e/helpers/constants.ts:13-16` — seeded operator email and a
  **committed password fallback** for `PW_ADMIN_PASSWORD` (credential type:
  seeded admin password; value deliberately not reproduced here). `PK`
  fallback at :8-10 is a publishable key — client-public by design, fine to
  keep.
- Dev containers the docs must describe: `pokenic-postgres` (Postgres 16,
  user/db `medusa`) and `pokenic-redis` (Redis 7), both
  `--restart unless-stopped` (root README "Running the backend" section).
  The exact credentials/ports to document live in the tracked
  `backend/packages/api/.env.template` — readable only **after** Step 1.

## Commands you will need

| Purpose           | Command (working dir)                               | Expected on success      |
| ----------------- | --------------------------------------------------- | ------------------------ |
| Storefront gate   | `npm run typecheck` then `npm run lint` (repo root) | exit 0                   |
| E2E specs compile | `npx playwright test --list` (repo root)            | prints spec list, exit 0 |
| Grep checks       | see Done criteria                                   | as stated                |

## Scope

**In scope** (the only files you should modify):

- `.claude/hooks/guard-secrets.js` (local config — see Step 1 notes)
- `.env.example`
- `README.md`
- `backend/packages/api/README.md` (prerequisites section only)
- `backend/apps/admin/README.md`
- `tests/e2e/README.md`
- `tests/e2e/helpers/constants.ts` + whichever e2e helper asserts the admin
  password at use (Step 6)
- `plans/README.md` — status row

**Out of scope** (do NOT touch):

- `.github/workflows/e2e.yml` — its ephemeral-CI password fallback is a
  documented tradeoff (the DB lives and dies with the job); changing CI
  secret wiring is the operator's call.
- `.gitignore` — the local-only policy for `AGENTS.md`/`CLAUDE.md`/`docs/`
  is deliberate; this plan makes the README stop contradicting it, not
  reverse it.
- `scripts/launch-stack.ps1` — it's operator-local; do not create a tracked
  file with that name (Step 3 inlines the docker commands instead).
- `src/lib/medusa.ts` — the no-fallback publishable key is correct (a wrong
  baked-in key would be worse than a loud missing one).
- Real `.env` / `.env.local` / `deploy/*.app.yaml` files — never open these.

## Git workflow

- Branch: `advisor/028-onboarding-truth-2`
- Conventional commits, e.g. `docs: repair onboarding path (env template, provisioning commands, dead refs)`
- Note: the `guard-secrets.js` change can never be committed (`.claude/` is
  gitignored) — it lands as a local-config edit plus a written handoff note
  to the operator (Step 1).
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Exempt committed env templates in guard-secrets.js

In `isSecretPath`, before the dotenv regex, add:

```js
if (/\.env\.(example|template)$/.test(s)) return false;
```

Apply the same edit to **every copy of the hook that exists on this
machine**: the tree you are working in, and the main tree at
`C:\Users\PC\Desktop\Projects\PixelSlot\.claude\hooks\guard-secrets.js` if
present (the file is untracked, so git will not propagate it between
worktrees — editing only your worktree's copy leaves the operator's main
sessions still blocked). List in your report which copies you touched.

**Verify**: Read `.env.example` with the Read tool → succeeds (no hook
block). Read `backend/packages/api/.env.template` → succeeds. Attempt to
read `.env.local` (if it exists) → still **blocked**. If `.env.local` is not
blocked after your change, revert and STOP — the regex edit is wrong.

### Step 2: Complete `.env.example` (finishes plan 020 step 1)

Read `.env.example`. Append the Medusa client vars if absent, placeholders
only — never a real key:

```bash
# Medusa backend (see backend/) — the storefront 401s on every /store call
# without a valid publishable key (src/lib/medusa.ts has no fallback for it).
NEXT_PUBLIC_MEDUSA_BACKEND_URL=http://localhost:9000
# Obtain: seeded on first backend deploy (deploy:init prints it), or
# Admin dashboard → Settings → Publishable API keys.
NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY=pk_REPLACE_ME
```

Cross-check: `grep -rn "NEXT_PUBLIC_" src/ --include="*.ts" --include="*.tsx" -h -o | sort -u`
— any other `NEXT_PUBLIC_*` var read by `src/` that is missing from
`.env.example` gets a line too (with a placeholder and one-line comment).

**Verify**: `grep -c "NEXT_PUBLIC_MEDUSA" .env.example` → ≥2. No string
starting `pk_` other than `pk_REPLACE_ME` appears in the file.

### Step 3: Root README — replace the dead provisioning pointer and fix the flagship

1. Read `backend/packages/api/.env.template` (now unblocked) and note the
   Postgres credentials/port the backend expects. Then replace the
   `launch-stack.ps1` instruction in README's "Running the backend" with
   inline, copy-pastable creation commands, e.g. (adjust user/password/db to
   what `.env.template` actually says):

```bash
docker run -d --name pokenic-postgres --restart unless-stopped \
  -e POSTGRES_USER=medusa -e POSTGRES_PASSWORD=<from .env.template> -e POSTGRES_DB=medusa \
  -p 5432:5432 postgres:16
docker run -d --name pokenic-redis --restart unless-stopped -p 6379:6379 redis:7
```

Keep the existing "thereafter `docker start pokenic-postgres
   pokenic-redis`" sentence. You may mention that operators with the
local-only `scripts/launch-stack.ps1` can use it instead — but the
committed path must be self-sufficient. 2. Line ~5 and ~9: replace the "claw machine" framing and the `/claw` route
mention with `/slots` (the slot-machine pack opening). While there, spot-check
the other routes named on line 9 against `ls src/app` and drop any that
no longer exist. 3. Lines ~114-115: replace the `AGENTS.md`/`CLAUDE.md` entries with one
truthful line (e.g. "AI-agent config lives in untracked local files —
see `.gitignore` 'Private' section") or delete them. 4. Line ~120: point Deployment at `.do/README.md` (which exists and is
tracked) instead of `docs/HANDOFF.md`. 5. Lines ~95, ~111-113: mark `docs/research/` as local-only (not shipped) or
drop the references.

**Verify**: `grep -n "launch-stack\|HANDOFF\|/claw\b" README.md` → no
matches. `grep -n "AGENTS.md" README.md` → no matches (or only inside the
truthful local-config note).

### Step 4: Backend API README prerequisites

`backend/packages/api/README.md:54-58`: replace the "create them per the
root `README.md` … e.g. `pwsh scripts/launch-stack.ps1`" sentence with a
pointer to the root README's (now inline) docker commands. Leave the rest of
the runbook untouched — plan 025 wrote it and it verified clean.

**Verify**: `grep -n "launch-stack" backend/packages/api/README.md` → no matches.

### Step 5: Admin README and E2E README

1. `backend/apps/admin/README.md`: replace the Vite boilerplate with a short
   real runbook (~15 lines): what it is (admin dashboard for the Medusa
   backend, Vite + React, mounts `@mercurjs/admin`), how to run it
   (`node ../../node_modules/vite/bin/vite.js` per root README, port 7000),
   test/lint commands (`corepack yarn test`, `corepack yarn lint`), and
   where the seeded admin credentials come from (`create-admin.ts` via
   `deploy:migrate-user` — do not print any credential values).
2. `tests/e2e/README.md`: add the six missing specs to the coverage table
   (`bulk-sell`, `card-management`, `delivery-request`, `rewards`,
   `ship-orders`, `slot-vault-room` — one line each describing the flow, read
   each spec's header comment for the wording); fix the "root `CLAUDE.md`"
   reference at line ~27 (point at this README itself or drop it); document
   the `PW_ADMIN_PASSWORD` env requirement introduced by Step 6.

**Verify**: `grep -c "spec.ts" tests/e2e/README.md` → ≥9.
`grep -n "This template provides" backend/apps/admin/README.md` → no matches.

### Step 6: Make the e2e admin password env-required

In `tests/e2e/helpers/constants.ts`, change the `ADMIN_PASSWORD` export to
read `process.env.PW_ADMIN_PASSWORD ?? ''` (drop the committed literal).
Then find the sign-in helper that uses it (grep `ADMIN_PASSWORD` under
`tests/e2e/`) and add a fail-fast guard **at use time** (not at module load
— constants is imported by specs that never touch admin):

```ts
if (!ADMIN_PASSWORD) {
  throw new Error(
    "PW_ADMIN_PASSWORD is not set — export it to match your stack's seeded admin (see tests/e2e/README.md).",
  );
}
```

Leave the `PK` publishable-key fallback as-is (client-public by design).
Record in your report, for the operator: the removed password literal was
committed to git history — rotate that seeded admin credential on any
persistent stack (local shared dev DB, staging) that used it. Do not print
the value.

**Verify**: `npx playwright test --list` → exit 0 (specs still compile).
`grep -rn "pokenicadmin" tests/e2e/helpers/constants.ts` → no matches
(pattern chosen to catch the literal's prefix without reproducing it here —
if that grep already returns nothing before your edit, check `git log -p`
drift and STOP if the fallback moved elsewhere).

## Test plan

No new automated tests — this is docs + config truth. The executable checks
are: the two hook-block probes in Step 1, `npx playwright test --list`, and
the grep gates in Done criteria. Additionally do one manual trace: follow
your rewritten README from "clone" to "backend containers running" and
confirm every command exists in the repo.

## Done criteria

Machine-checkable; ALL must hold:

- [ ] Read tool succeeds on `.env.example` and `backend/packages/api/.env.template`; still blocks `.env.local`
- [ ] `grep -c "NEXT_PUBLIC_MEDUSA" .env.example` ≥ 2; no real `pk_` value in the file
- [ ] `grep -rn "launch-stack" README.md backend/packages/api/README.md` → no matches
- [ ] `grep -n "HANDOFF\|/claw\b" README.md` → no matches
- [ ] `grep -c "spec.ts" tests/e2e/README.md` ≥ 9
- [ ] `grep -n "This template provides" backend/apps/admin/README.md` → no matches
- [ ] No committed admin-password literal remains in `tests/e2e/helpers/constants.ts`
- [ ] `npm run typecheck` and `npm run lint` exit 0; `npx playwright test --list` exits 0
- [ ] No files outside the in-scope list modified (`git status`)
- [ ] `plans/README.md` status row updated (and mark plan 020 fully DONE — its blocked step is resolved here)

## STOP conditions

Stop and report back (do not improvise) if:

- After the Step 1 edit, the hook still blocks `.env.example` (a second
  enforcement layer exists — find out where before editing anything else),
  or stops blocking `.env.local` (regex wrong — revert).
- `backend/packages/api/.env.template` turns out to contain a real secret
  value (not a placeholder) — do not copy anything from it; report the
  credential type + line for rotation.
- `.env.example` already contains `NEXT_PUBLIC_MEDUSA_*` lines (operator did
  it by hand since the audit) — skip Step 2, note it, continue.
- The e2e admin sign-in helper derives the password from anywhere other than
  `constants.ts` (drift).

## Maintenance notes

- The hook edit is **machine-local and uncommittable**. Hand the operator a
  one-paragraph note (in your completion report) so they can replicate it on
  other machines; if the `.claude/` tree ever becomes tracked, this exemption
  should ride along.
- Future env vars: the convention this plan cements is "every
  `NEXT_PUBLIC_*` var read in `src/` has a placeholder line in
  `.env.example`". Reviewers should hold new storefront PRs to it.
- The e2e suite now requires `PW_ADMIN_PASSWORD` locally; CI (e2e.yml) sets
  its own env and is unaffected. If someone reports "e2e suddenly needs a
  password", point them at tests/e2e/README.md.
- Deferred deliberately: committing a cross-platform provisioning script
  (bash + ps1) — inline commands serve until a third platform appears.
