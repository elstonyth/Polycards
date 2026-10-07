# Vault Packs (gifted packs) + Bonus Credit (泥码) — design

Date: 2026-10-07. Approved section by section in chat by the operator (Elston) the
same day, relaying the ask from Wei Yuan.

## The ask

Wei Yuan, translated:

1. "Make it possible to send packs into a player's vault. A pack in the vault has
   one action, **Open**, which jumps to that pack's page. There the **Open Pack**
   button becomes **Vault x1**; inside, **Bet RM300** becomes **Vault x1**. If the
   player adds a row (two reels spinning together) it becomes **Bet Vault x1 +
   RM300**."
2. "If their vault holds a Bronze pack and they navigate to the Bronze pack by hand,
   it behaves the same as opening it from the vault."
3. "And set **泥码 credit** (written 拟码 — same pronunciation, _ní mǎ_): it cannot
   be cashed out, it can only be spent."

泥码 is the casino term for _dead chips_: promotional chips that can be bet but never
exchanged for cash. In product copy and code it is **Bonus Credit**.

Two independent sub-projects, one spec, because they share a single economic rule
(the value a gift or a bonus represents must never become withdrawable money):

- **A. Pack Gifts** — admin-granted unopened packs, shown in the vault, consumed by
  the normal open flow.
- **B. Bonus Credit** — a spend-only slice of the credit ledger.

Build order: B's ledger column first (A's buyback rule depends on it), then A.

## Decisions (operator answers, 2026-10-07)

| Question                                                                                                                                   | Answer                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A card pulled with bonus credit, or from a gifted pack, is sold back. What does the player get?                                            | **Bonus credit** (stays non-withdrawable). Keeping or physically shipping the card remains allowed.                                                                          |
| Do gift opens / bonus-funded opens count toward Ranks, the weekly challenge, task progress, VIP level, referral commission, the live feed? | **Count nothing** (like task free rips today).                                                                                                                               |
| Spend order when a player holds both                                                                                                       | **Bonus first, fair split.** RM 270 bonus + RM 30 normal for a RM 300 open; a later sell-back pays 90% bonus / 10% normal, so the player's own money never turns into bonus. |
| How bonus is shown                                                                                                                         | **Total everywhere** (header pill, spin page CREDIT); the **wallet page** splits Normal / Bonus; Withdrawable excludes bonus.                                                |
| Pack page / spin page wording                                                                                                              | As drafted in §1 (operator: "looks correct").                                                                                                                                |
| Admin surface, rules table (§2)                                                                                                            | Approved as drafted.                                                                                                                                                         |
| Technical shape (§3–§7)                                                                                                                    | Approved as drafted.                                                                                                                                                         |

## Glossary additions (CONTEXT.md, same change)

**Pack Gift** (customer-facing: _Vault pack_, "Vault x1"):
An admin-granted, unopened Pack held for one customer — table `pack_gift`, one row
per pack. Shown in the Vault UI, but it is **not** a Pull and not a Vault item in the
ADR 0001 sense (the vault stays a Pull status; the Vault _page_ now renders Pulls and
Pack Gifts side by side). Consumed by a normal Open, which writes a Pull with
`source='gift'`.
_Avoid_: voucher (VIP credit grant), free rip (the task reward, a `task_claim` row),
reward.

**Bonus Credit** (泥码):
The spend-only slice of a customer's Credit. Spent only on pack Opens, never
withdrawn, never pays a delivery fee. Tracked as a signed column on the existing
ledger (`credit_transaction.bonus_cents`), not a second wallet. **Bonus Balance** =
Σ bonus*cents; **Normal Balance** = Balance − Bonus Balance.
\_Avoid*: promo credit (the economy report's bucket for task/voucher credit, which IS
withdrawable), dead chips, free credit.

Also update: **Pull** gains `source='gift'` and `source='bonus'`; **Available** /
**Withdrawal** note that Withdrawable is the Normal Balance only.

## 1. Player experience (storefront)

**Vault page** — a new **Packs** row above the cards, one tile per pack held:

```
[Bronze art]  Bronze Pack ×2        [ Open ]
              Gift from Polycards
```

**Open** links to `/slots/<slug>` (the pack page). Hidden when the player holds none.

**Pack page** (`/slots/[slug]`, bottom bar). Gifts auto-apply whenever the player
holds one for this pack — arriving from the vault or by hand:

```
qty 1:  Vault x1                 [− 1 +]  [ Open Vault x1 ]
qty 2:  Vault x1 + RM 300.00     [− 2 +]  [ Open Pack ]
```

