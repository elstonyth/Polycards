# Plan 068: Docs & naming truth round 5 — runbook, CHANGELOG, turnover naming, suspension hygiene

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat a993f34a..HEAD -- docs/ops/ CHANGELOG.md CONTEXT.md docs/adr/ docs/superpowers/specs/ "src/app/(account)/vip/vip-benefits.ts" "src/app/(account)/ReferralCookieClaim.tsx" backend/packages/api/src/modules/packs/vip-lifetime.ts backend/apps/admin/src/i18n/en.json`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P3 (docs; the naming half prevents a future money-basis bug)
- **Effort**: S–M
- **Risk**: LOW
- **Depends on**: none. Supersedes the doc half of orphaned round-6 plan 050 (see plans/README.md round-8 notes) — this plan re-does that content FRESH against the current tree; do not cherry-pick `7888b138`.
- **Category**: docs / dx / tech-debt (naming)
- **Planned at**: commit `a993f34a`, 2026-08-01

## Why this matters

The operator's launch decisions run through documents that now disagree with
shipped code: the go-live runbook still lists two RESOLVED blockers as
BLOCKING (challenge settlement shipped in #296; vendor self-registration
fenced in #173), the CHANGELOG describes this repo's website-cloner template
ancestor, the delta's two biggest economy decisions (VIP levels on full
turnover #254; the reward-surface suspension #294) have no durable decision
record, and the approved odds spec describes a model #298 replaced. Separately
— and highest-consequence — the money core's turnover counter is still NAMED
`lifetimeExternalSenFor`/`lifetime_external_spend_sen` and surfaces in the
admin Players list as "Spend": the next engineer reading "external" will reach
for the wrong basis in commission/withdrawal code, and the operator reads
turnover as deposits.

## Current state

- **Runbook** — `docs/ops/production-reset-and-golive-runbook.md:31` §1.1
  "Weekly Challenge has no settlement engine (BLOCKING)" (verified-in-code
  note dated 2026-07-19). Reality: `backend/packages/api/src/jobs/settle-challenge-week.ts`
  exists (#296) with `__tests__/challenge-settle.integration.spec.ts`.
  `:72-74` — "Vendor self-registration is open … Close before a public
  launch". Reality: `backend/packages/api/src/api/middlewares.ts:120-139`
  hard-404s both registration entrypoints, guarded by
  `integration-tests/http/vendor-selfreg-block.spec.ts`. The §1.3 items that
  are STILL REAL and must survive the rewrite: Google OAuth consent screen in
  Testing mode; password-reset email env-gated (Resend envs must be APP-level
  since subscribers run on the worker); demo-sized prod challenge stage
  thresholds.
- **CHANGELOG** — `CHANGELOG.md`: one `[Unreleased]` entry (Node-24 baseline),
  then `[0.3.1] - 2026-03-29` describing "/clone-website skill",
  "Initial template scaffold for website reverse-engineering". Last commit to
  it: 2026-03-30. `package.json:3` still `"version": "0.3.1"`. ~300 PRs
  unrecorded.
- **Missing ADRs** — `docs/adr/` holds `0001-vault-is-a-pull-status.md` and
  `0002-admin-dashboard-ui-stack.md`. Nothing records: (a) #254's basis change
  (VIP levels on FULL pack-open turnover, winnings included — while commission
  BASIS and the withdrawal gate stay external-funded); (b) #294's
  suspend-don't-retire decision (spec exists at
  `docs/superpowers/specs/2026-07-29-suspend-vip-referral-surfaces-design.md`
  but has no review-by date).
- **Stale odds spec** — `docs/superpowers/specs/2026-07-27-odds-auto-split-target-rtp-design.md`
  header says "Status: Approved, ready for planning"; #298 then changed the
  model (DEFAULT_TIER_PCT preset, derive-unless-locked editing, per-tier
  EV/value ranges). A reader following the spec re-derives superseded
  behavior.
- **CONTEXT.md** — `CONTEXT.md:122-151` (§"Rewards, VIP, and referrals")
  defines Reward Box / Voucher / Commission / Sponsor–Recruit in present tense;
  all their storefront surfaces 404 since #294.
- **Missing SUSPENDED banners** — the #294 convention (exemplar,
  `src/lib/actions/daily.ts:1-8`):

  ```ts
  /**
   * SUSPENDED 2026-07-29 — the `/daily` route was deleted with the reward
   * surfaces (docs/superpowers/specs/2026-07-29-suspend-vip-referral-surfaces-design.md).
   * Kept unreferenced, not deleted, so un-suspending is a revert rather than a
   * rewrite; the backend routes these call are all still live.
   */
  ```

  Two orphans lack it: `src/app/(account)/vip/vip-benefits.ts` (only importer
  is its own test) and `src/app/(account)/ReferralCookieClaim.tsx` (unmounted;
  its doc comment still describes live behavior; `src/lib/referral-cookie.ts:6`
  notes the 30-day cookie horizon).

- **Footer/fairness** — `src/components/app-shell/SiteFooter.tsx:20-31`
  comment records that after the 2026-07-31 removal "a logged-out visitor has
  no path to the fairness disclosure, to support, or to /about at all"; the
  `/me` comment (`src/app/(account)/me/page.tsx:47-53`) records the removal as
  deliberate de-duplication. The 2026-07-29 spec line
  `docs/superpowers/specs/2026-07-29-storefront-display-changes-design.md:19`
  ("still linked from `/me` and the footer") is now false either way.
- **Turnover naming** — `backend/packages/api/src/modules/packs/service.ts:4405-4419`
  `lifetimeExternalSenFor` sums ALL `pack_open` debits (no external filter);
  `vip-lifetime.ts:1-6` documents the turnover semantics correctly but keeps
  the name (`lifetimeExternalSen`); `service.ts:2457-2461` comment still says
  the sponsor tier ranks on "lifetime external-funded spend" (it ranks on
  turnover; the commission BASIS at `service.ts:~2449` correctly stays
  `-externalFundedCents`); admin Players list maps `vipSpendCents` →
  `total_spend` (`api/admin/players/route.ts:60`) rendered under
  `"spend": "Spend"` (`backend/apps/admin/src/i18n/en.json:504`).

## Commands you will need

| Purpose           | Command                                              | Expected on success |
| ----------------- | ---------------------------------------------------- | ------------------- |
| Backend typecheck | `cd backend && corepack yarn check-types`            | exit 0              |
| Backend unit tier | `cd backend/packages/api && corepack yarn test:unit` | all pass            |
| Storefront check  | `npm run check`                                      | exit 0              |
| Storefront tests  | `npm test`                                           | all pass            |

## Scope

**In scope**:

- `docs/ops/production-reset-and-golive-runbook.md`
- `CHANGELOG.md`, `package.json` (version line only)
- `docs/adr/0003-*.md`, `docs/adr/0004-*.md` (new)
- `docs/superpowers/specs/2026-07-27-odds-auto-split-target-rtp-design.md` (header only)
- `docs/superpowers/specs/2026-07-29-suspend-vip-referral-surfaces-design.md` (header only)
- `docs/superpowers/specs/2026-07-29-storefront-display-changes-design.md` (one line)
- `CONTEXT.md` (§Rewards heading marker)
- `src/app/(account)/vip/vip-benefits.ts`, `src/app/(account)/ReferralCookieClaim.tsx` (banners)
- `backend/packages/api/src/modules/packs/service.ts`, `vip-lifetime.ts` (rename + comments)
- `backend/apps/admin/src/i18n/en.json` (one label)

**Out of scope**:

- The DB column `vip_member_state.lifetime_external_spend_sen` — keep the
  column name; the model file gets a comment instead (a rename migration buys
  nothing and risks a live table).
- Restoring the footer links (operator decision — this plan only fixes the
  spec line and records the open question; see maintenance notes).
- `plans/050-docs-truth-round4.md` content (superseded).
- Any behavioral code change; the rename must be pure.

## Git workflow

- Branch: `advisor/068-docs-naming-truth`
- Conventional commits: `docs(ops): …`, `docs(adr): …`, `refactor(vip): rename lifetime turnover counter …`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Runbook §1 rewrite

Strike §1.1 (replace with one line: settled by #296 — hourly
`settle-challenge-week` job + integration spec; point at the job file). Strike
the vendor bullet at `:72-74` (settled by #173 —
`middlewares.ts:120-139` + `vendor-selfreg-block.spec.ts`). Keep and re-verify
the three live §1.3 items (listed in Current state) — check each against
current code/config before re-asserting it; re-date the header with today and
the HEAD SHA you're working on.

**Verify**: `grep -n "no settlement engine\|self-registration is open" docs/ops/production-reset-and-golive-runbook.md` → no matches.

### Step 2: CHANGELOG decision (delete)

Delete `CHANGELOG.md`. Rationale to put in the commit body: PR titles +
`plans/README.md` carry the real narrative; a changelog frozen at the
template era misleads onboarding readers (it describes a website-cloner).
Set `package.json` `"version"` to `1.0.0-rc` so the version stops asserting
the template scaffold. If the operator has expressed a preference for keeping
a changelog, STOP condition applies.

**Verify**: `ls CHANGELOG.md` → not found; `grep -n '"version"' package.json` → `1.0.0-rc`.

### Step 3: Two ADRs

- `docs/adr/0003-vip-levels-on-full-turnover.md`: context (#254), decision
  (VIP level basis = full pack-open turnover incl. winnings; commission BASIS
  and withdrawal gate remain external-funded — cite `service.ts` regions from
  Current state), consequences (the "Spend"→"Turnover" relabel; the
  `backfillExternalFundedBasis` contrast at `service.ts:~4576`). Follow
  0001/0002's format.
- `docs/adr/0004-reward-economy-suspension.md`: context (#294), decision
  (suspend-not-retire; SUSPENDED-banner convention; backend stays live), and a
  **review-by date = 2026-10-01** ("if not restored by then, decide
  retire-vs-restore explicitly — see the kept-orphan list"). Add the same
  review-by line to the 2026-07-29 suspension spec header.

**Verify**: both files exist; `grep -n "review-by\|Review by" docs/adr/0004-reward-economy-suspension.md docs/superpowers/specs/2026-07-29-suspend-vip-referral-surfaces-design.md` → matches in both.

### Step 4: Spec headers + CONTEXT.md marker

- Odds spec: change its Status header to
  `Superseded in part by #298 (2026-07-30) — default tier preset, derive-unless-locked editing, per-tier EV/value ranges; the auto-split solver itself still matches.` (one header edit, no rewrite).
