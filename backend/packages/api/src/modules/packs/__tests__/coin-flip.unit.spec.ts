import {
  parseCoinFlipSettings,
  coinFlipSettingsView,
  effectiveCoinWinUnits,
  coinFlipWins,
  publicCoinFlipRound,
  assertCoinFlipEligible,
  coinFlipSelection,
  coinFlipStakeCents,
  coinFlipStakeSelection,
  coinFlipTicketSelection,
  COIN_FLIP_MAX_TICKETS,
  type CoinFlipRoundRecord,
} from '../coin-flip';

const settings = {
  enabled: true,
  win_percent: 45.1234,
  win_percent_2: null,
  win_percent_3: null,
  published_win_percent: 50,
};

describe('coin flip rules', () => {
  it.each(Array.from({ length: 101 }, (_, i) => 100 - i))('uses exact win/loss boundaries at %i%% actual odds for every group', percent => {
    for (const set of [1, 2, 3] as const) {
      const config = parseCoinFlipSettings({ ...settings, win_percent: 17,
        [`win_percent${set === 1 ? '' : `_${set}`}`]: percent });
      const units = effectiveCoinWinUnits(config, set);
      expect(units).toBe(percent * 10000);
      expect(coinFlipWins(0, units)).toBe(percent > 0);
      expect(coinFlipWins(999999, units)).toBe(percent === 100);
      if (units > 0) expect(coinFlipWins(units - 1, units)).toBe(true);
      if (units < 1000000) expect(coinFlipWins(units, units)).toBe(false);
    }
  });

  it('bounds and deduplicates selection at the service boundary', () => {
    expect(coinFlipSelection(['b', 'a'], 'tail')).toEqual({ pullIds: ['a', 'b'], chosenSide: 'tail' });
    for (const ids of [[], ['a', 'a'], [' a'], [null], Array.from({ length: 21 }, (_, i) => `p${i}`)]) {
      expect(() => coinFlipSelection(ids, 'head')).toThrow();
    }
    expect(() => coinFlipSelection(['a'], 'edge')).toThrow();
  });

  it('bounds a ticket stake at the service boundary', () => {
    expect(coinFlipTicketSelection(5, 'tail')).toEqual({ tickets: 5, chosenSide: 'tail' });
    expect(coinFlipTicketSelection(COIN_FLIP_MAX_TICKETS, 'head').tickets).toBe(COIN_FLIP_MAX_TICKETS);
    for (const tickets of [0, -1, 1.5, '5', null, undefined, NaN, Infinity, COIN_FLIP_MAX_TICKETS + 1]) {
      expect(() => coinFlipTicketSelection(tickets, 'head')).toThrow();
    }
    expect(() => coinFlipTicketSelection(5, 'edge')).toThrow();
    expect(() => coinFlipTicketSelection(5, undefined)).toThrow();
  });

  it('takes cards, tickets or both, and needs a stated call whenever tickets are in', () => {
    const customerId = 'c';
    expect(coinFlipStakeSelection({ customerId, pullIds: ['b', 'a'], tickets: 5, chosenSide: 'tail' }))
      .toEqual({ pullIds: ['a', 'b'], tickets: 5, chosenSide: 'tail' });
    expect(coinFlipStakeSelection({ customerId, pullIds: ['a'], chosenSide: 'tail' }))
      .toEqual({ pullIds: ['a'], tickets: 0, chosenSide: 'tail' });
    expect(coinFlipStakeSelection({ customerId, tickets: 5, chosenSide: 'head' }))
      .toEqual({ pullIds: [], tickets: 5, chosenSide: 'head' });
    // Existing single-card clients used the emblem (Head) implicitly.
    expect(coinFlipStakeSelection({ customerId, pullId: 'a' }))
      .toEqual({ pullIds: ['a'], tickets: 0, chosenSide: 'head' });
    expect(() => coinFlipStakeSelection({ customerId, tickets: 5 })).toThrow();
    expect(() => coinFlipStakeSelection({ customerId, pullIds: ['a'], tickets: 5 })).toThrow();
    expect(() => coinFlipStakeSelection({ customerId, pullIds: ['a'], tickets: 0, chosenSide: 'head' })).toThrow();
    expect(() => coinFlipStakeSelection({ customerId, pullIds: [], tickets: 5, chosenSide: 'head' })).toThrow();
  });

  it('retains four-decimal probabilities and exact sen', () => {
    expect(parseCoinFlipSettings(settings)).toEqual({
      enabled: true, win_units: 451234,
      win_units_2: null, win_units_3: null, published_win_units: 500000,
    });
    expect(coinFlipSettingsView(null)).toEqual({
      enabled: false, win_percent: null,
      win_percent_2: null, win_percent_3: null, published_win_percent: null,
      revision: 0,
    });
  });

  it('inherits unset rates while respecting explicit zero', () => {
    const config = parseCoinFlipSettings({ ...settings, win_percent_2: 0 });
    expect(effectiveCoinWinUnits(config, 1)).toBe(451234);
    expect(effectiveCoinWinUnits(config, 2)).toBe(0);
    expect(effectiveCoinWinUnits(config, 3)).toBe(0);
    expect(effectiveCoinWinUnits({ ...config, win_units_3: 250000 }, 3)).toBe(250000);
  });

  it.each([NaN, Infinity, -1, 100.0001, 45.12345, '50', true])(
    'rejects invalid probability %p at the boundary', (win_percent) => {
      expect(() => parseCoinFlipSettings({ ...settings, win_percent })).toThrow();
    },
  );

  it.each([0, -1, Infinity, 0.001, Number.MAX_SAFE_INTEGER, '100'])(
    'rejects unsafe or imprecise card values %p', (amount) => {
      expect(() => coinFlipStakeCents(amount)).toThrow();
    },
  );

  it('allows incomplete disabled drafts but never enables missing terms', () => {
    const empty = { ...settings, enabled: false, win_percent: null, published_win_percent: null };
    expect(parseCoinFlipSettings(empty).enabled).toBe(false);
    for (const key of ['win_percent', 'published_win_percent']) {
      expect(() => parseCoinFlipSettings({ ...settings, [key]: null })).toThrow();
    }
    expect(() => parseCoinFlipSettings({ ...settings, enabled: 'true' })).toThrow();
  });

  it('keeps exact sen on very large values, where floats get coarse, and still refuses part-sen', () => {
    expect(coinFlipStakeCents(10_000_000.22)).toBe(1_000_000_022);
    expect(coinFlipStakeCents(20_000_000.07)).toBe(2_000_000_007);
    expect(() => coinFlipStakeCents(1.005)).toThrow();
    expect(() => coinFlipStakeCents(10_000_000.225)).toThrow();
  });

  it('ignores obsolete caps and accepts values beyond the old integer column range', () => {
    expect(parseCoinFlipSettings({ ...settings, max_stake_amount: 1 })).not.toHaveProperty('max_stake_cents');
    expect(coinFlipStakeCents(30_000_000)).toBe(3_000_000_000);
  });

  it('uses exact inclusive/exclusive roll boundaries, including 0 and 100%', () => {
    expect(coinFlipWins(0, 0)).toBe(false);
    expect(coinFlipWins(999999, 1000000)).toBe(true);
    expect(coinFlipWins(451233, 451234)).toBe(true);
    expect(coinFlipWins(451234, 451234)).toBe(false);
    expect(() => coinFlipWins(1000000, 500000)).toThrow();
    expect(() => coinFlipWins(-1, 500000)).toThrow();
  });

  it('allows eligible zero-balance accounts and refuses eligibility failures', () => {
    const wallet = { isFrozen: false, hasTopup: true, playthrough: { remaining: 0 } };
    expect(() => assertCoinFlipEligible(wallet)).not.toThrow();
    expect(() => assertCoinFlipEligible({ ...wallet, isFrozen: true })).toThrow(/review/i);
    expect(() => assertCoinFlipEligible({ ...wallet, hasTopup: false })).toThrow(/top up/i);
    expect(() => assertCoinFlipEligible({ ...wallet, playthrough: { remaining: 0.01 } })).toThrow(/playthrough/i);
    expect(() => assertCoinFlipEligible({ ...wallet, hasTopup: false }, null)).toThrow(/top up/i);
    // Any real group skips the top-up; playthrough still holds where withdrawals are allowed.
    const open = { withdrawals_blocked: false };
    expect(() => assertCoinFlipEligible({ ...wallet, hasTopup: false }, open)).not.toThrow();
    expect(() => assertCoinFlipEligible({ ...wallet, playthrough: { remaining: 0.01 } }, open)).toThrow(/playthrough/i);
    expect(() => assertCoinFlipEligible({ ...wallet, isFrozen: true }, open)).toThrow(/review/i);
    // A withdrawal-blocked group can never cash out, so only the freeze still applies.
    const blocked = { withdrawals_blocked: true };
    expect(() => assertCoinFlipEligible({ ...wallet, hasTopup: false, playthrough: { remaining: 5 } }, blocked)).not.toThrow();
    expect(() => assertCoinFlipEligible({ ...wallet, isFrozen: true }, blocked)).toThrow(/review/i);
  });

  it('allowlists public receipt and pays only terminal wins', () => {
    const card = { pull_id: 'pull_1', name: 'Charizard', image: '/card.png', grader: 'PSA', grade: '10' };
    const row: CoinFlipRoundRecord = {
      id: 'flip_1', customer_id: 'customer_1', pull_id: 'pull_1',
      status: 'won', stake_cents: 10000, ticket_stake: 0, flip_version: 0, config_revision: 4,
      expires_at: new Date('2026-10-28T00:01:00Z'),
      settled_at: new Date('2026-10-28T00:00:04Z'), roll: 1234,
      credit_transaction_id: 'credit_1',
      snapshot: {
        card,
        valuation: { value_usd: 20, multiplier: 1, fx: 5, quoted_at: '2026-10-28T00:00:00.000Z' },
        group_id: 'secret', odds_set: 3, actual_win_units: 451234,
        published_win_units: 500000, source: 'gift', bonus_bp: 10000,
      },
    };
    expect(publicCoinFlipRound(row)).toEqual({
      id: 'flip_1', status: 'won', stake_amount: 100, win_amount: 100,
      expires_at: '2026-10-28T00:01:00.000Z', settled_at: '2026-10-28T00:00:04.000Z',
      published_win_percent: 50, card,
      cards: [{ ...card, stake_amount: 100 }], tickets: 0, chosen_side: 'head', landed_side: 'head',
    });
    expect(publicCoinFlipRound({ ...row, status: 'lost' }).win_amount).toBe(0);
    expect(publicCoinFlipRound({ ...row, status: 'quoted', settled_at: null }).win_amount).toBe(0);
    for (const chosen_side of ['head', 'tail'] as const) {
      const chosen = { ...row, snapshot: { ...row.snapshot, chosen_side } };
      expect(publicCoinFlipRound(chosen).landed_side).toBe(chosen_side);
      expect(publicCoinFlipRound({ ...chosen, status: 'lost' }).landed_side).toBe(chosen_side === 'head' ? 'tail' : 'head');
      expect(publicCoinFlipRound({ ...chosen, status: 'quoted' }).landed_side).toBeNull();
    }
  });

  it('a ticket receipt moves no money, names no card and hides the odds', () => {
    const row: CoinFlipRoundRecord = {
      id: 'flip_2', customer_id: 'customer_1', pull_id: null,
      status: 'won', stake_cents: 0, ticket_stake: 5, flip_version: 0, config_revision: 4,
      expires_at: new Date('2026-10-28T00:01:00Z'),
      settled_at: new Date('2026-10-28T00:00:04Z'), roll: 1234, credit_transaction_id: null,
      snapshot: {
        chosen_side: 'tail', group_id: 'secret', odds_set: 3, actual_win_units: 451234,
        published_win_units: 500000, source: 'tickets', bonus_bp: 0,
      },
    };
    const receipt = publicCoinFlipRound(row);
    expect(receipt).toEqual({
      id: 'flip_2', status: 'won', stake_amount: 0, win_amount: 0,
      expires_at: '2026-10-28T00:01:00.000Z', settled_at: '2026-10-28T00:00:04.000Z',
      published_win_percent: 50, card: null, cards: [], tickets: 5, chosen_side: 'tail', landed_side: 'tail',
    });
    expect(JSON.stringify(receipt)).not.toMatch(/actual|odds_set|group_id|roll|bonus_bp/);
    expect(publicCoinFlipRound({ ...row, status: 'lost' })).toMatchObject({ tickets: 5, win_amount: 0, landed_side: 'head' });
  });

  it('a mixed receipt carries the cards, their money and the tickets', () => {
    const card = { pull_id: 'pull_1', name: 'Charizard', image: '/card.png', grader: 'PSA', grade: '10' };
    const row: CoinFlipRoundRecord = {
      id: 'flip_3', customer_id: 'customer_1', pull_id: 'pull_1',
      status: 'won', stake_cents: 10000, ticket_stake: 5, flip_version: 0, config_revision: 4,
      expires_at: new Date('2026-10-28T00:01:00Z'),
      settled_at: new Date('2026-10-28T00:00:04Z'), roll: 1234, credit_transaction_id: 'credit_1',
      snapshot: {
        card, valuation: { value_usd: 20, multiplier: 1, fx: 5, quoted_at: '2026-10-28T00:00:00.000Z' },
        group_id: null, odds_set: 1, actual_win_units: 451234,
        published_win_units: 500000, source: 'pack', bonus_bp: 0,
      },
    };
    expect(publicCoinFlipRound(row)).toMatchObject({
      stake_amount: 100, win_amount: 100, tickets: 5, card, cards: [{ ...card, stake_amount: 100 }],
    });
  });
});
