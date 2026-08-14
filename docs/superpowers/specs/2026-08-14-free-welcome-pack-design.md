# Free Welcome Pack — Design

Date: 2026-08-14
Status: approved (brainstorm), pending implementation plan

## Summary

Every newly registered account gets ONE free pack open. The free pack is a
normal gacha Pack that the operator configures with the existing pack editor
(cards, odds, RTP tooling), flagged `free_welcome` and hidden from the public
catalog. The card won from the free pack is **fully locked** — no buyback, no
delivery — until the customer purchases and opens one paid pack. Reference UX:
90scard floating "FREE PACK" badge (entry point) and cardgitals vault lock
overlay (locked-state messaging), except our lock also blocks sell-back
(operator decision — full lock, no credit leak).

## Decisions (from brainstorm)

| Question | Decision |
| --- | --- |
| Lock scope before first paid open | **Full lock**: no buyback, no delivery, no cashout effect (card produces no credit) |
| Storefront entry | **Floating badge** on `/slots` only, eligible accounts only, gone after claim |
| Admin config | **Reuse pack editor**; free pack = Pack row flagged `free_welcome`; admin `/packs` gets a "Free pack" sub-tab; one active free pack at a time |
| Eligibility | **New registrations only** (accounts created after feature ships); no retroactive backfill |
| Unlock trigger | **Any paid pack open** (any successful `pack_open` charge > RM0, any funding source) |
| Approach | A — flagged Pack, reuse open flow (B separate module and C reward-draw reuse rejected) |

## Data model (packs module)

1. **`pack.category = 'free_welcome'`** — NO new pack column (revised at plan
   time from the earlier `free_welcome` boolean: the catalog already excludes
   internal packs by category — `category: { $ne: 'reward_box' }` in
   `/store/packs` — so a reserved category reuses that exact pattern with zero
   pack migration).
   - Public catalog list (`/store/packs`) excludes `free_welcome` (added to the
     existing `$ne` exclusion, now `$nin: ['reward_box', 'free_welcome']`).
   - Admin list filters `category === 'free_welcome'` for the "Free pack"
     sub-tab.
   - Server validation: a `free_welcome` pack must have `price = 0`, and at
     most ONE may be `status='active'` at a time (activating a second → 400).
2. **`pull.source`** — enum gains `'free'` (beside `'pack' | 'reward'`).
   - Free pulls write `recorded_value_usd = NULL` (mirrors `'reward'`): they are
     excluded from the leaderboard, the Weekly Pulled Value Challenge, and any
     pulled-value aggregate. Farm protection.
   - Free pulls are also excluded from the public live-pulls feed.
   - Migration note: the `pull_source_check` CHECK is model-owned and emitted by
     `db:generate` — do NOT hand-write a second CHECK. Verify the generated SQL
     manually (`db:generate` diffs against the snapshot, not the live DB).
3. **`customer_account_state`** — two new nullable timestamps:
   - `free_pack_available_at` — stamped by a `customer.created` subscriber.
     Only accounts registered after the feature ships ever get the stamp, which
     implements "new registrations only" with no date cutoffs.
   - `free_pack_claimed_at` — stamped atomically at claim time.

## Backend flow

### Claim + open

Reuse `POST /store/packs/[slug]/open` and `openPackWorkflow` unchanged in
shape. Inside the workflow, when the pack is `free_welcome`:

- The credit charge step is replaced by a **claim step**:
  `UPDATE customer_account_state SET free_pack_claimed_at = now() WHERE
  customer_id = ? AND free_pack_available_at IS NOT NULL AND
  free_pack_claimed_at IS NULL` — zero rows affected → error (already claimed
  or not eligible). This is the concurrency guard (double-tap / two tabs: the
  second caller loses).
- Compensation clears `free_pack_claimed_at` if a downstream step fails, same
  discipline as the charge step's refund compensation.
- No `credit_transaction` row is written → VIP turnover, referral commission,
  and the playthrough withdrawal gate are all naturally unaffected. RM0 price
  display; `pack.price` is ignored for free packs.
- Roll, stock earmark (`stock_earmarked`), and pull record run unchanged; the
  pull is written with `source='free'`, `open_id` NULL (no charge row to link).

Adjacent routes:

