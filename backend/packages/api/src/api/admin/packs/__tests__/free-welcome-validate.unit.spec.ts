import { assertSingleActiveFreePack, coercePackBody } from '../validate';
import { FREE_WELCOME_CATEGORY } from '../../../../modules/packs/free-pack';

// The free welcome pack is an ordinary Pack in a RESERVED category, so the two
// invariants that make it "the free pack" live in admin validation, not in the
// schema: it is FREE (price 0) and there is at most ONE active at a time.
const base = {
  title: 'Free Welcome Pack',
  category: FREE_WELCOME_CATEGORY,
  price: 0,
  image: '/images/free.webp',
  buyback_percent: 90,
  boost: false,
  rank: 0,
  status: 'active',
};

describe('coercePackBody — free_welcome price', () => {
  it('rejects a priced free_welcome pack', () => {
    expect(() => coercePackBody({ ...base, price: 10 }, 'fw')).toThrow(/price/i);
  });

  it('rejects a stringly-typed non-zero price too', () => {
    expect(() => coercePackBody({ ...base, price: '0.01' }, 'fw')).toThrow(
      /price/i,
    );
  });

  it('accepts a price-0 free_welcome pack', () => {
    expect(coercePackBody({ ...base, price: 0 }, 'fw').category).toBe(
      FREE_WELCOME_CATEGORY,
    );
  });

  it('leaves priced packs in every OTHER category alone', () => {
    expect(
      coercePackBody({ ...base, category: 'pokemon', price: 10 }, 'fw').price,
    ).toBe(10);
  });

  // The money gate, not tidiness: chargePackOpenStep skips the debit at price 0
  // and open-pack stamps source='pack' on every non-free-category open — which
  // is what hasPaidOpen() reads to unlock the free welcome pull. An RM0 pack in
  // a normal category would hand out that unlock for nothing.
  it('rejects an RM0 pack in a NORMAL category', () => {
    expect(() =>
      coercePackBody({ ...base, category: 'pokemon', price: 0 }, 'fw'),
    ).toThrow(/only the free welcome pack/i);
  });

  it('rejects an omitted price in a normal category (defaults to 0)', () => {
    expect(() =>
      coercePackBody({ ...base, category: 'pokemon', price: undefined }, 'fw'),
    ).toThrow(/only the free welcome pack/i);
  });
});

describe('assertSingleActiveFreePack', () => {
  const incoming = {
    slug: 'fw2',
    category: FREE_WELCOME_CATEGORY,
    status: 'active',
  };

  it('rejects activating a SECOND free_welcome pack', () => {
    expect(() => assertSingleActiveFreePack('free-welcome', incoming)).toThrow(
      /one active/i,
    );
  });

  it('allows re-saving the SAME active free pack', () => {
    expect(() =>
      assertSingleActiveFreePack('free-welcome', {
        ...incoming,
        slug: 'free-welcome',
      }),
    ).not.toThrow();
  });

  it('allows a second free pack saved as DRAFT', () => {
    expect(() =>
      assertSingleActiveFreePack('free-welcome', {
        ...incoming,
        status: 'draft',
      }),
    ).not.toThrow();
  });

  it('allows the FIRST active free pack (nothing active yet)', () => {
    expect(() => assertSingleActiveFreePack(null, incoming)).not.toThrow();
  });

  it('ignores packs in other categories', () => {
    expect(() =>
      assertSingleActiveFreePack('free-welcome', {
        ...incoming,
        category: 'pokemon',
      }),
    ).not.toThrow();
  });
});
