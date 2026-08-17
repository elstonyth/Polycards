import { describe, expect, it } from 'vitest';
import {
  catalogGroupOf,
  groupPacks,
  inGuaranteedGroup,
  type Pack,
} from '@/lib/packs-data';

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

// Three-way catalog section membership — "Raw Cards (Ungraded)" must now
// claim only backend-derived all-raw pools; everything uncertain (MIX,
// non-PSA-10 graded, null/older-backend) lands in the claim-free bucket.
describe('catalogGroupOf', () => {
  it('places an all-PSA-10 graded pool in graded', () => {
    expect(catalogGroupOf(pack({ group: 'GRADED', psa10: true }))).toBe(
      'graded',
    );
  });

  it('places a backend-derived all-raw pool in raw', () => {
    expect(catalogGroupOf(pack({ group: 'RAW' }))).toBe('raw');
  });

  it('places a mixed pool in the claim-free bucket', () => {
    expect(catalogGroupOf(pack({ group: 'MIX' }))).toBe('more');
  });

  it('places a graded-but-not-PSA-10 pool in the claim-free bucket, not raw', () => {
    // Headline case: an all-graded PSA-9-poisoned pool must NOT be
    // mislabeled "Raw Cards (Ungraded)" — it is not raw at all.
    expect(catalogGroupOf(pack({ group: 'GRADED', psa10: false }))).toBe(
      'more',
    );
  });

  it('places a null/absent group (older backend, unknown composition) in the claim-free bucket', () => {
    expect(catalogGroupOf(pack({ group: null }))).toBe('more');
    expect(catalogGroupOf(pack({}))).toBe('more');
  });

  it('follows group === RAW alone, even with an inconsistent psa10:true payload', () => {
    // 'raw' is gated on the backend's own group derivation only — not a
    // second guess against psa10. If group says RAW, that pool has no
    // graded cards to be PSA-10 poisoned by in the first place.
    expect(catalogGroupOf(pack({ group: 'RAW', psa10: true }))).toBe('raw');
  });
});

// Sectioning used by the pack detail page's selector rails. The invariant that
// matters there: a pack that falls out of the grouping is a pack the customer
// can no longer switch to.
describe('groupPacks', () => {
  const graded = pack({ id: 'g', group: 'GRADED', psa10: true });
  const raw = pack({ id: 'r', group: 'RAW' });
  const mixed = pack({ id: 'm', group: 'MIX' });

  it('splits a mixed catalog into graded/raw/more, in that order', () => {
    // Input order is deliberately scrambled: section order comes from
    // CATALOG_GROUP_ORDER, not from where a pack sits in the list.
    expect(groupPacks([mixed, raw, graded])).toEqual([
      { id: 'graded', packs: [graded] },
      { id: 'raw', packs: [raw] },
      { id: 'more', packs: [mixed] },
    ]);
  });

  it('keeps every pack — nothing is dropped, no pack lands in two groups', () => {
    const packs = [
      graded,
      raw,
      mixed,
      pack({ id: 'p9', group: 'GRADED', psa10: false }),
      pack({ id: 'unknown' }),
    ];
    const ids = groupPacks(packs).flatMap((g) => g.packs.map((p) => p.id));
    expect(ids.slice().sort()).toEqual(
      packs
        .map((p) => p.id)
        .slice()
        .sort(),
    );
  });

  it('preserves the caller-given (backend rank) order within a group', () => {
    const a = pack({ id: 'a', group: 'RAW' });
    const b = pack({ id: 'b', group: 'RAW' });
    expect(groupPacks([b, a])).toEqual([{ id: 'raw', packs: [b, a] }]);
  });

  it('drops empty groups, so an all-graded catalog renders one section', () => {
    expect(groupPacks([graded]).map((g) => g.id)).toEqual(['graded']);
    expect(groupPacks([])).toEqual([]);
  });
});