Rule: gifts used = min(qty, gifts held). The price line shows `Vault xG` plus
`+ RM <(qty−G)×price>` when any row is paid. The button reads `Open Vault xG` when
every row is a gift, otherwise the usual `Open Pack`.

**Spin page** (`/slots/[slug]/spin`) — the bet line under Spin:

- `Bet Vault x1`
- after `+` adds a row: `Bet Vault x1 + RM300.00`
- 2 gifts, 2 rows: `Bet Vault x2`

Use order for every open: **gifts → bonus credit → normal credit**.

**Reveal / sell** — the sell button names what comes back:

- gift card: `Sell for RM 270.00 bonus`
- mixed card: `Sell for RM 243.00 bonus + RM 27.00`
- normal card: unchanged

The vault's sell confirm modal shows the same split.

**Wallet page**:

```
Total            RM 4,744.58
  Normal         RM 4,474.58
  Bonus          RM   270.00   spend only · can't withdraw
Withdrawable     (normal only)
```

Under Withdrawable the page states the minimum withdrawal ("Minimum withdrawal
RM 50", read from the payment limits the withdraw form uses), adding how much
more is needed when playthrough is done and the withdrawable amount is below it
(operator request, 2026-10-07).

The header pill and the spin page's CREDIT card show the **total**. The transactions
list labels `bonus_grant` rows "Bonus credit" and tags any row whose bonus part is
non-zero.

**Notifications** (customer feed): "You received 2× Bronze Pack — open it from your
Vault." / "You received RM 300.00 bonus credit."

**Stale screen safety** — if the screen showed "Vault xG" but G gifts are no longer
there (opened in another tab, revoked by admin), the open is **refused** with
"Your vault pack is no longer available — refresh." It never silently charges the
price instead.

## 2. Admin experience and rules

**Customer-360 page** (`backend/apps/admin/src/routes/customers/[id]/page.tsx`), two
panels beside the existing credit adjust:

- **Gift packs** — pack select, quantity 1–10, required note → Send. Below: this
  customer's gifts — Unopened / Opened (with the opened date; the admin has no
  pull page to link to) / Revoked / Stuck; **Revoke** on unopened rows. A stuck
  gift (claimed by an open that crashed after writing its card) is left for an
  operator: it is never reclaimed or revoked automatically, so it can never
  become a second card.
- **Bonus credit** — shows the Bonus Balance; amount (+ give / − take back, cannot go
  below 0) and required note.

Both are audit-logged with the admin's id, carry an idempotency key, and count toward
the existing daily mint cap `ADJUST_DAILY_MINT_MAX_RM` (a gift counts as its pack
price × quantity at grant time).

**Rules**

| Situation                                                                                  | Behavior                                                     |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| Account frozen                                                                             | Cannot open gifts or spend bonus (same freeze gate as today) |
| Pack sold out / hidden after the gift                                                      | Gift waits in the vault; Open shows "unavailable"            |
| Gift for a `free_welcome` / `reward_box` pack, or a pack with no odds                      | Admin cannot select it                                       |
| Bonus pays for                                                                             | **Pack opens only** — not delivery fees, not withdrawals     |
| Card from a gift / bonus open                                                              | Keep, ship, or sell (sell pays bonus per the decision)       |
| Counts toward Ranks, challenge, tasks, VIP, referral, feed, Telegram board, public profile | Nothing                                                      |
| Unlocks the welcome-pack lock (`hasPaidOpen`)                                              | No — only a `source='pack'` pull does                        |
| Playthrough                                                                                | Bonus spend banks none                                       |
| Expiry                                                                                     | None                                                         |
| Bulk gifting                                                                               | Not in this version — one customer at a time                 |
| Task free rips                                                                             | Unchanged — still on /task                                   |

## 3. Data model

### 3.1 `pack_gift` (new, packs module)

| column        | type             | notes                                                           |
| ------------- | ---------------- | --------------------------------------------------------------- |
| `id`          | id               |                                                                 |
| `customer_id` | text             |                                                                 |
| `pack_id`     | text             | Pack slug, like `pull.pack_id`                                  |
| `value_myr`   | bigNumber        | pack price at grant — the mint-cap basis                        |
| `note`        | text             | admin note (≤ 512), never shown to the customer                 |
| `granted_by`  | text             | admin user id                                                   |
| `grant_key`   | text             | the grant's idempotency key (shared by the N rows of one grant) |
| `open_id`     | text null        | set when claimed by an open                                     |
| `pull_id`     | text null unique | the pull the gift became                                        |
| `opened_at`   | dateTime null    |                                                                 |
| `revoked_at`  | dateTime null    |                                                                 |
| `revoked_by`  | text null        |                                                                 |