- `POST /store/packs/[slug]/open-batch` rejects a `free_welcome` slug.
- The open/reveal response for a free pull carries **no instant buyback
  offer** (quote suppressed; UI shows the locked note instead).

### Lock guard (computed, no stored unlock flag)

A free pull is locked while the customer has **zero `pack_open` charge rows**
(`credit_transaction`, customer-indexed). One shared util in the packs module,
enforced at:

- `POST /store/vault/[id]/buyback` — 4xx when the pull is a locked free pull.
- `POST /store/vault/buyback-batch` — locked free pulls excluded from the batch.
- Delivery order create (`POST /store/delivery-orders`) — reject when any
  requested pull is a locked free pull.

The first paid open unlocks automatically — no stamp, no migration, no cache;
the query only ever runs for `source='free'` pulls, which a customer has at
most one of.

### Eligibility endpoint

`GET /store/free-pack` (authenticated) → `{ eligible: boolean, slug: string |
null }`. `eligible` = `free_pack_available_at` set AND `free_pack_claimed_at`
null AND an active `free_welcome` pack exists. Feeds the storefront badge; the
badge is the only public surface of the free pack.

## Storefront

- **Floating badge** on `/slots`: floated bottom-right of the catalog.
  Rendered only when `GET /store/free-pack` returns eligible. Tap →
  `/slots/<free-slug>`. Disappears after claim (endpoint re-checked /
  optimistic hide).
  - Asset DONE (2026-08-14, operator-picked from 3 Higgsfield options —
    revised same day to Option 1): black-and-gold squircle badge, pack peeking
    out top, white "FREE PACK" type, confetti; transparent WebP at
    `public/images/polycards/free-pack-badge.webp` (393×512). Render at
    ~100–130px wide; subtle float/bob animation, gated on
    `usePrefersReducedMotion`.
- **Pack detail** (`/slots/<free-slug>`): existing `PackDetailClient`;
  price and quantity controls hidden; single "Open Free Pack" CTA. Direct
  navigation by an ineligible account shows the pack but the open fails
  server-side (defense in depth; UI can also disable the CTA off the
  eligibility endpoint).
- **Reveal**: no sell buttons for a free pull; note "Purchase any pack to
  unlock selling & delivery."
- **Vault**: locked free card gets a cardgitals-style overlay — lock icon,
  "Locked — purchase & open any pack to unlock selling & delivery",
  tap-to-dismiss. Sell/deliver selection disabled for that card. Once a paid
  open exists the overlay is gone and the card behaves normally.

## Admin

- `/packs` gains sub-tabs **"Packs | Free pack"**. The Free pack tab is the
  same table filtered to `free_welcome`, with its own "Create free pack"
  button (creates a Pack with the flag set). The pack editor — cards, odds,
  RTP auto-split, published odds — is reused untouched.
- Server-side validation guards the one-active-free-pack rule (the UI also
  surfaces the error).

## Edge cases

- Free pack drafted or deactivated → badge hidden (`eligible: false`), open
  404s (existing inactive-pack validation).
- Frozen / disabled accounts → existing open guards already block.
- Claim race → atomic stamp; loser gets an error, no double pull.
- Mass-registration farming → cards locked forever without a purchase, zero
  credit minted, excluded from leaderboard/challenge/feed; phone OTP gate
  (when enabled) throttles signup volume.
- Account deletion → free pull follows the existing pull lifecycle; no
  special-casing.

## Testing

- **Unit**: claim step atomicity + double-claim rejection; lock guard truth
  table (free pull × paid-open existence); one-active-free-pack validation;
  eligibility computation.
- **Integration (http)**: register → eligible → open free pack → pull has
  `source='free'` + null recorded value → buyback 4xx → delivery create 4xx →
  paid open → buyback and delivery both succeed. `buyback-batch` excludes the
  locked pull. `open-batch` rejects the free slug. Leaderboard/feed exclusion.
- **Fixtures**: `seed:e2e` gains an active free pack.
- **Storefront**: Playwright QA loop — badge visibility (eligible vs not),
  locked overlay, post-unlock normal behavior.

## Out of scope

- Retroactive grants to existing accounts.
- Sell-back-for-credit variant (cardgitals behavior) — operator chose full lock.
- Multiple concurrent free packs / A-B testing of free packs.
- Any change to cashout/withdrawal rules (free pack mints no credit).
