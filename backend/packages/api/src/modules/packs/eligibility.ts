import type { Context } from '@medusajs/framework/types';
import type PacksModuleService from './service';
import type { LedgerSqlManager } from './claim';
import {
  DEFAULT_PLAYER_GROUP_FLAG,
  DEFAULT_PLAYER_GROUP_NAME,
  EFFECTIVE_GROUP_SQL,
} from './odds-sets';
import { groupPolicyOf, type GroupPolicy } from './group-policy';
import { normalSenSql } from './bonus-credit';

/**
 * Player eligibility: who may show, receive or play (owner rules #1036, #993,
 * #988, #939). The SQL twins here and the JS readers on the service
 * (isAccountDisabled, disabledCustomerIds, effectivePlayerGroup) are pinned
 * against each other by eligibility.integration.spec.ts.
 *
 * Callers still decide what "hidden" means on their surface: the boards drop
 * a hidden account, past results show it as "Anonymous".
 */

// Inside the subqueries an outer column named with the same alias binds to the
// subquery's own table and the test is always true (see realCustomerSql), so
// the inner aliases carry a prefix no caller uses and callers must qualify.
const INNER_ALIAS = /^elig_/i;
const qualified = (fn: string, column: string): string => {
  if (
    !/^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/i.test(column) ||
    INNER_ALIAS.test(column)
  ) {
    throw new Error(`${fn}: column must be table-qualified, got '${column}'`);
  }
  return column;
};

/** EXISTS a live disabled account-state row for `column`: the SQL twin of
 *  isAccountDisabled / disabledCustomerIds. A purged customer matches too (the
 *  purge writes a disabled tombstone). */
export const disabledAccountSql = (column: string): string =>
  'EXISTS (SELECT 1 FROM customer_account_state elig_s ' +
  `WHERE elig_s.customer_id = ${qualified('disabledAccountSql', column)} ` +
  'AND elig_s.disabled = true AND elig_s.deleted_at IS NULL)';

/** EXISTS a live membership of `column` in a live group neither named DEFAULT
 *  nor flagged is_default: "has a real player group", the existence form of
 *  EFFECTIVE_GROUP_SQL. */
export const realGroupMemberSql = (column: string): string =>
  'EXISTS (SELECT 1 FROM customer_group_customer elig_cgc ' +
  'JOIN customer_group elig_cg ON elig_cg.id = elig_cgc.customer_group_id AND elig_cg.deleted_at IS NULL ' +
  `WHERE elig_cgc.customer_id = ${qualified('realGroupMemberSql', column)} AND elig_cgc.deleted_at IS NULL ` +
  `AND elig_cg.name IS DISTINCT FROM '${DEFAULT_PLAYER_GROUP_NAME}' ` +
  `AND elig_cg.metadata->'${DEFAULT_PLAYER_GROUP_FLAG}' IS DISTINCT FROM 'true'::jsonb)`;

/** A public board's length. */
export const BOARD_TOP_N = 10;
/** Over-fetch, because the hidden filter runs after the aggregate: a hidden
 *  player in the top 10 must not shorten the board to 9. Double is the bound
 *  (owner, 2026-11-15: not changed) — a board where more than half the top 20
 *  are hidden renders short, which is the honest outcome. */
export const BOARD_FETCH_N = BOARD_TOP_N * 2;

/**
 * The first `n` ranked rows nobody hid, re-numbered by the caller over the
 * survivors (no gaps: a gap would publish that someone was removed).
 * `hiddenAboveCut` counts the hidden rows passed before the board filled. The
 * public boards and challenge settlement all cut here, so the rank shown is
 * the rank paid.
 */
export function topShown<T>(
  ranked: readonly T[],
  hidden: ReadonlySet<string>,
  idOf: (row: T) => string,
  n = BOARD_TOP_N,
): { shown: T[]; hiddenAboveCut: number } {
  const shown: T[] = [];
  let hiddenAboveCut = 0;
  for (const row of ranked) {
    if (shown.length === n) break;
    if (hidden.has(idOf(row))) hiddenAboveCut++;
    else shown.push(row);
  }
  return { shown, hiddenAboveCut };
}

export type Game = 'lucky_draw' | 'coin_flip';
export type PlayRefusal = 'unavailable' | 'frozen' | 'no_topup';

/** What DEFAULT (or no group) must have topped up, in total, to play Coin
 *  Flip. Spending it on packs is not asked (owner, 2026-11-21): withdrawals
 *  keep their own spend-first gate, so a flip win still cannot leave before
 *  the top-up has gone through packs. */
export const COIN_FLIP_MIN_TOPUP_MYR = 50;

