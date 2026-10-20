import { NextResponse, type NextRequest } from 'next/server';

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
export function proxy(request: NextRequest) {
  if (request.method === 'POST') {
    return new NextResponse(null, {
      status: 405,
      headers: { Allow: 'GET, HEAD' },
    });
  }
}

// The matcher does the filtering so the proxy never runs for ordinary
// traffic: only / with that exact content type (the same exact match Next uses
// to call it a possible action) and no Next-Action header.
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
  ],
};
