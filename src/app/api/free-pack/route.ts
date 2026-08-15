import { NextResponse } from 'next/server';
import { getFreePackState, type FreePackState } from '@/lib/data/free-pack';
import { getAuthToken } from '@/lib/data/customer';

// Same-origin endpoint the site-wide floating badge (GlobalFreePackBadge)
// re-reads on route/auth change (throttled client-side to 30s — see
// FreePackBadge.tsx's REFETCH_TTL_MS) — the customer JWT is an httpOnly cookie
// the browser can't read, and a direct Store-API call would be CORS-blocked,
// so the state read runs server-side here.
//
// Two cache regimes, split on auth because the two branches have opposite
// freshness needs:
//  - AUTHED (`eligible`+`slug`, per-customer): per-request, `force-dynamic` —
//    the badge must vanish on the next navigation after the one-time claim is
//    spent.
//  - GUEST (`promo`, a single operator-set boolean, identity-free): served
//    from a 60s module-level cache instead of round-tripping the Store API on
//    every anonymous navigation — the guest answer changes only when an
//    operator activates/retires a free pack, so up to 60s of staleness costs
//    nothing. This is what keeps the site-wide badge (#442) off the shared
//    store-read circuit breaker (backend middlewares.ts, STORE_READ_DEFAULTS).
export const dynamic = 'force-dynamic';

const GUEST_TTL_MS = 60_000;
let guestCache: { expires: number; body: FreePackState } | null = null;

export async function GET() {
  const token = await getAuthToken();
  if (token) {
    return NextResponse.json(await getFreePackState());
  }
  if (guestCache && guestCache.expires > Date.now()) {
    return NextResponse.json(guestCache.body);
  }
  // getFreePackState() re-reads the cookie itself and finds none on this
  // branch, so the cached body is always guest-shaped (`signup` or `hidden`,
  // never `claim`) — the cache can never leak a per-customer answer.
  const body = await getFreePackState();
  guestCache = { expires: Date.now() + GUEST_TTL_MS, body };
  return NextResponse.json(body);
}
