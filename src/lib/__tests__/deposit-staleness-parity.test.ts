import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The storefront's DEPOSIT_OVERDUE_MS decides when a pending top-up stops
// rendering as "confirming" and starts pointing the customer at support. The
// backend's GLOBEPAY_STALE_AFTER_MS is when that same deposit stops being
// served at all and the sweep may expire it. Only a comment links them
// ("Mirrors the backend's GLOBEPAY_STALE_AFTER_MS"), so a one-sided edit either
// leaves a page claiming to confirm a deposit nobody is chasing any more, or
// sends the customer to support while the sweep is still working on it.
//
// Unlike buyback-parity/delivery-fee-parity, BOTH sides are read as source
// text: the storefront copy is a bare `const` inside a `'use server'` module,
// which may only export async functions, so there is nothing to import. The
// backend is a separate package with its own tsconfig and is not on this
// project's module graph either.
const STOREFRONT_SRC = join(process.cwd(), 'src/lib/actions/vault.ts');
const BACKEND_SRC = join(
  process.cwd(),
  'backend/packages/api/src/modules/packs/globepay-reconcile.ts',
);

/**
 * A guard that silently passes when its regex stops matching is worse than no
 * guard, so this throws instead of returning a default. Both constants are
 * written as a product (`60 * 60 * 1000`), so the whole right-hand side is
 * captured and multiplied out -- capturing a fixed number of factors would read
 * `60 * 60 * 1000` as 3600, and a two-factor bug would return 3600 on BOTH
 * sides and still compare equal.
 *
 * Line-anchored (`^\s*` + /m): unanchored, `String.match` returns the first
 * TEXTUAL hit, so a commented-out previous declaration left above the live one
 * would be read instead and the guard would go green on real drift.
 */
function msConst(src: string, name: string): number {
  const expr = src.match(
    new RegExp(`^\\s*(?:export\\s+)?const ${name}\\s*=\\s*([^;]+);`, 'm'),
  )?.[1];
  if (expr === undefined || !/^[\d\s*]+$/.test(expr)) {
    throw new Error(
      `${name} not found, or no longer a plain millisecond product. If it was ` +
        `renamed, moved, or is now computed, update this guard -- do not ` +
        `delete it.`,
    );
  }
  return expr.split('*').reduce((product, factor) => product * +factor, 1);
}

describe('deposit staleness parity: storefront mirror vs backend truth', () => {
  it('storefront DEPOSIT_OVERDUE_MS matches backend GLOBEPAY_STALE_AFTER_MS', () => {
    const storefront = msConst(
      readFileSync(STOREFRONT_SRC, 'utf8'),
      'DEPOSIT_OVERDUE_MS',
    );
    // Guard the guard: two zero reads would agree with each other.
    expect(storefront).toBeGreaterThan(0);
    expect(storefront).toBe(
      msConst(readFileSync(BACKEND_SRC, 'utf8'), 'GLOBEPAY_STALE_AFTER_MS'),
    );
  });

  // The one extractor bug the assertion above cannot catch: both sides read
  // `60 * 60 * 1000`, so dropping the third factor returns 3600 on each and the
  // equality still passes.
  it('multiplies every factor, not just the first two', () => {
    expect(msConst('const X_MS = 60 * 60 * 1000;\n', 'X_MS')).toBe(3_600_000);
  });

  // Unanchored, this would read the commented-out 30 minutes and go green.
  it('reads the live declaration, not a commented-out one above it', () => {
    expect(
      msConst(
        '// const X_MS = 30 * 60 * 1000;\nconst X_MS = 60 * 60 * 1000;\n',
        'X_MS',
      ),
    ).toBe(3_600_000);
  });
});