Unopened = `opened_at IS NULL AND revoked_at IS NULL`. Partial index on
`(customer_id, pack_id, created_at) WHERE opened_at IS NULL AND revoked_at IS NULL
AND deleted_at IS NULL`.

### 3.2 `credit_transaction.bonus_cents` (new column) + reason `bonus_grant`

Signed integer sen, nullable (legacy rows read as 0), like `external_funded_cents`.

| row                                     | amount   | bonus_cents     |
| --------------------------------------- | -------- | --------------- |
| `bonus_grant` (admin give)              | +X       | +X·100          |
| `bonus_grant` (admin take back)         | −X       | −X·100          |
| `pack_open`                             | −total   | −bonus consumed |
| `pack_open` reversal mirror             | +total   | +bonus consumed |
| `buyback` of a pull with `bonus_bp > 0` | +amount  | +bonus share    |
| everything else                         | as today | 0               |

`bonus_grant` joins the reason enum in all three enforced places: the model enum, the
DB CHECK `credit_transaction_reason_check` (migration), and the storefront mirror
`src/lib/data/schemas.ts` (with its drift test).

### 3.3 Pull: `source` gains `gift` and `bonus`; new `bonus_bp`

- `source`: `pack | reward | free | gift | bonus` (model-owned CHECK — migration).
  - `gift` — a row covered by a Pack Gift.
  - `bonus` — a paid row whose price was at least partly bonus-funded.
  - `pack` — a paid row funded entirely by normal credit (unchanged).
- `bonus_bp` integer 0–10000, default 0: the share of a future sell-back paid as
  bonus. `gift` = 10000; `bonus` = round(bonus sen of the row ÷ price sen × 10000);
  everything else 0.

### 3.4 Other closed value lists that must learn the new values

Each is enforced somewhere, so each is a deliberate edit, not a side effect:

- **Admin audit** (`models/admin-action-audit.ts`): `entity_type` and `action` are
  `model.enum`s (DB CHECKs). Add entity `pack_gift` and actions `grant_pack_gift`,
  `revoke_pack_gift`, `grant_bonus_credit` — migration.
- **Feed notifications**: `FeedTemplate` in `modules/packs/notify-feed.ts` gains
  `pack_gift_received` and `bonus_credit_received`; the storefront copy mirror
  (`src/lib/notifications/`) gains their copy — its drift test
  (`copy.test.ts`) parses the backend union.
- **Storefront vault item** (`src/lib/data/schemas.ts:468`):
  `source: z.enum(['pack','reward','free']).catch('pack')` would silently relabel
  gift and bonus pulls as `pack`. Add both values.
- **Storefront credit reason mirror** (`schemas.ts`, with its drift test): add
  `bonus_grant`.

## 4. Money rules

All in integer sen, inside the existing `credit:<customer>` advisory lock, from one
locked aggregate read that now sums `bonus_cents` beside `amount` and
`external_funded_cents`.

`settleOpen` is the only writer of `pack_open` debits (no production caller sends
`pack_open` through `mutateCreditAtomic`; verified 2026-10-07), so the bonus consume
lives there alone. The reversal mirror row is written by `reverseOpen`.

1. **Open consume** (`settleOpen`): `bonusUsed = min(total, bonusBalance)`;
   `extUsed = consumeExternalSen(total − bonusUsed, extBalance)`. Floor: `balance −
total ≥ 0` (unchanged; balance includes bonus). Returns `bonusUsed`.
   Consequence: while a player holds bonus, their opens bank **no playthrough**, so
   granting bonus to a player who still has deposits to play through delays their
   withdrawal unlock until the bonus is spent.
2. **Per-row allocation** in a batch: paid rows take bonus in row order, each
   `min(price, remaining)`, so at most one row is partial. Gift rows take none and
   are charged nothing.
