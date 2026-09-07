/**
 * Shared mechanism for turning a backend/transport error into safe UI copy.
 *
 * Each caller passes its OWN ordered rules + fallback — the patterns and the
 * messages stay local to the action (an action's error vocabulary is its own),
 * only the text-extract + first-match loop is shared. This dedupes the four
 * near-identical `friendlyError` helpers without merging their pattern sets
 * (a shared union table would change which message a given error maps to).
 *
 * NEVER surface raw error text to the UI — always go through here.
 *
 * `httpStatus` is the non-prose half: the SDK's `FetchError` carries the real
 * status code, so control flow (a 401 that must reopen the login sheet, a 404
 * that must render "not found") reads THAT rather than guessing from a message.
 * Only the COPY still matches on text, and only against each caller's own rules.
 *
 * Imports the `FetchError` class but never `@/lib/medusa` — this module must
 * stay free of the SDK singleton so tests that touch it need no sdk mock. The
 * same goes for `StoreError`: it comes from src/lib/store-port.ts, which has no
 * runtime imports of its own, not from the port's HTTP adapter.
 */
import { FetchError } from '@medusajs/js-sdk';
import { StoreError, type Failure } from '@/lib/store-port';

/**
 * A [pattern, message] pair: if `test` matches the error text, return
 * `message` — or, when the backend's own wording is the right answer (it
 * carries figures the storefront cannot know), a function of that text.
 */
export type ErrorRule = readonly [
  test: RegExp,
  message: string | ((text: string) => string),
];

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** First matching rule's message, else the fallback. */
export function friendlyError(
  error: unknown,
  rules: readonly ErrorRule[],
  fallback: string,
): string {
  const text = errorText(error);
  for (const [test, message] of rules) {
    if (test.test(text))
      return typeof message === 'function' ? message(text) : message;
  }
  return fallback;
}

/**
 * Copy every surface shares for a TRANSPORT failure — one about the
 * connection, not the domain.
 *
 * `rateLimited` was spelled out by six rules tables and `generic` by eight
 * fallback constants, which is how packs.ts and profile-appearance.ts came to
 * word the SAME 429 three different ways without anyone noticing. Declared
 * here once now, and consumed either through `friendlyFailure` (the first
 * two) or as a caller's `fallback` (the third).
 *
 * These are the shared sentences, not the only ones: a surface with its own
 * word for a transport failure keeps it (see `RATE_LIMITED`/`UNAUTHORIZED`).
 */
export const COPY = {
  rateLimited: 'Too many requests — give it a moment and try again.',
  loginRequired: 'Please log in first.',
  generic: 'Something went wrong. Please try again.',
} as const;

/**
 * The two transport probes, declared ONCE.
 *
 * A surface that words a transport failure its own way still keeps that
 * sentence — the copy is its domain, only the pattern was duplicated — so it
 * pairs the shared probe with its own message in its own rules table
 * (packs.ts, profile-appearance.ts, wallet.ts, vip.ts, customer.ts,
 * delivery-errors.ts, vault-errors.ts). Everyone else drops the rule and lets
 * `friendlyFailure` answer.
 */
export const RATE_LIMITED = /too many|rate.?limit|429/i;
export const UNAUTHORIZED = /unauthorized|not authenticated|401/i;

/**
 * The shared transport tier — consulted only after the caller's own rules.
 *
 * Matched on the failure TEXT rather than keyed on `f.kind`, deliberately.
 * `kind` is the authoritative classification and keying on it would be tidier,
 * but it is strictly WIDER than the text probe and that difference is pinned
 * behaviour: actions/__tests__/wallet.test.ts records that "a 401 whose body
 * says nothing about auth reads as the generic fallback, as it always has"
 * (e.g. `{ status: 401, message: 'Invalid token.' }`). A kind-keyed table
 * would answer that with a login prompt instead. Widen it only as a deliberate
 * copy change, with those expectations updated in the same commit.
 *
 * `backend` has no entry on purpose: its answer is the caller's `fallback`,
 * which is NOT one shared sentence (packs says "Could not open the pack.").
 *
 * Exported for the handful of call sites that catch a THROWN error instead of
 * reading a port `Failure` (the `sdk.store.customer.*` address book, see
 * actions/delivery.ts) and so must append it to their own table by hand.
 */
export const TRANSPORT_RULES: readonly ErrorRule[] = [
  [RATE_LIMITED, COPY.rateLimited],
  [UNAUTHORIZED, COPY.loginRequired],
];

/**
 * A port `Failure` as UI copy: the caller's domain rules first (so a surface
 * can still override a transport sentence), then the shared transport tier,
 * then the caller's fallback.
 */
export function friendlyFailure(
  f: Failure,
  rules: readonly ErrorRule[],
  fallback: string,
): string {
  return friendlyError(f.text, [...rules, ...TRANSPORT_RULES], fallback);
}

/**
 * HTTP status of a failed backend call, or undefined when the failure never
 * reached a response (network drop, or an error we threw ourselves).
 *
 * `sdk.client.fetch` rejects a non-2xx with `FetchError`, which carries the
 * status; `store.orThrow` (src/lib/store-port.ts) throws `StoreError`, whose
 * `failure.status` is the same number — undefined there too when the call never
 * reached a response, or never left at all for want of a cookie. Prefer this
 * over matching the error's message whenever the status is what actually
 * decides the branch.
 */
export const httpStatus = (error: unknown): number | undefined => {
  if (error instanceof StoreError) return error.failure.status;
  return error instanceof FetchError ? error.status : undefined;
};

/**
 * The broad 401 probe used by the vault actions to set `needsAuth`.
 *
 * A real 401 wins outright; the text probe stays as a fallback for failures
 * that never carried a status (a locally thrown `new Error('Not
 * authenticated.')` — see data/customer.ts — or a wrapped error). Strictly a
 * superset of the old text-only test, so no caller that used to get
 * `needsAuth: true` stops.
 *
 * KNOWN NON-AUTH 401s — do NOT route these through here. Two backend routes
 * answer 401 for a reason the customer can fix without logging in again:
 * `store/phone-verification/change` returns it for a WRONG PASSWORD and for a
 * missing OTP proof. `changePhone` deliberately does not use this predicate.
 * Wiring it up would open the login sheet instead of saying the password was
 * wrong, which is why this warning is here rather than in a commit message.
 */
export const isAuthError = (error: unknown): boolean =>
  httpStatus(error) === 401 || UNAUTHORIZED.test(errorText(error));
