import { NextResponse } from 'next/server';
import { getFreePackState } from '@/lib/data/free-pack';
import { getAuthToken } from '@/lib/data/customer';
import { cached } from '@/lib/ttl-cache';

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

export async function GET() {
  const token = await getAuthToken();
  if (token) {
    return NextResponse.json(await getFreePackState());
  }
  // The shared TTL memo rather than a Map of this route's own — same window,
  // same per-process scope, plus the stampede collapse and rejection eviction
  // that come with it. getFreePackState never throws (any failure is
  // `hidden`), so that eviction never fires here: a blip still caches `hidden`
  // for up to 60s, exactly as the hand-rolled Map did.
  //
  // getFreePackState() re-reads the cookie itself and finds none on this
  // branch, so the cached body is always guest-shaped (`signup` or `hidden`,
  // never `claim`) — the cache can never leak a per-customer answer.
  return NextResponse.json(
    await cached('free-pack:guest', GUEST_TTL_MS, getFreePackState),
  );
}
