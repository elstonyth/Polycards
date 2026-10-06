// Real name (spec docs/superpowers/specs/2026-10-06-real-name-and-phone-lock-design.md):
// the name the account's phone is registered to in Touch 'n Go eWallet. Staff
// compare it against a TNG lookup of the number when a big hit looks like a
// farmed account, so the copy asks for it EXACTLY as on the IC / TNG account.
//
// MIRROR of backend/packages/api/src/utils/real-name.ts, which is the
// authoritative check — this one only saves a round trip. Keep the two
// identical; src/lib/__tests__/real-name-parity.test.ts runs both.

export const REAL_NAME_MIN = 3;
export const REAL_NAME_MAX = 100;

const REAL_NAME_RE = /^[\p{L}\p{M}][\p{L}\p{M} .'@/,-]*$/u;

export const REAL_NAME_INVALID =
  'Enter your full name exactly as it appears on your IC / Touch ’n Go eWallet (letters only, 3–100 characters).';

/** Trim, collapse inner whitespace, and validate. The stored form, or null. */
export function normalizeRealName(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const name = input.normalize('NFC').trim().replace(/\s+/g, ' ');
  if (name.length < REAL_NAME_MIN || name.length > REAL_NAME_MAX) return null;
  return REAL_NAME_RE.test(name) ? name : null;
}

/** Shown beside every real-name input and on the confirm step. */
export const REAL_NAME_HINT =
  'Must match the name on your Touch ’n Go eWallet. It can’t be changed later.';
