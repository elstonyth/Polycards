import { describe, expect, it } from 'vitest';
import { inGuaranteedGroup, type Pack } from '@/lib/packs-data';

// Membership rule for the "Graded (Guaranteed PSA 10)" catalog section — the
// truth-critical gate (real-money guarantee copy). Both backend flags must
// pass; every degraded/older-backend shape must land OUTSIDE the guarantee.

const pack = (over: Partial<Pack>): Pack => ({
  id: 'p',
  name: 'P',
  price: 'RM 10',
  priceValue: 10,
  image: '/x.webp',
  ...over,
});

describe('inGuaranteedGroup', () => {
  it('admits only all-graded + all-PSA-10 pools', () => {
    expect(inGuaranteedGroup(pack({ group: 'GRADED', psa10: true }))).toBe(
      true,
    );
  });

  it('rejects everything else — RAW, MIX, empty, PSA-9 poison, older backend', () => {
    // All-graded but a PSA 9 (or BGS) in the pool: graded ≠ guaranteed.
    expect(inGuaranteedGroup(pack({ group: 'GRADED', psa10: false }))).toBe(
      false,
    );
    expect(inGuaranteedGroup(pack({ group: 'RAW', psa10: false }))).toBe(false);
    expect(inGuaranteedGroup(pack({ group: 'MIX', psa10: false }))).toBe(false);
    expect(inGuaranteedGroup(pack({ group: null, psa10: false }))).toBe(false);
    // Older backend: both fields absent.
    expect(inGuaranteedGroup(pack({}))).toBe(false);
    // Inconsistent payload (psa10 without group) still fails the group gate.
    expect(inGuaranteedGroup(pack({ psa10: true }))).toBe(false);
  });
});
