import { NextResponse } from 'next/server';
import { setReferralCookie } from '@/lib/referral-cookie';
import { normalizeReferralCode } from '@/lib/referral-code';
import { lookupReferralCode } from '@/lib/data/referral';
import { getAuthToken } from '@/lib/data/customer';
import { logger } from '@/lib/logger';

/**
 * GET /r/<code> — the shareable referral link (the QR, the "Link" row and the
 * share sheet on /referral all point here).
 *
 * Three outcomes, all of them explicit to the visitor. The first version
 * planted a cookie and dumped everyone on the home page with no signal: a
 * friend had no idea they were meant to sign up, a dead link failed silently
 * at signup, and an existing customer got nothing at all.
 *
 *  - valid code + logged OUT → plant the cookie, land on `/?invite=<CODE>`
 *    where InviteWelcome greets them and opens the signup form with the code
 *    already filled in.
 *  - valid code + logged IN  → NO cookie (attribution binds at signup only,
 *    so it could never apply) and `/?invite=has-account` says so.
 *  - unknown / mistyped code → NO cookie, `/?invite=unknown`.
 *
 * The Sec-Fetch check stays: SameSite=Lax governs sending, not setting, so
 * without it any third-party page could stuff an affiliate code with an
 * <img> tag and skim a cut of that visitor's future spend.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ code: string }> },
): Promise<NextResponse> {
  const { code: raw } = await params;
  const code = normalizeReferralCode(raw);
  // Bare RELATIVE Location, written by hand — never `new URL('/', request.url)`.
  // Behind the DO proxy `request.url`'s origin is the standalone server's own
  // BIND origin (http://0.0.0.0:3000), so an absolute redirect sent every
  // shared link to a connection error (the trap #311 fixed for the Google
  // callback, recreated here). The browser resolves a relative Location
  // against the origin IT requested.
  const redirect = (path: string) =>
    new NextResponse(null, { status: 302, headers: { Location: path } });
  const home = (invite: string) =>
    redirect(`/?invite=${encodeURIComponent(invite)}`);

  const mode = request.headers.get('sec-fetch-mode');
  const dest = request.headers.get('sec-fetch-dest');
  const isTopLevelNavigation =
    (mode === null || mode === 'navigate') &&
    (dest === null || dest === 'document');
  if (!isTopLevelNavigation || !code) {
    return redirect('/');
  }

  // Already a customer? Attribution binds at signup and never after, so
  // planting the cookie would be a lie. Say so instead of failing silently.
  if (await getAuthToken()) {
    return home('has-account');
  }

  // A mistyped or retired code would sail through here and only fail — with
  // nobody watching — inside the post-signup bind. Resolve it now.
  // lookupReferralCode returns a STATUS UNION and never throws: 'notfound'
  // covers a dead code AND a disabled referrer (the backend hides both), and
  // 'error' is OUR outage — don't punish the visitor for that one, plant the
  // cookie and let the bind re-validate server-side.
  const lookup = await lookupReferralCode(code);
  if (lookup.status === 'notfound') {
    return home('unknown');
  }
  if (lookup.status === 'error') {
    logger.error(`[referral] code lookup degraded for "${code}"`);
  }

  await setReferralCookie(code);
  return home(code);
}
