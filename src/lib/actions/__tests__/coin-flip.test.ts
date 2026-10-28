import { describe, expect, it, vi } from 'vitest';
import { backend, storeShim } from '@/lib/__tests__/store-shim';
vi.mock('@/lib/store', () => ({ store: storeShim }));
import { acceptCoinFlip, getCoinFlipRound, quoteCoinFlip } from '../coin-flip';
import { CoinFlipRoundSchema, quoteIsLive } from '@/lib/coin-flip';

const round = {
  id: 'cfr_1',
  status: 'quoted',
  expires_at: '2026-10-28T12:01:00.000Z',
  settled_at: null,
  stake_amount: 100,
  win_amount: 0,
  published_win_percent: 50,
  card: {
    pull_id: 'pull_1',
    name: 'Pikachu',
    image: null,
    grader: 'PSA',
    grade: '10',
  },
};

describe('coin flip boundary', () => {
  it('quotes only pull ID with bearer and strips private response fields', async () => {
    const mem = backend({
      'POST /store/coin-flips/quotes': {
        body: {
          round: { ...round, roll: 1, snapshot: { actual_win_units: 42 } },
        },
      },
    });
    const result = await quoteCoinFlip('pull_1');
    expect(result).toEqual({ ok: true, round });
    expect(mem.requests[0]).toMatchObject({
      body: { pull_id: 'pull_1' },
      headers: { Authorization: 'Bearer test-token' },
    });
  });
  it('keeps ambiguous acceptance recoverable, never invents a loss', async () => {
    backend({
      'POST /store/coin-flips/cfr_1/accept': {
        status: 500,
        body: { message: 'private SQL failure' },
      },
    });
    expect(await acceptCoinFlip('cfr_1')).toMatchObject({
      ok: false,
      uncertain: true,
    });
    backend({
      'GET /store/coin-flips/cfr_1': {
        body: {
          round: {
            ...round,
            status: 'won',
            win_amount: 100,
            settled_at: round.expires_at,
          },
        },
      },
    });
    expect(await getCoinFlipRound('cfr_1')).toMatchObject({
      ok: true,
      round: { status: 'won', win_amount: 100 },
    });
  });
  it('stale quote refusal requires fresh confirmation', async () => {
    backend({
      'POST /store/coin-flips/cfr_1/accept': {
        status: 400,
        body: { message: 'Quote expired. Select your card again.' },
      },
    });
    expect(await acceptCoinFlip('cfr_1')).toMatchObject({
      ok: false,
      uncertain: false,
      error: 'Quote expired. Review your card again.',
    });
  });
  it('rejects malformed money/outcome and expires precisely', () => {
    expect(
      CoinFlipRoundSchema.safeParse({ ...round, stake_amount: -1 }).success,
    ).toBe(false);
    const parsed = CoinFlipRoundSchema.parse(round);
    expect(quoteIsLive(parsed, Date.parse(round.expires_at) - 1)).toBe(true);
    expect(quoteIsLive(parsed, Date.parse(round.expires_at))).toBe(false);
  });
});
