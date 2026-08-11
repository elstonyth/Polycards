/**
 * Recognises the storefront copy that `requirePhoneVerified` (backend
 * api/utils/phone-verification-guard.ts) is mapped to — VAULT_RULES and
 * DELIVERY_RULES both start theirs with "Verify your phone number".
 *
 * Matching DISPLAY text is the same necessity those tables document: the
 * action returns `{ ok: false, error: string }` and nothing machine-readable
 * survives the trip. A reword that drops the phrase would silently take the
 * "Add your phone number" button away with it, so both error-table suites
 * assert their mapped message still satisfies this predicate.
 */
export const isPhoneGateError = (message: string): boolean =>
  /verify your phone/i.test(message);
