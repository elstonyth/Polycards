import { NextResponse, type NextRequest } from 'next/server';
import { setAuthToken } from '@/lib/data/customer';
import {
  localSignInConfig,
  safeNextPath,
  signLocalToken,
} from '@/lib/local-sign-in';

// Local testing only: signs in without a password against the prod-copy
// backend (see src/lib/local-sign-in.ts for every condition). Anywhere else it
// is a plain 404, the same as a route that does not exist.
// GET /api/dev-sign-in[?as=<customer id>][&next=/path]
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const cfg = localSignInConfig({
    ...process.env,
    // written out in full so the build inlines it: the backend this build
    // really talks to (as src/lib/medusa.ts), whatever the server's env says
    NEXT_PUBLIC_MEDUSA_BACKEND_URL: process.env.NEXT_PUBLIC_MEDUSA_BACKEND_URL,
  });
  if (!cfg) return new NextResponse('Not found', { status: 404 });
  const as = req.nextUrl.searchParams.get('as');
  const account = as
    ? cfg.accounts.find((a) => a.customerId === as)
    : cfg.accounts[0];
  if (!account) return new NextResponse('Not found', { status: 404 });
  const next = safeNextPath(req.nextUrl.searchParams.get('next'));
  // the site's own session cookie, set the way a real sign-in sets it
  // (Secure everywhere real, not on a plain-http preview: lib/private-host.ts)
  await setAuthToken(signLocalToken(cfg.secret, account));
  // relative: the server may listen on 0.0.0.0, which is no address to send a browser to
  return new NextResponse(null, { status: 303, headers: { Location: next } });
}
