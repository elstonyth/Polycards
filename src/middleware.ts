import { NextRequest, NextResponse } from 'next/server';
import { buildCsp } from '@/lib/security/csp';

// Per-request nonce so Next can nonce its own inline bootstrap scripts. We set
// the CSP on the REQUEST headers (Next reads it there to nonce scripts) and on
// the RESPONSE headers (the browser applies it).
//
// The policy ships in REPORT-ONLY mode by default: the browser logs violations
// to the console / a report endpoint but blocks nothing, so a too-tight
// directive can't break the live site. Set `CSP_ENFORCE=true` in the deploy env
// to switch the response header to the enforcing `Content-Security-Policy` once
// prod has been verified clean. The REQUEST header stays the enforcing name in
// both modes so Next keeps noncing its own scripts (making the later flip a
// no-op for script nonces).
export function middleware(request: NextRequest) {
  const nonce = btoa(crypto.randomUUID());
  const csp = buildCsp(nonce);

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  const responseHeader =
    process.env.CSP_ENFORCE === 'true'
      ? 'Content-Security-Policy'
      : 'Content-Security-Policy-Report-Only';
  response.headers.set(responseHeader, csp);
  return response;
}

export const config = {
  // Skip static assets + the image optimizer; they don't execute scripts and
  // re-noncing them only adds latency.
  matcher: [
    {
      source:
        '/((?!api|_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|gif|webp|avif|svg|ico|woff2?)$).*)',
      missing: [{ type: 'header', key: 'next-router-prefetch' }],
    },
  ],
};
