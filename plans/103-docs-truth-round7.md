# Plan 103: Docs truth round 7 — ADR 0004 amendment, Cashout vocabulary, the three undocumented payout knobs, deletion-retention ADR, stale approve-route comment

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 5c74ce17..HEAD -- docs/adr CONTEXT.md backend/packages/api/.env.template docs/payments/globepay365-setup.md docs/ops/production-reset-and-golive-runbook.md "backend/packages/api/src/api/admin/globepay/withdrawals/[id]/approve/route.ts"`
> On drift, compare "Current state"; mismatch = STOP.

## Status

- **Priority**: P2
- **Effort**: S–M
- **Risk**: LOW (docs + one comment; no behavior)
- **Depends on**: none
- **Category**: docs
- **Planned at**: commit `5c74ce17`, 2026-08-15

## Why this matters

This repo treats stale docs as actively harmful (six prior "docs truth"
rounds), and the #392–#443 delta invalidated five spots:

1. **ADR 0004's central promise is now false for referrals.** PR #427 deleted
   `src/lib/actions/referral.ts`, `src/lib/referral-cookie.ts`, and
   `src/app/(account)/ReferralCookieClaim.tsx` (correctly — the referral link
   path carried an unbounded recursive CTE, a real DoS). The ADR still lists
   all three as must-keep banner holders and claims restoring the economy is
   "a revert, not a rewrite". For the referral half it is now a REBUILD — a
   material input to the ADR's 2026-10-01 review that the review will not see
   unless the doc says so. (The user-global `CLAUDE.md:39` also names the two
   lib files as current holders — gitignored, so it is an OPERATOR follow-up,
   recorded in the README row, not editable from a worktree.)
2. **CONTEXT.md's money vocabulary contradicts the shipped product.** The
   Cashout entry says `_Avoid_: withdraw ... payout` — while the delta shipped
   `globepay_withdrawal`, `POST /store/credits/withdraw`, the admin
   `/withdrawals` queue, `withdrawal-receipt.ts`,
   `PAYOUT_DESTINATION_COOLDOWN_HOURS`, and customer copy saying "withdrawal".
   The naming authority now instructs readers to avoid the words the schema
   uses. Four delta nouns are also missing entirely: held withdrawal/approval,
   payout destination (+cooldown), account deletion (+retained anonymous
   books), expired deposit.
3. **Three env knobs that gate real money are documented nowhere.**
   `GLOBEPAY_WD_APPROVAL_ABOVE_RM` (unset = the RM 1,000 default engages, but
   nobody chose it), `GLOBEPAY_WD_DAILY_MAX_RM`, and
   `PAYOUT_DESTINATION_COOLDOWN_HOURS` (read at 5 sites; `=0` is a documented
   deliberate operator choice) appear in neither `.env.template` nor
   `docs/payments/globepay365-setup.md`'s config table — the doc that lists 17
   other `GLOBEPAY_*` keys. The go-live runbook has zero hits for
   "approval"/"held"/"COOLDOWN": nothing tells the operator a live payout
   channel now needs a human watching a queue.
4. **The deletion-retention decision has no ADR.** "PII destroyed, books
   retained anonymously" (which exact columns survive and why) lives in a
   230-line feature spec, not in `docs/adr/` where a future privacy or
   compliance pass will look. Erasure-vs-retention is the archetypal decision
   that must not be silently reversed in either direction.
5. **A comment shipped stale inside its own PR**: the withdrawal approve route
   says the queue may not surface the frozen flag; the same commit shipped the
   flag (row badge + disabled Approve).

## Current state

- `docs/adr/0004-reward-economy-suspension.md:26-35` — "restoring the surfaces
  later is a revert (delete the banner, re-add the route), not a rewrite" +
  the holders list naming `src/lib/actions/referral.ts`,
  `src/lib/referral-cookie.ts`, `src/app/(account)/ReferralCookieClaim.tsx`.
  All three files are ABSENT on disk (verify: `ls` each). The deleting commit:
  `b49ba094` (#427) — read `git show b49ba094 --stat` and its commit body for
  the CTE rationale to cite.
- Also stale on the same event: `docs/superpowers/specs/2026-07-29-suspend-vip-referral-surfaces-design.md:30`
  and `docs/superpowers/plans/2026-07-29-suspend-vip-referral-surfaces.md:17`
  ("do NOT delete" for those paths).
- `CONTEXT.md:127-130`:

```
**Cashout**:
Converting site credit out to real money (ledger reason `cashout`).
_Avoid_: withdraw (that word is the physical reward-shipment flow — see Delivery
Order and `rewards/withdraw`), payout
```

Note: the disambiguation it guards (reward-shipment "withdraw") is itself a
SUSPENDED surface (ADR 0004). CONTEXT.md was otherwise maintained in the
delta (Free Welcome Pack entry added at `:47-56`) — extend, don't rewrite.

- `backend/packages/api/.env.template` — zero hits for the three knobs
  (verified at plan time). `ALLOWED_SMS_COUNTRIES` IS present — use its entry
  style as the pattern.
- `docs/payments/globepay365-setup.md:34-47` — the config table (17 keys).
- `docs/ops/production-reset-and-golive-runbook.md` — zero hits for
  approval/held/COOLDOWN.
- Deletion-retention source material:
  `docs/superpowers/specs/2026-08-13-account-disable-delete-design.md`,
  route header `backend/packages/api/src/api/store/customers/me/delete/route.ts:54-58`,
  purge `service.ts:4099-4232` (account_number → last-4, holder name emptied,
  proof_images nulled, ship_country_code retained).
- Stale comment: `backend/packages/api/src/api/admin/globepay/withdrawals/[id]/approve/route.ts:95`
  ("Task 6's brief does not require the queue to surface the flag, so the
  approver may not be able to see it") — refuted by
  `backend/apps/admin/src/routes/withdrawals/route.ts:229` (returns `frozen`)
  and `page.tsx:324` (badge) / `:416` (Approve disabled). The list route's own
  comment at `:225-228` states the true reason a re-read exists (the badge is a
  stale preview; approve-time re-check is the gate) — align with it.
- ADR numbering: 0001–0005 exist; yours is 0006. Match the existing files'
  format (title line, Status, Context, Decision, Consequences — read 0003 as
  the freshest exemplar).

## Commands you will need

| Purpose                          | Command                                  | Expected  |
| -------------------------------- | ---------------------------------------- | --------- |
| Grep gates                       | see Done criteria                        | as stated |
| Backend typecheck (comment edit) | `corepack yarn check-types` (`backend/`) | exit 0    |

## Scope

**In scope**:

- `docs/adr/0004-reward-economy-suspension.md` (dated amendment section)
- NEW `docs/adr/0006-account-deletion-destroys-pii-retains-anonymous-books.md`
- `CONTEXT.md` (Cashout rewrite + 4 new entries)
- `backend/packages/api/.env.template` (3 entries)
- `docs/payments/globepay365-setup.md` (3 table rows)
- `docs/ops/production-reset-and-golive-runbook.md` (one payout-queue step)
- `docs/superpowers/specs/2026-07-29-suspend-vip-referral-surfaces-design.md`
  - `docs/superpowers/plans/2026-07-29-suspend-vip-referral-surfaces.md`
    (one-line "partially superseded by #427" pointers each)
- `backend/packages/api/src/api/admin/globepay/withdrawals/[id]/approve/route.ts`
  (ONE comment)

**Out of scope**:

- Any behavior change anywhere.
- `CLAUDE.md` / `AGENTS.md` — gitignored on this machine; record the needed
  edit (drop the two deleted referral paths from the CLAUDE.md holders list)
  as an operator follow-up in your README row.
- The suspended-surface code files themselves.
- Deciding retire-vs-restore (that is ADR 0004's review, DIR-D — you are
  correcting its inputs, not making the call).

## Git workflow

- Branch: `advisor/103-docs-truth-7`
- Conventional commits per doc cluster, e.g. `docs(adr): record that #427 made referral restoration a rebuild`.
- No push/PR without operator instruction.

