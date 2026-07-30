import {
  isForeignOffer,
  normalizeOffer,
  penniesToUsd,
} from '../collection-offers';
import {
  gradeForIncludeString,
  priceFieldForGrade,
} from '../../../../modules/packs/pricecharting-grades';

// The collection import writes market_value off the grade this mapper picks, so
// every label it returns MUST be one the price lookup + nightly sync can price.
// The tags below are the ones this account's live collection actually carries
// (measured over 9,000 offers, 2026-07-30) — not invented examples.
describe('gradeForIncludeString', () => {
  it('maps the per-grader 10s onto their own upstream fields', () => {
    expect(gradeForIncludeString('PSA 10')).toBe('PSA 10');
    expect(gradeForIncludeString('BGS 10')).toBe('BGS 10');
    expect(gradeForIncludeString('cgc 10')).toBe('CGC 10');
    expect(gradeForIncludeString('SGC 10')).toBe('SGC 10');
  });

  it('prices a BGS Black Label off plain BGS 10 — there is no black field', () => {
    expect(gradeForIncludeString('BGS 10 Black')).toBe('BGS 10');
  });

  it("treats a bare 10 and Gem Mint as PriceCharting's top tier", () => {
    expect(gradeForIncludeString('Grade 10')).toBe('PSA 10');
    expect(gradeForIncludeString('Graded 10')).toBe('PSA 10');
    expect(gradeForIncludeString('10')).toBe('PSA 10');
    expect(gradeForIncludeString('Gem Mint')).toBe('PSA 10');
  });

  // "Graded N" is the single most common graded tag upstream — PriceCharting
  // drops the grading company below its top-tier fields.
  it('prices sub-10 grades by number, whoever graded it', () => {
    expect(gradeForIncludeString('Graded 9')).toBe('Grade 9');
    expect(gradeForIncludeString('Graded 9.5')).toBe('Grade 9.5');
    expect(gradeForIncludeString('Graded 8')).toBe('Grade 8');
    expect(gradeForIncludeString('Graded 7')).toBe('Grade 7');
    expect(gradeForIncludeString('PSA 9')).toBe('Grade 9');
    expect(gradeForIncludeString('BGS 9.5')).toBe('Grade 9.5');
    expect(gradeForIncludeString('Grade 8.5')).toBe('Grade 8');
  });

  it('maps raw/ungraded tags to Ungraded', () => {
    expect(gradeForIncludeString('Ungraded')).toBe('Ungraded');
    expect(gradeForIncludeString('  raw ')).toBe('Ungraded');
  });

  it('returns null when no field prices that tag', () => {
    // ACE is a real grading company upstream with no PriceCharting price field;
    // "Graded 6/5/4" fall below the lowest field. The operator picks the tier
    // instead of the import guessing on a money field.
    expect(gradeForIncludeString('ACE 10')).toBeNull();
    expect(gradeForIncludeString('Graded 6')).toBeNull();
    expect(gradeForIncludeString('Graded 4')).toBeNull();
    expect(gradeForIncludeString('')).toBeNull();
    expect(gradeForIncludeString('Graded')).toBeNull();
  });

  it('leaves the video-game condition family alone', () => {
    // A collection also holds games; "Item, Box, and Manual" is a completeness
    // tag, not a card grade, and must not be mapped onto a card price tier.
    expect(gradeForIncludeString('Item only')).toBeNull();
    expect(gradeForIncludeString('Item, Box, and Manual')).toBeNull();
    expect(gradeForIncludeString('New Item, Box, and Manual')).toBeNull();
  });

  it('only ever returns labels the price lookup can resolve', () => {
    const tags = [
      'PSA 10',
      'BGS 10',
      'BGS 10 Black',
      'CGC 10',
      'SGC 10',
      'Gem Mint',
      'Graded 9',
      'Graded 9.5',
      'Graded 8',
      'Graded 7',
      'Ungraded',
    ];
    for (const tag of tags) {
      const label = gradeForIncludeString(tag);
      expect(label).not.toBeNull();
      expect(priceFieldForGrade(label as string)).not.toBeNull();
    }
  });
});

