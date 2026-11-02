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
  chosen_side: 'head',
  landed_side: null,
  cards: [
    {
      pull_id: 'pull_1',
      name: 'Pikachu',
      image: null,
      grader: 'PSA',
      grade: '10',
      stake_amount: 100,
    },
  ],
  card: {
    pull_id: 'pull_1',
    name: 'Pikachu',
    image: null,
    grader: 'PSA',
    grade: '10',
  },
};

describe('coin flip boundary', () => {
  it('quotes only pull IDs and side with bearer and strips private response fields', async () => {
    const mem = backend({
      'POST /store/coin-flips/quotes': {
        body: {
          round: { ...round, roll: 1, snapshot: { actual_win_units: 42 } },
        },
      },
    });
    const result = await quoteCoinFlip(['pull_1'], 'head');
    expect(result).toEqual({ ok: true, round: { ...round, tickets: 0 } });
    expect(mem.requests[0]).toMatchObject({
      body: { pull_ids: ['pull_1'], chosen_side: 'head' },
      headers: { Authorization: 'Bearer test-token' },
    });
  });
  it('quotes only a ticket count and side, and parses a receipt with no card or money', async () => {
    const tickets = {
      ...round,
      stake_amount: 0,
      card: null,
      cards: [],
      tickets: 5,
    };
    const mem = backend({
      'POST /store/coin-flips/quotes': { body: { round: tickets } },
    });
    expect(await quoteCoinFlip([], 'tail', 5)).toEqual({
      ok: true,
      round: tickets,
    });
    expect(mem.requests[0]?.body).toEqual({ tickets: 5, chosen_side: 'tail' });
  });
  it('quotes cards and tickets in one request, and leaves tickets out when none', async () => {
    const mem = backend({
      'POST /store/coin-flips/quotes': {
        body: { round: { ...round, tickets: 5 } },
      },
    });
    const result = await quoteCoinFlip(['pull_1'], 'tail', 5);
    expect(result).toMatchObject({ ok: true, round: { tickets: 5 } });
    expect(mem.requests[0]?.body).toEqual({
      pull_ids: ['pull_1'],
      tickets: 5,
      chosen_side: 'tail',
    });
    await quoteCoinFlip(['pull_1'], 'head');
    expect(mem.requests[1]?.body).toEqual({
      pull_ids: ['pull_1'],
      chosen_side: 'head',
    });
  });
  it('refuses a receipt that stakes nothing, or pays money with no cards', () => {
    const tickets = { ...round, stake_amount: 0, card: null, cards: [] };
    for (const good of [
      { ...round, tickets: 5 },
      { ...tickets, tickets: 5 },
    ]) {
      expect(CoinFlipRoundSchema.safeParse(good).success).toBe(true);
    }
    for (const bad of [
      { ...tickets, tickets: 0 },
      { ...tickets, tickets: 5, stake_amount: 1 },
      { ...tickets, tickets: 5, win_amount: 1 },
      { ...tickets, tickets: 10_001 },
    ]) {
      expect(CoinFlipRoundSchema.safeParse(bad).success).toBe(false);
    }
  });
  it.each([
    [
      'This card is no longer available in your Vault.',
      'A card in this flip is no longer available. Choose your cards again.',
    ],
    [
      'This quote has an invalid card value.',
      'A card in this flip is no longer available. Choose your cards again.',
    ],
    [
      'Pay for one pack yourself to unlock selling & delivery.',
      'Pay for one pack yourself before flipping this card.',
    ],
  ])(
    'tells the customer why a quote was refused: %s',
    async (message, error) => {
      backend({
        'POST /store/coin-flips/quotes': { status: 400, body: { message } },
      });
      expect(await quoteCoinFlip(['pull_1'], 'head')).toMatchObject({
        ok: false,
        uncertain: false,
        error,
      });
    },
  );
  it('names the card still processing, even one named like another refusal', async () => {
    const message =
      'Paused Expired Mew is still processing. Please try again later.';
    backend({
      'POST /store/coin-flips/quotes': { status: 400, body: { message } },
    });
    expect(await quoteCoinFlip(['pull_1'], 'head')).toMatchObject({
      ok: false,
      uncertain: false,
      error: message,
    });
  });
  it('words ticket refusals as tickets', async () => {
    backend({
      'POST /store/coin-flips/quotes': {
        status: 400,
        body: { message: 'You do not have enough tickets for this flip.' },
      },
    });
    expect(await quoteCoinFlip([], 'tail', 5)).toMatchObject({
      ok: false,
      uncertain: false,
      error: 'You no longer have that many tickets.',
    });
    backend({
      'POST /store/coin-flips/cfr_1/accept': {
        status: 400,
        body: { message: 'Quote expired. Select your tickets again.' },
      },
    });
    expect(await acceptCoinFlip('cfr_1')).toMatchObject({
      error: 'Quote expired. Review your tickets again.',
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
            landed_side: 'head',
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
      error: 'Quote expired. Review your flip again.',
    });
  });
  it('a failure with no rule names the action it came from', async () => {
    backend({
      'POST /store/coin-flips/quotes': {
        status: 400,
        body: { message: 'Odd' },
      },
    });
    expect(await quoteCoinFlip(['pull_1'], 'head')).toMatchObject({
      ok: false,
      error: 'Could not load a quote. Nothing has been staked.',
    });
    backend({
      'POST /store/coin-flips/cfr_1/accept': {
        status: 400,
        body: { message: 'Odd' },
      },
    });
    expect(await acceptCoinFlip('cfr_1')).toMatchObject({
      ok: false,
      error:
        'Could not confirm the flip. Check its status before trying again.',
    });
  });
  it('rejects a receipt whose payout or settlement disagrees with its status', () => {
    const settled = {
      ...round,
      settled_at: '2026-10-28T12:00:30.000Z',
      landed_side: 'head',
    };
    const parses = (extra: Record<string, unknown>) =>
      CoinFlipRoundSchema.safeParse({ ...settled, ...extra }).success;
    expect(parses({ status: 'won', win_amount: 100 })).toBe(true);
    expect(parses({ status: 'won', win_amount: 999 })).toBe(false);
    expect(
      parses({ status: 'lost', win_amount: 50, landed_side: 'tail' }),
    ).toBe(false);
    expect(parses({ status: 'won', win_amount: 100, settled_at: null })).toBe(
      false,
    );
    expect(
      CoinFlipRoundSchema.safeParse({
        ...round,
        settled_at: '2026-10-28T12:00:30.000Z',
      }).success,
    ).toBe(false);
  });
  it('rejects malformed money/outcome and expires precisely', () => {
    expect(
      CoinFlipRoundSchema.safeParse({ ...round, stake_amount: -1 }).success,
    ).toBe(false);
    expect(
      CoinFlipRoundSchema.safeParse({
        ...round,
        cards: [...round.cards, ...round.cards],
      }).success,
    ).toBe(false);
    expect(
      CoinFlipRoundSchema.safeParse({ ...round, stake_amount: 200 }).success,
    ).toBe(false);
    expect(
      CoinFlipRoundSchema.safeParse({
        ...round,
        status: 'won',
        landed_side: 'tail',
      }).success,
    ).toBe(false);
    const parsed = CoinFlipRoundSchema.parse(round);
    expect(quoteIsLive(parsed, Date.parse(round.expires_at) - 1)).toBe(true);
    expect(quoteIsLive(parsed, Date.parse(round.expires_at))).toBe(false);
  });
});
