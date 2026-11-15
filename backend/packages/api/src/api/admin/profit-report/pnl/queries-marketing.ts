import type { CustomerScope } from '../../../../modules/packs/real-customers';
import { filterSql } from '../../../../modules/packs/real-customers';
import type {
  CardSource,
  CreditSource,
  MarketingWindowRows,
} from '../../../../modules/packs/pnl-marketing';
import { DEFAULT_MARKET_MULTIPLIER } from '../../../../modules/packs/pricing';
import { bonusSourceSql } from '../../../../modules/packs/money-figures';
import { mytDaySql } from '../../../../modules/packs/myt-window';
import { and, windowFilter, type ReportDb } from '../../../reports/sql';
import type { ReportWindow } from '../../../reports/params';

// The P&L Marketing section's SQL (spec §7). Read-only, one statement at a
// time; the fold is modules/packs/pnl-marketing.ts. Free packs come from
// packWindowRows (queries.ts), which the route already runs.

// Each bonus row's source (decision 21). 'other' (voucher, daily reward, a
// future promo) stays a marketing cost.
const CREDIT_SOURCE_SQL = bonusSourceSql('ct.');

/** One window's marketing rows: free credit used/given by source, reward
 *  cards given, referral commission. Statements run one after another. */
export async function marketingWindowRows(
  db: ReportDb,
  window: ReportWindow,
  scope: CustomerScope,
): Promise<MarketingWindowRows> {
  // Oldest grant first (plans/pnl-report/bonus-fifo-proof.sql): each
  // customer's lots (bonus_cents > 0) and consumptions (< 0) become cumulative
  // ranges over ALL history; a spend uses the lots its range overlaps. The
  // window applies only after the ranges are built. Valid because no bonus
  // balance was ever negative (prod 11-15).
  const who = filterSql(scope, 'ct.customer_id');
  const used = windowFilter(window, 'u.created_at');
  const given = windowFilter(window, 'created_at');
  const removed = windowFilter(window, 'created_at');
  const credit = await db.raw<{
    kind: MarketingWindowRows['credit'][number]['kind'];
    source: CreditSource;
    sen: string | null;
  }>(
    'WITH b AS (SELECT ct.id, ct.customer_id, ct.created_at, ct.reason, ct.bonus_cents, ' +
      `${CREDIT_SOURCE_SQL} AS source ` +
      'FROM credit_transaction ct ' +
      "LEFT JOIN task_definition td ON ct.reason = 'reward_credit' " +
      "AND ct.source_transaction_id LIKE 'task:%' " +
      "AND td.id = split_part(ct.source_transaction_id, ':', 2) " +
      'WHERE ct.deleted_at IS NULL AND COALESCE(ct.bonus_cents, 0) <> 0' +
      who.sql +
      '), lots AS (SELECT customer_id, created_at, source, bonus_cents AS amt, ' +
      'SUM(bonus_cents) OVER w - bonus_cents AS lo, SUM(bonus_cents) OVER w AS hi ' +
      'FROM b WHERE bonus_cents > 0 ' +
      'WINDOW w AS (PARTITION BY customer_id ORDER BY created_at, id ROWS UNBOUNDED PRECEDING)' +
      '), uses AS (SELECT customer_id, created_at, reason, -bonus_cents AS amt, ' +
      'SUM(-bonus_cents) OVER w + bonus_cents AS lo, SUM(-bonus_cents) OVER w AS hi ' +
      'FROM b WHERE bonus_cents < 0 ' +
      'WINDOW w AS (PARTITION BY customer_id ORDER BY created_at, id ROWS UNBOUNDED PRECEDING)) ' +
      // A negative bonus_grant is an admin removal: it consumes lots, not "used".
      "SELECT 'used' AS kind, l.source, SUM(LEAST(l.hi, u.hi) - GREATEST(l.lo, u.lo))::bigint AS sen " +
      'FROM lots l JOIN uses u ON u.customer_id = l.customer_id AND u.lo < l.hi AND u.hi > l.lo ' +
      "WHERE u.reason <> 'bonus_grant'" +
      used.sql +
      ' GROUP BY l.source ' +
      "UNION ALL SELECT 'given', source, SUM(amt)::bigint FROM lots WHERE TRUE" +
      given.sql +
      ' GROUP BY source ' +
      "UNION ALL SELECT 'removed', 'adjustment', SUM(amt)::bigint FROM uses " +
      "WHERE reason = 'bonus_grant'" +
      removed.sql,
    [...who.params, ...used.params, ...given.params, ...removed.params],
  );

  // Reward CARDS (no pack row): task cards (check-in when the claim's task is
  // checkin_days) and weekly challenge cards. Lucky Draw card prizes are
  // Lucky Draw cost. Sold ones at the RM credited (buyback_amount); the rest
  // as live USD, priced by the fold.
  const pulls = and(
    windowFilter(window, 'p.rolled_at'),
    filterSql(scope, 'p.customer_id'),
  );
  const cards = await db.raw<{
    source: CardSource;
    day: string;
    n: string;
    sold: string;
    sold_sen: string;
    unsold_usd: number;
  }>(
    "SELECT CASE WHEN p.pack_id LIKE 'challenge-%' THEN 'weekly_challenge' " +
      "WHEN td.requirement->>'type' = 'checkin_days' THEN 'checkin' ELSE 'task' END AS source, " +
      `${mytDaySql('p.rolled_at')} AS day, ` +
      'COUNT(*)::bigint AS n, COUNT(p.buyback_amount)::bigint AS sold, ' +
      'COALESCE(SUM(ROUND(p.buyback_amount * 100)), 0)::bigint AS sold_sen, ' +
      'COALESCE(SUM(c.market_value * COALESCE(c.market_multiplier, ?)) ' +
      'FILTER (WHERE p.buyback_amount IS NULL), 0)::float8 AS unsold_usd ' +
      'FROM pull p LEFT JOIN card c ON c.handle = p.card_id AND c.deleted_at IS NULL ' +
      'LEFT JOIN task_claim tc ON tc.claim_ref = p.id AND tc.deleted_at IS NULL ' +
      'LEFT JOIN task_definition td ON td.id = tc.task_id ' +
      "WHERE p.deleted_at IS NULL AND p.source = 'reward' " +
      "AND (p.pack_id = 'task-reward' OR p.pack_id LIKE 'challenge-%') " +
      'AND NOT EXISTS (SELECT 1 FROM pack pk WHERE pk.slug = p.pack_id)' +
      pulls.sql +
      ' GROUP BY 1, 2',
    [DEFAULT_MARKET_MULTIPLIER, ...pulls.params],
  );

  // Referral commission when credited (decision 18).
  const ledger = and(
    windowFilter(window, 'ct.created_at'),
    filterSql(scope, 'ct.customer_id'),
  );
  const referral = await db.raw<{ sen: string }>(
    'SELECT COALESCE(SUM(ROUND(ct.amount * 100)), 0)::bigint AS sen ' +
      'FROM credit_transaction ct ' +
      "WHERE ct.deleted_at IS NULL AND ct.reason = 'referral_commission'" +
      ledger.sql,
    ledger.params,
  );

  // Reward credits paid as CASH (the part with no free-credit share; before
  // 11 Oct every reward was cash) count as marketing when given (decision 24).
  // Lucky Draw credit prizes are Lucky Draw cost, not marketing.
  const cashRewards = await db.raw<{ source: CreditSource; sen: string }>(
    `SELECT ${CREDIT_SOURCE_SQL} AS source, ` +
      'COALESCE(SUM(ROUND(ct.amount * 100) - COALESCE(ct.bonus_cents, 0)), 0)::bigint AS sen ' +
      'FROM credit_transaction ct ' +
      "LEFT JOIN task_definition td ON ct.reason = 'reward_credit' " +
      "AND ct.source_transaction_id LIKE 'task:%' " +
      "AND td.id = split_part(ct.source_transaction_id, ':', 2) " +
      "WHERE ct.deleted_at IS NULL AND ct.reason = 'reward_credit' " +
      "AND COALESCE(ct.source_transaction_id, '') NOT LIKE 'luckydraw:%'" +
      ledger.sql +
      ' GROUP BY 1',
    ledger.params,
  );

  return {
    cash_rewards: cashRewards.rows
      .map((r) => ({ source: r.source, sen: Number(r.sen ?? 0) }))
      .filter((r) => r.sen !== 0),
    credit: credit.rows.map((r) => ({
      kind: r.kind,
      source: r.source,
      sen: Number(r.sen ?? 0),
    })),
    cards: cards.rows.map((r) => ({
      source: r.source,
      day: r.day,
      n: Number(r.n),
      sold: Number(r.sold),
      sold_sen: Number(r.sold_sen),
      unsold_usd: Number(r.unsold_usd),
    })),
    referral_sen: Number(referral.rows[0]?.sen ?? 0),
  };
}