describe('penniesToUsd', () => {
  it('converts integer pennies from a number or a string', () => {
    expect(penniesToUsd(1999)).toBe(19.99);
    expect(penniesToUsd('1999')).toBe(19.99);
    expect(penniesToUsd('$1,999')).toBe(19.99);
  });

  it('tolerates padding and sub-cent values', () => {
    expect(penniesToUsd(' 1999 ')).toBe(19.99);
    // Upstream is integer pennies; a fractional one rounds rather than
    // producing a sub-cent price the money columns can't represent.
    expect(penniesToUsd(1.5)).toBe(0.02);
  });

  it('treats absent / zero / negative / junk as no price', () => {
    expect(penniesToUsd(0)).toBeNull();
    expect(penniesToUsd(null)).toBeNull();
    expect(penniesToUsd(undefined)).toBeNull();
    expect(penniesToUsd('abc')).toBeNull();
    // A negative valuation is not a price — it must read as "no price", never
    // as a negative money value flowing into the table.
    expect(penniesToUsd(-100)).toBeNull();
    expect(penniesToUsd(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe('isForeignOffer', () => {
  it('flags only an explicit false', () => {
    // A seller-less call comes back with every row false — that is the bug
    // signature. Absent is tolerated: a correctly-scoped response with rows in
    // it has never been observed (the collection is empty), so demanding
    // `=== true` could empty a page that is working fine.
    expect(isForeignOffer({ 'user-viewing-own-offers': false })).toBe(true);
    expect(isForeignOffer({ 'user-viewing-own-offers': true })).toBe(false);
    expect(isForeignOffer({})).toBe(false);
    expect(isForeignOffer({ 'user-viewing-own-offers': 'false' })).toBe(false);
  });
});

describe('normalizeOffer', () => {
  // Field-for-field the shape the live /api/offers returns (trimmed to the keys
  // the import uses — upstream rows carry ~60).
  const RAW = {
    'offer-id': 'f6zw6w3fjrq6crc7lkszv7uoci',
    id: 836945,
    'product-name': 'Charizard V #79',
    'console-name': "Pokemon Champion's Path",
    'include-string': 'Graded 9',
    'condition-string': 'Normal wear',
    value: 21500,
    price: 21500,
    'is-card': true,
    'image-url':
      'https://storage.googleapis.com/images.pricecharting.com/33q3lkcfqp3h4oxv/240.jpg',
  };

  it('normalizes a graded card offer', () => {
    expect(normalizeOffer(RAW)).toEqual({
      offer_id: 'f6zw6w3fjrq6crc7lkszv7uoci',
      product_id: '836945',
      name: 'Charizard V #79',
      set: "Pokemon Champion's Path",
      include: 'Graded 9',
      condition: 'Normal wear',
      value_usd: 215,
      grade: 'Grade 9',
      image:
        'https://storage.googleapis.com/images.pricecharting.com/33q3lkcfqp3h4oxv/240.jpg',
      is_card: true,
    });
  });

  it('drops an offer with no product id — it cannot be priced or linked', () => {
    expect(normalizeOffer({ ...RAW, id: undefined })).toBeNull();
    expect(normalizeOffer({ ...RAW, id: '  ' })).toBeNull();
  });

  it('drops an offer with no offer id — two holdings would collapse into one', () => {
    // The admin keys a row by offer_id. Without one, a second copy of the same
    // card at the same grade would share the first one's key, get deduped away
    // during the scan, and the units held would be undercounted.
    expect(normalizeOffer({ ...RAW, 'offer-id': undefined })).toBeNull();
    expect(normalizeOffer({ ...RAW, 'offer-id': '   ' })).toBeNull();
  });

  it('drops an offer id that is neither a string nor a finite number', () => {
    // String({}) is "[object Object]" — a key EVERY such row would share, so
    // the scan dedupe would fold distinct holdings into one and undercount.
    expect(normalizeOffer({ ...RAW, 'offer-id': {} })).toBeNull();
    expect(normalizeOffer({ ...RAW, 'offer-id': [] })).toBeNull();
    expect(normalizeOffer({ ...RAW, 'offer-id': true })).toBeNull();
    expect(normalizeOffer({ ...RAW, 'offer-id': Number.NaN })).toBeNull();
  });

  it('accepts a numeric offer id rather than emptying the page', () => {
    // Dropping numerically-keyed rows would render as "collection is empty",
    // indistinguishable from the operator's real empty-collection state.
    expect(normalizeOffer({ ...RAW, 'offer-id': 42 })?.offer_id).toBe('42');
  });

  it('falls back to the listed price when the valuation is absent', () => {
    expect(normalizeOffer({ ...RAW, value: undefined })?.value_usd).toBe(215);
    expect(
      normalizeOffer({ ...RAW, value: undefined, price: 0 })?.value_usd,
    ).toBeNull();
  });

  it('marks non-card holdings so the card storefront can filter them out', () => {
    expect(normalizeOffer({ ...RAW, 'is-card': false })?.is_card).toBe(false);
    expect(normalizeOffer({ ...RAW, 'is-card': undefined })?.is_card).toBe(
      false,
    );
  });

  it('leaves an unmappable grade tag null for the operator to pick', () => {
    expect(
      normalizeOffer({ ...RAW, 'include-string': 'ACE 10' })?.grade,
    ).toBeNull();
  });

  it('accepts only PriceCharting-hosted images', () => {
    // Anything else would be stored VERBATIM by the create step (it only
    // ingests PriceCharting URLs), i.e. hotlinked into the catalog.
    expect(
      normalizeOffer({ ...RAW, 'image-url': 'http://x/y.jpg' })?.image,
    ).toBeNull();
    expect(
      normalizeOffer({ ...RAW, 'image-url': 'https://evil.test/pwn.jpg' })
        ?.image,
    ).toBeNull();
    expect(
      normalizeOffer({
        ...RAW,
        'image-url': 'https://storage.googleapis.com/other-bucket/240.jpg',
      })?.image,
    ).toBeNull();
    expect(normalizeOffer({ ...RAW, 'image-url': 42 })?.image).toBeNull();
  });

  it('survives an offer missing every optional field', () => {
    expect(normalizeOffer({ id: 7, 'offer-id': 'o7' })).toEqual({
      offer_id: 'o7',
      product_id: '7',
      name: '',
      set: '',
      include: '',
      condition: '',
      value_usd: null,
      grade: null,
      image: null,
      is_card: false,
    });
  });
});
