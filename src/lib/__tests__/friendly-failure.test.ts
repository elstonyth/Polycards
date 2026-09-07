import { describe, it, expect } from 'vitest';
import {
  friendlyFailure,
  COPY,
  UNAUTHORIZED,
  type ErrorRule,
} from '@/lib/errors';
import type { Failure } from '@/lib/store-port';

// The transport tier: the copy every surface shares for a failure about the
// CONNECTION rather than the domain. This suite is the single place those two
// sentences are pinned — the per-action tables used to re-declare both the
// probe and the message, and drifted (see the module comment in errors.ts).
const fail = (
  kind: Failure['kind'],
  text: string,
  status?: number,
): Failure => ({ ok: false, kind, status, text });

const FALLBACK = 'Nothing matched.';
const map = (f: Failure, rules: readonly ErrorRule[] = []) =>
  friendlyFailure(f, rules, FALLBACK);

describe('friendlyFailure resolution order', () => {
  it('runs the caller domain rules first, on the failure text', () => {
    const rules: ErrorRule[] = [[/not enough credits/i, 'Top up first.']];
    expect(map(fail('backend', 'Not enough credits.', 400), rules)).toBe(
      'Top up first.',
    );
  });

  it('lets a domain rule override the shared transport copy', () => {
    // What packs and profile-appearance do: same probe, their own sentence.
    const rules: ErrorRule[] = [
      [/too many|rate.?limit|429/i, "You're opening packs too fast."],
    ];
    expect(map(fail('rate_limited', 'Too many pack opens.', 429), rules)).toBe(
      "You're opening packs too fast.",
    );
    expect(map(fail('rate_limited', 'Too many pack opens.', 429))).toBe(
      COPY.rateLimited,
    );
  });

  it('answers a rate limit with the shared copy', () => {
    expect(map(fail('rate_limited', 'Too many requests.', 429))).toBe(
      COPY.rateLimited,
    );
    // The memory adapter's bodyless form, and a raw provider phrasing.
    expect(map(fail('rate_limited', 'HTTP 429', 429))).toBe(COPY.rateLimited);
    expect(map(fail('rate_limited', 'rate limit exceeded', 429))).toBe(
      COPY.rateLimited,
    );
  });

  it('answers an expired session with the shared login prompt', () => {
    expect(map(fail('unauthenticated', 'Unauthorized', 401))).toBe(
      COPY.loginRequired,
    );
    expect(map(fail('unauthenticated', 'HTTP 401', 401))).toBe(
      COPY.loginRequired,
    );
    // No cookie at all — the call never left, so there is no status.
    expect(map(fail('unauthenticated', 'Not authenticated.'))).toBe(
      COPY.loginRequired,
    );
  });

  // THE reason the transport tier matches TEXT and not `f.kind`. Recorded on
  // this branch by actions/__tests__/wallet.test.ts: "a 401 whose body says
  // nothing about auth reads as the generic fallback, as it always has". A
  // kind-keyed table would answer it with a login prompt instead.
  it('leaves a 401 that says nothing about auth on the caller fallback', () => {
    expect(map(fail('unauthenticated', 'Invalid token.', 401))).toBe(FALLBACK);
  });

  it('leaves every other kind on the caller fallback', () => {
    // `backend` deliberately has NO shared entry: the fallback is the caller's
    // own sentence (packs: "Could not open the pack. Please try again.").
    expect(map(fail('backend', 'boom', 500))).toBe(FALLBACK);
    expect(map(fail('not_found', 'HTTP 404', 404))).toBe(FALLBACK);
    expect(map(fail('invalid_shape', 'Unexpected response shape.'))).toBe(
      FALLBACK,
    );
  });

  it('exports the probes so no table re-declares them', () => {
    expect(UNAUTHORIZED.test('Unauthorized')).toBe(true);
    expect(UNAUTHORIZED.test('not authenticated')).toBe(true);
    expect(UNAUTHORIZED.test('HTTP 401')).toBe(true);
    expect(UNAUTHORIZED.test('Invalid token.')).toBe(false);
  });
});
