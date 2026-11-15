import type { CustomerScope } from '../../../../modules/packs/real-customers';
import { filterSql } from '../../../../modules/packs/real-customers';
import type {
  CogsWindowRows,
  DayRate,
  FreeSource,
  PackMeta,
  PackWindowRows,
  ShippingWindow,
  DatedCostLine,
} from '../../../../modules/packs/pnl';
import { costAsOf } from '../../../../modules/packs/pnl';
import { DEFAULT_MARKET_MULTIPLIER } from '../../../../modules/packs/pricing';
import {
  BUYBACK_FULL,
  capsuleOpenSql,
  PACK_SALES_FULL,
  rewardCardSql,
  LIVE_VALUE_USD_SQL,
} from '../../../../modules/packs/money-figures';
import { mytDaySql } from '../../../../modules/packs/myt-window';
import { packOpens } from '../../../reports/finance/queries';
import { and, windowFilter, type ReportDb } from '../../../reports/sql';
import type { ReportWindow } from '../../../reports/params';

// The P&L report's SQL (spec plans/pnl-report/SPEC.md). Read-only aggregates
// through the shared connection, like the /reports queries; the pure folding is
// modules/packs/pnl.ts. Callers run these one after another (small pool).

/** One window's pack rows: paid opens at full price, paid pulls, free packs. */
export async function packWindowRows(
  db: ReportDb,
  window: ReportWindow,
  scope: CustomerScope,
): Promise<PackWindowRows> {
  const ledger = and(
    windowFilter(window, 'ct.created_at'),
    filterSql(scope, 'ct.customer_id'),
  );
  // A pack_open row's amount is the full price (cash + bonus share, negative);
  // bonus_cents is the bonus share (negative). Linked to its pack through the
  // open's pulls. A charge whose open made capsule spins is Lucky Draw revenue
  // (decision 3), left out here by that link, whatever the pack row says.
  const paid = await db.raw<{
    pack_id: string | null;
    full_sen: string;
    bonus_sen: string;
  }>(
    // The pack via one IDX_pull_open_id lookup per charge in the window (an
    // open's pulls share one pack). Joining a DISTINCT of every pull ever made
    // took 20 s on prod (2026-11-15).
    'SELECT (SELECT p.pack_id FROM pull p WHERE p.open_id = ct.source_transaction_id ' +
      'AND p.deleted_at IS NULL LIMIT 1) AS pack_id, ' +
      `COALESCE(SUM(${PACK_SALES_FULL.sen('ct.')}), 0)::bigint AS full_sen, ` +
      'COALESCE(SUM(-COALESCE(ct.bonus_cents, 0)), 0)::bigint AS bonus_sen ' +
      'FROM credit_transaction ct ' +
      `WHERE ct.deleted_at IS NULL AND ${PACK_SALES_FULL.where('ct.')} ` +
      `AND NOT ${capsuleOpenSql('ct.')}` +
      ledger.sql +
      ' GROUP BY 1',
    ledger.params,
  );

  const pulls = and(
    windowFilter(window, 'p.rolled_at'),
    filterSql(scope, 'p.customer_id'),
  );
  const opens = await packOpens(db, pulls, ['pack', 'bonus']);

  // Free packs: an admin gift, the welcome pack, or a task's free rip (a
  // reward pull of a real pack, task_claim.claim_ref = pull.id). Card rewards
  // (task-reward, challenge-…, lucky-draw) have no pack row, so the JOIN drops
  // them. Check-in is a task whose requirement type is checkin_days.
  const free = await db.raw<{ slug: string; source: FreeSource; qty: string }>(
    'SELECT p.pack_id AS slug, ' +
      "CASE WHEN p.source = 'gift' THEN 'adjustment' " +
      "WHEN p.source = 'free' THEN 'welcome' " +
      "WHEN td.id IS NULL THEN 'other' " +
      "WHEN td.requirement->>'type' = 'checkin_days' THEN 'checkin' " +
      "ELSE 'task' END AS source, " +
      'COUNT(*)::bigint AS qty ' +
      'FROM pull p JOIN pack pk ON pk.slug = p.pack_id ' +
      'LEFT JOIN task_claim tc ON p.source = ' +
      "'reward' AND tc.claim_ref = p.id AND tc.deleted_at IS NULL " +
      'LEFT JOIN task_definition td ON td.id = tc.task_id ' +
      "WHERE p.deleted_at IS NULL AND p.source IN ('gift', 'reward', 'free')" +
      pulls.sql +
      ' GROUP BY 1, 2',
    pulls.params,
  );

  return {
    paid: new Map(
      paid.rows.map((r) => [
        r.pack_id,
        { full_sen: Number(r.full_sen), bonus_sen: Number(r.bonus_sen) },
      ]),
    ),
    opens,
    free: free.rows.map((r) => ({
      slug: r.slug,
      source: r.source,
      qty: Number(r.qty),
    })),
  };
}

