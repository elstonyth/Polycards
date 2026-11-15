import type { CustomerScope } from '../../../../modules/packs/real-customers';
import { filterSql } from '../../../../modules/packs/real-customers';
import {
  bonusSourceSql,
  cardValueSen,
  depositedPtSenSql,
} from '../../../../modules/packs/money-figures';
import {
  BONUS_SOURCES,
  type BonusSource,
  type CardsLine,
  type StockRow,
  type WalletRow,
} from '../../../../modules/packs/pnl-balance';
import { FLAT_PERCENT } from '../../../../modules/packs/buyback-rate';
import { DEFAULT_MARKET_MULTIPLIER } from '../../../../modules/packs/pricing';
import type { ReportDb } from '../../../reports/sql';

// The P&L report's point-in-time SQL (spec §9-10): as of now, no window.
// Read-only; callers run these one after another (small pool). Folded by
// modules/packs/pnl-balance.ts.

// The delivery-order statuses that still hold a card on the shelf
// (inventoryLifecycleBuckets in service.ts; 'packing' = legacy 'processed').
const REQUESTED = "('requested', 'processed', 'packing')";
const READY_TO_SHIP = "('ready_to_ship', 'pending_ship')";
const SHIPPED = "('shipped', 'completed', 'delivered')";

/** Every received card's shelf counts, the Stock page's (inventory-view.ts):
 *  on hand = GRN lines + invoice lines not transferred from a GRN − shipped;
 *  requested and ready to ship as that page buckets them. Company stock, so
 *  no customer scope: a card held for anyone's open order is not unsold. */
export async function stockRows(db: ReportDb): Promise<StockRow[]> {
  const { rows } = await db.raw<{
    handle: string;
    on_hand: string;
    requested: string;
    ready_to_ship: string;
  }>(
    'WITH rec AS (' +
      'SELECT l.card_handle AS handle, SUM(l.qty) AS n FROM goods_receive_note_line l ' +
      'JOIN goods_receive_note g ON g.id = l.grn_id AND g.deleted_at IS NULL ' +
      'WHERE l.deleted_at IS NULL GROUP BY 1 ' +
      'UNION ALL SELECT l.card_handle, SUM(l.qty) FROM purchase_invoice_line l ' +
      'JOIN purchase_invoice i ON i.id = l.invoice_id AND i.deleted_at IS NULL ' +
      'WHERE l.deleted_at IS NULL AND i.from_grn_id IS NULL GROUP BY 1), ' +
      'recv AS (SELECT handle, SUM(n) AS n FROM rec GROUP BY 1), ' +
      // COUNT(DISTINCT): one pull can sit on two item rows (inventoryLifecycleBuckets).
      'ord AS (SELECT p.card_id AS handle, ' +
      `COUNT(DISTINCT p.id) FILTER (WHERE dord.status IN ${REQUESTED}) AS requested, ` +
      `COUNT(DISTINCT p.id) FILTER (WHERE dord.status IN ${READY_TO_SHIP}) AS rts, ` +
      `COUNT(DISTINCT p.id) FILTER (WHERE dord.status IN ${SHIPPED}) AS shipped ` +
      'FROM delivery_order_item doi ' +
      'JOIN delivery_order dord ON dord.id = doi.delivery_order_id AND dord.deleted_at IS NULL ' +
      'JOIN pull p ON p.id = doi.pull_id AND p.deleted_at IS NULL ' +
      'WHERE doi.deleted_at IS NULL GROUP BY 1) ' +
      'SELECT r.handle, (r.n - COALESCE(o.shipped, 0))::bigint AS on_hand, ' +
      'COALESCE(o.requested, 0)::bigint AS requested, COALESCE(o.rts, 0)::bigint AS ready_to_ship ' +
      'FROM recv r LEFT JOIN ord o ON o.handle = r.handle',
  );
  return rows.map((r) => ({
    handle: r.handle,
    on_hand: Number(r.on_hand),
    requested: Number(r.requested),
    ready_to_ship: Number(r.ready_to_ship),
  }));
}

/** walletSummary's inputs for every scoped customer holding credit, in one
 *  scan: balance, bonus, playthrough deposited / used, any top-up, frozen. */
export async function walletRows(
  db: ReportDb,
  scope: CustomerScope,
): Promise<WalletRow[]> {
  // Scoped after grouping: the real-customer test runs once per customer,
  // not once per ledger row (3.6 s -> 1.2 s on prod 11-15).
  const f = filterSql(scope, 'w.customer_id');
  const { rows } = await db.raw<{
    balance_sen: string;
    bonus_sen: string;
    deposited_sen: string;
    used_sen: string;
    has_topup: boolean;
    frozen: boolean;
  }>(
    'SELECT w.balance_sen, w.bonus_sen, w.deposited_sen, w.used_sen, w.has_topup, ' +
      // isFrozen: any live frozen account-state row.
      'EXISTS (SELECT 1 FROM customer_account_state s WHERE s.customer_id = w.customer_id ' +
      'AND s.frozen AND s.deleted_at IS NULL) AS frozen ' +
      'FROM (SELECT ct.customer_id, ' +
      'COALESCE(SUM(ROUND(ct.amount * 100)), 0)::bigint AS balance_sen, ' +
      'COALESCE(SUM(COALESCE(ct.bonus_cents, 0)), 0)::bigint AS bonus_sen, ' +
      // The playthrough basis walletSummary gates on.
      `COALESCE(SUM(${depositedPtSenSql('ct.')}), 0)::bigint AS deposited_sen, ` +
      "COALESCE(SUM(-ct.external_funded_cents) FILTER (WHERE ct.reason = 'pack_open'), 0)::bigint AS used_sen, " +
      "COALESCE(bool_or(ct.reason = 'topup' AND ct.amount > 0), false) AS has_topup " +
      'FROM credit_transaction ct WHERE ct.deleted_at IS NULL GROUP BY ct.customer_id) w ' +
      'WHERE (w.balance_sen <> 0 OR w.bonus_sen <> 0)' +
      f.sql,
    f.params,
  );
  return rows.map((r) => ({
    balance_sen: Number(r.balance_sen),
    bonus_sen: Number(r.bonus_sen),
    deposited_sen: Number(r.deposited_sen),
    used_sen: Number(r.used_sen),
    has_topup: r.has_topup,
    frozen: r.frozen,
  }));
}

