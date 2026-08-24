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
  if (INVITE_HANDLE_RE.test(normalized)) {
    await setReferralCookie(normalized);
  }
  return NextResponse.redirect(new URL('/', request.url));
}
