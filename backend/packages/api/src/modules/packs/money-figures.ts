import { reasonCashSenSql } from './bonus-credit';
import { EFFECTIVE_GROUP_SQL } from './odds-sets';
import { realCustomerSql, type CustomerScope } from './real-customers';

// The money figures more than one report reads, each spelled once with what
// it counts (architecture review 2026-11-15, plans/architecture-deepening/
// 04-money-figures-design.md). Callers keep their own queries and splice these
// in. Plain strings, no Medusa imports: service.ts cannot import from api/.
// A fragment takes the table alias with its dot ('ct.'), or '' for none.

/** A WHERE fragment (starting with " AND", or empty) and its bindings.
 *  Defined here, below api/, and re-exported by api/reports/sql.ts. */
export type SqlPart = { sql: string; params: unknown[] };

// ── Who a figure counts ──────────────────────────────────────────────────────

/**
 * One name per population. The word 'default' is on the wire twice, and both
 * mean `real` (owner decision 2026-11-16): CustomerScope 'default' (Profit,
 * P&L, Stats, Settlement) and GroupScope 'default' (the desk reports'
 * ?group=default). Real = in no non-default group AND not an
 * operator-generated credential account.
 */
export type Population =
  | { kind: 'everyone' }
  | { kind: 'real' }
  | { kind: 'group'; id: string; name: string }
  | { kind: 'customer'; id: string };

/** ?scope= (CustomerScope): 'default' is the real customers. */
export const fromCustomerScope = (s: CustomerScope): Population =>
  s === 'all' ? { kind: 'everyone' } : { kind: 'real' };

/** The desk reports' ?group= scope, as api/reports/params.ts resolves it
 *  (its GroupScope; spelled here so modules/ needs nothing from api/). */
type GroupScope =
  | { kind: 'all' }
  | { kind: 'default' }
  | { kind: 'group'; id: string; name: string };

/** ?group= (GroupScope): 'default' is the real customers, as on Profit. A
 *  named group keeps its credential accounts (no test there). */
export const fromGroupScope = (s: GroupScope): Population =>
  s.kind === 'all'
    ? { kind: 'everyone' }
    : s.kind === 'default'
      ? { kind: 'real' }
      : { kind: 'group', id: s.id, name: s.name };

/**
 * An `AND …` clause restricting `column` (a non-null customer id) to the
 * population, and what it binds. The group rule is EFFECTIVE_GROUP_SQL's
 * (odds-sets.ts), the real-customer rule realCustomerSql's: this only maps.
 */
export function populationSql(p: Population, column: string): SqlPart {
  switch (p.kind) {
    case 'everyone':
      return { sql: '', params: [] };
    case 'real':
      return { sql: ` AND ${realCustomerSql(column)}`, params: [] };
    case 'group':
      // The EFFECTIVE group: a player in two groups counts in the older one.
      return {
        sql: ` AND ${column} IN (SELECT customer_id FROM (${EFFECTIVE_GROUP_SQL}) eff WHERE eff.group_id = ?)`,
        params: [p.id],
      };
    case 'customer':
      return { sql: ` AND ${column} = ?`, params: [p.id] };
  }
}

// ── Ledger figures (credit_transaction) ──────────────────────────────────────

/** A figure over credit_transaction rows: which rows, and each row's sen
 *  (positive = the figure grows). `note` says what it counts, for the report
 *  JSON's `basis` and the tool descriptions. */
export type Figure = {
  note: string;
  where: (t: string) => string;
  sen: (t: string) => string;
};

/** P&L "Pack sales" (decision 11). */
export const PACK_SALES_FULL: Figure = {
  note: 'Pack sales at full price: the cash and bonus credit each charge took (P&L). The P&L takes capsule opens out of pack sales and counts them as Lucky Draw sales.',
  where: (t) => `${t}reason = 'pack_open'`,
  sen: (t) => `-ROUND(${t}amount * 100)`,
};

/** Economy / Profit / Finance "revenue" and "pack sales" (spec 2026-10-07). */
export const PACK_SALES_CASH: Figure = {
  note: 'Pack sales, cash only: the normal-credit part of each charge, net of reversals. Bonus credit spent is not revenue. Capsule opens are included.',
  where: (t) => `${t}reason = 'pack_open'`,
  sen: (t) => `-(${reasonCashSenSql(t)})`,
};

/** The capsule part of PACK_SALES_CASH: Lucky Draw revenue, not pack sales
 *  (P&L decision 3). Profit shows it on its own line. */
export const CAPSULE_SALES_CASH: Figure = {
  note: 'Lucky Draw capsule sales, cash only: the normal-credit part of each capsule charge, net of reversals.',
  where: (t) => `${PACK_SALES_CASH.where(t)} AND ${capsuleOpenSql(t)}`,
  sen: (t) => PACK_SALES_CASH.sen(t),
};

