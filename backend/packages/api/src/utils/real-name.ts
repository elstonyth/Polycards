// Real name (spec docs/superpowers/specs/2026-10-06-real-name-and-phone-lock-design.md):
// the name the account's phone is registered to in Touch 'n Go eWallet, which
// staff compare against a TNG lookup of the number when a big hit looks like a
// farmed account. Permissive on purpose — Malaysian names carry "bin", "a/l",
// "@" and apostrophes, and any script is allowed — but not free text: digits,
// emoji and URL-ish punctuation never appear in a legal name.
//
// MIRRORED in the storefront (src/lib/real-name.ts) as a courtesy check; this
// copy is the authoritative one. Keep the two identical — the storefront's
// real-name-parity test reads both.

export const REAL_NAME_MIN = 3;
export const REAL_NAME_MAX = 100;

// Letters and combining marks of any script, plus the separators real names
// use. Anchored, so the whole (normalized) name must match.
const REAL_NAME_RE = /^[\p{L}\p{M}][\p{L}\p{M} .'@/,-]*$/u;

export const REAL_NAME_INVALID =
  'Enter your full name exactly as it appears on your IC / Touch ’n Go eWallet (letters only, 3–100 characters).';

/**
 * Trim, collapse inner whitespace, and validate. Returns the stored form, or
 * null when the input is not an acceptable real name.
 */
export function normalizeRealName(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const name = input.normalize('NFC').trim().replace(/\s+/g, ' ');
  if (name.length < REAL_NAME_MIN || name.length > REAL_NAME_MAX) return null;
  return REAL_NAME_RE.test(name) ? name : null;
}
