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

/**
 * The account layout's required-phone gate (PhoneOnboardingModal). True for
 * a password-less account with no phone while enforcement is on — the one
 * cohort the change route lets add a first phone on the new-number proof
 * alone. `hasPassword` is a thunk so the account read is paid only by
 * phoneless accounts; a failed read reports `true` (see getAccountInfo) and
 * therefore fails OPEN here — the backend money/goods gates are the
 * enforcement, the modal is UX.
 */
export async function shouldGatePhone(input: {
  flag: boolean;
  phone: string | null | undefined;
  hasPassword: () => Promise<boolean>;
}): Promise<boolean> {
  if (!input.flag || input.phone) return false;
  return !(await input.hasPassword());
}