/** Title, grouping and price of the packs the rows name, deleted ones too. */
export async function packMeta(
  db: ReportDb,
  slugs: readonly string[],
): Promise<PackMeta[]> {
  if (slugs.length === 0) return [];
  const { rows } = await db.raw<
    Omit<PackMeta, 'price_sen'> & { price_sen: string }
  >(
    'SELECT DISTINCT ON (slug) slug, title, category, pack_type, prize_type, ' +
      'ROUND(price * 100)::bigint AS price_sen FROM pack ' +
      `WHERE slug IN (${slugs.map(() => '?').join(', ')}) ` +
      'ORDER BY slug, deleted_at NULLS FIRST',
    slugs,
  );
  return rows.map((r) => ({ ...r, price_sen: Number(r.price_sen) }));
}

// Reward CARDS (task-reward, challenge-…, lucky-draw pulls: no pack row) are a
// marketing cost when given, so their buybacks and shipping stay out of COGS.
// Free-pack rips (reward pulls of a real pack) stay in (decision 12).
const NOT_REWARD_CARD = `NOT ${rewardCardSql('p.')}`;

/** One window's COGS rows (spec §6): buyback paid, card value pulled, cards
 *  shipped, supplier purchases. */
export async function cogsWindowRows(
  db: ReportDb,
  window: ReportWindow,
  scope: CustomerScope,
): Promise<CogsWindowRows> {
  const ledger = and(
    windowFilter(window, 'ct.created_at'),
    filterSql(scope, 'ct.customer_id'),
  );
  const buyback = await db.raw<{ slug: string; sen: string }>(
    `SELECT p.pack_id AS slug, COALESCE(SUM(${BUYBACK_FULL.sen('ct.')}), 0)::bigint AS sen ` +
      'FROM credit_transaction ct JOIN pull p ON p.id = ct.pull_id ' +
      `WHERE ct.deleted_at IS NULL AND ${BUYBACK_FULL.where('ct.')} AND ${NOT_REWARD_CARD}` +
      ledger.sql +
      ' GROUP BY p.pack_id',
    ledger.params,
  );

  // Draw-time snapshot, else live (LIVE_VALUE_USD_SQL in money-figures.ts); priced
  // per MYT day by the caller (fx_rate_day).
  const pulls = and(
    windowFilter(window, 'p.rolled_at'),
    filterSql(scope, 'p.customer_id'),
  );
  const pulled = await db.raw<{
    slug: string;
    day: string;
    n: string;
    usd: number;
  }>(
    `SELECT p.pack_id AS slug, ${mytDaySql('p.rolled_at')} AS day, COUNT(*)::bigint AS n, ` +
      `COALESCE(SUM(COALESCE(p.recorded_value_usd, ${LIVE_VALUE_USD_SQL})), 0)::float8 AS usd ` +
      'FROM pull p LEFT JOIN card c ON c.handle = p.card_id AND c.deleted_at IS NULL ' +
      `WHERE p.deleted_at IS NULL AND ${NOT_REWARD_CARD}` +
      pulls.sql +
      ' GROUP BY 1, 2',
    [DEFAULT_MARKET_MULTIPLIER, ...pulls.params],
  );

  // One row per pull at its first shipment (a pull can sit on two item rows),
  // statuses as the Stock page counts shipped; then window and scope.
  const orders = and(
    windowFilter(window, 'x.shipped_at'),
    filterSql(scope, 'x.customer_id'),
  );
  const shipped = await db.raw<{
    slug: string;
    handle: string;
    day: string;
    n: string;
    market_usd: number | null;
  }>(
    `SELECT x.slug, x.handle, ${mytDaySql('x.shipped_at')} AS day, ` +
      'COUNT(*)::bigint AS n, MAX(c.market_value)::float8 AS market_usd ' +
      'FROM (SELECT DISTINCT ON (p.id) p.pack_id AS slug, p.card_id AS handle, ' +
      'p.customer_id, o.shipped_at FROM delivery_order o ' +
      'JOIN delivery_order_item i ON i.delivery_order_id = o.id AND i.deleted_at IS NULL ' +
      'JOIN pull p ON p.id = i.pull_id ' +
      "WHERE o.deleted_at IS NULL AND o.status IN ('shipped', 'completed', 'delivered') " +
      `AND o.shipped_at IS NOT NULL AND ${NOT_REWARD_CARD} ` +
      'ORDER BY p.id, o.shipped_at) x ' +
      'LEFT JOIN card c ON c.handle = x.handle AND c.deleted_at IS NULL ' +
      'WHERE TRUE' +
      orders.sql +
      ' GROUP BY 1, 2, 3',
    orders.params,
  );

  // Company purchases: no customer scope. Dated by the invoice date.
  const invoices = windowFilter(window, 'pi.date');
  const purchase = await db.raw<{ sen: string }>(
    'SELECT COALESCE(SUM(ROUND(l.line_total * 100)), 0)::bigint AS sen ' +
      'FROM purchase_invoice_line l ' +
      'JOIN purchase_invoice pi ON pi.id = l.invoice_id AND pi.deleted_at IS NULL ' +
      'WHERE l.deleted_at IS NULL' +
      invoices.sql,
    invoices.params,
  );

  return {
    buyback: new Map(buyback.rows.map((r) => [r.slug, Number(r.sen)])),
    pulled: pulled.rows.map((r) => ({
      slug: r.slug,
      day: r.day,
      n: Number(r.n),
      usd: Number(r.usd),
    })),
    shipped: shipped.rows.map((r) => ({
      slug: r.slug,
      handle: r.handle,
      day: r.day,
      n: Number(r.n),
      market_usd: r.market_usd === null ? null : Number(r.market_usd),
    })),
    purchase_sen: Number(purchase.rows[0]?.sen ?? 0),
  };
}

