import { describe, expect, test } from 'vitest';
import {
  MAX_NEW_EVENT_PRIZES,
  blankCredit,
  creditAmount,
  creditTitle,
  newEventPayload,
  patchCredit,
  poolCardFrom,
  poolMoney,
  poolSummary,
  poolTotal,
  prizeCards,
  type PoolCard,
  type PoolCredit,
} from './prize-pool';
import type { InventoryRow } from '../../lib/admin-rest';
import type { EventDraft } from './lucky-draw-draft';
import { toIso } from '../tasks/task-draft';

const row = (over: Partial<InventoryRow> = {}): InventoryRow => ({
  handle: 'charizard-psa10',
  product_id: 'prod_1',
  photo: '/static/charizard.png',
  name: 'Charizard PSA 10',
  sku: 'CHZ-10',
  is_card: true,
  graded: true,
  fmv: 1000,
  price: 1200,
  cost: 900,
  created_at: '2026-10-01T00:00:00.000Z',
  to_procure: 0,
  on_hand: 5,
  counter: 3,
  in_vault: 0,
  requested: 0,
  ready_to_ship: 0,
  shipped: 0,
  listing_count: 1,
  ...over,
});

const card = (over: Partial<PoolCard> = {}): PoolCard => ({
  handle: 'charizard-psa10',
  name: 'Charizard PSA 10',
  photo: null,
  value: 1200,
  title: 'Charizard PSA 10',
  ...over,
});

const credit = (over: Partial<PoolCredit> = {}): PoolCredit => ({
  ...blankCredit(),
  amount: '50',
  imageUrl: '/static/credit.png',
  ...over,
});

const draft: EventDraft = {
  name: 'December Lucky Draw',
  startsAt: '2026-12-01T00:00',
  endsAt: '2026-12-31T23:00',
};

describe('prizeCards', () => {
  // Spec 2026-10-24: the operator picks any card. On prod 10-30 only 1 of
  // 1,200 cards had a counter above 0, so a stock gate left one card to pick.
  test('keeps every registered card whatever its stock; drops non-cards', () => {
    const rows = [
      row({ handle: 'a' }),
      row({ handle: 'b', is_card: false }),
      row({ handle: 'c', counter: 0, on_hand: 0 }),
      row({ handle: 'd', counter: -2, on_hand: -1 }),
      row({ handle: 'e', counter: null }),
      row({ handle: 'f', counter: 1 }),
    ];
    expect(prizeCards(rows).map((r) => r.handle)).toEqual([
      'a',
      'c',
      'd',
      'e',
      'f',
    ]);
  });
});

describe('poolCardFrom', () => {
  test('snapshots the row; the title starts as the card name; value is the RM price', () => {
    expect(poolCardFrom(row())).toEqual({
      handle: 'charizard-psa10',
      name: 'Charizard PSA 10',
      photo: '/static/charizard.png',
      value: 1200,
      title: 'Charizard PSA 10',
    });
    expect(poolCardFrom(row({ price: null, counter: null }))).toMatchObject({
      value: null,
    });
  });
});

describe('creditAmount / creditTitle', () => {
  test.each([
    ['25', 25],
    [' 12.5 ', 12.5],
    ['50000', 50_000],
    ['0.01', 0.01],
  ])('%s is a valid amount', (amount, expected) => {
    expect(creditAmount(credit({ amount }))).toBe(expected);
  });

  test.each([
    [''],
    ['abc'],
    ['0'],
    ['-5'],
    ['50000.01'],
    ['10.005'],
    ['Infinity'],
  ])('%s is not', (amount) => {
    expect(creditAmount(credit({ amount }))).toBeNull();
  });

  test('the default title names the amount', () => {
    expect(creditTitle(25)).toBe('RM 25 bonus credit');
    expect(creditTitle(12.5)).toBe('RM 12.50 bonus credit');
    expect(creditTitle(1500)).toBe('RM 1,500 bonus credit');
  });
});

describe('poolMoney / poolTotal / poolSummary', () => {
  test('whole amounts show no decimals, others two', () => {
    expect(poolMoney(98_400)).toBe('RM 98,400');
    expect(poolMoney(1234.5)).toBe('RM 1,234.50');
    expect(poolMoney(0)).toBe('RM 0');
  });

  test('the total is the card values plus the valid credit amounts', () => {
    expect(
      poolTotal(
        [card({ value: 1200 }), card({ handle: 'b', value: 340.5 })],
        [credit({ amount: '50' }), credit({ amount: '9.5' })],
      ),
    ).toBe(1600);
  });

  test('a card with no value and a credit row with a bad amount add nothing', () => {
    expect(
      poolTotal(
        [card({ value: null }), card({ handle: 'b', value: 10 })],
        [credit({ amount: '' }), credit({ amount: 'x' })],
      ),
    ).toBe(10);
  });

  test('sums stay in whole sen', () => {
    expect(
      poolTotal([card({ value: 0.1 }), card({ handle: 'b', value: 0.2 })], []),
    ).toBe(0.3);
  });

  test('the summary counts prizes and prints the total', () => {
    const cards = Array.from({ length: 6 }, (_, i) =>
      card({ handle: `c${i}`, value: 16_000 }),
    );
    expect(
      poolSummary(cards, [
        credit({ amount: '1000' }),
        credit({ amount: '1400' }),
      ]),
    ).toBe('8 prizes · RM 98,400');
    expect(poolSummary([card({ value: 50 })], [])).toBe('1 prize · RM 50');
    expect(poolSummary([], [])).toBe('No prizes yet');
  });

  test('a card with no value is called out, so the total is not silently low', () => {
    expect(poolSummary([card({ value: null })], [])).toBe(
      '1 prize · RM 0 · 1 card has no value yet',
    );
    expect(
      poolSummary(
        [
          card({ value: 50 }),
          card({ handle: 'b', value: null }),
          card({ handle: 'c', value: null }),
        ],
        [credit({ amount: '10' })],
      ),
    ).toBe('4 prizes · RM 60 · 2 cards have no value yet');
  });
});

