import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { FLAT_BUYBACK_PERCENT } from '@/lib/packs-data';
import { BUYBACK_RATE_LABEL } from '@/lib/buyback-copy';

// FLAT_BUYBACK_PERCENT is a hand-copied mirror of the backend's FLAT_PERCENT,
// and BUYBACK_RATE_LABEL is quoted as a guarantee on public marketing pages.
// If the backend rate ever moves and the mirror does not, the storefront makes
// a false money promise. Nothing else links the two files, so read the backend
// constant from source rather than importing it (the backend is a separate
// package with its own tsconfig, not on this project's module graph).
const BACKEND_SRC = join(
  process.cwd(),
  'backend/packages/api/src/modules/packs/buyback-rate.ts',
);

function backendFlatPercent(): number {
  const src = readFileSync(BACKEND_SRC, 'utf8');
  const m = src.match(/export const FLAT_PERCENT\s*=\s*(\d+(?:\.\d+)?)/);
  if (!m) {
    throw new Error(
      `FLAT_PERCENT not found in ${BACKEND_SRC}. If it was renamed or moved, ` +
        `update this guard -- do not delete it.`,
    );
  }
  return Number(m[1]);
}

describe('buyback rate parity: storefront mirror vs backend truth', () => {
  it('storefront FLAT_BUYBACK_PERCENT matches backend FLAT_PERCENT', () => {
    expect(FLAT_BUYBACK_PERCENT).toBe(backendFlatPercent());
  });

  it('the marketing label quotes that same number', () => {
    expect(BUYBACK_RATE_LABEL).toContain(String(FLAT_BUYBACK_PERCENT));
  });

  it('never quotes a rate above the guaranteed floor', () => {
    // Understating is safe (a pack may pay more in-window); overstating is a
    // false promise. Catch any digits in the label that exceed the floor.
    for (const n of BUYBACK_RATE_LABEL.match(/\d+(?:\.\d+)?/g) ?? []) {
      expect(Number(n)).toBeLessThanOrEqual(FLAT_BUYBACK_PERCENT);
    }
  });
});
