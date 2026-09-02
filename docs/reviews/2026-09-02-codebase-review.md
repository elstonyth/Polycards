# Codebase review — 2026-09-02

Whole-codebase functional review of the storefront (`src/`), the backend
(`backend/packages/api`) and the admin dashboard (`backend/apps/admin`),
followed by fixes on branch `fix/codebase-review-2026-09`. The brief was
"do not trust the existing tests or reports": every finding below was traced
in the implementation (callers, DB constraints, installed framework source)
before it was accepted, and every fix was re-verified against the suites and
a local stack.

Six review passes ran in parallel (backend money core, backend engines,
storefront server, storefront client, admin, architecture); four fixer passes
landed the changes on disjoint file sets; a final whole-branch review checked
the combined diff. The raw reports live outside the repo (session scratch);
this document is the durable summary.

## Baseline before any change

| Gate                          | Result                                  |
| ----------------------------- | --------------------------------------- |
| storefront `tsc`              | green                                   |
| storefront vitest             | 84 files / 796 tests green              |
| backend `tsc`                 | green                                   |
| backend jest unit             | 151 suites / 1937 tests green           |

## Findings and what happened to them

Severity: CRITICAL = money loss / exploit / data corruption on the main path;
HIGH = feature broken for users or operators; MEDIUM = edge case wrong;
LOW = quality. Status: **fixed** on this branch, or **deferred** with a reason.

### Admin

| Sev      | Finding                                                                                                                                                                                      | Status                                                                                                                                                    |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CRITICAL | Card edit **Save** silently dropped the PriceCharting link (`pc_product_id`/`pc_grade` → null, nightly FMV sync stops) and reset `market_multiplier` to 1.2 on unlinked cards (prices, EV/RTP and buyback quotes drop). `update-card.ts` coerced every omitted field to `null`/`1.2`. | fixed — step is tri-state (`undefined` keeps, `null` clears), validate layer unlinks atomically, admin Unlink preserves the multiplier; 10 new unit cases |
| HIGH     | Economy dashboard 500s once any `delivery_fee` (live since 2026-08-25) or `referral_commission` ledger row exists — `ledgerTotals` threw on unknown reasons.                                   | fixed — two new buckets (fee line, promo cost; both outside revenue/net), admin tiles, and an enum-sweep test so the next new reason fails in CI           |
| MEDIUM   | Odds editor Save impossible on a pool over 1,000 cards; `delete-pack`/`delete-card` snapshot only the first 1,000 odds rows.                                                                   | fixed — `pageAll` in all three steps (latent: prod pools are ≤ 30 rows)                                                                                   |
| MEDIUM   | Deleting a card a Task rewards left a dangling reference; **Retire** on that task then 400ed because `saveTaskDefinition` re-validated the reward.                                              | fixed — reward/requirement targets re-validated only when changed                                                                                         |
| MEDIUM   | Single-order delivery status changes wrote no `admin_action_audit` row (bulk did).                                                                                                             | fixed — one row per status change, `action: 'edit'` (no `'status'` enum value without a migration)                                                        |
| LOW      | `eligible-products` capped both reads at 1,000.                                                                                                                                              | fixed                                                                                                                                                     |
| LOW      | Customer-state routes never checked the customer exists.                                                                                                                                     | **deferred** — three CI-gated HTTP suites drive those routes with synthetic ids by design; not worth rewriting them for an ops nicety                       |
| LOW      | Referrals runs table keyless Fragment; sibling react-query caches stale after adjust/partner-rate; multer had no file-count limit.                                                            | fixed                                                                                                                                                     |
| LOW      | `apps/vendor` is a bare `@mercurjs/vendor` mount with no custom routes; self-registration is middleware-blocked.                                                                             | report only — check `/seller` access logs before removing                                                                                                 |

### Backend — money core

