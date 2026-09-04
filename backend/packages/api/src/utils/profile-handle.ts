// Public username rules. A customer's display name (`customer.first_name`) IS
// their public profile URL: /profile/<display name>. There is no second
// identifier — no `metadata.handle`, no slug, no id hash.
//
// That equivalence is the whole point. The previous model derived a handle
// once (name slug + id hash) and froze it, so every rename silently orphaned
// the URL: in production on 2026-09-04, `wei-nguan-5ren` was displaying
// "MOONBREON" and NOT ONE of the ten linked handles still matched its own
// display name. Deriving nothing and looking the name up directly makes
// "rename changes the URL" structurally true rather than something a write
// hook has to remember to maintain.
//
// Two invariants hold it together, both enforced below the app:
//  - uniqueness is CASE-INSENSITIVE, so `MOONBREON` and `Moonbreon` cannot
//    both exist and hand two users what reads as one link. Backed by a
//    partial unique index on lower(first_name) (Migration20260904120000).
//  - the charset is ASCII `A-Za-z0-9_-`, so a name is a URL without
//    percent-encoding. Display case is preserved; only matching folds it.

/** Username length bounds — also the storefront's input caps. */
export const USERNAME_MIN = 3;
export const USERNAME_MAX = 30;

/**
 * Accepted username shape — the route-param gate AND the write gate. Uppercase
 * is allowed (it is a DISPLAY name), which is exactly why matching must fold
 * case everywhere; see `normalizeUsername`.
 */
export const USERNAME_RE = /^[A-Za-z0-9_-]{3,30}$/;

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
 * PII-safe public display fields for a ranked customer, shared by the store
 * leaderboard and the challenge top-N (both are public and must NEVER leak
 * email/id): a display name (first_name, else an anonymous "Collector ####"
 * from the seed), the public profile handle — which IS that display name when
 * it is a valid username — and the equipped avatar url if set. `customer` is
 * undefined when the id resolved to no customer record. Callers append
 * surface-specific fields (points, volume, equipped_frame_level, …).
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
    // Null (not a guessed slug) when the name is not URL-usable: a link is
    // only rendered for a handle that resolves. The backfill migration leaves
    // no such rows behind, but a row written before it must degrade to "no
    // link", never to a 404 link.
    handle: isValidUsername(first) ? first : null,
    avatarUrl: typeof avatarUrl === 'string' ? avatarUrl : null,
  };
}
