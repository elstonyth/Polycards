import { describe, it, expect } from 'vitest';
import {
  actionFailure,
  isLoggedOut,
  COPY,
  UNAUTHORIZED,
  type ErrorRule,
} from '@/lib/errors';
import type { Failure } from '@/lib/store-port';

// The one translator from a port `Failure` to an action's `{ ok: false }`
// answer. It owns the branch order and the result SHAPE; the copy stays with
// each caller. `toStrictEqual` throughout: a missing `needsAuth` key and
// `needsAuth: undefined` are different answers here, and `toEqual` would not
// tell them apart.
const fail = (
  kind: Failure['kind'],
  text: string,
  status?: number,
): Failure => ({ ok: false, kind, status, text });

const LOGGED_OUT = 'Log in to see this.';
const FALLBACK = 'Nothing matched.';
const RULES: ErrorRule[] = [
  [/not enough credits/i, 'Top up first.'],
  [UNAUTHORIZED, 'Your session ended.'],
];
const map = (f: Failure, unexpected?: string) =>
  actionFailure(f, {
    loggedOut: LOGGED_OUT,
    rules: RULES,
    fallback: FALLBACK,
    unexpected,
  });

describe('isLoggedOut', () => {
  it.each<[string, Failure, boolean]>([
    [
      'no cookie: the call never left',
      fail('unauthenticated', 'Not authenticated.'),
      true,
    ],
    ['a real 401', fail('unauthenticated', 'Unauthorized', 401), false],
    ['statusless non-auth failure', fail('backend', 'socket hang up'), false],
    [
      'invalid shape',
      fail('invalid_shape', 'Unexpected response shape.'),
      false,
    ],
  ])('%s', (_, f, expected) => {
    expect(isLoggedOut(f)).toBe(expected);
  });
});

describe('actionFailure', () => {
  it.each<[string, Failure, ReturnType<typeof actionFailure>]>([
    [
      'no cookie gives the caller logged-out copy and needsAuth',
      fail('unauthenticated', 'Not authenticated.'),
      { ok: false, error: LOGGED_OUT, needsAuth: true },
    ],
    [
      'a 401 the rules match keeps the rule copy and needsAuth',
      fail('unauthenticated', 'Unauthorized', 401),
      { ok: false, error: 'Your session ended.', needsAuth: true },
    ],
    [
      // Text-keyed on purpose (errors.ts, friendlyFailure): a 401 whose body
      // says nothing about auth reads as the fallback, still with needsAuth.
      "a 401 'Invalid token.' reads as the fallback",
      fail('unauthenticated', 'Invalid token.', 401),
      { ok: false, error: FALLBACK, needsAuth: true },
    ],
    [
      'a 2xx that failed its schema gives the unexpected copy, no needsAuth key',
      fail('invalid_shape', 'Unexpected response shape.'),
      { ok: false, error: COPY.unexpected },
    ],
    [
      'a 429 gets the shared transport copy',
      fail('rate_limited', 'Too many requests.', 429),
      { ok: false, error: COPY.rateLimited, needsAuth: false },
    ],
    [
      'a caller rule beats the transport tier and the fallback',
      fail('backend', 'Not enough credits.', 400),
      { ok: false, error: 'Top up first.', needsAuth: false },
    ],
    [
      'an unmatched 500 gives the fallback',
      fail('backend', 'Internal error', 500),
      { ok: false, error: FALLBACK, needsAuth: false },
    ],
    [
      'a statusless network failure gives the fallback',
      fail('backend', 'socket hang up'),
      { ok: false, error: FALLBACK, needsAuth: false },
    ],
  ])('%s', (_, f, expected) => {
    expect(map(f)).toStrictEqual(expected);
  });

  it('lets a caller word its own unexpected-response copy', () => {
    expect(
      map(
        fail('invalid_shape', 'Unexpected response shape.'),
        'Could not load the bank list.',
      ),
    ).toStrictEqual({ ok: false, error: 'Could not load the bank list.' });
  });

  it('checks logged out before the rules, even when a rule would match', () => {
    // The no-cookie text is 'Not authenticated.', which UNAUTHORIZED matches.
    expect(map(fail('unauthenticated', 'Not authenticated.')).error).toBe(
      LOGGED_OUT,
    );
  });
});
