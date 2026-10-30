import { coercePackBody } from '../validate';
import { coerceTicketPrizeEntries } from '../[slug]/ticket-prizes/route';
import { FREE_WELCOME_CATEGORY } from '../../../../modules/packs/free-pack';

const base = {
  title: 'Lucky Pack',
  category: 'poly',
  price: 10,
  image: '/images/lucky.webp',
  buyback_percent: 90,
  boost: false,
  rank: 0,
  status: 'draft',
};

describe('coercePackBody prize_type', () => {
  it('leaves it undefined when absent, so an update keeps the stored type', () => {
    expect(coercePackBody(base, 'lucky').prize_type).toBeUndefined();
  });

  it('accepts the two types and refuses anything else', () => {
    expect(
      coercePackBody({ ...base, prize_type: 'tickets' }, 'lucky').prize_type,
    ).toBe('tickets');
    expect(
      coercePackBody({ ...base, prize_type: 'cards' }, 'lucky').prize_type,
    ).toBe('cards');
    expect(() =>
      coercePackBody({ ...base, prize_type: 'coins' }, 'lucky'),
    ).toThrow(/prize_type/);
  });

  it.each([FREE_WELCOME_CATEGORY, 'reward_box'])(
    "refuses tickets in the '%s' category, which is never bought",
    (category) => {
      expect(() =>
        coercePackBody(
          { ...base, category, price: 0, prize_type: 'tickets' },
          'lucky',
        ),
      ).toThrow(/ticket/i);
    },
  );
});

const row = (tickets: unknown, extra: Record<string, unknown> = {}) => ({
  tickets,
  rarity: 'Common',
  locked: false,
  pct: 0,
  pct_2: null,
  pct_3: null,
  ...extra,
});

describe('coerceTicketPrizeEntries', () => {
  it('keys each row by its amount and keeps the rates', () => {
    expect(
      coerceTicketPrizeEntries([
        row(100, { rarity: 'Rare', locked: true, pct: 2.5, pct_2: 1 }),
      ]),
    ).toEqual([
      {
        card_id: 'tickets-100',
        rarity: 'Rare',
        locked: true,
        pct: 2.5,
        pct_2: 1,
        pct_3: null,
      },
    ]);
  });

  it('needs an array of rows', () => {
    expect(() => coerceTicketPrizeEntries(undefined)).toThrow(/rows/);
    expect(() => coerceTicketPrizeEntries([null])).toThrow(/tickets/);
  });

  it.each([0, -5, 1.5, '100', null, 2_147_483_648])(
    'refuses %p as an amount',
    (tickets) => {
      expect(() => coerceTicketPrizeEntries([row(tickets)])).toThrow(/tickets/);
    },
  );

  it('refuses the same amount twice', () => {
    expect(() => coerceTicketPrizeEntries([row(100), row(100)])).toThrow(
      /100.*once/,
    );
  });

  it('applies the odds route rules to everything else', () => {
    expect(() =>
      coerceTicketPrizeEntries([row(100, { rarity: 'Shiny' })]),
    ).toThrow(/rarity/);
    expect(() =>
      coerceTicketPrizeEntries([row(100, { locked: 'yes' })]),
    ).toThrow(/locked/);
    expect(() =>
      coerceTicketPrizeEntries([row(100, { pct: 'abc' })]),
    ).toThrow(/pct/);
    expect(() =>
      coerceTicketPrizeEntries([row(100, { pct_2: '5' })]),
    ).toThrow(/pct_2/);
  });
});