3. **Other debits** (`cashout`, `delivery_fee`, negative `adjustment`): the floor is
   checked against the **Normal Balance** (`balance − bonusBalance + delta ≥ floor`)
   in `mutateCreditAtomic`, so bonus can never fund them. When the Balance would
   cover the debit but the Normal Balance does not, the refusal says so to the
   customer ("Bonus credit can only be spent on packs, it can't pay delivery
   fees.") rather than the admin-worded overdraft message.
4. **Negative `bonus_grant`**: refused if it would take the Bonus Balance below 0.
5. **Buyback**: `bonusShare = round(amountSen × bonus_bp / 10000)`; one `buyback` row
   with the full amount and `bonus_cents = bonusShare` (instant and vault rates
   alike).
6. **Reverse** (`reverseOpen`): the mirror row restores `+bonusUsed`.
7. **Withdrawable** (`walletSummary`): `gateOpen ? max(0, available − bonusBalance) :
0`. `withdrawForCashout` and the precheck already route through it, so the
   existing three refusal messages are unchanged.
8. **Turnover** for VIP and referral counts the normal-funded part of opens only:
   `Σ over pack_open of (−amount·100 + COALESCE(bonus_cents, 0))`. Applies to
   `creditSummary`'s VIP basis (and its unit-tested fold `credit-summary.ts`), the
   lifetime VIP turnover counter, `packTurnoverCentsByCustomer` (referral
   settlement), and the downline turnover display. A gift open writes no debit, so it
   adds nothing.
9. **Economy / finance reports**: `bonus_grant` is its own bucket (operator promo,
   excluded from net and revenue, like `rewardPromo`). Revenue counts only the normal
   part of `pack_open`; payouts count only the normal part of `buyback`.
   `economy.ts`'s `ledgerTotals` throws on unknown reasons, so this lands in the same
   change.
10. **`ledger_entry`** (the operator event log, read only by the admin ledger list):
    no new type. `wallet_delta` stays the true balance move (bonus included).
    - SP payload gains optional `bonus` (MYR consumed) and `gifts` (count); a
      gift-only open books `wallet_delta` 0, like the free welcome open.
    - SE payload gains optional `bonus` (MYR of the sell-back paid as bonus).
    - A bonus grant books **AD** with payload `detail: 'bonus'` (`reason` keeps
      the admin note, as for every AD row) and `wallet_delta` ±X; a pack gift
      books **AD** with `detail` "pack_gift <slug> ×N", no deltas, `ref_id` =
      the grant key.

## 5. Opening with gifts

The batch route `POST /store/packs/:slug/open-batch` gains an optional body field
`gifts` (integer, 0 ≤ gifts ≤ count, default 0). The storefront always calls the
batch route when gifts > 0, even for one row. The single-open route is unchanged
apart from the bonus split (§4).

New step `claimPackGiftsStep`, first in `openBatchWorkflow` (modelled on
`claimFreePackStep`):

- freeze gate;
- `UPDATE pack_gift SET opened_at = now(), open_id = :open_id WHERE id IN (SELECT id
… unopened for (customer, pack) ORDER BY created_at LIMIT :gifts FOR UPDATE SKIP
LOCKED) RETURNING id`;
- fewer than `gifts` rows → 409 "Your vault pack is no longer available — refresh."
  (nothing charged);
- compensation clears `opened_at` / `open_id` on the claimed ids.

**Stuck claims.** Workflow steps commit separately, so a crash between the claim and
the pull stamp could leave a gift claimed with no card (the free welcome claim has
the same exposure). The claim query and the count read therefore treat a row with
`pull_id IS NULL AND opened_at < now() − 10 minutes` as unopened again. The record
step stamps `pull_id` only `WHERE open_id = :open_id`, so a late original run whose
gift was re-claimed stamps nothing and compensates.

**Free-rip mode wins.** The spin page in `?freeRip=<claimId>` mode ignores gifts
(it is a different entitlement with its own route).

Then: charge `(count − gifts) × price` (a zero total writes no debit, the existing
free path) → record pulls (the first `gifts` rows `source='gift'`, `bonus_bp=10000`,
`pack_gift.pull_id` stamped; paid rows `pack` or `bonus` per §4.2) → stock → events →
`settleVip` (no-op for the bonus/gift part via §4.8).

The open_id is minted before the claim step so the gift rows and the debit share it.
The batch response carries the per-pull buyback quote with its bonus share.

## 6. Read APIs (storefront)

- `GET /store/pack-gifts` (auth) → `[{ pack_id, count, title, image }]` for the
  customer's unopened gifts. Read client-side with no cache (vault, pack page, spin
  page) so the cached pack-detail loaders and ISR stay untouched.
- `GET /store/credits` wallet block gains `bonus`; `withdrawable` follows §4.7; each
  ledger row gains `bonus` (MYR) for the transactions list.
- `GET /store/vault` items and the open/batch reveal quotes gain `buyback_bonus`
  beside the existing buyback amount.
- `GET /store/credits/balance` (header pill) unchanged — it already returns the
  total.

## 7. Admin API

All under existing admin auth, `adminActionRateLimit`, an `audit` row each
(`entity_type 'pack_gift'` / `'credit'`), and any RBAC policies declared in
`src/policies` (undeclared policies are soft-deleted at boot).

- `POST /admin/customers/:id/pack-gifts` `{ pack_id, quantity 1–10, note,
idempotency_key }` — N rows; replay of a `grant_key` returns the existing rows.
- `GET /admin/customers/:id/pack-gifts` — all states, newest first.
- `POST /admin/pack-gifts/:id/revoke` — conditional on still unopened; otherwise
  409 "Already opened".
