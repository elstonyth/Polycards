// Public identity rules. Two values, deliberately kept apart:
//
//  - the DISPLAY NAME (`customer.first_name`) — what every surface prints.
//    The player may change it whenever they like.
//  - the PROFILE HANDLE (`customer.metadata.handle`) — the permanent address,
//    /profile/<handle>. Fixed once, from the name the account had when it was
//    first given one (the name typed at signup, else "Collector####"), and
//    never rewritten by a rename.
//
// The operator's rule (2026-09-30): the link is the ID card, the name is only
// what is written on it. From 2026-09-04 to 2026-09-30 the display name WAS
// the URL, and every rename retired a link that had already gone out — the
// Telegram board posts /profile/<name> to a public channel, so a player who
// hit an Immortal and then renamed left that post pointing at a 404, and at
// whoever claimed the freed name next. Migration20260930140000 froze every
// live account's then-current name as its handle, so no link that worked
// before the change stopped working because of it.
//
// Both values share one shape: ASCII `A-Za-z0-9_-`, 3..30, so either is a URL
// segment without percent-encoding, and both are unique CASE-INSENSITIVELY
// (partial unique indexes on lower(first_name) — Migration20260904120000 — and
// on lower(metadata->>'handle') — Migration20260930140000). Display case is
// preserved; only matching folds it. They are separate namespaces: a handle
// can equal some OTHER player's display name, because the name a handle was
// frozen from can be given up by its owner and then taken by someone else.

/** Username length bounds — also the storefront's input caps. */
export const USERNAME_MIN = 3;
export const USERNAME_MAX = 30;

/**
 * Accepted username shape — the route-param gate AND the write gate. Uppercase
 * is allowed (it is a DISPLAY name), which is exactly why matching must fold
 * case everywhere; see `normalizeUsername`.
 */
export const USERNAME_RE = new RegExp(
  `^[A-Za-z0-9_-]{${USERNAME_MIN},${USERNAME_MAX}}$`,
);

/**
 * The comparison key for a username: uniqueness, lookup and the DB index all
 * agree on this fold. Never store the result — display case is the user's.
 */
export function normalizeUsername(name: string): string {
  return name.trim().toLowerCase();
}

/** Whether a raw string is directly usable as a username. */
export function isValidUsername(name: unknown): name is string {
  return typeof name === 'string' && USERNAME_RE.test(name.trim());
}

/**
 * Deterministic string hash — the SAME function as the leaderboard's avatar
 * seed (`seedOf` in store/leaderboard/route.ts), exported here so the public
 * profile shows the identical avatar for the identical customer.
 */
export function seedOf(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/**
 * Best-effort coercion of an arbitrary name into the username charset —
 * whitespace and punctuation become `_`, everything outside ASCII is dropped.
 * Returns null when nothing usable survives (a wholly non-latin name such as
 * the production account displaying "爱动漫的"), which is the caller's cue to
 * fall back to `generatedUsername`.
 *
 * This is for the MIGRATION and for OAuth signup, where a name arrives from
 * somewhere we cannot show an error to. A name the user typed themselves is
 * REJECTED, not silently rewritten — see the username guard.
 */
export function sanitizeUsername(raw: string | null | undefined): string | null {
  const cleaned = (raw ?? '')
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/^[_-]+|[_-]+$/g, '')
    .slice(0, USERNAME_MAX)
    .replace(/[_-]+$/g, '');
  return cleaned.length >= USERNAME_MIN ? cleaned : null;
}

/**
 * An anonymous but stable username for a customer with no usable name, shaped
 * like the rest of the pool ("Collector4809") rather than announcing itself as
 * a fallback.
 */
export function generatedUsername(seed: string): string {
  return `Collector${String(seedOf(seed) % 10_000).padStart(4, '0')}`;
}

/**
 * The next candidate when `base` is taken: a deterministic 4-digit suffix, and
 * on further collisions a different one. Truncates `base` so the result always
 * fits USERNAME_MAX — appending blindly would produce a candidate the write
 * gate then rejects, turning a collision into a 500.
 */
export function suffixedUsername(
  base: string,
  seed: string,
  attempt: number,
): string {
  const digits = String(seedOf(`${seed}#${attempt}`) % 10_000).padStart(4, '0');
  const room = USERNAME_MAX - digits.length;
  const stem = base.slice(0, room).replace(/[_-]+$/g, '') || 'Collector';
  return `${stem}${digits}`;
}

/**
 * The customer's permanent profile handle, or null while none is assigned.
 *
 * Null is a real state, not an error: the handle is assigned lazily (the
 * ensure-profile-handle step, on the first GET /store/profiles/me — which every
 * storefront login makes), so a row created some other way has none until
 * then. Callers render that as "no link", never as a link built from the
 * display name: that is the URL a rename would retire.
 */
export function storedHandle(
  customer: { metadata?: Record<string, unknown> | null } | null | undefined,
): string | null {
  const handle = (customer?.metadata ?? {})['handle'];
  return typeof handle === 'string' && USERNAME_RE.test(handle) ? handle : null;
}

/**
 * PII-safe public display fields for a ranked customer, shared by the store
 * leaderboard and the challenge top-N (both are public and must NEVER leak
 * email/id): a display name (first_name, else an anonymous "Collector ####"
 * from the seed), the permanent profile handle the name links to, and the
 * equipped avatar url if set. `customer` is undefined when the id resolved to
 * no customer record. Callers append surface-specific fields (points, volume,
 * equipped_frame_level, …).
 */
export function publicProfileFields(
  customer:
    | { first_name?: string | null; metadata?: Record<string, unknown> | null }
    | undefined,
  seed: number,
): { name: string; handle: string | null; avatarUrl: string | null } {
  const first = (customer?.first_name || '').trim();
  const meta = (customer?.metadata ?? {}) as Record<string, unknown>;
  const avatarUrl = meta['avatar_url'];
  return {
    name: first.length > 0 ? first : `Collector ${String(seed).slice(0, 4)}`,
    handle: storedHandle(customer),
    avatarUrl: typeof avatarUrl === 'string' ? avatarUrl : null,
  };
}