/** P&L buyback (decision 12); the P&L also leaves reward cards out
 *  (rewardCardSql). */
export const BUYBACK_FULL: Figure = {
  note: 'Buybacks at the full RM credited, bonus share included (P&L, which leaves reward cards out).',
  where: (t) => `${t}reason = 'buyback'`,
  sen: (t) => `ROUND(${t}amount * 100)`,
};

/** Economy "payouts" / Profit "sellbacks". */
export const BUYBACK_CASH: Figure = {
  note: 'Buybacks, cash part only. Differs from the full amount only on buybacks before 2026-10-09. Reward cards are included.',
  where: (t) => `${t}reason = 'buyback'`,
  sen: (t) => reasonCashSenSql(t),
};

/** Full and cash are one number: the writer sets bonus_cents 0
 *  (coin-flip-operations.ts). */
export const COIN_FLIP_WINS: Figure = {
  note: 'Credit paid to coin flip winners (no bonus part).',
  where: (t) => `${t}reason = 'coin_flip_win'`,
  sen: (t) => `ROUND(${t}amount * 100)`,
};

/** Economy "topups": positive topup rows only, as the Players list and the
 *  player page count them (owner decision 2026-11-16). The Dashboard and
 *  Profit count the gateway's settled deposits instead. */
export const TOPUPS_LEDGER: Figure = {
  note: 'Top-ups as the wallet ledger records them: every positive topup row (cash part).',
  where: (t) => `${t}reason = 'topup' AND ${t}amount > 0`,
  sen: (t) => reasonCashSenSql(t),
};

/** The rows the Economy ledger totals (ledgerReasonTotals, the Finance desk's
 *  economy and daily) read: all but a topup row that is not positive, so
 *  their topups bucket is TOPUPS_LEDGER. No other bucket reads topup rows. */
export const ledgerTotalsRowsSql = (t = ''): string =>
  `NOT (${t}reason = 'topup' AND ${t}amount <= 0)`;

/** A pack_open charge whose open made capsule spins (P&L decision 3: Lucky
 *  Draw revenue, not pack sales). `ct` = the credit_transaction alias. */
export const capsuleOpenSql = (ct: string): string =>
  `EXISTS (SELECT 1 FROM ticket_spin s WHERE s.open_id = ${ct}source_transaction_id AND s.deleted_at IS NULL)`;

/** A reward CARD pull (task-reward, challenge-…, lucky-draw: no pack row), a
 *  marketing cost when given. A free-pack rip (a reward pull of a real pack)
 *  is not one. `p` = the pull alias. */
export const rewardCardSql = (p: string): string =>
  `(${p}source = 'reward' AND NOT EXISTS (SELECT 1 FROM pack pk WHERE pk.slug = ${p}pack_id))`;

/** plan-033 playthrough basis per ledger row, in sen: a post-1b deposit's
 *  amount, plus the held part of a card sale (sellbackHoldBp), which the
 *  buyback row stamps as external_funded_cents. Shared by creditSummary,
 *  walletSummary, the release check and the P&L balance (mirrored by
 *  credit-summary.ts's fold). */
export const playthroughBasisSenSql = (t = ''): string =>
  `CASE WHEN ${t}reason = 'topup' AND ${t}amount > 0 AND ${t}external_funded_cents IS NOT NULL THEN ROUND(${t}amount * 100) ` +
  `WHEN ${t}reason = 'buyback' THEN COALESCE(${t}external_funded_cents, 0) ELSE 0 END`;

/** Each bonus row's source (P&L decision 21). Needs `task_definition td`
 *  LEFT JOINed on the row's `task:<id>` claim. Check-in = a task whose
 *  requirement type is checkin_days; Lucky Draw credit prizes are
 *  `luckydraw:<prize>`. Bonus coming back by an undo is 'returned'; any other
 *  grant is 'other'. `nullForSpends`: a consumption (bonus_cents < 0) has no
 *  source. */
export const bonusSourceSql = (
  t: string,
  opts: { nullForSpends?: boolean } = {},
): string =>
  'CASE ' +
  (opts.nullForSpends ? `WHEN ${t}bonus_cents < 0 THEN NULL ` : '') +
  `WHEN ${t}reason = 'bonus_grant' THEN 'adjustment' ` +
  `WHEN ${t}reason = 'reward_credit' AND ${t}source_transaction_id LIKE 'challenge:%' THEN 'weekly_challenge' ` +
  `WHEN ${t}reason = 'reward_credit' AND ${t}source_transaction_id LIKE 'luckydraw:%' THEN 'lucky_draw' ` +
  `WHEN ${t}reason = 'reward_credit' AND ${t}source_transaction_id LIKE 'task:%' THEN ` +
  "CASE WHEN td.requirement->>'type' = 'checkin_days' THEN 'checkin' ELSE 'task' END " +
  `WHEN ${t}reason IN ('pack_open', 'delivery_fee', 'buyback') THEN 'returned' ` +
  "ELSE 'other' END";