- Bonus credit rides the EXISTING `POST /admin/customers/:id/credits` with
  `kind: 'bonus'` (`{ amount (±, 2dp, ≤ RM 1,000,000), note, idempotency_key,
  kind }`), so it shares the credit-adjust workflow, validation, audit and
  compensation; it writes `bonus_grant` via `mutateCreditAtomic`. (As built —
  the draft named a separate `/bonus-credits` route.)
- The customer summary the 360 page reads gains `bonus_balance`.

Grants post the customer feed notification (§1) through the existing
`notify-feed.ts` helper.

## 8. Places that name sources explicitly (must learn `gift` / `bonus`)

Positive `source = 'pack'` filters (leaderboard, challenge, feed, profile,
`hasPaidOpen`, finance, Growth pull-card, and the task `rip_count` and period
pixel counts) exclude the new values with no edit — that is the "count nothing"
rule for free. These need an edit:

- **Achievements** (`service.ts` task facts, ~2085–2110): the lifetime `vault_count`
  query and the lifetime `vault_pixel_count` total count **every** source on purpose
  (reward and free cards count). Gift and bonus pulls must be excluded there
  (`source NOT IN ('gift','bonus')`), or a gifted card completes an achievement
  whose reward can be withdrawable credit. `reach_level` follows VIP (§4.8);
  `checkin_days` is unaffected.
- `modules/packs/telegram.ts` `EXCLUDED_SOURCES` — add both.
- `api/admin/customers/[id]/pulls/route.ts` source filter — accept both.
- `api/reports/growth/packs/route.ts` — no change: its `source IN ('pack', 'free')`
  filter already leaves gift and bonus pulls out of the paid/free counts.
- `modules/packs/delivery.ts` / `workflows/steps/buyback-pull.ts` — no change (both
  only special-case `reward` and `free`); covered by tests.
- Storefront pull source mirror (`src/lib/data/schemas.ts:468`, see §3.4).

## 9. Out of scope

Bulk gifting, gift or bonus expiry, task free rips in the vault, bonus paying delivery
fees, a player-chosen spend order, gifting `free_welcome` / `reward_box` packs.

## 10. Testing

Backend integration specs (`backend/packages/api/integration-tests`), TDD:

- migrations: pack_gift table, `bonus_cents` column, reason and source CHECKs —
  proven in a spec (local `db:migrate` needs operator OK);
- bonus-first split: single open, batch, exact bonus, partial row, zero bonus;
- mixed batch `gifts=1, count=2` → one gift pull + one paid pull, one debit of 1×price;
- gift-only batch → no debit row;
- stale gift (gifts > unopened) → 409, nothing charged, nothing claimed;
- concurrent opens racing for one gift → exactly one wins;
- compensation: a failure after claim un-claims gifts and restores bonus;
- buyback split (instant and vault rate) for gift, bonus, mixed and normal pulls;
- withdrawable excludes bonus; cashout, delivery fee, negative adjustment cannot dip
  into bonus; negative `bonus_grant` cannot go below 0;
- VIP turnover and referral turnover exclude the bonus part; gift opens add nothing;
- gift and bonus pulls absent from leaderboard, challenge, feed, task progress
  (rips, period pixel counts) **and achievements** (`vault_count`, lifetime
  `vault_pixel_count`), profile, Telegram board; do not unlock the welcome pack;
- a claimed-but-unstamped gift older than 10 minutes is claimable again; a late
  original run then stamps nothing and compensates;
- revoke vs open race; admin grant idempotency; mint cap counts bonus and gifts;
- `ledgerTotals` / finance buckets for `bonus_grant` and split rows; SP/SE/AD
  payloads carry the bonus parts;
- audit enum and `FeedTemplate` additions (backend CHECK migration, storefront
  drift tests).

Unit: the allocation math and the buyback split as pure functions, beside
`external-funded.ts`.

Storefront: vitest for the label builder (`Vault xG + RM …`); Playwright screenshots
against the mock backend for the vault Packs row, pack page (qty 1/2), spin bet line
(1 row, + row, 2 gifts), reveal sell label, wallet breakdown.

## 11. Rollout

One PR (backend + admin + storefront). The new reason and source values reach the
storefront's zod mirrors, so the storefront must be live before an admin issues the
first grant: deploy the backend (migrations are additive), then the storefront, then
start granting. Record the bonus-credit decision as ADR 0010 ("Bonus credit is a
signed ledger column, not a second wallet; its value never becomes withdrawable").
