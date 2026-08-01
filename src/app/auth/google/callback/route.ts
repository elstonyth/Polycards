import { NextResponse, type NextRequest } from 'next/server';
import { googleCallback } from '@/lib/actions/auth';
import { ALLOWED_SELF_HOSTS } from '@/lib/allowed-hosts';

/**
 * Google OAuth return URL (an Authorised redirect URI on the OAuth client).
 * Google sends the browser here with `?code&state` (or `?error` if the user
 * declined). This MUST be a Route Handler, not a page: completing the exchange
 * calls `setAuthToken` → `cookies().set()`, which Next.js only permits in a
 * Route Handler or an action-dispatched Server Action — never during a Server
 * Component render. On success the customer lands on their account; on failure
 * we bounce to the storefront's Google-error page (route handlers can't render
 * JSX, so the human-readable reason travels as a query param).
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams } = request.nextUrl;

  // NEVER build redirects from `request.url`: behind the DO proxy the
  // standalone server sees its own bind origin (http://0.0.0.0:<port>), and a
  // redirect there lands the phone on Safari's "restricted network port"
  // error page. Derive the public origin from the forwarded headers instead,
  // allowlisted (they're client-supplied) — same guard as googleLoginStart.
  const host =
    request.headers.get('x-forwarded-host') ?? request.headers.get('host');
  const proto =
    request.headers.get('x-forwarded-proto') ??
    (process.env.NODE_ENV === 'production' ? 'https' : 'http');
  const origin =
    host && ALLOWED_SELF_HOSTS.has(host) ? `${proto}://${host}` : request.url;

  const failed = (reason: string): NextResponse =>
    NextResponse.redirect(
      new URL(
        `/auth/google/failed?reason=${encodeURIComponent(reason)}`,
        origin,
      ),
    );

  if (searchParams.get('error')) {
    return failed('Google sign-in was cancelled. You can try again.');
  }

  // googleCallback is written to return an AuthResult rather than throw, but a
  // try/catch here is cheap insurance: any unexpected throw still lands on the
  // friendly failure page instead of a raw 500.
  try {
    const result = await googleCallback({
      code: searchParams.get('code') ?? undefined,
      state: searchParams.get('state') ?? undefined,
    });

    if (result.ok) {
      return NextResponse.redirect(new URL('/me', origin));
    }
    return failed(result.error);
  } catch {
    return failed('Google sign-in could not be completed. Please try again.');
  }
}
