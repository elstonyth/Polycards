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
 */

/** A [pattern, message] pair: if `test` matches the error text, return `message`. */
export type ErrorRule = readonly [test: RegExp, message: string];

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
    if (test.test(text)) return message;
  }
  return fallback;
}

/** The broad 401 probe used by the vault actions to set `needsAuth`. */
export const isAuthError = (error: unknown): boolean =>
  /unauthorized|not authenticated|401/i.test(errorText(error));
