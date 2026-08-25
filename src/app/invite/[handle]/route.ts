import { NextResponse } from 'next/server';
import { INVITE_HANDLE_RE, setReferralCookie } from '@/lib/referral-cookie';

// GET /invite/<handle> — the shareable referral link. Plants the invite
// cookie and lands the visitor on the home page; the signup action consumes
// the cookie and binds attribution permanently. A malformed handle just
// redirects home without a cookie — no error page for a mistyped link.
export async function GET(
  request: Request,
  { params }: { params: Promise<{ handle: string }> },
): Promise<NextResponse> {
  const { handle } = await params;
  const normalized = handle?.toLowerCase() ?? '';
  // Only a REAL top-level navigation may plant the cookie. SameSite=Lax
  // governs sending, not setting, so without this any third-party page could
  // stuff an affiliate handle with <img src=".../invite/attacker"> and skim a
  // cut of that visitor's future spend (security review 2026-08-25). Older
  // browsers omit Sec-Fetch-* entirely; treat absent headers as a navigation
  // so the link keeps working there, and reject only an explicit sub-resource.
  const mode = request.headers.get('sec-fetch-mode');
  const dest = request.headers.get('sec-fetch-dest');
  const isTopLevelNavigation =
    (mode === null || mode === 'navigate') &&
    (dest === null || dest === 'document');
  if (isTopLevelNavigation && INVITE_HANDLE_RE.test(normalized)) {
    await setReferralCookie(normalized);
  }
  return NextResponse.redirect(new URL('/', request.url));
}
