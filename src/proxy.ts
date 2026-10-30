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

// Then it moved to made-up URLs (/leaderboard/sda, ~2,000 req/s across pods):
// a URL no route serves still costs a full not-found render. Every page the app
// serves is listed here (src/app/**/page.tsx + route.ts + metadata files; there
// are no rewrites or redirects in next.config). Anything else gets the same
// bare, cacheable 404 as an impossible card handle, before Next renders.
// Adding a page? Add it here too, or it 404s (src/__tests__/proxy.test.ts
// walks src/app and fails when a route is missing from this list).
const KNOWN_ROUTE = [
  /^\/$/,
  /^\/(about|addresses|audio-preview|bank|bank-withdrawal|contact|download|fairness|healthz|how-it-works|leaderboard|lucky-draw|me|notifications|orders|privacy|referral|reset-password|settings|slots|task|transactions|vault|wallet)\/?$/,
  /^\/vault\/history\/?$/,
  /^\/auth\/google\/(callback|failed)\/?$/,
  /^\/(card|profile|r)\/[^/]+\/?$/,
  /^\/slots\/[^/]+(\/spin)?\/?$/,
  /^\/(robots\.txt|sitemap\.xml|manifest\.webmanifest|favicon\.ico|icon\.png|apple-icon\.png)$/,
];
export const isKnownRoute = (pathname: string): boolean =>
  KNOWN_ROUTE.some((re) => re.test(pathname));

const notFound = () =>
  new NextResponse('Not found', {
    status: 404,
    headers: { 'cache-control': 'public, max-age=300' },
  });

// Origin lock. The storefront sits behind our Cloudflare zone, whose rules
// (MY/SG only, rate limit, hosting-network challenge) are the real flood
// defence, but DigitalOcean also serves the app on its own hostname and edge,
// so a bot that calls those skips every rule. A Cloudflare Transform Rule adds
// `x-polycards-edge: <secret>` to every request it forwards; once
// EDGE_SHARED_SECRET is set on the app, anything without that header is refused
// here. Unset = lock off (deploy the code first, add the Cloudflare rule,
// then set the secret). /healthz stays open for DigitalOcean's own probes.
const EDGE_HEADER = 'x-polycards-edge';

function sameSecret(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function bypassedEdge(request: NextRequest): boolean {
  const secret = process.env.EDGE_SHARED_SECRET;
  if (!secret || request.nextUrl.pathname === '/healthz') return false;
  return !sameSecret(request.headers.get(EDGE_HEADER) ?? '', secret);
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  if (bypassedEdge(request)) {
    return new NextResponse(null, {
      status: 403,
      headers: { 'cache-control': 'no-store' },
    });
  }
  if (implausibleCardPath(pathname)) return notFound();
  if (POLLED_JSON.test(pathname)) {
    if (sameOriginFetch(request)) return;
    return new NextResponse(null, {
      status: 403,
      headers: { 'cache-control': 'no-store' },
    });
  }
  if (pathname.startsWith('/api/')) return;
  if (!isKnownRoute(pathname)) return notFound();
  if (
    pathname === '/' &&
    request.method === 'POST' &&
    request.headers.get('content-type') ===
      'application/x-www-form-urlencoded' &&
    !request.headers.has('next-action')
  ) {
    return new NextResponse(null, {
      status: 405,
      headers: { Allow: 'GET, HEAD' },
    });
  }
}

// Every page path (static files under public/ and /_next/ skipped), plus the
// polled public JSON routes.
export const config = {
  matcher: [
    '/((?!_next/|api/|3dicons/|branding/|cdn/|fonts/|images/|pack-index-icons/|seo/|social/|sounds/|videos/).*)',
    '/api/pack-detail/:path*',
    '/api/cards/:path*',
    '/api/recent-pulls',
    '/api/pull-gaps',
    '/api/free-pack',
    '/api/announcements',
  ],
};
