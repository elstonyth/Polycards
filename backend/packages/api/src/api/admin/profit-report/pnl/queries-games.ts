import type { CustomerScope } from '../../../../modules/packs/real-customers';
import { filterSql } from '../../../../modules/packs/real-customers';
import type { GamesWindowRows } from '../../../../modules/packs/pnl-games';
import { DEFAULT_MARKET_MULTIPLIER } from '../../../../modules/packs/pricing';
import {
  CAPSULE_OPEN_SQL,
  COIN_FLIP_WINS,
  PACK_SALES_FULL,
} from '../../../../modules/packs/money-figures';
import { mytDaySql } from '../../../../modules/packs/myt-window';
import { and, windowFilter, type ReportDb } from '../../../reports/sql';
import type { ReportWindow } from '../../../reports/params';

// The P&L report's Coin flip and Lucky Draw SQL (spec §3-4). Read-only, one
// statement after another (small pool); the folding is modules/packs/pnl-games.ts.

const n = (v: string | number | null | undefined) => Number(v ?? 0);

/** One window's coin flip and Lucky Draw rows. */
export async function gamesWindowRows(
  db: ReportDb,
  window: ReportWindow,
  scope: CustomerScope,
): Promise<GamesWindowRows> {
  // A settled card flip is one CF ledger row (coin-flip-operations.ts): a loss
  // has vault_delta = minus the non-reward stake, payload.cards every card's
  // flip value (100% of display price, the basis the win credit pays).
  const cf = and(
    windowFilter(window, 'le.occurred_at'),
    filterSql(scope, 'le.customer_id'),
  );
  const flips = await db.raw<{ n: string; lost_sen: string; bet_sen: string }>(
    'SELECT COUNT(*)::bigint AS n, ' +
      // Every card lost at its flip value, free reward cards included (decision
      // 23): vault_delta counts reward cards 0, so read the payload instead.
      "COALESCE(SUM((SELECT SUM(ROUND((x->>'value')::numeric * 100)) FROM jsonb_array_elements(le.payload->'cards') x)) FILTER (WHERE le.payload->>'outcome' = 'lost'), 0)::bigint AS lost_sen, " +
      "COALESCE(SUM((SELECT SUM(ROUND((x->>'value')::numeric * 100)) FROM jsonb_array_elements(le.payload->'cards') x)), 0)::bigint AS bet_sen " +
      "FROM ledger_entry le WHERE le.type = 'CF' AND le.deleted_at IS NULL" +
      cf.sql,
    cf.params,
  );

  const ledger = and(
    windowFilter(window, 'ct.created_at'),
    filterSql(scope, 'ct.customer_id'),
  );
  const wins = await db.raw<{ sen: string }>(
    `SELECT COALESCE(SUM(${COIN_FLIP_WINS.sen('ct.')}), 0)::bigint AS sen ` +
      `FROM credit_transaction ct WHERE ct.deleted_at IS NULL AND ${COIN_FLIP_WINS.where('ct.')}` +
      ledger.sql,
    ledger.params,
  );

  // Tickets by reason. A ticket-only flip writes a coin_flip ticket row and no
  // CF row (ref = the round id), so it is counted here.
  const tk = and(
    windowFilter(window, 't.created_at'),
    filterSql(scope, 't.customer_id'),
  );
  const tickets = await db.raw<{
    reason: string;
    given: string;
    spent: string;
    ticket_only: string;
  }>(
    'SELECT t.reason, ' +
      'COALESCE(SUM(t.delta) FILTER (WHERE t.delta > 0), 0)::bigint AS given, ' +
      'COALESCE(SUM(-t.delta) FILTER (WHERE t.delta < 0), 0)::bigint AS spent, ' +
      // Rounds, not rows: a ticket-only flip can write a stake and a payout row.
      "COUNT(DISTINCT t.ref) FILTER (WHERE t.reason = 'coin_flip' AND NOT EXISTS (" +
      "SELECT 1 FROM ledger_entry le WHERE le.type = 'CF' AND le.ref_id = t.ref " +
      'AND le.deleted_at IS NULL))::bigint AS ticket_only ' +
      'FROM lucky_draw_ticket t WHERE t.deleted_at IS NULL' +
      tk.sql +
      ' GROUP BY t.reason',
    tk.params,
  );

  // Capsule charges at full price (amount = cash + bonus share; bonus_cents the
  // bonus share), linked through the open's spins — a batch shares one open_id
  // and one pack. Per charge in the window, by IDX_ticket_spin_open, not a
  // DISTINCT of every spin ever made.
  const capsules = await db.raw<{
    slug: string;
    full_sen: string;
    bonus_sen: string;
  }>(
    'SELECT (SELECT s.pack_id FROM ticket_spin s WHERE s.open_id = ct.source_transaction_id ' +
      'AND s.deleted_at IS NULL LIMIT 1) AS slug, ' +
      `COALESCE(SUM(${PACK_SALES_FULL.sen('ct.')}), 0)::bigint AS full_sen, ` +
      'COALESCE(SUM(-COALESCE(ct.bonus_cents, 0)), 0)::bigint AS bonus_sen ' +
      'FROM credit_transaction ct ' +
      `WHERE ct.deleted_at IS NULL AND ${PACK_SALES_FULL.where('ct.')} ` +
      `AND ${CAPSULE_OPEN_SQL('ct.')}` +
      ledger.sql +
      ' GROUP BY 1',
    ledger.params,
  );

  const sp = and(
    windowFilter(window, 's.rolled_at'),
    filterSql(scope, 's.customer_id'),
  );
  const spins = await db.raw<{ slug: string; n: string }>(
    'SELECT s.pack_id AS slug, COUNT(*)::bigint AS n FROM ticket_spin s ' +
      'WHERE s.deleted_at IS NULL' +
      sp.sql +
      ' GROUP BY s.pack_id',
    sp.params,
  );

  // Prizes that actually paid: a credit prize's ledger row or a card prize's
  // minted pull (no pull = the card was gone, nothing given). Card prizes at the
  // card's live display value; the fold applies the vault rate and day's FX.
  const pz = and(
    windowFilter(window, 'r.drawn_at'),
    filterSql(scope, 'r.winner_customer_id'),
  );
  const prizes = await db.raw<{
    kind: 'card' | 'credit';
    day: string;
    n: string;
    credit_sen: string;
    card_usd: number;
  }>(
    `SELECT pz.kind, ${mytDaySql('r.drawn_at')} AS day, COUNT(*)::bigint AS n, ` +
      'COALESCE(SUM(ROUND(ct.amount * 100)), 0)::bigint AS credit_sen, ' +
      'COALESCE(SUM(c.market_value * COALESCE(c.market_multiplier, ?)), 0)::float8 AS card_usd ' +
      'FROM lucky_draw_result r ' +
      'JOIN lucky_draw_prize pz ON pz.id = r.prize_id ' +
      'LEFT JOIN credit_transaction ct ON ct.id = r.credit_transaction_id AND ct.deleted_at IS NULL ' +
      'LEFT JOIN pull p ON p.id = r.pull_id ' +
      'LEFT JOIN card c ON c.handle = p.card_id AND c.deleted_at IS NULL ' +
      'WHERE r.deleted_at IS NULL AND r.winner_customer_id IS NOT NULL ' +
      "AND ((pz.kind = 'credit' AND ct.id IS NOT NULL) OR (pz.kind = 'card' AND p.id IS NOT NULL))" +
      pz.sql +
      ' GROUP BY 1, 2',
    [DEFAULT_MARKET_MULTIPLIER, ...pz.params],
  );

  const coin = tickets.rows.find((r) => r.reason === 'coin_flip');
  const credit = prizes.rows.filter((r) => r.kind === 'credit');
  return {
    coin_flip: {
      card_flips: n(flips.rows[0]?.n),
      lost_sen: n(flips.rows[0]?.lost_sen),
      bet_sen: n(flips.rows[0]?.bet_sen),
      win_sen: n(wins.rows[0]?.sen),
      ticket_only_flips: n(coin?.ticket_only),
    },
    capsules: capsules.rows.map((r) => ({
      slug: r.slug,
      full_sen: n(r.full_sen),
      bonus_sen: n(r.bonus_sen),
    })),
    spins: spins.rows.map((r) => ({ slug: r.slug, n: n(r.n) })),
    credit_prizes: {
      n: credit.reduce((s, r) => s + n(r.n), 0),
      sen: credit.reduce((s, r) => s + n(r.credit_sen), 0),
    },
    card_prizes: prizes.rows
      .filter((r) => r.kind === 'card')
      .map((r) => ({ day: r.day, n: n(r.n), usd: Number(r.card_usd) })),
    tickets: tickets.rows.map((r) => ({
      reason: r.reason,
      given: n(r.given),
      spent: n(r.spent),
    })),
  };
}