| Sev    | Finding                                                                                                                                                                                                                | Status                                                                                                                                                              |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MEDIUM | `revealPull`, the showcase route and the address-edit route claimed an "atomic filtered update", but Medusa's generated selector-update is list-then-update-by-pk (`medusa-internal-service.js:184`): duplicate Telegram post on a reveal race, showcase stamped on a sold pull, address overwritten on a shipped order. | fixed for reveal (raw conditional `UPDATE … RETURNING`) and showcase (`setShowcasedIfVaulted`); **deferred** for the address edit (dynamic-column snapshot, ops-only outcome) |
| MEDIUM | Process death between the charge commit and the pull commit leaves a paid open with no pull and no repair path.                                                                                                      | **deferred** — needs its own job + HTTP suite (`reverseOpen` is already idempotent; sweep `pack_open` debits older than N minutes with no `pull.open_id`)              |
| MEDIUM | Account self-delete + re-signup re-arms the Free Welcome Pack (spec marks this OPEN).                                                                                                                                  | **deferred** — needs the phone-hash audit design from the spec                                                                                                       |
| LOW    | Batch open booked `price × count` un-rounded (`149.9 × 3 → 449.70000000000005` in `wallet_delta` and `total_charged`).                                                                                                | fixed — cent-rounded; unit spec                                                                                                                                     |
| LOW    | Insurance fee priced on the lenient/fallback FX rate.                                                                                                                                                                  | fixed — strict resolver                                                                                                                                             |
| LOW    | Free-pack batch refusal lived only in the route.                                                                                                                                                                       | fixed — step refuses too                                                                                                                                            |
| LOW    | `recordRewardWithdrawal` flipped the pull unconditionally (dormant behind the redemption gate).                                                                                                                         | fixed — `transitionPullStatus`                                                                                                                                      |
| LOW    | Customer cancel window checked before the lock; dead money code (`reverseCreditTransaction`, `hasEnoughCredit`, unreachable 23505 catch).                                                                              | **deferred** (window is one round trip and state stays consistent; dead code is a cleanup)                                                                          |

### Backend — engines (gateway, referral, tasks, VIP, challenge)

| Sev    | Finding                                                                                                                                                       | Status                                                                                                           |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| MEDIUM | Pay job racing an admin line-void could pay a voided settlement line (both guards were selector-updates; money moved before the status flip).                    | fixed — line claimed with a conditional `UPDATE … RETURNING` before any money moves; void mirrors it              |
| MEDIUM | A challenge week that unlocked nothing is re-judged hourly for 7 days against whatever ladder is live (a lowered ladder retroactively pays last week).          | **deferred** — needs a `challenge_week_settlement` table (design recorded in the fix report)                      |
| LOW    | Task card-reward stock taken on another connection before the claim could lose the unique race.                                                              | fixed — take moved after the claim commits                                                                       |
| LOW    | Admin Deny on a gateway-closed row overwrote the gateway's `failure_reason`.                                                                                   | fixed — first writer wins                                                                                        |
| LOW    | `approveWeeklySettlement` audited a no-op; payout-verify bumped the sweep's `updated_at` clock; duplicate `vip_level_up` on concurrent rung crossings.        | fixed                                                                                                            |
| LOW    | Referral close fired at the exact week boundary (a pack open committing milliseconds late is lost forever).                                                  | fixed — 5-minute grace on the cron path; explicit `weekStartIso` unaffected                                      |
| LOW    | "Bound at signup" was enforced as "no pack_open yet" — an aged, funded account could still attach a referrer.                                                  | fixed — 24h signup window on `created_at` (admin override untouched)                                              |
| LOW    | Task requirement targets not existence-checked; `reach_level` measured on the net level that can drop.                                                        | fixed — `highest_level_ever`                                                                                     |
| LOW    | `voidWeeklySettlement` still uses the ORM selector-update for the run row.                                                                                    | **deferred** (pay refuses a `void` run, so money-safe)                                                            |

### Storefront — server

