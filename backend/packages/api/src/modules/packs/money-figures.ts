import type { GroupScope } from '../../api/reports/params';
import type { SqlPart } from '../../api/reports/sql';
import { reasonCashSenSql } from './bonus-credit';
import { EFFECTIVE_GROUP_SQL } from './odds-sets';
import { realCustomerSql, type CustomerScope } from './real-customers';

// The money figures more than one report reads, each spelled once with what
// it counts (architecture review 2026-11-15, plans/architecture-deepening/
// 04-money-figures-design.md). Callers keep their own queries and splice these
// in. Plain strings, no Medusa imports: service.ts cannot import from api/.
// A fragment takes the table alias with its dot ('ct.'), or '' for none.

// ── Who a figure counts ──────────────────────────────────────────────────────

/**
 * One name per population. The word 'default' means two things on the wire,
 * so neither is used here:
 *  - `real`: CustomerScope 'default' (Profit, P&L, Stats, Settlement): in no
 *    non-default group AND not an operator-generated credential account.
 *  - `default_group`: GroupScope 'default' (the desk reports' ?group=default):
 *    effective player group DEFAULT, with NO credential test.
 */
export type Population =
  | { kind: 'everyone' }
  | { kind: 'real' }
  | { kind: 'default_group' }
  | { kind: 'group'; id: string; name: string }
  | { kind: 'customer'; id: string };

/** ?scope= (CustomerScope): 'default' is the real customers. */
export const fromCustomerScope = (s: CustomerScope): Population =>
  s === 'all' ? { kind: 'everyone' } : { kind: 'real' };

/** ?group= (GroupScope): 'default' is the DEFAULT group, credential accounts
 *  included. Reading it as `real` would change the desk numbers (owner G1). */
export const fromGroupScope = (s: GroupScope): Population =>
  s.kind === 'all'
    ? { kind: 'everyone' }
    : s.kind === 'default'
      ? { kind: 'default_group' }
      : { kind: 'group', id: s.id, name: s.name };

const QUALIFIED = /^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/i;

/**
 * An `AND …` clause restricting `column` (a non-null customer id) to the
 * population, and what it binds. The group rule is EFFECTIVE_GROUP_SQL's
 * (odds-sets.ts), the real-customer rule realCustomerSql's: this only maps.
 * Exclusions are correlated NOT EXISTS: equal to NOT IN while both customer
 * id columns are NOT NULL (checked on prod 2026-11-15), and an anti-join
 * whatever work_mem allows.
 */
export function populationSql(p: Population, column: string): SqlPart {
  switch (p.kind) {
    case 'everyone':
      return { sql: '', params: [] };
    case 'real':
      return { sql: ` AND ${realCustomerSql(column)}`, params: [] };
    case 'default_group':
      // Unqualified, the name binds to eff's own customer_id: always true,
      // excluding everyone.
      if (!QUALIFIED.test(column)) {
        throw new Error(
          `populationSql: column must be table-qualified, got '${column}'`,
        );
      }
      return {
        sql: ` AND NOT EXISTS (SELECT 1 FROM (${EFFECTIVE_GROUP_SQL}) eff WHERE eff.customer_id = ${column})`,
        params: [],
      };
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
  note: 'Pack sales at full price: the cash and bonus credit each charge took (P&L). Capsule opens are left out (they are Lucky Draw sales).',
  where: (t) => `${t}reason = 'pack_open'`,
  sen: (t) => `-ROUND(${t}amount * 100)`,
};

/** Economy / Profit / Finance "revenue" and "pack sales" (spec 2026-10-07). */
export const PACK_SALES_CASH: Figure = {
  note: 'Pack sales, cash only: the normal-credit part of each charge, net of reversals. Bonus credit spent is not revenue. Capsule opens are included.',
  where: (t) => `${t}reason = 'pack_open'`,
  sen: (t) => `-(${reasonCashSenSql(t)})`,
};

/** P&L buyback (decision 12); P&L also leaves reward cards out (REWARD_CARD_SQL). */
export const BUYBACK_FULL: Figure = {
  note: 'Card sell-backs at the full RM credited, bonus share included (P&L, which also leaves reward cards out).',
  where: (t) => `${t}reason = 'buyback'`,
  sen: (t) => `ROUND(${t}amount * 100)`,
};

/** Economy "payouts" / Profit "sellbacks". */
export const BUYBACK_CASH: Figure = {
  note: 'Card sell-backs, cash part only. Differs from the full amount only on sell-backs before 2026-10-09. Reward cards are included.',
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

/** Economy "topups": every topup row, a negative one included. The Players
 *  list and the player page count positive rows only (owner G6). The
 *  Dashboard and Profit count the gateway's settled deposits instead. */
export const TOPUPS_LEDGER: Figure = {
  note: 'Top-ups as the wallet ledger records them: every topup row (cash part), a negative correction included.',
  where: (t) => `${t}reason = 'topup'`,
  sen: (t) => reasonCashSenSql(t),
};

/** A pack_open charge whose open made capsule spins (P&L decision 3: Lucky
 *  Draw revenue, not pack sales). `ct` = the credit_transaction alias. */
export const CAPSULE_OPEN_SQL = (ct: string): string =>
  `EXISTS (SELECT 1 FROM ticket_spin s WHERE s.open_id = ${ct}source_transaction_id AND s.deleted_at IS NULL)`;

/** A reward CARD pull (task-reward, challenge-…, lucky-draw: no pack row), a
 *  marketing cost when given. A free-pack rip (a reward pull of a real pack)
 *  is not one. `p` = the pull alias. */
export const REWARD_CARD_SQL = (p: string): string =>
  `(${p}source = 'reward' AND NOT EXISTS (SELECT 1 FROM pack pk WHERE pk.slug = ${p}pack_id))`;

/** plan-033 playthrough basis per ledger row, in sen: a post-1b deposit's
 *  amount, plus the held part of a card sale (sellbackHoldBp), which the
 *  buyback row stamps as external_funded_cents. Shared by creditSummary,
 *  walletSummary, the release check and the P&L balance (mirrored by
 *  credit-summary.ts's fold). */
export const depositedPtSenSql = (t = ''): string =>
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

/** What the Economy ledger totals count (the Finance economy / daily
 *  reports' `basis`, read back by the desk bots and the assistant). */
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
  /** Payout fee in sen, ABS per row: TGPay payouts settled before 2026-09-10
   *  stored net the other way round (Settlement still sums signed: owner G2). */
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

// ── Card value ───────────────────────────────────────────────────────────────

/** A card's live DISPLAY value in USD (FMV × market multiplier). Requires
 *  `card c`; binds ONE `?` (DEFAULT_MARKET_MULTIPLIER). */
export const LIVE_VALUE_USD_SQL =
  'c.market_value * COALESCE(c.market_multiplier, ?)';

/** One card's value in sen, rounded per card. Requires `card c`.
 *  - 'display': what buyback percents credit against (#263); binds
 *    [DEFAULT_MARKET_MULTIPLIER, fx].
 *  - 'sellback': what the vault pays back now; binds
 *    [DEFAULT_MARKET_MULTIPLIER, fx, FLAT_PERCENT] (display MYR × percent =
 *    sen: × 100 ÷ 100 cancel). */
export const cardValueSen = (basis: 'display' | 'sellback'): string =>
  basis === 'display'
    ? `ROUND(${LIVE_VALUE_USD_SQL} * ? * 100)`
    : `ROUND(${LIVE_VALUE_USD_SQL} * ? * ?)`;
