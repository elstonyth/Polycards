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
 *
 * The pattern itself is broader than that sentence: it also matches the
 * phone-CHANGE and login copy in actions/phone-verification.ts and
 * actions/auth.ts. What bounds it is the mounting, not the regex —
 * PhoneGateAction renders on exactly the three surfaces whose routes carry the
 * guard, and none of them can hold those strings. Mounting it anywhere new
 * means re-checking that.
 */
export const isPhoneGateError = (message: string): boolean =>
  /verify your phone/i.test(message);
