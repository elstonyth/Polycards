import { describe, expect, test } from 'vitest';
import { shouldSeedBuffer } from './seed-buffer';

describe('shouldSeedBuffer', () => {
  test('does not seed before data has loaded', () => {
    expect(shouldSeedBuffer(null, undefined)).toBe(false);
    expect(shouldSeedBuffer(undefined, undefined)).toBe(false);
  });

  test('seeds once when nothing has been seeded yet', () => {
    expect(shouldSeedBuffer({ id: 1 }, undefined)).toBe(true);
  });

  test('does NOT reseed on a fresh data identity once seeded (the regression)', () => {
    const seeded = { id: 1 };
    // A background refetch: same logical data, brand-new object reference.
    // The old `data !== seeded` guard returned true here and wiped edits.
    expect(shouldSeedBuffer({ id: 1 }, seeded)).toBe(false);
  });

  test('reseeds when the seeded snapshot is stale (e.g. slug switch)', () => {
    const seeded = { slug: 'a' };
    const isStale = (s: { slug: string }) => s.slug !== 'b';
    expect(shouldSeedBuffer({ slug: 'b' }, seeded, isStale)).toBe(true);
  });

  test('stays seeded when isStale reports the snapshot is still current', () => {
    const seeded = { slug: 'b' };
    const isStale = (s: { slug: string }) => s.slug !== 'b';
    expect(shouldSeedBuffer({ slug: 'b' }, seeded, isStale)).toBe(false);
  });

  test('never seeds from null data even when isStale would be true', () => {
    const isStale = () => true;
    expect(shouldSeedBuffer(null, { slug: 'a' }, isStale)).toBe(false);
  });
});
