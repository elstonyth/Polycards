import { model } from '@medusajs/framework/utils';

// Pull — the ledger: one row per opened pack (the rolled result). Written by the
// open-pack workflow; it is the source of truth for the live-pulls feed, the
// leaderboard, AND the customer's vault (a vault item = a pull with status
// "vaulted" — no separate vault table).
//
// References use the same stable business keys as PackOdds (Pack.slug,
// Card.handle). `order_id` ties the pull to the Medusa order that paid for it
// (nullable until checkout is wired).
export const Pull = model
  .define('pull', {
    id: model.id().primaryKey(),
    customer_id: model.text(),
    pack_id: model.text(), // = Pack.slug
    card_id: model.text(), // = Card.handle (the won card)
    order_id: model.text().nullable(),
    rolled_at: model.dateTime(),
    // When the customer first SAW the card at the reveal (the open animation
    // lags rolled_at). The 30s instant-sell window counts from here, capped at
    // rolled_at + BUYBACK_REVEAL_GRACE_MS so a delayed ping can't extend it.
    // Null until the reveal ping stamps it (or for cards never revealed).
    revealed_at: model.dateTime().nullable(),
    // Set when the reveal ends or the customer leaves it (POST
    // /store/pulls/close-instant, fired on the reveal client's unmount — Spin
    // again or in-app navigation; a hard tab-kill falls to the 30s deadline).
    // Once set, the instant buyback premium is over for good — every sell is flat
    // rate, even inside the 30s window. This is what makes the vault (only
    // reachable by leaving the reveal) always quote 90%; the 30s deadline is
    // just the backstop for a hard tab-kill that never stamps. Null while the
    // reveal is still live.
    instant_closed_at: model.dateTime().nullable(),
    // TRUE only when this pull actually decremented physical stock (pulls at 0
    // stock / untracked products don't). Buyback restores +1 ONLY when set —
    // otherwise repeated 0-stock pull→sell cycles would mint phantom units.
    stock_earmarked: model.boolean().default(false),
    // Vault lifecycle: every pull starts vaulted; instant buyback (at reveal or
    // later from the vault page) flips it to bought_back and credits the customer.
    // vaulted → delivering (in an active delivery order) → delivered (terminal);
    // delivering → vaulted on order cancel. bought_back only reachable while vaulted.
    status: model
      .enum(['vaulted', 'bought_back', 'delivering', 'delivered'])
      .default('vaulted'),
    // USD pulled value (decimal) — a SNAPSHOT taken at DRAW time (card FMV ×
    // its market_multiplier, default baked in), same discipline as
    // buyback_amount below. The leaderboard/challenge "pulled value" aggregates
    // read this so a mid-week price sync can't rewrite past totals. Null on
    // reward pulls (excluded from those boards) and on pre-migration rows until
    // the backfill runs — readers COALESCE to live pricing.
    recorded_value_usd: model.bigNumber().nullable(),
    // MYR actually credited (RM decimal, never sen) — a SNAPSHOT taken at buyback
    // time (current FMV × the pack's buyback_percent), kept since FMV moves.
    buyback_amount: model.bigNumber().nullable(),
    buyback_at: model.dateTime().nullable(),
    // Profile showcase opt-in: customer chose to display this pull publicly.
    showcased: model.boolean().default(false),
    // Origin of this pull: 'pack' (standard open) or 'reward' (daily reward draw).
    // For reward pulls, card_id holds the product_handle sentinel.
    // Model-owned CHECK (pull_source_check) emitted by db:generate — do NOT
    // hand-write a separate CHECK (would collide → 42710).
    source: model.enum(['pack', 'reward']).default('pack'),
    // The open's stable id (same uuid the pack_open charge row stores in
    // credit_transaction.source_transaction_id) — the money↔card audit link.
    // A count=N batch open shares ONE open_id across its N pulls (one charge
    // row paid them all). NULL on reward pulls (no charge; reward_draw carries
    // their provenance) and on pre-migration rows (forward-only, never
    // back-filled). ponytail: no index — audit/dispute reads are rare; add one
    // if a hot path ever filters on it.
    open_id: model.text().nullable(),
  })
  .indexes([
    // vault + public profile + admin gacha: filter customer_id, order rolled_at.
    {
      name: 'IDX_pull_customer_id_rolled_at',
      on: ['customer_id', 'rolled_at'],
      where: 'deleted_at IS NULL',
    },
    // global recent-pulls feed + leaderboard window: order/range on rolled_at,
    // no customer predicate (so it can't use the composite above).
    {
      name: 'IDX_pull_rolled_at',
      on: ['rolled_at'],
      where: 'deleted_at IS NULL',
    },
  ]);

export default Pull;
