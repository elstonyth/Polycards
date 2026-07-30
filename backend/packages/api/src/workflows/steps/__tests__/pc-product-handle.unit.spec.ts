import { buildPcProductHandle } from '../create-product-from-pricecharting';

// The handle is the uniqueness key for a from-PriceCharting product (the SKU is
// derived from it), so two holdings that are genuinely different items must not
// produce the same one — and two imports of the SAME item must.
const H = (grader: string, grade: string, pc_grade: string) =>
  buildPcProductHandle({
    name: 'Charizard V #79',
    grader,
    grade,
    pc_grade,
    pc_product_id: '836945',
  });

describe('buildPcProductHandle', () => {
  it('separates generic tiers of the same card', () => {
    // The regression this exists for: PriceCharting drops the grading company
    // below its top-tier fields, so "Graded 9" imports grader-less — and before
    // the tier fallback it slugged identically to "Ungraded", making the second
    // create fail on the unique handle/sku index mid-batch.
    const ungraded = H('', '', 'Ungraded');
    const graded9 = H('', '', 'Grade 9');
    const graded8 = H('', '', 'Grade 8');

    expect(new Set([ungraded, graded9, graded8]).size).toBe(3);
    expect(graded9).toBe('charizard-v-79-grade-9-836945');
  });

  it('is stable for the same holding — re-importing must still collide', () => {
    // The unique index is also the idempotency guard: adding the same card at
    // the same tier twice should fail, not silently mint a duplicate product.
    expect(H('', '', 'Grade 9')).toBe(H('', '', 'Grade 9'));
    expect(H('PSA', '10', 'PSA 10')).toBe(H('PSA', '10', 'PSA 10'));
  });

  it('keeps the pre-existing shape when a grader was asserted', () => {
    // Byte-identical to the old `name-grader-grade-id` formula, so products
    // already in the catalog keep resolving to their handle.
    expect(H('PSA', '10', 'PSA 10')).toBe('charizard-v-79-psa-10-836945');
    expect(H('BGS', '9', 'Grade 9')).toBe('charizard-v-79-bgs-9-836945');
  });

  it('keeps the pre-existing shape for a legacy grade without a grader', () => {
    // Catalog rows exist in this shape (e.g. pikachu-227-s-p-9-5-4199649).
    expect(H('', '9.5', 'Grade 9.5')).toBe('charizard-v-79-9-5-836945');
  });

  it('separates two different cards that share a tier', () => {
    const a = buildPcProductHandle({
      name: 'Pikachu ex #238',
      grader: '',
      grade: '',
      pc_grade: 'Ungraded',
      pc_product_id: '111',
    });
    const b = buildPcProductHandle({
      name: 'Pikachu ex #238',
      grader: '',
      grade: '',
      pc_grade: 'Ungraded',
      pc_product_id: '222',
    });
    expect(a).not.toBe(b);
  });
});
