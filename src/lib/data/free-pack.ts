/**
 * Free welcome pack badge-state seam (GET /store/free-pack).
 *
 * The free pack is hidden from the public catalog (the backend excludes the
 * `free_welcome` category from /store/packs), so this answer is the badge's —
 * and therefore the pack's — ONLY entry point: `claim` for an eligible
 * customer, `signup` as a logged-out signup hook while a pack is active, else
 * `hidden`. Server-only: the customer JWT lives in the httpOnly cookie and is
 * sent as an explicit bearer (browser auth is CORS-blocked at the verify
 * origin — see data/customer.ts).
 *
 * Never throws and never caches: the badge is an enhancement, so an expired
 * token or an unreachable backend both resolve to `hidden` and the page
 * renders exactly as it does today.
 */
import { store } from '@/lib/store';
import { getAuthToken } from '@/lib/data/customer';
import { FreePackSchema } from '@/lib/data/schemas';
import type { FreePackRequirement } from '@/lib/packs-data';

/** Badge state for /slots — the union the page passes to the catalog.
 *  `missing` (claim only, present only when non-empty): the pack is the
 *  customer's, but it opens once they verify their phone / add a real name. */
export type FreePackState =
  | { mode: 'claim'; slug: string; missing?: FreePackRequirement[] }
  | { mode: 'signup' }
  | { mode: 'hidden' };

const HIDDEN: FreePackState = { mode: 'hidden' };

/**
 * Pure mapper, unit-tested: (had a token, parsed answer) → badge state.
 * Guests read ONLY `promo` (the catalog fact); authed customers read ONLY
 * `eligible`+`slug` (the per-customer claim). Neither can leak into the
 * other's branch, so a stray field can never resurrect a spent claim.
 */
export function mapFreePackState(
  hasToken: boolean,
  parsed: {
    eligible: boolean;
    slug: string | null;
    promo?: boolean;
    missing?: FreePackRequirement[];
  } | null,
): FreePackState {
  if (!parsed) return HIDDEN;
  if (!hasToken) return parsed.promo ? { mode: 'signup' } : HIDDEN;
  if (!parsed.eligible || !parsed.slug) return HIDDEN;
  const missing = parsed.missing ?? [];
  return missing.length > 0
    ? { mode: 'claim', slug: parsed.slug, missing }
    : { mode: 'claim', slug: parsed.slug };
}

/**
 * What still stands between this visitor and opening `slug` — empty when
 * nothing does (or when they are not on the claim path at all). Pure, like
 * canClaimFreePack, so the detail page's verify prompt has a test net.
 */
export function freePackMissing(
  state: FreePackState,
  slug: string,
): FreePackRequirement[] {
  return state.mode === 'claim' && state.slug === slug
    ? (state.missing ?? [])
    : [];
}

/**
 * May the visitor looking at `slug` still claim it? Pure, so the detail page's
 * eligibility branch has a test net — a server component has none here.
 *
 * `signup` (logged out, promo live) is ELIGIBLE on purpose: the offer is real
 * for them, and the detail page's CTA prompts login on tap. Answering false
 * would tell a first-time visitor their welcome pack was already claimed.
 *
 * The slug guard keeps a `claim` for a DIFFERENT active free pack from
 * authorising this one, and `hidden` — a spent claim, or a failed read — is
 * false: withhold the offer rather than advertise one the backend refuses.
 */
export function canClaimFreePack(state: FreePackState, slug: string): boolean {
  return (
    state.mode === 'signup' || (state.mode === 'claim' && state.slug === slug)
  );
}

/**
 * Never throws and never caches: any failure is `hidden` and the page
 * renders exactly as it does today.
 */
export async function getFreePackState(): Promise<FreePackState> {
  // The cookie is read HERE as well as inside the port, and not by oversight:
  // the mapper needs to know WHICH answer it is reading. A guest reads only
  // `promo` and a customer only `eligible`+`slug`, so a stray field can never
  // resurrect a spent claim — and that split needs the login state, which a
  // Result cannot carry.
  //
  // `auth: 'optional'`: this route answers a guest rather than 401ing, and the
  // bearer rides along when there is one — exactly what `authedFetch(token,
  // …)` with a possibly-undefined token did, header omitted and all.
  const token = await getAuthToken();
  const r = await store.get('/store/free-pack', FreePackSchema, {
    auth: 'optional',
  });
  // Any failure — expired token, unreachable backend, malformed 200 — is
  // `hidden`, and the page renders exactly as it does today.
  return mapFreePackState(Boolean(token), r.ok ? r.data : null);
}
