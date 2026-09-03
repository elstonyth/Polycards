/**
 * Referral code shape, shared by the client form and the server seams. The
 * backend (utils/referral-code.ts) is authoritative and re-validates; this
 * keeps junk out of the cookie and gives the form an instant "that's not a
 * code" answer.
 */
const REFERRAL_CODE_RE = /^[A-Z0-9]{8}$/;

/** Uppercases and strips spaces/dashes ("f42b-0700" → "F42B0700"); null when
 *  what remains isn't a code. */
export function normalizeReferralCode(
  input: string | null | undefined,
): string | null {
  if (!input) return null;
  const code = input.replace(/[\s-]/g, '').toUpperCase();
  return REFERRAL_CODE_RE.test(code) ? code : null;
}
