# Plan 023: Revive the disabled storefront→backend E2E money-loop specs

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat e9ce6968..HEAD -- tests/e2e/ src/app/slots src/app/(account)/vault`
> If the specs or the slots/vault UI changed since this plan was written,
> compare the "Current state" excerpts against the live code before
> proceeding; on a mismatch, re-read the changed UI before re-selectoring
> (that is expected work here, not a STOP) — STOP only if a whole flow is gone.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW — test-only change; worst case is a flaky spec (Playwright
  retries are already configured).
- **Depends on**: none (needs a locally running stack — see Commands)
- **Category**: tests
- **Planned at**: commit `e9ce6968`, 2026-07-12

## Why this matters

The only deterministic end-to-end coverage of the money loop **spanning
storefront + backend** — `signup → top up → open → keep → vault → sell-back` —
is currently disabled: six specs are `test.fixme` because the slots/vault
redesigns removed the UI they drove. Until they're re-authored, the money loop
is verified only by per-route HTTP specs in isolation and by the
non-deterministic LLM-driven sim harness. A regression that only manifests
when the storefront action and the backend workflow disagree (buyback percent,
credit rounding, vault→delivery handoff) would ship green today.

## Current state

All verified 2026-07-12.

- Disabled specs (`grep -n "test.fixme" tests/e2e/*.spec.ts`):
  - `tests/e2e/customer.spec.ts:20` — `test.fixme('signup → top up → open → keep → vault → sell-back', ...)` (the flagship)
  - `tests/e2e/customer.spec.ts:92` — `test.fixme('anonymous demo spin creates NO backend pull', ...)`
  - `tests/e2e/bulk-sell.spec.ts:17` — bulk-sell via UI
  - `tests/e2e/delivery-request.spec.ts:17` — delivery request via UI
  - `tests/e2e/odds-reflection.spec.ts:74` and `:102` — 100%-odds headline tests
- `tests/e2e/README.md` (~line 55): _"Drift note (2026-07-07): `customer`,
  `bulk-sell`, `delivery-request`, and the `odds-reflection` headline are
  currently `test.fixme` — they drive UI the slots/vault redesigns removed and
  need re-authoring (see each file's header)."_ Endpoints/creds overridable via
  `PW_BASE`, `PW_ADMIN`, `PW_BACKEND`, `PW_PK`, `PW_ADMIN_EMAIL`,
  `PW_ADMIN_PASSWORD` (see `tests/e2e/helpers/constants.ts`).
- `playwright.config.ts:5-6`: _"Services are expected to already be running
  (see tests/e2e/README.md). There is no webServer block on purpose — the
  storefront must be the production [standalone build]"_. Retries configured
  at `playwright.config.ts:16`.
- The current slots UI lives in `src/app/slots/[slug]/` (client:
  `SlotMachineClient.tsx` — note: this file has small uncommitted changes in
  the main working tree at planning time); the vault UI in
  `src/app/(account)/vault/VaultClient.tsx` (selection model: a
  `selected: Set<string>` with per-tile toggle buttons, grid capped at 500).
- Each disabled spec's file header describes what its old selectors expected —
  read those headers first; they are the re-authoring TODO list.

## Commands you will need

| Purpose                | Command                                                                                                                                                                                                                                                                                                                                                                                                 | Expected on success                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Start full local stack | follow the `launching-pokenic-stack` skill if available; otherwise: `docker start pokenic-postgres pokenic-redis`, then `cd backend/packages/api && corepack yarn dev` (health: `http://localhost:9000/health`), then `npm run build && pwsh scripts/serve-standalone.ps1 -Port 4000`, then `cd backend/apps/admin && npm run dev` (vite on :7000 — the odds-reflection specs drive the admin UI there) | backend `/health` 200; storefront serves on :4000; admin loads on :7000 |
| Point Playwright at it | set `PW_BASE`/`PW_BACKEND` per `tests/e2e/helpers/constants.ts` defaults (check that file first — defaults may already match :4000/:9000)                                                                                                                                                                                                                                                               | —                                                                       |
| One spec, headed       | `npx playwright test customer --headed --project=e2e`                                                                                                                                                                                                                                                                                                                                                   | pass                                                                    |
| Full e2e               | `npx playwright test`                                                                                                                                                                                                                                                                                                                                                                                   | pass                                                                    |
| Report                 | `npx playwright show-report tests/e2e/.report`                                                                                                                                                                                                                                                                                                                                                          | opens report                                                            |

**Never verify against `next dev`** — repo rule; the standalone production
build is the only trustworthy serving mode (`next.config.ts` sets
`output: 'standalone'`, which breaks `npx next start`).

## Suggested executor toolkit

- The `launching-pokenic-stack` project skill (if available in your
  environment) automates backend + storefront startup and seeded logins — use
  it instead of hand-rolling the stack.
- Playwright MCP/codegen is NOT required; prefer role/name selectors
  (`getByRole`, `getByLabel`) over CSS so the next redesign doesn't re-break
  the suite.

## Scope

**In scope** (the only files you should modify):

- `tests/e2e/customer.spec.ts`
- `tests/e2e/bulk-sell.spec.ts`
- `tests/e2e/delivery-request.spec.ts`
- `tests/e2e/odds-reflection.spec.ts`
- `tests/e2e/helpers/*` (only if a shared helper needs a selector update)
- `tests/e2e/README.md` (remove/update the drift note when done)
- `plans/README.md` (this plan's status row only)

**Out of scope** (do NOT touch, even though they look related):

- ANY file under `src/` or `backend/` — if a spec can only pass by changing
  product code, that's a STOP (you may have found a real bug; report it).
- `playwright.config.ts` — no webServer block, no retry changes.
- `scripts/qa-*.mjs` visual scripts.

## Git workflow

- Branch: `advisor/023-revive-e2e-money-loop`
- Commit style: conventional commits, e.g. `test(e2e): re-author customer money-loop spec against redesigned slots/vault UI` — one commit per revived spec file.
- Do NOT push or open a PR unless the operator instructed it.
- **Coordination note**: no active plan/worktree touches `tests/e2e/`. The
  slots UI has pending uncommitted tweaks in the main tree — build from your
  branch's HEAD and re-run the drift check if it lands mid-work.

## Steps

### Step 1: Boot the stack and confirm the baseline

Start services (see Commands). Run the currently-enabled e2e suite to prove
the harness itself is green before touching anything.

**Verify**: `npx playwright test` → passes with the six `fixme` tests reported
as skipped, zero failures.

### Step 2: Revive `customer.spec.ts` (the flagship, widest coverage)

Read the spec header + body. Walk the flow manually once (headed browser or
the running storefront) to learn the CURRENT selectors for: signup, top-up
(mock gateway), pack open on `/slots/[slug]`, the keep/sell choice, vault
listing, sell-back. Re-selector each step (prefer `getByRole`). Remove
`test.fixme` → `test`.

**Verify**: `npx playwright test customer --headed --project=e2e` → both tests
in the file pass. Run it twice to shake out first-pass flakiness.

### Step 3: Revive `bulk-sell.spec.ts`

The vault selection model is `VaultClient.tsx`'s `selected: Set<string>` with
per-tile toggle buttons and a bulk action bar. Re-selector accordingly.

**Verify**: `npx playwright test bulk-sell --project=e2e` → pass, twice.

### Step 4: Revive `delivery-request.spec.ts`

Note: the delivery flow gained a customer cancel action recently
(PR #131) — the request path selectors may have moved. Walk it manually first.

**Verify**: `npx playwright test delivery-request --project=e2e` → pass, twice.

### Step 5: Revive the two `odds-reflection.spec.ts` headline tests

These drive the ADMIN UI (set a pack to 100% odds) then open packs on the
storefront. The admin dashboard is a separate Vite app on :7000 — confirm the
spec's admin URL/creds envs (`PW_ADMIN`, `PW_ADMIN_EMAIL`,
`PW_ADMIN_PASSWORD`) against `helpers/constants.ts`.

**Verify**: `npx playwright test odds-reflection --project=e2e` → all tests in
the file pass (headline no longer fixme).

### Step 6: Update the drift note and run everything

Update `tests/e2e/README.md`: remove the 2026-07-07 drift note (or replace
with "re-authored <date> against the redesigned slots/vault UI").

**Verify**: `npx playwright test` → full suite green, `grep -rn "test.fixme"
tests/e2e/*.spec.ts` → **zero matches**.

## Test plan

This plan IS tests. Acceptance = the six formerly-fixme specs pass
deterministically (each verified twice in a row locally). No product code
changes.

## Done criteria

- [ ] `grep -rn "test.fixme" tests/e2e/*.spec.ts` returns no matches
- [ ] `npx playwright test` exits 0, full suite, against the standalone build
- [ ] Each revived spec passed twice consecutively
- [ ] `tests/e2e/README.md` drift note updated
- [ ] No files under `src/` or `backend/` modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- A flow no longer exists in the UI at all (e.g. there is genuinely no
  bulk-sell affordance anymore) — the spec may need product-owner input, not
  selectors.
- A revived spec fails in a way that implicates PRODUCT behavior (wrong
  balance after sell-back, missing pull, 4xx from the backend on a legitimate
  action). That is a real bug find — report it with the trace instead of
  bending the assertion to match.
- The stack won't boot (backend `/health` failing, ports occupied by other
  agents' servers — several agents are active in this repo; check
  `Get-Process node` count per repo guidance and report rather than killing
  processes you don't own).
- The mock top-up path is disabled in your environment (`ALLOW_MOCK_TOPUP`
  gating) — the top-up step can't run without it.

## Maintenance notes

- These specs are the tripwire for the next redesign: when slots/vault UI
  changes again, they should FAIL, not get re-`fixme`d. If a redesign lands,
  budget selector updates in the same PR.
- Consider (deferred, operator decision): adding the revived suite to
  `.github/workflows/e2e.yml`'s required set so drift blocks merges.
- Reviewer scrutiny: assertions must still check BACKEND effects (ledger
  entries, pull rows) where the old specs did — not just UI text.