## Steps

### Step 1: ADR 0004 amendment

Append a dated section "Amended 2026-08-15 — partially superseded by #427":
what was deleted and why (cite the commit's unbounded-CTE security rationale),
the corrected claim (VIP/daily surfaces remain a revert — their banner holders
are intact; referral restoration is now a rebuild: `linkSponsor`,
`POST /store/referral`, and the storefront referral surfaces are gone while
models/ledger reasons/`mature-commissions.ts` were deliberately kept), and
prune the three dead paths from the holders list (annotate "deleted by #427",
don't silently drop). Add the two one-line pointers to the 07-29 spec + plan.

**Verify**: `grep -n "referral.ts" docs/adr/0004-reward-economy-suspension.md`
→ only inside the amendment's deleted-by-#427 annotation.

### Step 2: CONTEXT.md

Rewrite the Cashout entry: **Withdrawal** becomes the money-out noun (table
`globepay_withdrawal`, route `/store/credits/withdraw`, ledger reason
`cashout` stays the ledger's internal reason string); keep a disambiguation
note that reward-shipment "withdraw" (`rewards/withdraw`) is a SUSPENDED
surface's vocabulary. Add four entries in the matching house style: **Held
Withdrawal / Approval** (status `held`, threshold env, admin queue,
approve/deny), **Payout Destination** (+ cooldown env, why it exists — the
steal-token→add-destination→cash-out chain), **Account Deletion** (PII
destroyed, anonymous books retained, login impossible forever, re-signup
allowed), **Expired Deposit** (non-terminal, requeried by the slow sweep).
Keep each entry as terse as the existing ones.

**Verify**: `grep -c "Held Withdrawal\|Payout Destination\|Account Deletion\|Expired Deposit" CONTEXT.md` → ≥4; the Cashout entry no longer says avoid-withdraw.

### Step 3: env template + setup doc + runbook

`.env.template`: three commented entries (default, what it bounds, the
security consequence of unset, `0` semantics where applicable — note
`GLOBEPAY_WD_APPROVAL_ABOVE_RM=0`'s stop-lever meaning lands with plan 095;
phrase it as "0 holds every payout (from plan 095 onward)" if 095 hasn't
merged). `globepay365-setup.md`: three rows in the `:34-47` table, same
column style. Runbook: one go-live step — set the approval threshold
deliberately, confirm the admin `/withdrawals` queue defaults to the `held`
view, name who watches it.

**Verify**: `grep -n "GLOBEPAY_WD_APPROVAL_ABOVE_RM" backend/packages/api/.env.template docs/payments/globepay365-setup.md docs/ops/production-reset-and-golive-runbook.md` → ≥1 hit in each.

### Step 4: ADR 0006

Write `docs/adr/0006-account-deletion-destroys-pii-retains-anonymous-books.md`:
decision, alternatives rejected (full hard delete — breaks reconciliation;
soft-delete-only — retains PII and blocks the email forever), the exact
retained columns and each one's reason (from `service.ts:4099-4232` — last-4
account number, emptied holder name, nulled proof images, retained
ship_country_code), pointer to the 08-13 design doc for detail. Status:
Accepted (decision shipped in #434).

**Verify**: file exists; `grep -n "0006" docs/adr/0006-*.md` → title present.

### Step 5: the stale comment

Replace the approve route's `:95` sentence with the truth: the queue DOES
surface the frozen flag (badge + disabled Approve), but the badge is a stale
preview — the approve-time re-read is the gate (align wording with the list
route's `:225-228` comment).

**Verify**: `grep -n "Task 6" "backend/packages/api/src/api/admin/globepay/withdrawals/[id]/approve/route.ts"` → 0 matches; `corepack yarn check-types` exit 0.

## Test plan

Docs-only + one comment: the grep gates above are the tests. Run the backend
typecheck once (comment edit).

## Done criteria

- [ ] All five Verify greps pass as stated
- [ ] ADR 0006 exists and follows the 0003 format
- [ ] No code-behavior diffs (`git diff` shows docs + one comment only)
- [ ] Operator follow-up (gitignored CLAUDE.md holders list) recorded in the README row
- [ ] `plans/README.md` row updated

## STOP conditions

- Any target doc was restructured since `5c74ce17` such that the cited lines
  moved by more than ~20 lines — re-anchor by heading text; STOP only if the
  content itself changed meaning.
- You find the referral files RESTORED on disk (someone reverted #427) — the
  whole Step 1 premise flips; report.
- Writing ADR 0006 surfaces a retained column NOT covered by the design doc's
  reasoning (an undocumented retention) — report it; do not invent a
  justification.

## Maintenance notes

- ADR 0004's 2026-10-01 review should now read the amendment first — the
  retire-or-restore decision is TWO decisions (VIP/daily = revert; referrals =
  rebuild). That framing is this plan's main payload.
- Future money env knobs: the definition of done includes `.env.template` +
  setup-doc rows — three rounds have now filed this same class.
