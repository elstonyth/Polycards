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
 * stay free of the SDK singleton so tests that touch it need no sdk mock.
 */
import { FetchError } from '@medusajs/js-sdk';

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
 * HTTP status of a failed backend call, or undefined when the failure never
 * reached a response (network drop, or an error we threw ourselves).
 *
 * `sdk.client.fetch` — and therefore `authedFetch` — rejects a non-2xx with
 * `FetchError`, which carries the status. Prefer this over matching the error's
 * message whenever the status is what actually decides the branch.
 */
export const httpStatus = (error: unknown): number | undefined =>
  error instanceof FetchError ? error.status : undefined;

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
  httpStatus(error) === 401 ||
  /unauthorized|not authenticated|401/i.test(errorText(error));