describe('patchCredit', () => {
  test('changes only the row with that key', () => {
    const a = credit({ amount: '10' });
    const b = credit({ amount: '20' });
    const out = patchCredit([a, b], b.key, { imageUrl: '/new.png' });
    expect(out).toEqual([a, { ...b, imageUrl: '/new.png' }]);
    expect(out[0]).toBe(a);
  });

  test('keeps what was typed after the patch was prepared (a late upload only sets its image)', () => {
    const row = credit({ amount: '10', imageUrl: '' });
    // The row is edited while the upload is still running...
    const edited = patchCredit([row], row.key, {
      amount: '99',
      title: 'Typed',
    });
    // ...and the upload then lands on the latest list, not the old row.
    expect(patchCredit(edited, row.key, { imageUrl: '/up.png' })).toEqual([
      { ...row, amount: '99', title: 'Typed', imageUrl: '/up.png' },
    ]);
  });

  test('a row removed meanwhile stays removed', () => {
    const a = credit();
    const b = credit();
    expect(patchCredit([a], b.key, { imageUrl: '/late.png' })).toEqual([a]);
  });
});

describe('newEventPayload', () => {
  test('builds the event with every prize in order: cards first, then credits', () => {
    const payload = newEventPayload(
      draft,
      [
        card({ handle: 'a', title: 'Charizard PSA 10' }),
        card({ handle: 'b', title: 'Pikachu PSA 9' }),
      ],
      [credit({ amount: '25', title: '', imageUrl: '/static/c.png' })],
    );
    expect(payload).toEqual({
      name: 'December Lucky Draw',
      starts_at: toIso(draft.startsAt),
      ends_at: toIso(draft.endsAt),
      prizes: [
        {
          kind: 'card',
          card_handle: 'a',
          credit_myr: null,
          title: 'Charizard PSA 10',
          image_url: null,
          sort: 0,
          draw_at: null,
        },
        {
          kind: 'card',
          card_handle: 'b',
          credit_myr: null,
          title: 'Pikachu PSA 9',
          image_url: null,
          sort: 1,
          draw_at: null,
        },
        {
          kind: 'credit',
          card_handle: null,
          credit_myr: 25,
          title: 'RM 25 bonus credit',
          image_url: '/static/c.png',
          sort: 2,
          draw_at: null,
        },
      ],
    });
    expect('id' in payload!).toBe(false);
  });

  test('a prize carries no id and no event_id: the event does not exist yet', () => {
    const payload = newEventPayload(draft, [card()], [credit()]);
    for (const p of payload!.prizes!) {
      expect('id' in p).toBe(false);
      expect('event_id' in p).toBe(false);
    }
  });

  test('a typed title wins; a blank card title falls back to the name; titles are trimmed and capped at 120', () => {
    const payload = newEventPayload(
      draft,
      [
        card({ handle: 'a', title: '  Grand prize  ' }),
        card({ handle: 'b', title: '   ', name: 'Pikachu PSA 9' }),
        card({ handle: 'c', title: 'x'.repeat(200) }),
      ],
      [credit({ title: ' Top-up ' })],
    );
    expect(payload!.prizes!.map((p) => p.title)).toEqual([
      'Grand prize',
      'Pikachu PSA 9',
      'x'.repeat(120),
      'Top-up',
    ]);
  });

  test('no cards and no credits is a plain event with an empty pool', () => {
    expect(newEventPayload(draft, [], [])).toMatchObject({ prizes: [] });
  });

  test.each([
    ['no amount', { amount: '' }],
    ['a zero amount', { amount: '0' }],
    ['more than the ceiling', { amount: '50001' }],
    ['a fraction of a sen', { amount: '10.005' }],
  ])('a credit row with %s makes the whole payload null', (_, over) => {
    expect(newEventPayload(draft, [card()], [credit(over)])).toBeNull();
  });

  test('a credit row with no image is fine (players see coins)', () => {
    const out = newEventPayload(draft, [], [credit({ imageUrl: '' })]);
    expect(out!.prizes![0]).toMatchObject({ kind: 'credit', image_url: null });
  });

  test('an invalid event makes it null', () => {
    expect(newEventPayload({ ...draft, name: '' }, [card()], [])).toBeNull();
    expect(
      newEventPayload({ ...draft, endsAt: draft.startsAt }, [card()], []),
    ).toBeNull();
  });

  test('more than the most the backend takes is null', () => {
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) => card({ handle: `c${i}` }));
    expect(
      newEventPayload(draft, many(MAX_NEW_EVENT_PRIZES), []),
    ).not.toBeNull();
    expect(
      newEventPayload(draft, many(MAX_NEW_EVENT_PRIZES), [credit()]),
    ).toBeNull();
  });
});
