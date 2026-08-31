import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { FLAT_BUYBACK_PERCENT } from '@/lib/packs-data';
import { BUYBACK_RATE_LABEL } from '@/lib/buyback-copy';
import { SELL_COUNTDOWN_SECS } from '@/lib/sell-countdown';

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

// Line-anchored (`^\s*` + /m). Without the anchor `String.match` returns the
// first TEXTUAL hit, so a commented-out previous declaration left above the
// live one as rationale -- a habit this codebase has -- would be read instead,
// and the guard would go green on exactly the drift it exists to catch.
function backendFlatPercent(): number {
  const src = readFileSync(BACKEND_SRC, 'utf8');
  const m = src.match(/^\s*export const FLAT_PERCENT\s*=\s*(\d+(?:\.\d+)?)/m);
  if (!m) {
    throw new Error(
      `FLAT_PERCENT not found in ${BACKEND_SRC}. If it was renamed or moved, ` +
        `update this guard -- do not delete it.`,
    );
  }
  return Number(m[1]);
}

/** The backend's checked-in instant-window default, in ms. */
function backendDefaultWindowMs(): number {
  const src = readFileSync(BACKEND_SRC, 'utf8');
  const m = src.match(
    /^\s*(?:export\s+)?const DEFAULT_WINDOW_MS\s*=\s*(\d+)\s*\*\s*(\d+);/m,
  );
  if (!m) {
    throw new Error(
      `DEFAULT_WINDOW_MS not found in ${BACKEND_SRC}, or it is no longer ` +
        `written as a single product. If it was renamed, moved, or recomputed, ` +
        `update this guard -- do not delete it.`,
    );
  }
  return Number(m[1]) * Number(m[2]);
}

describe('buyback rate parity: storefront mirror vs backend truth', () => {
  it('storefront FLAT_BUYBACK_PERCENT matches backend FLAT_PERCENT', () => {
    expect(FLAT_BUYBACK_PERCENT).toBe(backendFlatPercent());
  });

  it('the marketing label quotes that same number', () => {
    expect(BUYBACK_RATE_LABEL).toContain(String(FLAT_BUYBACK_PERCENT));
  });

  it('the instant window is the same 30s the reveal counts down', () => {
    // SELL_COUNTDOWN_SECS drives both the reveal countdown and, since the offer
    // builder's fallback deadline derives from it, what the storefront assumes
    // when the open response omits instantDeadlineMs. Drift means the countdown
    // runs past the real deadline and the customer is shown the instant price
    // for a sell that credits the flat one.
    //
    // SCOPE: pins the checked-in DEFAULT only. The live window is env-tunable
    // (`instantWindowMs` reads BUYBACK_INSTANT_WINDOW_MS), so green here is NOT
    // proof the two agree in a given deployment.
    expect(SELL_COUNTDOWN_SECS * 1000).toBe(backendDefaultWindowMs());
  });

  it('never quotes a rate above the guaranteed floor', () => {
    // Understating is safe (a pack may pay more in-window); overstating is a
    // false promise. Catch any digits in the label that exceed the floor.
    for (const n of BUYBACK_RATE_LABEL.match(/\d+(?:\.\d+)?/g) ?? []) {
      expect(Number(n)).toBeLessThanOrEqual(FLAT_BUYBACK_PERCENT);
    }
  });
});
