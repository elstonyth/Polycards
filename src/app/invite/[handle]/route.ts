import { NextResponse } from 'next/server';
import { INVITE_HANDLE_RE, setReferralCookie } from '@/lib/referral-cookie';
import { getPublicProfile } from '@/lib/data/profiles';
import { getAuthToken } from '@/lib/data/customer';
import { logger } from '@/lib/logger';

/**
 * GET /invite/<handle> — the shareable referral link.
 *
 * Three outcomes, all of them explicit to the visitor. The first version
 * planted a cookie and dumped everyone on the home page with no signal: a
 * friend had no idea they were meant to sign up, a dead link failed silently
 * at signup, and an existing customer got nothing at all.
 *
 *  - valid handle + logged OUT → plant the cookie, land on `/?invite=<handle>`
 *    where InviteWelcome greets them and opens the signup form.
 *  - valid handle + logged IN  → NO cookie (attribution binds at signup only,
 *    so it could never apply) and `/?invite=has-account` says so.
 *  - unknown / typo'd handle   → NO cookie, `/?invite=unknown`.
 *
 * The Sec-Fetch check stays: SameSite=Lax governs sending, not setting, so
 * without it any third-party page could stuff an affiliate handle with an
 * <img> tag and skim a cut of that visitor's future spend.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ handle: string }> },
): Promise<NextResponse> {
  const { handle } = await params;
  const normalized = handle?.toLowerCase() ?? '';
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
  if (!isTopLevelNavigation || !INVITE_HANDLE_RE.test(normalized)) {
    return redirect('/');
  }

  // Already a customer? Attribution binds at signup and never after, so
  // planting the cookie would be a lie. Say so instead of failing silently.
  if (await getAuthToken()) {
    return home('has-account');
  }

  // A typo'd or deleted handle would sail through here and only fail — with
  // nobody watching — inside the post-signup bind. Resolve it now.
  // getPublicProfile returns a STATUS UNION and never throws: 'notfound' is a
  // dead handle, 'unavailable' a disabled account (both un-bindable), and
  // 'error' is OUR outage — don't punish the visitor for that one, plant the
  // cookie and let the bind re-validate server-side.
  const lookup = await getPublicProfile(normalized);
  if (lookup.status === 'notfound' || lookup.status === 'unavailable') {
    return home('unknown');
  }
  if (lookup.status === 'error') {
    logger.error(`[invite] handle lookup degraded for "${normalized}"`);
  }

  await setReferralCookie(normalized);
  return home(normalized);
}