- Display-changes spec `:19`: correct the "still linked from `/me` and the
  footer" claim to describe reality (trust routes reachable via URL/sitemap
  and in-content links only, per the 2026-07-31 removal) and reference the
  SiteFooter comment.
- `CONTEXT.md` §"Rewards, VIP, and referrals" heading: add one italic line
  under it — terms below describe surfaces SUSPENDED 2026-07-29 (#294);
  vocabulary retained because un-suspending is a revert (ADR 0004).

**Verify**: `grep -n "Superseded" docs/superpowers/specs/2026-07-27-odds-auto-split-target-rtp-design.md` → match; `grep -n "SUSPENDED 2026-07-29" CONTEXT.md` → match.

### Step 5: SUSPENDED banners

Add the daily.ts-style banner (excerpt in Current state) to
`vip-benefits.ts` (note additionally: perk strings describe suspended
economies — verify before un-suspending) and `ReferralCookieClaim.tsx` (note
additionally: unmounted from the account layout; 30-day cookie revert horizon
per `referral-cookie.ts:6`).

**Verify**: `grep -ln "SUSPENDED 2026-07-29" "src/app/(account)/vip/vip-benefits.ts" "src/app/(account)/ReferralCookieClaim.tsx"` → both listed. `npm run check` → exit 0.

### Step 6: Turnover rename

- `service.ts`: rename `lifetimeExternalSenFor` → `lifetimeTurnoverSenFor`
  (find all call sites with grep — the cluster includes the VIP settle path
  and the commission-tier read near `:2457`); fix the `:2457-2461` comment to
  say the sponsor tier ranks on lifetime TURNOVER while the commission basis
  stays external-funded.
- `vip-lifetime.ts`: rename `lifetimeExternalSen` → `lifetimeTurnoverSen`,
  update its header's first line and the "Mirrors the service raw SQL" pointer.
- Model file for `vip_member_state`: add a comment on
  `lifetime_external_spend_sen` — "column name predates the 2026-07-22
  turnover change (#254); holds full turnover, see ADR 0003; kept to avoid a
  live-table rename".
- `en.json:504`: `"spend": "Turnover"` (check whether the Players page has a
  tooltip/aria string to update alongside — grep `total_spend` in
  `backend/apps/admin/src`).

**Verify**: `grep -rn "lifetimeExternalSen" backend/packages/api/src` → zero matches; `cd backend && corepack yarn check-types` → exit 0; `cd backend/packages/api && corepack yarn test:unit` → all pass (specs referencing the old name must be updated in the same commit).

## Test plan

No new tests — Step 6 is a pure rename covered by typecheck + the existing
unit tier (vip-lifetime has specs; they get the new name). Docs steps are
grep-verified.

## Done criteria

- [ ] All step Verify greps pass as stated
- [ ] `cd backend && corepack yarn check-types` exit 0; `corepack yarn test:unit` all pass
- [ ] `npm run check` exit 0; `npm test` all pass
- [ ] No files outside the in-scope list modified
- [ ] `plans/README.md` status rows updated (this plan DONE; round-6 plan 050 marked SUPERSEDED by this plan)

## STOP conditions

Stop and report back if:

- Re-verifying a §1.3 runbook item shows it RESOLVED too (e.g. OAuth app now
  published) — don't guess; report what you found and update accordingly only
  with evidence.
- The operator has a stated changelog preference anywhere in repo docs — keep
  it and reset content instead of deleting; report which you did.
- The rename's grep surfaces a call site in a file plans 059–067 also touch —
  rebase order matters; report instead of racing.
- `en.json` "spend" key is shared by another surface (grep its usages) —
  report before relabeling.

## Maintenance notes

- OPEN OPERATOR QUESTION recorded here deliberately: should a logged-out
  visitor reach `/fairness` and `/contact` from the page chrome? The removal
  was deliberate (comments in SiteFooter.tsx + me/page.tsx), but for a
  real-money product the compliance-page reachability question deserves an
  explicit yes/no. One footer link row restores it if yes.
- ADR 0004's review-by date (2026-10-01) is the suspension's expiry alarm —
  whoever triages plans after that date should force the retire-vs-restore
  decision (direction item DIR-D in the round-8 README).
- Reviewer scrutiny: Step 6 must be behavior-identical (no SQL change, no
  basis change) — the diff should read as rename + comments + one label.