/** Each card's purchase-invoice lines with the invoice's MYT day, for
 *  costAsOf (pnl.ts). */
export async function cardCostLines(
  db: ReportDb,
  handles: readonly string[],
): Promise<Map<string, DatedCostLine[]>> {
  const out = new Map<string, DatedCostLine[]>();
  if (handles.length === 0) return out;
  const { rows } = await db.raw<{
    card_handle: string;
    day: string;
    qty: number;
    unit_cost: string;
  }>(
    `SELECT l.card_handle, ${mytDaySql('pi.date')} AS day, l.qty, l.unit_cost ` +
      'FROM purchase_invoice_line l ' +
      'JOIN purchase_invoice pi ON pi.id = l.invoice_id AND pi.deleted_at IS NULL ' +
      `WHERE l.deleted_at IS NULL AND l.card_handle IN (${handles.map(() => '?').join(', ')})`,
    handles,
  );
  for (const r of rows) {
    const list = out.get(r.card_handle) ?? [];
    list.push({
      day: r.day,
      qty: Number(r.qty),
      unit_cost: Number(r.unit_cost),
    });
    out.set(r.card_handle, list);
  }
  return out;
}

/** Each card's weighted-average supplier cost in RM today (inventory-cost.ts,
 *  every invoice), null when it has none. */
export async function cardCosts(
  db: ReportDb,
  handles: readonly string[],
): Promise<Map<string, number | null>> {
  const lines = await cardCostLines(db, handles);
  return new Map(handles.map((h) => [h, costAsOf(lines.get(h) ?? [], null)]));
}

/** Saved USD_MYR day rates (fx_rate_day), oldest first. */
export async function dayRates(db: ReportDb): Promise<DayRate[]> {
  const { rows } = await db.raw<{ day: string; rate: string }>(
    "SELECT to_char(day, 'YYYY-MM-DD') AS day, rate FROM fx_rate_day " +
      "WHERE pair = 'USD_MYR' ORDER BY day",
  );
  return rows.map((r) => ({ day: r.day, rate: Number(r.rate) }));
}

/** Delivery charge and insurance by order creation date, canceled orders left
 *  out (spec §5). Prize and vault orders pay their zone fee alike. */
export async function shippingWindow(
  db: ReportDb,
  window: ReportWindow,
  scope: CustomerScope,
): Promise<ShippingWindow> {
  const orders = and(
    windowFilter(window, 'o.created_at'),
    filterSql(scope, 'o.customer_id'),
  );
  const { rows } = await db.raw<{ ship: string; ins: string; n: string }>(
    'SELECT COALESCE(SUM(ROUND(COALESCE(o.shipping_fee, 0) * 100)), 0)::bigint AS ship, ' +
      'COALESCE(SUM(ROUND(COALESCE(o.insurance_fee, 0) * 100)), 0)::bigint AS ins, ' +
      'COUNT(*)::bigint AS n FROM delivery_order o ' +
      "WHERE o.deleted_at IS NULL AND o.status <> 'canceled'" +
      orders.sql,
    orders.params,
  );
  const r = rows[0];
  return {
    shipping_sen: Number(r?.ship ?? 0),
    insurance_sen: Number(r?.ins ?? 0),
    orders: Number(r?.n ?? 0),
  };
}
