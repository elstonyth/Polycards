import { describe, expect, it } from 'vitest';
import {
  coinFlipDraft,
  parseCoinFlipDraft,
  effectiveCoinRates,
  coinHistoryQuery,
} from './coin-flips';
const initial = {
  enabled: false,
  win_percent: null,
  win_percent_2: null,
  win_percent_3: null,
  published_win_percent: null,
  revision: 0,
};
describe('coin flip operator inputs', () => {
  it('starts disabled/unconfigured and distinguishes inherited blank from actual zero', () => {
    const draft = coinFlipDraft(initial);
    expect(draft.enabled).toBe(false);
    expect(draft.win_percent).toBe('');
    expect(() => parseCoinFlipDraft({ ...draft, enabled: true })).toThrow();
    const parsed = parseCoinFlipDraft({
      ...draft,
      enabled: true,
      win_percent: '48.125',
      win_percent_2: '0',
      published_win_percent: '50',
    });
    expect(parsed.win_percent_2).toBe(0);
    expect(parsed.win_percent_3).toBeNull();
    expect(effectiveCoinRates(parsed)).toEqual([48.125, 0, 0]);
  });
  it('validates finite ranges and exact decimal precision', () => {
    const draft = coinFlipDraft(initial);
    for (const value of ['NaN', 'Infinity', '101', '-1', '0.00001', '1e1'])
      expect(() =>
        parseCoinFlipDraft({ ...draft, win_percent: value }),
      ).toThrow();
    expect(
      parseCoinFlipDraft({ ...draft, win_percent: '0.0001' }).win_percent,
    ).toBe(0.0001);
  });
  it('encodes filters and bounds pagination without losing a customer ID', () => {
    const query = new URLSearchParams(
      coinHistoryQuery({
        page: -2,
        status: 'lost',
        customer: 'c&x',
        source: 'gift',
        from: '2026-10-01',
        to: '',
      }),
    );
    expect(query.get('customer_id')).toBe('c&x');
    expect(query.get('source')).toBe('gift');
    expect(query.get('offset')).toBe('0');
    expect(query.get('status')).toBe('lost');
    expect(query.has('to')).toBe(false);
  });
});
