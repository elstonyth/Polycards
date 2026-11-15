import {
  capsuleSlugsOf,
  coinFlipSection,
  luckyDrawSection,
  type GamesWindowRows,
} from '../pnl-games';
import type { PackMeta } from '../pnl';

const capsule = (slug: string, title: string, price_sen: number): PackMeta => ({
  slug,
  title,
  category: 'poly',
  pack_type: null,
  prize_type: 'tickets',
  price_sen,
});

const META: PackMeta[] = [
  capsule('diamond-capsule', 'Diamond Capsule', 20000),
  capsule('lucky-pack', 'Bronze Capsule', 1000),
  capsule('silver-capsule', 'Silver Capsule', 2000),
];

const rows = (r: Partial<GamesWindowRows> = {}): GamesWindowRows => ({
  coin_flip: {
    card_flips: 0,
    lost_sen: 0,
    bet_sen: 0,
    win_sen: 0,
    ticket_only_flips: 0,
  },
  capsules: [],
  spins: [],
  credit_prizes: { n: 0, sen: 0 },
  card_prizes: [],
  tickets: [],
  ...r,
});

describe('coinFlipSection', () => {
  const cur = rows({
    coin_flip: {
      card_flips: 10,
      lost_sen: 3_919_487,
      bet_sen: 8_856_109,
      win_sen: 4_323_639,
      ticket_only_flips: 5,
    },
    tickets: [
      { reason: 'coin_flip', given: 170, spent: 190 },
      { reason: 'task_claim', given: 900, spent: 0 },
    ],
  });

  it('counts cards lost as revenue and win credit as cost', () => {
    const s = coinFlipSection(cur, null);
    expect(s.revenue).toEqual({ current_sen: 3_919_487, previous_sen: null });
    expect(s.cost).toEqual({ current_sen: 4_323_639, previous_sen: null });
    expect(s.bet_value).toEqual({ current_sen: 8_856_109, previous_sen: null });
  });

  it('counts card flips plus ticket-only flips', () => {
    expect(coinFlipSection(cur, null).flips).toEqual({
      current: 15,
      previous: null,
    });
  });

  it('takes tickets lost and won from the coin_flip ticket rows only', () => {
    const s = coinFlipSection(cur, null);
    expect(s.tickets_lost).toEqual({ current: 190, previous: null });
    expect(s.tickets_won).toEqual({ current: 170, previous: null });
  });

  it('gives previous 0 when the previous window had no flips', () => {
    const s = coinFlipSection(cur, rows());
    expect(s.revenue.previous_sen).toBe(0);
    expect(s.tickets_lost.previous).toBe(0);
    expect(s.flips.previous).toBe(0);
  });
});

