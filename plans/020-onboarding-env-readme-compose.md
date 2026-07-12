# Plan 020: Make onboarding truthful — env template, README DB step, compose naming

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat e9ce6968..HEAD -- .env.example README.md docker-compose.yml`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.
>
> **Tooling constraint**: a `guard-secrets` PreToolUse hook in this repo
> BLOCKS any shell command that references `.env*` files (even `.env.example`).
> Use the file Read/Edit tools on `.env.example`, never `cat`/`grep`/`sed`
> via Bash. Never print values of any real `.env`/`.env.local` file.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: dx / docs
- **Planned at**: commit `e9ce6968`, 2026-07-12

## Why this matters

Three onboarding lies, each cheap to fix:

1. `.env.example` omits every `NEXT_PUBLIC_MEDUSA_*` variable. The publishable
   key has **no code fallback** and is the single most load-bearing storefront
   var — a dev who copies the template gets a storefront where every `/store`
   call 401s, with no hint why.
2. The README's "Running the backend" section assumes the `pokenic-postgres` /
   `pokenic-redis` Docker containers already exist; it gives no command to
   create them. Following the README verbatim on a fresh machine starts Medusa
   against a non-existent database (`KnexTimeoutError`).
3. `docker-compose.yml` still ships the clone template's identity
   (`ai-website-cloner` image/container names) in a repo whose product is
   PixelSlot/Pokenic — mislabeled artifacts for anyone using compose.

## Current state

- `src/lib/medusa.ts:18` (verified):
  ```ts
  publishableKey: process.env.NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY,
  ```
  No fallback. `src/lib/security/csp.ts:28-32` (verified) reads
  `NEXT_PUBLIC_MEDUSA_BACKEND_URL` (default `http://localhost:9000`) and
  `NEXT_PUBLIC_MEDIA_HOST` (optional; gates prod media origins in the CSP).
- `.env.example` currently documents only (key names, no values):
  `NEXT_PUBLIC_FEATURE_MARKETPLACE`, `NEXT_PUBLIC_FEATURE_PACK_PARTY`,
  `NEXT_PUBLIC_SITE_URL`, `NEXT_PUBLIC_SENTRY_DSN`, `SENTRY_ORG`,
  `SENTRY_PROJECT`, `SENTRY_AUTH_TOKEN`. Zero `NEXT_PUBLIC_MEDUSA_*` keys
  (verified via key-name grep).
- `README.md` "Running the backend" (verified, ~lines 50-56):
  ```
  # Postgres + Redis stay up via Docker (--restart unless-stopped)
  cd backend/packages/api && corepack yarn dev     # Medusa API on :9000 (health: /health)
  cd backend/apps/admin   && node ../../node_modules/vite/bin/vite.js   # Admin on :7000
  ```
  The comment names the containers but no creation command exists anywhere in
  README. First-time creation currently lives only in `scripts/sim/provision.mjs`
  and the `launching-pokenic-stack` Claude skill.
- `docker-compose.yml:7-8,39-40` (verified):
  ```yaml
  image: ai-website-cloner:latest
  container_name: ai-website-cloner
  ...
  image: ai-website-cloner:dev
  container_name: ai-website-cloner-dev
  ```
- The backend publishable key is minted by
  `backend/packages/api` script `deploy:init` (runs
  `medusa exec ./src/scripts/print-publishable-key.ts`).

## Commands you will need

| Purpose               | Command                         | Expected on success               |
| --------------------- | ------------------------------- | --------------------------------- |
| Storefront check      | `npm run check`                 | exit 0 (lint + typecheck + build) |
| Compose config sanity | `docker compose config --quiet` | exit 0, no schema errors          |

## Scope

**In scope** (the only files you should modify):

- `.env.example`
- `README.md`
- `docker-compose.yml`

**Out of scope** (do NOT touch, even though they look related):

- `.env`, `.env.local`, or any file with real values — never read or edit.
- `backend/packages/api/.env.template` — backend env docs are a separate
  concern (see plans/README.md Round 3 notes).
- `scripts/serve-standalone.ps1`, `scripts/preview.ps1`, `scripts/sim/*` —
  behavior stays as-is; README only gains a pointer.
- `next.config.ts`, `src/lib/medusa.ts`, `src/lib/security/csp.ts` — code is
  correct; only the template/docs lag.

## Git workflow

- Branch: `advisor/020-onboarding-env-readme-compose`
- Commit style: conventional commits, e.g. `docs: document Medusa env vars, DB provisioning, and rename compose services`.
- Do NOT push or open a PR unless the operator instructed it.
- **Coordination note**: `package.json` and several backend files are dirty in
  the main working tree from other agents' work — none of this plan's three
  files overlap with plans 009–018 or the active worktrees.