/** Unused bonus credit by source, oldest grant first (decision 21,
 *  plans/pnl-report/bonus-fifo-proof.sql). Per customer the grants stack into
 *  ranges [lo, hi) and every consumption (spends and admin removals) fills
 *  [0, consumed) — the proof's overlap join collapses to: a lot's unused part
 *  is max(0, hi − max(lo, consumed)). */
export async function freeCreditUnused(
  db: ReportDb,
  scope: CustomerScope,
): Promise<Record<BonusSource, number>> {
  const f = filterSql(scope, 'ct.customer_id');
  const { rows } = await db.raw<{ source: BonusSource; sen: string }>(
    'WITH b AS (SELECT ct.id, ct.customer_id, ct.created_at, ct.bonus_cents, ' +
      `${bonusSourceSql('ct.', { nullForSpends: true })} AS source ` +
      'FROM credit_transaction ct ' +
      "LEFT JOIN task_definition td ON ct.reason = 'reward_credit' AND ct.source_transaction_id LIKE 'task:%' " +
      "AND td.id = split_part(ct.source_transaction_id, ':', 2) " +
      'WHERE ct.deleted_at IS NULL AND COALESCE(ct.bonus_cents, 0) <> 0' +
      f.sql +
      '), lots AS (SELECT customer_id, source, ' +
      'SUM(bonus_cents) OVER w - bonus_cents AS lo, SUM(bonus_cents) OVER w AS hi ' +
      'FROM b WHERE bonus_cents > 0 ' +
      'WINDOW w AS (PARTITION BY customer_id ORDER BY created_at, id ROWS UNBOUNDED PRECEDING)), ' +
      'used AS (SELECT customer_id, -SUM(bonus_cents) AS n FROM b WHERE bonus_cents < 0 GROUP BY 1) ' +
      'SELECT l.source, COALESCE(SUM(GREATEST(0, l.hi - GREATEST(l.lo, COALESCE(u.n, 0)))), 0)::bigint AS sen ' +
      'FROM lots l LEFT JOIN used u ON u.customer_id = l.customer_id GROUP BY 1',
    f.params,
  );
  const out = Object.fromEntries(BONUS_SOURCES.map((s) => [s, 0])) as Record<
    BonusSource,
    number
  >;
  for (const r of rows) out[r.source] = Number(r.sen);
  return out;
}

/** Scoped customers' cards at the vault sell-back value, profitOwed's per-pull
 *  expression (live FMV × multiplier × fx × FLAT_PERCENT, rounded per card):
 *  in the vault, and in an open delivery order (requested to ready to ship —
 *  a shipped order's cards are no longer here). `fx` is the current USD_MYR
 *  rate (resolveFxRate). */
export async function vaultCards(
  db: ReportDb,
  scope: CustomerScope,
  fx: number,
): Promise<{ vault: CardsLine; processing: CardsLine }> {
  const f = filterSql(scope, 'p.customer_id');
  const { rows } = await db.raw<{
    vault_n: string;
    vault_sen: string;
    processing_n: string;
    processing_sen: string;
  }>(
    'WITH t AS (SELECT CASE ' +
      "WHEN p.status = 'vaulted' THEN 'vault' " +
      "WHEN p.status = 'delivering' AND EXISTS (SELECT 1 FROM delivery_order_item i " +
      'JOIN delivery_order o ON o.id = i.delivery_order_id AND o.deleted_at IS NULL ' +
      `WHERE i.pull_id = p.id AND i.deleted_at IS NULL AND (o.status IN ${REQUESTED} OR o.status IN ${READY_TO_SHIP})) ` +
      "THEN 'processing' END AS k, " +
      `${cardValueSen('sellback')} AS sen ` +
      'FROM pull p JOIN card c ON c.handle = p.card_id AND c.deleted_at IS NULL ' +
      "WHERE p.deleted_at IS NULL AND p.status IN ('vaulted', 'delivering')" +
      f.sql +
      ") SELECT COUNT(*) FILTER (WHERE k = 'vault')::bigint AS vault_n, " +
      "COALESCE(SUM(sen) FILTER (WHERE k = 'vault'), 0)::bigint AS vault_sen, " +
      "COUNT(*) FILTER (WHERE k = 'processing')::bigint AS processing_n, " +
      "COALESCE(SUM(sen) FILTER (WHERE k = 'processing'), 0)::bigint AS processing_sen FROM t",
    [DEFAULT_MARKET_MULTIPLIER, fx, FLAT_PERCENT, ...f.params],
  );
  const r = rows[0];
  return {
    vault: { cards: Number(r?.vault_n ?? 0), sen: Number(r?.vault_sen ?? 0) },
    processing: {
      cards: Number(r?.processing_n ?? 0),
      sen: Number(r?.processing_sen ?? 0),
    },
  };
}
