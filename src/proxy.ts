import { NextResponse, type NextRequest } from 'next/server';
import { isPlausibleCardHandle } from '@/lib/card-handle';

// A form-encoded POST to / skips the home page's route cache: Next treats any
// `application/x-www-form-urlencoded` POST as a possible server action and
// renders the whole tree for it (a ~230 KB render + gzip), while still
// answering `x-nextjs-cache: HIT`. Nothing in this app sends one — the forms
// all submit from JS, and real server actions carry a Next-Action header and
// never use this encoding (Next's own action handler bails out on it) — so
// only a bot would send one, and each would cost us a full render plus a
// backend call for one cheap request. Refuse them before rendering.
//
// Scoped to / on purpose: other pages may receive legitimate form POSTs (a
// payment gateway returning the browser to /transactions, for one).
//
// The public JSON the storefront's own pages poll is refused the same way when
// the request is not a same-origin fetch. On 2026-10-25 a flood of ~160 req/s
// from rotating proxy IPs hit /api/pack-detail/bronze-pack as direct
// navigations (Sec-Fetch-Dest: document) with no Referer, each pulling a
// ~270 KB body, and starved every pod into 503s. A real poll always carries
// Sec-Fetch-Site: same-origin, or (older Safari, no Fetch Metadata) a
// same-origin Referer under our strict-origin-when-cross-origin policy.
// cards/, free-pack and announcements are only ever fetched by our own client
// too (use-card-price, FreePackBadge, AnnouncementPopup); /api/cards costs the
// backend 4 DB queries a hit, so it is the next cheapest drain.
const POLLED_JSON =
  /^\/api\/(pack-detail\/|cards\/|recent-pulls$|pull-gaps$|free-pack$|announcements$)/;

function sameOriginFetch(request: NextRequest): boolean {
  const site = request.headers.get('sec-fetch-site');
  if (site) return site === 'same-origin';
  const referer = request.headers.get('referer');
  const host =
    request.headers.get('x-forwarded-host') ?? request.headers.get('host');
  if (!referer || !host) return false;
  try {
    return new URL(referer).host === host;
  } catch {
    return false;
  }
}

// The flood then moved to /card/adasdsad (~250 req/s reaching the backend): a
// handle that cannot be a card gets a bare 404 here, before the page renders.
// Cacheable, so an edge that honours it absorbs repeats of the same junk URL.
function implausibleCardPath(pathname: string): boolean {
  if (!pathname.startsWith('/card/')) return false;
  const segment = pathname.slice('/card/'.length).split('/')[0] ?? '';
  try {
    return !isPlausibleCardHandle(decodeURIComponent(segment));
  } catch {
    return true;
  }
}

export function proxy(request: NextRequest) {
  if (implausibleCardPath(request.nextUrl.pathname)) {
    return new NextResponse('Not found', {
      status: 404,
      headers: { 'cache-control': 'public, max-age=300' },
    });
  }
  if (POLLED_JSON.test(request.nextUrl.pathname)) {
    if (sameOriginFetch(request)) return;
    return new NextResponse(null, {
      status: 403,
      headers: { 'cache-control': 'no-store' },
    });
  }
  if (request.method === 'POST') {
    return new NextResponse(null, {
      status: 405,
      headers: { Allow: 'GET, HEAD' },
    });
  }
}

// The matcher does the filtering so the proxy never runs for ordinary
// traffic: only / with that exact content type (the same exact match Next uses
// to call it a possible action) and no Next-Action header, plus the polled
// public JSON routes.
export const config = {
  matcher: [
    {
      source: '/',
      has: [
        {
          type: 'header',
          key: 'content-type',
          value: 'application/x-www-form-urlencoded',
        },
      ],
      missing: [{ type: 'header', key: 'next-action' }],
    },
    '/card/:path*',
    '/api/pack-detail/:path*',
    '/api/cards/:path*',
    '/api/recent-pulls',
    '/api/pull-gaps',
    '/api/free-pack',
    '/api/announcements',
  ],
};