export type PlayFacts = {
  disabled: boolean;
  frozen: boolean;
  /** Any positive top-up ever: Lucky Draw's bar. */
  hasTopup: boolean;
  /** Lifetime real top-ups (MYR, normal part): Coin Flip's bar. */
  topupMyr: number;
  /** The effective player group's policy; null for DEFAULT or no group. A
   *  topped-up Lucky Draw player may pass null unread: the group only matters
   *  without a top-up. Lucky Draw likewise reads no freeze. */
  group: GroupPolicy | null;
};

/**
 * Why `game` turns this player away, or null. In order:
 *  1. a disabled account plays nothing;
 *  2. Coin Flip: any freeze, manual or auto (Lucky Draw entry checks only a
 *     manual one, through its own assertNotFrozen);
 *  3. only DEFAULT (or no group) must have topped up (owner 2026-11-02/04):
 *     Lucky Draw any top-up, Coin Flip COIN_FLIP_MIN_TOPUP_MYR in total (a
 *     non-finite total refuses).
 */
export function playRefusal(game: Game, f: PlayFacts): PlayRefusal | null {
  if (f.disabled) return 'unavailable';
  if (game === 'coin_flip' && f.frozen) return 'frozen';
  if (f.group) return null;
  if (game === 'coin_flip') {
    return Number.isFinite(f.topupMyr) && f.topupMyr >= COIN_FLIP_MIN_TOPUP_MYR
      ? null
      : 'no_topup';
  }
  return f.hasTopup ? null : 'no_topup';
}

const manager = (ctx: Context): LedgerSqlManager =>
  (ctx.transactionManager ?? ctx.manager) as unknown as LedgerSqlManager;

/** The customer's effective player group policy, read in SQL on the caller's
 *  connection (so inside its lock and transaction); null for DEFAULT or none. */
export async function effectiveGroupPolicy(
  customerId: string,
  ctx: Context,
): Promise<GroupPolicy | null> {
  const [row] = await manager(ctx).execute<
    { name: string | null; metadata: Record<string, unknown> | null }[]
  >(
    `SELECT cg.name, cg.metadata FROM (${EFFECTIVE_GROUP_SQL}) g ` +
      'JOIN customer_group cg ON cg.id = g.group_id WHERE g.customer_id = ?',
    [customerId],
  );
  return row ? groupPolicyOf(row) : null;
}

/** Lifetime real top-ups (MYR): the normal part of positive topup rows, the
 *  rows the check-in bar and topup_myr goals count. Admin credit and bonus
 *  never count, and a later clawback does not subtract. */
export async function realTopupMyr(
  customerId: string,
  ctx: Context,
): Promise<number> {
  const [row] = await manager(ctx).execute<{ sen: string | null }[]>(
    `SELECT COALESCE(SUM(${normalSenSql()}), 0)::bigint AS sen FROM credit_transaction ` +
      "WHERE customer_id = ? AND reason = 'topup' AND amount > 0 AND deleted_at IS NULL",
    [customerId],
  );
  return row?.sen == null ? 0 : Number(row.sen) / 100;
}

/** playRefusal over the live facts, read on the caller's context. */
export async function mayPlay(
  svc: PacksModuleService,
  customerId: string,
  game: Game,
  ctx: Context,
): Promise<PlayRefusal | null> {
  const disabled = await svc.isAccountDisabled(customerId, ctx);
  if (game === 'lucky_draw') {
    // Lucky Draw reads no freeze, and a top-up makes the group moot.
    const hasTopup = await svc.hasTopUp(customerId, ctx);
    const group = hasTopup ? null : await effectiveGroupPolicy(customerId, ctx);
    return playRefusal(game, {
      disabled,
      frozen: false,
      hasTopup,
      topupMyr: 0,
      group,
    });
  }
  const group = await effectiveGroupPolicy(customerId, ctx);
  const topupMyr = await realTopupMyr(customerId, ctx);
  return playRefusal(game, {
    disabled,
    frozen: await svc.isFrozen(customerId, ctx),
    hasTopup: topupMyr > 0,
    topupMyr,
    group,
  });
}

/** Coin Flip's refusal texts, thrown as NOT_ALLOWED. no_topup is Coin Flip's
 *  own copy (owner, 2026-11-15), not the delivery gate's NO_TOPUP_MESSAGE. */
export const COIN_FLIP_REFUSAL: Readonly<Record<PlayRefusal, string>> = {
  unavailable: 'This account is unavailable.',
  frozen: 'Coin flips are unavailable while your account is under review.',
  no_topup: `Top up at least RM ${COIN_FLIP_MIN_TOPUP_MYR} in total to play Coin Flip.`,
};
