import { marketingSection, type MarketingWindowRows } from '../pnl-marketing';
import type { PackMeta, PackWindowRows } from '../pnl';

const pack = (
  slug: string,
  price_sen: number,
  prize_type: string | null = 'cards',
): PackMeta => ({
  slug,
  title: slug.toUpperCase(),
  category: 'pokemon',
  pack_type: 'classic',
  prize_type,
  price_sen,
});

const META: PackMeta[] = [
  pack('bronze-pack', 30000),
  pack('silver-pack', 60000),
  pack('free-151', 0),
  pack('lucky-pack', 1000, 'tickets'),
];

const packRows = (free: PackWindowRows['free'] = []): PackWindowRows => ({
  paid: new Map(),
  opens: new Map(),
  free,
});

const mk = (r: Partial<MarketingWindowRows> = {}): MarketingWindowRows => ({
  credit: [],
  cash_rewards: [],
  cards: [],
  referral_sen: 0,
  ...r,
});

describe('marketingSection', () => {
  it('splits free credit used by source; returned counts, Lucky Draw prizes do not', () => {
    const s = marketingSection(
      META,
      packRows(),
      null,
      mk({
        credit: [
          { kind: 'used', source: 'adjustment', sen: 50000 },
          { kind: 'used', source: 'checkin', sen: 2000 },
          { kind: 'used', source: 'task', sen: 3000 },
          { kind: 'used', source: 'weekly_challenge', sen: 40000 },
          { kind: 'used', source: 'returned', sen: 500 },
          // Lucky Draw credit prizes are Lucky Draw cost, not marketing.
          { kind: 'used', source: 'lucky_draw', sen: 7000 },
        ],
      }),
      null,
      4.5,
    );
    expect(s.credit_used.by_source.adjustment).toEqual({
      current_sen: 50000,
      previous_sen: null,
    });
    expect(s.credit_used.by_source.lucky_draw.current_sen).toBe(7000);
    expect(s.credit_used.total).toEqual({
      current_sen: 50000 + 2000 + 3000 + 40000 + 500,
      previous_sen: null,
    });
    expect(s.total.current_sen).toBe(95500);
  });

  it('takes free credit that came back (a refund or reversal) off the used total (review F1)', () => {
    // RM 40 of check-in credit spent, the open reversed (RM 40 comes back),
    // then re-spent: one real use of RM 40, not RM 80.
    const s = marketingSection(
      META,
      packRows(),
      null,
      mk({
        credit: [
          { kind: 'used', source: 'checkin', sen: 4000 },
          { kind: 'given', source: 'returned', sen: 4000 },
          { kind: 'used', source: 'returned', sen: 4000 },
        ],
      }),
      null,
      4.5,
    );
    expect(s.credit_used.returned_back).toEqual({
      current_sen: 4000,
      previous_sen: null,
    });
    expect(s.credit_used.total).toEqual({
      current_sen: 4000,
      previous_sen: null,
    });
  });

  it('counts reward credits paid as cash when given, by source (decision 24)', () => {
    const s = marketingSection(
      META,
      packRows(),
      null,
      mk({
        cash_rewards: [
          { source: 'checkin', sen: 500 },
          { source: 'task', sen: 1500 },
          { source: 'returned', sen: 200 },
        ],
      }),
      null,
      4.5,
    );
    expect(s.cash_rewards.by_source.checkin).toEqual({
      current_sen: 500,
      previous_sen: null,
    });
    expect(s.cash_rewards.by_source.other).toEqual({
      current_sen: 200,
      previous_sen: null,
    });
    expect(s.cash_rewards.total).toEqual({
      current_sen: 2200,
      previous_sen: null,
    });
    expect(s.total.current_sen).toBe(2200);
  });

  it("counts an 'other' promo grant as used, never nets it as a refund (review)", () => {
    const s = marketingSection(
      META,
      packRows(),
      null,
      mk({
        credit: [
          { kind: 'given', source: 'other', sen: 10000 },
          { kind: 'used', source: 'other', sen: 6000 },
        ],
      }),
      null,
      4.5,
    );
    expect(s.credit_used.returned_back.current_sen).toBe(0);
    expect(s.credit_used.total.current_sen).toBe(6000);
  });

  it('keeps free credit given (and admin removals) out of the total', () => {
    const s = marketingSection(
      META,
      packRows(),
      packRows(),
      mk({
        credit: [
          { kind: 'given', source: 'adjustment', sen: 100000 },
          { kind: 'given', source: 'checkin', sen: 1000 },
          { kind: 'given', source: 'returned', sen: 800 },
          { kind: 'given', source: 'lucky_draw', sen: 5000 },
          { kind: 'removed', source: 'adjustment', sen: 20000 },
          { kind: 'used', source: 'adjustment', sen: 30000 },
        ],
      }),
      mk({ credit: [{ kind: 'given', source: 'adjustment', sen: 9000 }] }),
      4.5,
    );
    // Given = new free credit: the four marketing sources only.
    expect(s.credit_given.total).toEqual({
      current_sen: 101000,
      previous_sen: 9000,
    });
    expect(s.credit_given.by_source.returned.current_sen).toBe(800);
    expect(s.credit_given.removed).toEqual({
      current_sen: 20000,
      previous_sen: 0,
    });
    // Only the 30000 used counts (given would count the bonus twice), less
    // the 800 that came back by a refund (review F1).
    expect(s.total).toEqual({ current_sen: 29200, previous_sen: 0 });
  });

  it('values free cards: sold at the credited amount, the rest at 90% of live value', () => {
    const s = marketingSection(
      META,
      packRows(),
      packRows(),
      mk({
        cards: [
          {
            source: 'checkin',
            n: 10,
            sold: 8,
            sold_sen: 4000,
            unsold_usd: 2,
          },
          {
            source: 'weekly_challenge',
            n: 1,
            sold: 0,
            sold_sen: 0,
            unsold_usd: 100.123,
          },
        ],
      }),
      mk({
        cards: [
          { source: 'task', n: 1, sold: 1, sold_sen: 1234, unsold_usd: 0 },
        ],
      }),
      4.4,
    );
    // 2 USD × 4.4 × 90% = RM 7.92.
    expect(s.free_cards.by_source.checkin).toEqual({
      cards: 10,
      sold: 8,
      value: { current_sen: 4000 + 792, previous_sen: 0 },
    });
    // 100.123 × 4.4 × 90 = 39648.708 sen → rounded.
    expect(s.free_cards.by_source.weekly_challenge.value.current_sen).toBe(
      39649,
    );
    expect(s.free_cards.by_source.task).toEqual({
      cards: 0,
      sold: 0,
      value: { current_sen: 0, previous_sen: 1234 },
    });
    expect(s.free_cards.total).toEqual({
      current_sen: 4792 + 39649,
      previous_sen: 1234,
    });
  });

  it('lists free packs per pack at qty × price; welcome at RM 0; capsules left out', () => {
    const s = marketingSection(
      META,
      packRows([
        { slug: 'bronze-pack', source: 'adjustment', qty: 10 },
        { slug: 'bronze-pack', source: 'checkin', qty: 2 },
        { slug: 'silver-pack', source: 'task', qty: 1 },
        { slug: 'free-151', source: 'welcome', qty: 40 },
        { slug: 'lucky-pack', source: 'adjustment', qty: 3 },
      ]),
      packRows([{ slug: 'bronze-pack', source: 'other', qty: 1 }]),
      mk(),
      mk(),
      4.5,
    );
    expect(s.free_packs.packs.map((p) => p.slug)).toEqual([
      'bronze-pack',
      'silver-pack',
      'free-151',
    ]);
    const [bronze, silver, welcome] = s.free_packs.packs;
    // "bronze 10qty 3000myr", plus two check-in ones.
    expect(bronze).toEqual({
      slug: 'bronze-pack',
      title: 'BRONZE-PACK',
      price_sen: 30000,
      qty: { adjustment: 10, checkin: 2, task: 0, welcome: 0, other: 0 },
      value: { current_sen: 12 * 30000, previous_sen: 30000 },
    });
    expect(silver.value).toEqual({ current_sen: 60000, previous_sen: 0 });
    expect(welcome.qty.welcome).toBe(40);
    expect(welcome.value).toEqual({ current_sen: 0, previous_sen: 0 });
    expect(s.free_packs.total).toEqual({
      current_sen: 360000 + 60000,
      previous_sen: 30000,
    });
  });

  it('adds used credit, free cards, free packs and referral commission into the total', () => {
    const s = marketingSection(
      META,
      packRows([{ slug: 'bronze-pack', source: 'adjustment', qty: 1 }]),
      null,
      mk({
        credit: [
          { kind: 'used', source: 'task', sen: 1000 },
          { kind: 'given', source: 'task', sen: 99999 },
        ],
        cards: [
          { source: 'task', n: 1, sold: 1, sold_sen: 500, unsold_usd: 0 },
        ],
        referral_sen: 2500,
      }),
      null,
      4.5,
    );
    expect(s.referral).toEqual({ current_sen: 2500, previous_sen: null });
    expect(s.total).toEqual({
      current_sen: 1000 + 500 + 30000 + 2500,
      previous_sen: null,
    });
    // range=all: no previous anywhere.
    expect(s.free_packs.packs[0].value.previous_sen).toBeNull();
    expect(s.credit_given.removed.previous_sen).toBeNull();
    expect(s.free_cards.by_source.checkin.value.previous_sen).toBeNull();
  });

  it('reads an empty window as zeros', () => {
    const s = marketingSection([], packRows(), packRows(), mk(), mk(), 4.5);
    expect(s.total).toEqual({ current_sen: 0, previous_sen: 0 });
    expect(s.free_packs.packs).toEqual([]);
    expect(s.credit_used.by_source.returned).toEqual({
      current_sen: 0,
      previous_sen: 0,
    });
  });
});
