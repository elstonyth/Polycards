// @vitest-environment jsdom
// The module talks to sessionStorage, which the default node environment does
// not provide.
import { describe, expect, it, beforeEach } from 'vitest';
import {
  DEPOSIT_IN_FLIGHT_MAX_AGE_MS,
  markDepositInFlight,
  takeDepositInFlight,
} from '../deposit-return';

const NOW = Date.UTC(2026, 7, 11, 9, 4, 11);

describe('deposit-in-flight flag', () => {
  beforeEach(() => sessionStorage.clear());

  it('is false when no deposit was started', () => {
    expect(takeDepositInFlight(NOW)).toBe(false);
  });

  it('reports the return trip exactly once', () => {
    markDepositInFlight(NOW);

    // The poll window must not restart on a back-nav or a ?page= change.
    expect(takeDepositInFlight(NOW + 60_000)).toBe(true);
    expect(takeDepositInFlight(NOW + 60_000)).toBe(false);
  });

  it('ignores a stale flag from an abandoned payment', () => {
    markDepositInFlight(NOW);

    expect(takeDepositInFlight(NOW + DEPOSIT_IN_FLIGHT_MAX_AGE_MS + 1)).toBe(
      false,
    );
  });

  it('clears a stale flag rather than leaving it to fire later', () => {
    markDepositInFlight(NOW);
    takeDepositInFlight(NOW + DEPOSIT_IN_FLIGHT_MAX_AGE_MS + 1);

    expect(takeDepositInFlight(NOW)).toBe(false);
  });
});
