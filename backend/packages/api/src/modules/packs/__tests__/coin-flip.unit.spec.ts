import {
  parseCoinFlipSettings,
  coinFlipSettingsView,
  effectiveCoinWinUnits,
  coinFlipWins,
  publicCoinFlipRound,
  assertCoinFlipEligible,
  type CoinFlipRoundRecord,
} from '../coin-flip';

const settings = {
  enabled: true,
  max_stake_amount: 1000,
  win_percent: 45.1234,
  win_percent_2: null,
  win_percent_3: null,
  published_win_percent: 50,
};

describe('coin flip rules', () => {
  it('retains four-decimal probabilities and exact sen', () => {
    expect(parseCoinFlipSettings(settings)).toEqual({
      enabled: true, max_stake_cents: 100000, win_units: 451234,
      win_units_2: null, win_units_3: null, published_win_units: 500000,
    });
    expect(coinFlipSettingsView(null)).toEqual({
      enabled: false, max_stake_amount: null, win_percent: null,
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

  it.each([0, -1, Infinity, 0.001, 21474836.48, '100'])(
    'rejects invalid stake limit %p', (max_stake_amount) => {
      expect(() => parseCoinFlipSettings({ ...settings, max_stake_amount })).toThrow();
    },
  );

  it('allows incomplete disabled drafts but never enables missing terms', () => {
    const empty = { ...settings, enabled: false, win_percent: null, max_stake_amount: null, published_win_percent: null };
    expect(parseCoinFlipSettings(empty).enabled).toBe(false);
    for (const key of ['win_percent', 'max_stake_amount', 'published_win_percent']) {
      expect(() => parseCoinFlipSettings({ ...settings, [key]: null })).toThrow();
    }
    expect(() => parseCoinFlipSettings({ ...settings, enabled: 'true' })).toThrow();
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
  });

  it('allowlists public receipt and pays only terminal wins', () => {
    const row: CoinFlipRoundRecord = {
      id: 'flip_1', customer_id: 'customer_1', pull_id: 'pull_1',
      status: 'won', stake_cents: 10000, flip_version: 0, config_revision: 4,
      expires_at: new Date('2026-10-28T00:01:00Z'),
      settled_at: new Date('2026-10-28T00:00:04Z'), roll: 1234,
      credit_transaction_id: 'credit_1',
      snapshot: {
        card: { pull_id: 'pull_1', name: 'Charizard', image: '/card.png', grader: 'PSA', grade: '10' },
        valuation: { value_usd: 20, multiplier: 1, fx: 5, quoted_at: '2026-10-28T00:00:00.000Z' },
        group_id: 'secret', odds_set: 3, actual_win_units: 451234,
        published_win_units: 500000, source: 'gift', bonus_bp: 10000,
      },
    };
    expect(publicCoinFlipRound(row)).toEqual({
      id: 'flip_1', status: 'won', stake_amount: 100, win_amount: 100,
      expires_at: '2026-10-28T00:01:00.000Z', settled_at: '2026-10-28T00:00:04.000Z',
      published_win_percent: 50, card: row.snapshot.card,
    });
    expect(publicCoinFlipRound({ ...row, status: 'lost' }).win_amount).toBe(0);
    expect(publicCoinFlipRound({ ...row, status: 'quoted', settled_at: null }).win_amount).toBe(0);
  });
});
