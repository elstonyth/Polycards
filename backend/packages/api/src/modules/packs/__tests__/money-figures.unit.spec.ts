import { reasonCashSenSql } from '../bonus-credit';
import {
  BUYBACK_CASH,
  BUYBACK_FULL,
  capsuleOpenSql,
  COIN_FLIP_WINS,
  GATEWAY,
  LIVE_VALUE_USD_SQL,
  PACK_SALES_CASH,
  PACK_SALES_FULL,
  rewardCardSql,
  TOPUPS_LEDGER,
  bonusSourceSql,
  cardValueSen,
  ledgerTotalsRowsSql,
  inActiveOrderSql,
  inShippedOrderSql,
  playthroughBasisSenSql,
  fromCustomerScope,
  fromGroupScope,
  populationSql,
} from '../money-figures';
import { mytDaySql, mytPeriodStartSql } from '../myt-window';
import { EFFECTIVE_GROUP_SQL } from '../odds-sets';
import { filterSql, scopeSql } from '../real-customers';

// String identity: each fragment is exactly the text its sites spelled before
// the move (copied here as literals, since the moves delete the originals), so
// adopting it changes no statement and no number.

describe('population', () => {
  it("both meanings of 'default' are the real customers", () => {
    expect(fromCustomerScope('default')).toEqual({ kind: 'real' });
    expect(fromCustomerScope('all')).toEqual({ kind: 'everyone' });
    // Owner decision 2026-11-16: the desk ?group=default was the DEFAULT
    // group with credential accounts in; it is now `real`, as on Profit.
    expect(fromGroupScope({ kind: 'default' })).toEqual({ kind: 'real' });
    expect(fromGroupScope({ kind: 'all' })).toEqual({ kind: 'everyone' });
    expect(fromGroupScope({ kind: 'group', id: 'g1', name: 'VIP' })).toEqual({
      kind: 'group',
      id: 'g1',
      name: 'VIP',
    });
  });

  it('real is scopeSql / filterSql default', () => {
    expect(populationSql({ kind: 'real' }, 'ct.customer_id')).toEqual({
      sql: scopeSql('default', 'ct.customer_id'),
      params: [],
    });
    expect(populationSql({ kind: 'real' }, 'p.customer_id')).toEqual(
      filterSql('default', 'p.customer_id'),
    );
    expect(populationSql({ kind: 'everyone' }, 'ct.customer_id')).toEqual(
      filterSql('all', 'ct.customer_id'),
    );
    expect(populationSql({ kind: 'customer', id: 'c1' }, 'ct.customer_id')).toEqual(
      filterSql({ customerId: 'c1' }, 'ct.customer_id'),
    );
  });

  it("a named group is scopeFilter's effective-group IN, unchanged", () => {
    expect(
      populationSql({ kind: 'group', id: 'g1', name: 'VIP' }, 'ct.customer_id'),
    ).toEqual({
      sql: ` AND ct.customer_id IN (SELECT customer_id FROM (${EFFECTIVE_GROUP_SQL}) eff WHERE eff.group_id = ?)`,
      params: ['g1'],
    });
  });
});

describe('ledger figures', () => {
  it('cash figures are reasonCashSenSql', () => {
    expect(PACK_SALES_CASH.sen('ct.')).toBe(`-(${reasonCashSenSql('ct.')})`);
    expect(BUYBACK_CASH.sen('ct.')).toBe(reasonCashSenSql('ct.'));
    expect(TOPUPS_LEDGER.sen('')).toBe(reasonCashSenSql(''));
  });

  it("full figures are pnl/queries' and queries-games' text", () => {
    // pnl/queries.ts packWindowRows, queries-games.ts capsules.
    expect(`COALESCE(SUM(${PACK_SALES_FULL.sen('ct.')}), 0)::bigint`).toBe(
      'COALESCE(SUM(-ROUND(ct.amount * 100)), 0)::bigint',
    );
    // pnl/queries.ts cogsWindowRows buyback.
    expect(`COALESCE(SUM(${BUYBACK_FULL.sen('ct.')}), 0)::bigint`).toBe(
      'COALESCE(SUM(ROUND(ct.amount * 100)), 0)::bigint',
    );
    // queries-games.ts wins.
    expect(COIN_FLIP_WINS.sen('ct.')).toBe('ROUND(ct.amount * 100)');
    expect(COIN_FLIP_WINS.where('ct.')).toBe("ct.reason = 'coin_flip_win'");
    expect(PACK_SALES_FULL.where('ct.')).toBe("ct.reason = 'pack_open'");
    expect(PACK_SALES_CASH.where('ct.')).toBe("ct.reason = 'pack_open'");
    expect(BUYBACK_FULL.where('ct.')).toBe("ct.reason = 'buyback'");
    // Positive rows only (owner decision 2026-11-16), and the Economy
    // totals drop exactly the other topup rows.
    expect(TOPUPS_LEDGER.where('')).toBe("reason = 'topup' AND amount > 0");
    expect(ledgerTotalsRowsSql('ct.')).toBe("NOT (ct.reason = 'topup' AND ct.amount <= 0)");
  });

  it('every figure says what it counts', () => {
    for (const f of [
      PACK_SALES_FULL,
      PACK_SALES_CASH,
      BUYBACK_FULL,
      BUYBACK_CASH,
      COIN_FLIP_WINS,
      TOPUPS_LEDGER,
    ]) {
      expect(f.note.length).toBeGreaterThan(20);
    }
  });

  it('capsule and reward-card tests are the P&L text', () => {
    expect(`NOT ${capsuleOpenSql('ct.')}`).toBe(
      'NOT EXISTS (SELECT 1 FROM ticket_spin s WHERE s.open_id = ct.source_transaction_id ' +
        'AND s.deleted_at IS NULL)',
    );
    expect(`NOT ${rewardCardSql('p.')}`).toBe(
      "NOT (p.source = 'reward' AND NOT EXISTS " +
        '(SELECT 1 FROM pack pk WHERE pk.slug = p.pack_id))',
    );
  });

  it("deposited playthrough basis is service.ts's and queries-balance's", () => {
    expect(playthroughBasisSenSql()).toBe(
      "CASE WHEN reason = 'topup' AND amount > 0 AND external_funded_cents IS NOT NULL THEN ROUND(amount * 100) " +
        "WHEN reason = 'buyback' THEN COALESCE(external_funded_cents, 0) ELSE 0 END",
    );
    expect(playthroughBasisSenSql('ct.')).toBe(
      "CASE WHEN ct.reason = 'topup' AND ct.amount > 0 AND ct.external_funded_cents IS NOT NULL THEN ROUND(ct.amount * 100) " +
        "WHEN ct.reason = 'buyback' THEN COALESCE(ct.external_funded_cents, 0) ELSE 0 END",
    );
  });

  it("bonus source is queries-marketing's and queries-balance's CASE", () => {
    const tail =
      "WHEN ct.reason = 'bonus_grant' THEN 'adjustment' " +
      "WHEN ct.reason = 'reward_credit' AND ct.source_transaction_id LIKE 'challenge:%' THEN 'weekly_challenge' " +
      "WHEN ct.reason = 'reward_credit' AND ct.source_transaction_id LIKE 'luckydraw:%' THEN 'lucky_draw' " +
      "WHEN ct.reason = 'reward_credit' AND ct.source_transaction_id LIKE 'task:%' THEN " +
      "CASE WHEN td.requirement->>'type' = 'checkin_days' THEN 'checkin' ELSE 'task' END " +
      "WHEN ct.reason IN ('pack_open', 'delivery_fee', 'buyback') THEN 'returned' " +
      "ELSE 'other' END";
    expect(bonusSourceSql('ct.')).toBe(`CASE ${tail}`);
    expect(bonusSourceSql('ct.', { nullForSpends: true })).toBe(
      `CASE WHEN ct.bonus_cents < 0 THEN NULL ${tail}`,
    );
  });
});

