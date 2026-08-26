import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  EAST_PLACE_RE,
  EAST_SHIPPING_MYR,
  INSURANCE_RATE,
  isEastMalaysiaPostcode,
  PROTECTION_INCLUDED_MYR,
  WEST_SHIPPING_MYR,
} from '@/lib/delivery-fee';

// src/lib/delivery-fee.ts is a hand-copied mirror of the backend's shipping-fee
// math: the customer is QUOTED the storefront copy and the wallet is DEBITED
// from the backend copy. Nothing but a comment ("keep the two in sync when
// rates change") links them, so a one-sided edit quotes one number and charges
// another with both suites green. Read the backend constants from source rather
// than importing them — the backend is a separate package with its own tsconfig,
// not on this project's module graph (same technique as buyback-parity.test.ts).
const BACKEND_SRC = join(
  process.cwd(),
  'backend/packages/api/src/modules/packs/delivery.ts',
);

const renamed = (what: string) =>
  new Error(
    `${what} not found in ${BACKEND_SRC}. If it was renamed or moved, ` +
      `update this guard -- do not delete it.`,
  );

/** A guard that silently passes when its regex stops matching is worse than no
 *  guard, so every extractor below throws instead of returning a default. */
export function backendNumber(src: string, name: string): number {
  const m = src.match(
    new RegExp(`export const ${name}\\s*=\\s*(\\d+(?:\\.\\d+)?)`),
  );
  if (!m) throw renamed(name);
  return Number(m[1]);
}

export function backendEastPlaceSource(src: string): string {
  // Declared over two lines and NOT exported on the backend side, so this
  // cannot reuse the `export const` shape above.
  const m = src.match(/const EAST_PLACE_RE\s*=\s*\/(.+)\/i;/);
  if (!m) throw renamed('EAST_PLACE_RE');
  return m[1]!;
}

export function backendPostcodeBand(src: string): [number, number] {
  const m = src.match(/n >= (\d+) && n <= (\d+)/);
  if (!m) throw renamed('the East Malaysia postcode band');
  return [Number(m[1]), Number(m[2])];
}

const backendSrc = () => readFileSync(BACKEND_SRC, 'utf8');

describe('delivery fee parity: storefront mirror vs backend truth', () => {
  it.each([
    ['WEST_SHIPPING_MYR', WEST_SHIPPING_MYR],
    ['EAST_SHIPPING_MYR', EAST_SHIPPING_MYR],
    ['PROTECTION_INCLUDED_MYR', PROTECTION_INCLUDED_MYR],
    ['INSURANCE_RATE', INSURANCE_RATE],
  ])('storefront %s matches the backend literal', (name, mirrored) => {
    expect(mirrored).toBe(backendNumber(backendSrc(), name));
  });

  it('EAST_PLACE_RE is character-identical on both sides', () => {
    const backend = backendEastPlaceSource(backendSrc());
    // Guard the guard: an extractor that matched an empty string would make
    // every comparison below pass vacuously.
    expect(backend.length).toBeGreaterThan(20);
    expect(EAST_PLACE_RE.source).toBe(backend);
  });

  it('the East Malaysia postcode band matches the backend', () => {
    const [lo, hi] = backendPostcodeBand(backendSrc());
    // Asserted through the storefront's own function rather than its source
    // text, so a change to either side's arithmetic trips this.
    expect(isEastMalaysiaPostcode(String(lo))).toBe(true);
    expect(isEastMalaysiaPostcode(String(lo - 1))).toBe(false);
    expect(isEastMalaysiaPostcode(String(hi))).toBe(true);
    expect(isEastMalaysiaPostcode(String(hi + 1))).toBe(false);
  });
});

// The extractors are the load-bearing half of this file: if one stops matching
// and returns a default instead of throwing, the parity assertions above go
// green on a mirror that has actually drifted.
describe('the parity extractors fail loudly rather than silently', () => {
  const EMPTY = '// the constant was renamed\n';

  it('backendNumber throws when the constant is gone', () => {
    expect(() => backendNumber(EMPTY, 'WEST_SHIPPING_MYR')).toThrow(
      /do not delete it/,
    );
  });

  it('backendEastPlaceSource throws when the regex is gone', () => {
    expect(() => backendEastPlaceSource(EMPTY)).toThrow(/do not delete it/);
  });

  it('backendPostcodeBand throws when the band is gone', () => {
    expect(() => backendPostcodeBand(EMPTY)).toThrow(/do not delete it/);
  });
});
