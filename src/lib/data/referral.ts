/**
 * Referral data seam for the /referral page and the /r/<code> link (rebuild,
 * spec 2026-08-24). Server-side fetches, zod-validated (looseObject per house
 * style), never a throw — the page renders its logged-out / unavailable panel
 * and the link route falls back explicitly instead of crashing.
 */
import 'server-only';
import { cache } from 'react';
import { store } from '@/lib/store';
import {
  ReferralCodeLookupSchema,
  ReferralSummarySchema,
  type ReferralCodeLookup,
  type ReferralSummary,
} from '@/lib/data/schemas';

/** The signed-in customer's own referral panel, or null — logged out, a
 *  backend blip and a malformed 200 all render the same "unavailable" panel,
 *  so they collapse into one branch. */
export async function getReferralSummary(): Promise<ReferralSummary | null> {
  const r = await store.get('/store/referral', ReferralSummarySchema);
  return r.ok ? r.data : null;
}

export type ReferralCodeLookupResult =
  | ({ status: 'ok' } & ReferralCodeLookup)
  | { status: 'notfound' }
  | { status: 'error' };

/**
 * PUBLIC "who owns this code" check (GET /store/referral/codes/:code) behind
 * the /r/<code> link and the signup form. A STATUS UNION, never a throw:
 * 'notfound' is a dead code or a hidden (disabled) referrer — both
 * un-bindable — and 'error' is OUR outage, which callers treat as "carry on,
 * the bind re-validates". Expects an already-normalized code.
 */
export const lookupReferralCode = cache(
  async (code: string): Promise<ReferralCodeLookupResult> => {
    // Public route: no bearer, and no cache key on the wire (`cache: 'auto'`)
    // — what the bare sdk.client.fetch sent.
    const r = await store.get(
      `/store/referral/codes/${encodeURIComponent(code)}`,
      ReferralCodeLookupSchema,
      { auth: 'none', cache: 'auto' },
    );
    if (r.ok) return { status: 'ok', ...r.data };
    // Only a real 404 is 'notfound' (a dead code, or a hidden referrer).
    // A schema mismatch is OURS, so it stays 'error' — the caller carries on
    // and the bind re-validates rather than telling the visitor their
    // friend's code is dead. The port logged it, with the code in the path.
    return r.kind === 'not_found'
      ? { status: 'notfound' }
      : { status: 'error' };
  },
);