describe('luckyDrawSection', () => {
  it('lists capsules by price then title, sales at full price', () => {
    const cur = rows({
      capsules: [
        { slug: 'silver-capsule', full_sen: 536_000, bonus_sen: 56_000 },
        { slug: 'lucky-pack', full_sen: 1_475_000, bonus_sen: 230_500 },
      ],
      spins: [
        { slug: 'silver-capsule', n: 268 },
        { slug: 'lucky-pack', n: 1475 },
      ],
    });
    const s = luckyDrawSection(META, cur, null, [], 4.2);
    expect(s.capsules.map((c) => c.slug)).toEqual([
      'lucky-pack',
      'silver-capsule',
    ]);
    expect(s.capsules[0]).toEqual({
      slug: 'lucky-pack',
      title: 'Bronze Capsule',
      price_sen: 1000,
      current: { spins: 1475, sales_sen: 1_475_000, bonus_sen: 230_500 },
      previous: null,
    });
    expect(s.revenue).toEqual({ current_sen: 2_011_000, previous_sen: null });
  });

  it('keeps a capsule sold only in the previous window, current zero', () => {
    const prev = rows({
      capsules: [{ slug: 'diamond-capsule', full_sen: 40_000, bonus_sen: 0 }],
      spins: [{ slug: 'diamond-capsule', n: 2 }],
    });
    const s = luckyDrawSection(META, rows(), prev, [], 4.2);
    expect(s.capsules).toHaveLength(1);
    expect(s.capsules[0].current).toEqual({
      spins: 0,
      sales_sen: 0,
      bonus_sen: 0,
    });
    expect(s.capsules[0].previous?.sales_sen).toBe(40_000);
    expect(s.revenue).toEqual({ current_sen: 0, previous_sen: 40_000 });
  });

  it('falls back to the slug for a capsule with no pack row', () => {
    const cur = rows({
      capsules: [{ slug: 'gone-capsule', full_sen: 500, bonus_sen: 0 }],
    });
    const s = luckyDrawSection(META, cur, null, [], 4.2);
    expect(s.capsules[0]).toMatchObject({
      slug: 'gone-capsule',
      title: 'gone-capsule',
      price_sen: 0,
    });
  });

  it('prices card prizes at the vault buyback rate on the draw day', () => {
    const cur = rows({
      card_prizes: [
        { day: '2026-11-02', n: 1, usd: 100 },
        { day: '2026-11-10', n: 2, usd: 50 },
      ],
    });
    const rates = [
      { day: '2026-11-01', rate: 4.0 },
      { day: '2026-11-10', rate: 4.5 },
    ];
    const s = luckyDrawSection(META, cur, null, rates, 4.2);
    // 100 × 4.0 × 90% = RM 360; 50 × 4.5 × 90% = RM 202.50 (earlier-day rate on 11-02).
    expect(s.card_prizes).toEqual({ current_sen: 56_250, previous_sen: null });
    expect(s.prize_count.card).toEqual({ current: 3, previous: null });
  });

  it('uses the current rate when no day rate is saved', () => {
    const cur = rows({ card_prizes: [{ day: '2026-11-02', n: 1, usd: 10 }] });
    // 10 × 4.2 × 90% = RM 37.80
    expect(
      luckyDrawSection(META, cur, null, [], 4.2).card_prizes.current_sen,
    ).toBe(3780);
  });

  it('passes credit prizes through and adds both kinds into cost', () => {
    const cur = rows({
      credit_prizes: { n: 2, sen: 150_000 },
      card_prizes: [{ day: '2026-11-02', n: 1, usd: 10 }],
    });
    const prev = rows({ credit_prizes: { n: 1, sen: 10_000 } });
    const s = luckyDrawSection(META, cur, prev, [], 4.2);
    expect(s.credit_prizes).toEqual({
      current_sen: 150_000,
      previous_sen: 10_000,
    });
    expect(s.cost).toEqual({ current_sen: 153_780, previous_sen: 10_000 });
    expect(s.prize_count.credit).toEqual({ current: 2, previous: 1 });
    expect(s.prize_count.card).toEqual({ current: 1, previous: 0 });
  });

  it('lists tickets by reason in a fixed order, previous 0 when absent', () => {
    const cur = rows({
      tickets: [
        { reason: 'entry', given: 0, spent: 849 },
        { reason: 'task_claim', given: 988, spent: 0 },
        { reason: 'coin_flip', given: 170, spent: 190 },
      ],
    });
    const prev = rows({
      tickets: [
        { reason: 'task_claim', given: 500, spent: 0 },
        { reason: 'admin_grant', given: 10, spent: 2 },
      ],
    });
    const s = luckyDrawSection(META, cur, prev, [], 4.2);
    expect(s.tickets.map((t) => t.reason)).toEqual([
      'pack_spin',
      'task_claim',
      'coin_flip',
      'admin_grant',
      'refund',
      'entry',
    ]);
    const by = Object.fromEntries(s.tickets.map((t) => [t.reason, t]));
    expect(by.task_claim).toEqual({
      reason: 'task_claim',
      given: { current: 988, previous: 500 },
      spent: { current: 0, previous: 0 },
    });
    expect(by.admin_grant.given).toEqual({ current: 0, previous: 10 });
    expect(by.coin_flip.spent).toEqual({ current: 190, previous: 0 });
    expect(by.pack_spin.given).toEqual({ current: 0, previous: 0 });
  });

  it('keeps an unknown ticket reason after the known ones', () => {
    const cur = rows({ tickets: [{ reason: 'mystery', given: 1, spent: 0 }] });
    const s = luckyDrawSection(META, cur, null, [], 4.2);
    expect(s.tickets.at(-1)).toEqual({
      reason: 'mystery',
      given: { current: 1, previous: null },
      spent: { current: 0, previous: null },
    });
  });
});

describe('capsuleSlugsOf', () => {
  it('names every capsule a window sold or spun', () => {
    const a = rows({
      capsules: [{ slug: 'lucky-pack', full_sen: 1, bonus_sen: 0 }],
    });
    const b = rows({ spins: [{ slug: 'gold-capsule', n: 1 }] });
    expect(capsuleSlugsOf(a, null, b).sort()).toEqual([
      'gold-capsule',
      'lucky-pack',
    ]);
  });
});