/** What the Economy ledger totals count (the Finance economy report's
 *  `basis`, read back by the desk bots and the assistant). */
export const LEDGER_TOTALS_BASIS = {
  revenue: PACK_SALES_CASH.note,
  payouts: BUYBACK_CASH.note,
  coinFlipPayouts: COIN_FLIP_WINS.note,
  net: 'revenue - payouts - coinFlipPayouts.',
  topups: TOPUPS_LEDGER.note,
} as const;

// ── Gateway figures (gateway_deposit / gateway_withdrawal) ───────────────────

/** Per settled gateway row. No `?` and no `::` casts: knex named-binding
 *  queries (payments/fx) read `::word` as a binding. */
export const GATEWAY = {
  /** Deposit fee in sen, signed: gross − net, like Settlement. */
  depositFeeSen: (t = ''): string =>
    `ROUND((${t}amount_settled - ${t}net_amount) * 100)`,
  /** Payout fee in sen, ABS per row (Profit and Settlement): TGPay payouts
   *  settled before 2026-09-10 stored net the other way round. */
  payoutFeeSen: (t = ''): string =>
    `ROUND(ABS(${t}net_amount - COALESCE(${t}amount_settled, ${t}amount)) * 100)`,
  /** FX earned on a regional top-up, in RM, UNROUNDED: foreign paid × mid −
   *  RM credited, valued at what really moved. */
  depositFxRm: (t = ''): string =>
    `(${t}gateway_amount * COALESCE(${t}amount_settled, ${t}amount_requested) / NULLIF(${t}amount_requested, 0) * ${t}fx_mid - COALESCE(${t}amount_settled, ${t}amount_requested))`,
  /** FX earned on a regional payout, in RM, UNROUNDED: RM debited − foreign
   *  paid out × mid. */
  payoutFxRm: (t = ''): string =>
    `(${t}amount - ${t}gateway_amount * COALESCE(${t}amount_settled, ${t}amount) / NULLIF(${t}amount, 0) * ${t}fx_mid)`,
};

// ── Cards in delivery ────────────────────────────────────────────────────────

/** The delivery-order statuses by shelf bucket (inventoryLifecycleBuckets in
 *  service.ts; 'packing' = legacy 'processed'), as SQL lists. */
export const ORDER_STATUSES = {
  requested: "('requested', 'processed', 'packing')",
  readyToShip: "('ready_to_ship', 'pending_ship')",
  shipped: "('shipped', 'completed', 'delivered')",
} as const;

const inOrderSql = (p: string, statuses: string): string =>
  'EXISTS (SELECT 1 FROM delivery_order_item i ' +
  'JOIN delivery_order o ON o.id = i.delivery_order_id AND o.deleted_at IS NULL ' +
  `WHERE i.pull_id = ${p}id AND i.deleted_at IS NULL AND (${statuses}))`;

/** A delivering pull still on our shelf: in an order requested to ready to
 *  ship (P&L decision 15). The P&L and Profit count it as owed. */
export const inActiveOrderSql = (p: string): string =>
  inOrderSql(
    p,
    `o.status IN ${ORDER_STATUSES.requested} OR o.status IN ${ORDER_STATUSES.readyToShip}`,
  );

/** A delivering pull whose order has shipped: it left as goods (a cost). */
export const inShippedOrderSql = (p: string): string =>
  inOrderSql(p, `o.status IN ${ORDER_STATUSES.shipped}`);

// ── Card value ───────────────────────────────────────────────────────────────

/** A card's live DISPLAY value in USD (FMV × market multiplier). Requires
 *  `card c`; binds ONE `?` (DEFAULT_MARKET_MULTIPLIER). */
export const LIVE_VALUE_USD_SQL =
  'c.market_value * COALESCE(c.market_multiplier, ?)';

/** One card's value in sen, rounded per card. Requires `card c`.
 *  - 'display': what buyback percents credit against (#263); binds
 *    [DEFAULT_MARKET_MULTIPLIER, fx].
 *  - 'vault': what a buyback from the vault pays now (the Flat rate); binds
 *    [DEFAULT_MARKET_MULTIPLIER, fx, FLAT_PERCENT] (display MYR × percent =
 *    sen: × 100 ÷ 100 cancel). */
export const cardValueSen = (basis: 'display' | 'vault'): string =>
  basis === 'display'
    ? `ROUND(${LIVE_VALUE_USD_SQL} * ? * 100)`
    : `ROUND(${LIVE_VALUE_USD_SQL} * ? * ?)`;