| Sev    | Finding                                                                                                                                                                               | Status                                                                                                             |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| HIGH   | `/invite/<handle>` redirected to `https://0.0.0.0:3000/…` in production (absolute `Location` from the container bind origin — the bug PR #311 fixed for the Google callback). Referral acquisition funnel dead in prod. | fixed — relative `Location`; route test against a `0.0.0.0` request                                                |
| MEDIUM | `vipReward` schema still required `box_tier`; the backend dropped it in #490, so every ladder rung was discarded and the LV progress bar was wrong above level 1.                        | fixed                                                                                                              |
| MEDIUM | Auth cookie lived 7 days, the JWT 1 day; nothing reaped the dead cookie, so `/task`, `/referral` and the free-pack badge read "logged in" for six days after every login.               | fixed — cookie = 1d, `/api/me` clears a cookie the backend answered 401 to (never on 5xx), pages use the customer read |
| MEDIUM | Google OAuth `state` was not bound to the browser (login-CSRF: victim logged into the attacker's account, tops up into it).                                                             | fixed — httpOnly single-use state cookie on `/auth/google`                                                          |
| MEDIUM | Enforced CSP `img-src` omitted the two hot-link hosts `next.config.ts` allowlists.                                                                                                     | fixed (no hot-linked rows exist locally; belt and braces)                                                          |
| LOW    | Free-pack spin feed flipped to the global feed on first poll; `x-forwarded-proto` unclamped in `googleLoginStart`; `/auth/google/failed?reason=` rendered attacker text; double `decodeURIComponent` on route params. | fixed                                                                                                              |

### Storefront — client

| Sev    | Finding                                                                                                                                                           | Status                                                                                                             |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| HIGH   | Vault / Orders / Addresses seeded state once from the server prop; browser **Back** resurrected sold cards, cancelled orders and deleted addresses (the `/notifications` mechanism). | fixed — mount re-sync, never `revalidatePath`                                                                       |
| MEDIUM | `PhoneOtpStep` left Verify/Resend disabled forever when the action call rejected.                                                                                  | fixed                                                                                                              |
| MEDIUM | Spin page's "Add credits in your Vault →" linked to a page with no top-up control.                                                                                  | fixed — `/me`                                                                                                      |
| MEDIUM | A post-charge mapping failure said "try again" over a committed, vaulted open and never lit the Vault dot.                                                          | fixed — unmappable rolls dropped, honest copy, dot refreshed                                                       |
| MEDIUM | A `200` with zero rolls parked the machine in an empty review until reload.                                                                                        | fixed — refusal at the seam                                                                                        |
| LOW    | `modeUndecided`, `SignInPrompt` navigation, `AuctionClock` > 100%, `hasSpun` after a refusal.                                                                       | fixed                                                                                                              |
| LOW    | Addresses mount re-sync treats a 5xx as an empty book; a partially-mapped batch reveals through the watchdog with an idle reel.                                     | **deferred** (both need an `ok`/`dropped` signal threaded through; edge cases)                                      |

## Verified OK (traced end-to-end, unchanged)

Open / batch-open saga with per-customer advisory locks and partial-unique
idempotency; free welcome pack claim, lock and unlock; buyback race guards and
quote == credit; delivery create/cancel transactions; top-up idempotency;
freeze / disable / delete gates on every money route; route auth, authz and
rate limits; cent rounding and the USD→MYR seam; DB CHECK/unique constraints
vs code invariants; GlobePay deposit callback + sweep idempotency; withdrawal
debit-before-submit and single refund anchor; held approve/deny under lock;
payout-destination cooldown; MYT week math at the boundaries; referral
close/approve/pay idempotency; task once-per-day/period; VIP monotonic grants
post-commit; challenge per-winner locking; OTP proof binding and fail-closed;
storefront token flow (httpOnly only, never in URLs/logs/ISR); every server
action's validation and error mapping; zod schemas vs backend shapes (only
the VIP ladder had drifted); no links to deleted routes anywhere; spin state
machine, sell window, vault bulk sell, wallet/withdraw idempotency, modal
a11y and hook cleanups; admin auth on every `/admin/*` route; i18n keys.

## Verification of the branch

| Gate                                                | Result                                                                                       |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| storefront `tsc` / eslint / prettier (changed files) | green                                                                                        |
| storefront vitest                                   | 86 files / 813 tests green                                                                   |
| storefront `next build`                             | green                                                                                        |
| backend `tsc`                                       | green                                                                                        |
| backend jest unit                                   | 158 suites / 1991 tests green                                                                |
| backend module-integration (real Postgres)          | 31 suites / 177 tests green                                                                  |
| backend HTTP integration (touched areas)            | 26 suites / 130 tests green (money loop, engines, admin, delivery, showcase, odds, economy)  |
| Playwright QA scripts on the standalone build       | `qa-invite`, `qa-catalog-groups`, `qa-a11y`, `qa-reset-countdown`, `qa-motion13` green      |
| Playwright e2e (`tests/e2e`)                        | 19 passed, 2 skipped (suspended rewards) — two stale specs repaired (State field, snapshot)  |
| curl probes                                         | `/invite` relative `Location`; `/api/me` clears a dead cookie; `/task` logged-out prompt     |

## Architecture verdict

Keep the platform; fix the shape around the money core. Medusa is used for
the boring parts (customer, auth, product/inventory, notifications, admin
session, worker) and fought only at its edges; the money core is a hand-built
append-only ledger with per-customer advisory locks, DB idempotency keys and
105 HTTP suites gating it. That is the right architecture for one operator
plus agents on real money. The problems are:

1. **One 9,308-line, 132-method service** every feature lands in (61 of the
   last 60 days' commits). Extract the ledger core (~1,200 lines:
   `mutateCreditAtomic`, `settleOpen`, `reverseOpen`, `recordLedgerEntry`,
   `withdrawForCashout`, buyback/topup wrappers) into `ledger-core.ts` as
   functions of `(svc, sharedContext, input)` with 3-line decorated delegates
   left on the class; collapse the 70 `as unknown as LedgerSqlManager` casts
   into one helper. Do **not** split by folder or into separate modules —
   cross-module transactions are unsupported and the atomic open depends on one
   `sharedContext`.
2. **Two write patterns, one trap.** The generated `updateX({ selector })` is a
   find-then-write; this review found five sites that relied on it as an atomic
   guard. Rule for new money paths: a conditional raw `UPDATE … RETURNING`
   (the `transitionPullStatus` / `claimFreePack` idiom) whenever a status flip
   must win a race.
3. **Global serialization on `ledger_sequence`** (`FOR UPDATE` on one row per
   type per quarter inside every money transaction, while holding the customer
   lock and a pooled connection). Fine at current volume; the first promo-scale
   burst will find it. Measure lock waits under `qa-pack-1000-stress.mjs`
   before changing anything.
4. **The withdrawal path has 3–4 hand-copied refund orderings** (submit error,
   callback, sweep, admin approve). Collapse to one `settleOrRefundWithdrawal`
   when the next change there lands.
5. **Money controls have no boot evidence.** `.do/backend.app.yaml` sets
   `PAYOUT_DESTINATION_COOLDOWN_HOURS: "0"` — a recorded operator decision
   (spec comment, 2026-08-11, #422: the 24h wait blocked real customers' first
   withdrawal; the add-a-destination email + feed alert is the compensating
   control, so `RESEND_API_KEY` breaking is a security incident). Re-confirmed
   2026-09-02: stays 0. The gap is that nothing logs the resolved money controls
   at boot the way `[phone-gate]` does — add a `[money-gate]` line for cooldown,
   approval threshold, withdrawals-enabled and mock top-up.
6. **Store-route auth coverage has no probe** (the admin side has one because
   the omission happened four times). Copy
   `admin-rate-limit-coverage.unit.spec.ts` into a store variant with an
   explicit public allowlist.

Explicitly do not: migrate off Medusa; build on `apps/vendor`; convert the
GlobePay withdrawal to a workflow; add FKs from `pull`/ledger rows to
`card`/`pack`/`customer`; unify the two package managers; replace `ttl-cache`
with `use cache`; prune the SUSPENDED holders.

## Decisions for the operator

- **Session length.** The cookie now matches the backend JWT default (1 day).
  Before this change the cookie claimed 7 days but every backend call 401ed
  after day one, so nothing customer-facing got shorter. Re-confirmed
  2026-09-02: stays 1 day (raise `http.jwtExpiresIn` in `medusa-config.ts` and
  `COOKIE_MAX_AGE` in `src/lib/data/customer.ts` together if that changes).
- **Referral bind window.** Binding now requires the account to be < 24h old.
  The storefront binds at signup, so no legitimate flow is affected; an
  operator can still attach a referrer to any account through the admin
  override. Re-confirmed 2026-09-02.
- **`PAYOUT_DESTINATION_COOLDOWN_HOURS`** stays `0` in prod — re-confirmed
  2026-09-02 against the 2026-08-11 reason recorded in the spec comment (see
  architecture point 5).
- **`apps/vendor`** — remove after confirming nothing hits `/seller`.

## Follow-ups (not on this branch)

1. Orphan-open reconcile job (charge with no pull after a crash).
2. `challenge_week_settlement` table so a no-winner week is terminal.
3. Free Welcome Pack re-arm on delete → re-signup (phone-hash audit design).
4. Address-edit route and `voidWeeklySettlement` still use the selector-update.
5. Cancel window under the delivery lock (thread `allowedFrom`).
6. Ledger-core extraction and the store-route auth probe (architecture 1, 6).
7. `docs/payments/globepay365-setup.md` says the deposit sweep runs every
   10 minutes; it runs every minute (10-minute full tier via module state).
   `README.md` / `ci.yml` disagree on the HTTP suite count (66 / 84 / 105).