## Steps

### Step 1: Add the Medusa vars to `.env.example`

Using the **Edit tool** (not shell — see Tooling constraint), append a
commented block. Keys and comments only, placeholder values:

```bash
# --- Medusa backend connection -------------------------------------------
# Backend origin. Unset = local dev default http://localhost:9000
# (matches src/lib/medusa.ts and the CSP allowlist in src/lib/security/csp.ts).
NEXT_PUBLIC_MEDUSA_BACKEND_URL=http://localhost:9000

# REQUIRED — no code fallback; without it every /store call 401s.
# Mint one from the backend: cd backend/packages/api && corepack yarn deploy:init
# (or `medusa exec ./src/scripts/print-publishable-key.ts` on an existing DB).
NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY=pk_...

# Optional: production media host (bare hostname, no scheme) added to the CSP
# img/media allowlist. Leave unset for local dev.
# NEXT_PUBLIC_MEDIA_HOST=
```

**Verify**: Read `.env.example` back with the Read tool → the three keys are
present exactly once each; no real secret value pasted.

### Step 2: Add a "Start the databases" step to README

In `README.md`, immediately before the "Running the backend" code block, add a
one-time provisioning block:

```bash
# One-time: create the shared dev containers (they then stay up via --restart)
docker run -d --name pokenic-postgres --restart unless-stopped -p 5432:5432 \
  -e POSTGRES_PASSWORD=postgres postgres:16
docker run -d --name pokenic-redis --restart unless-stopped -p 6379:6379 redis:7
```

and one sentence after it: subsequent boots need only
`docker start pokenic-postgres pokenic-redis` (what `scripts/preview.ps1`
does), and `scripts/sim/provision.mjs` can bootstrap a seeded environment.

**Note**: check `scripts/sim/provision.mjs` (read-only) for the images/ports it
uses; if it pins different image tags or ports than shown above, use _its_
values — the sim provisioner is the source of truth for what the backend
expects.

**Verify**: `grep -n "pokenic-postgres" README.md` → at least one match inside
a `docker run` line.

### Step 3: Rename the compose identity

In `docker-compose.yml`, replace the four template names:
`ai-website-cloner:latest` → `pixelslot-storefront:latest`,
`container_name: ai-website-cloner` → `pixelslot-storefront`,
`ai-website-cloner:dev` → `pixelslot-storefront:dev`,
`ai-website-cloner-dev` → `pixelslot-storefront-dev`.
Do not change service keys (`app`, `dev`) — README commands
(`docker compose up app --build`) depend on them.

**Verify**: `docker compose config --quiet` → exit 0, and
`grep -c "ai-website-cloner" docker-compose.yml` → `0`.

### Step 4: Full storefront gate

**Verify**: `npm run check` → exit 0. (No source changed; this catches an
accidental stray edit.)

## Test plan

Docs/config only — the verification gates above are the test. No new specs.

## Done criteria

- [ ] `.env.example` documents `NEXT_PUBLIC_MEDUSA_BACKEND_URL`,
      `NEXT_PUBLIC_MEDUSA_PUBLISHABLE_KEY`, `NEXT_PUBLIC_MEDIA_HOST`
- [ ] README has a copy-pasteable first-time DB provisioning step before the
      backend run commands
- [ ] `grep -c "ai-website-cloner" docker-compose.yml` → 0; service keys
      `app`/`dev` unchanged
- [ ] `npm run check` exits 0
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The guard-secrets hook blocks even Read/Edit-tool access to `.env.example`
  (then the template must be edited by the operator).
- `scripts/sim/provision.mjs` provisions Postgres/Redis in a way that
  contradicts the container names above (different names, a compose file, or
  cloud-only) — report what it actually does instead of guessing README text.
- `docker compose config` fails for a reason unrelated to your rename.

## Maintenance notes

- If the backend URL, key-minting script, or media host handling changes,
  `.env.example` must move with it — it is now the documented contract.
- Deliberately deferred: a matching sweep of
  `backend/packages/api/.env.template` vs the env vars api code actually reads
  (`PRICECHARTING_API_TOKEN`, `FX_USD_MYR_URL`, `REWARDS_REDEMPTION_ENABLED`,
  `COMMISSION_COOLDOWN_DAYS`, `STOREFRONT_URL`, `MERCUR_STOREFRONT_URL`) —
  blocked on the same secrets-hook constraint; needs the operator.