describe('gateway figures', () => {
  it("are profitCashTotals' per-row expressions", () => {
    expect(GATEWAY.depositFeeSen()).toBe(
      'ROUND((amount_settled - net_amount) * 100)',
    );
    expect(GATEWAY.payoutFeeSen()).toBe(
      'ROUND(ABS(net_amount - COALESCE(amount_settled, amount)) * 100)',
    );
    expect(`ROUND(${GATEWAY.depositFxRm()} * 100)`).toBe(
      'ROUND((gateway_amount * COALESCE(amount_settled, amount_requested) / NULLIF(amount_requested, 0) * fx_mid - COALESCE(amount_settled, amount_requested)) * 100)',
    );
    expect(`ROUND(${GATEWAY.payoutFxRm()} * 100)`).toBe(
      'ROUND((amount - gateway_amount * COALESCE(amount_settled, amount) / NULLIF(amount, 0) * fx_mid) * 100)',
    );
  });

  it('take a table prefix and bind nothing (safe in named-binding knex)', () => {
    expect(GATEWAY.depositFxRm('d.')).toBe(
      '(d.gateway_amount * COALESCE(d.amount_settled, d.amount_requested) / NULLIF(d.amount_requested, 0) * d.fx_mid - COALESCE(d.amount_settled, d.amount_requested))',
    );
    for (const f of Object.values(GATEWAY)) {
      expect(f('w.')).not.toMatch(/\?|::/);
    }
  });
});

describe('cards in delivery', () => {
  it("inActiveOrderSql is the P&L balance's processing test", () => {
    expect(inActiveOrderSql('p.')).toBe(
      'EXISTS (SELECT 1 FROM delivery_order_item i ' +
        'JOIN delivery_order o ON o.id = i.delivery_order_id AND o.deleted_at IS NULL ' +
        "WHERE i.pull_id = p.id AND i.deleted_at IS NULL AND (o.status IN ('requested', 'processed', 'packing') OR o.status IN ('ready_to_ship', 'pending_ship')))",
    );
    expect(inShippedOrderSql('p.')).toContain(
      "(o.status IN ('shipped', 'completed', 'delivered'))",
    );
  });
});

describe('card value', () => {
  it("is vaultLiabilityMyr's and profitOwed's expression", () => {
    expect(LIVE_VALUE_USD_SQL).toBe(
      'c.market_value * COALESCE(c.market_multiplier, ?)',
    );
    expect(cardValueSen('display')).toBe(
      'ROUND(c.market_value * COALESCE(c.market_multiplier, ?) * ? * 100)',
    );
    expect(cardValueSen('vault')).toBe(
      'ROUND(c.market_value * COALESCE(c.market_multiplier, ?) * ? * ?)',
    );
  });

  it('binds multiplier + fx (display) or + percent (sellback)', () => {
    const binds = (s: string) => s.split('?').length - 1;
    expect(binds(cardValueSen('display'))).toBe(2);
    expect(binds(cardValueSen('vault'))).toBe(3);
  });
});

describe('Malaysia day SQL', () => {
  it("is the P&L's mytDay and settlementRows' bucket", () => {
    expect(mytDaySql('p.rolled_at')).toBe(
      "to_char((p.rolled_at AT TIME ZONE 'Asia/Kuala_Lumpur')::date, 'YYYY-MM-DD')",
    );
    expect(mytPeriodStartSql('week', 'settled_at')).toBe(
      "to_char(date_trunc('week', settled_at AT TIME ZONE 'Asia/Kuala_Lumpur'), 'YYYY-MM-DD')",
    );
  });
});
