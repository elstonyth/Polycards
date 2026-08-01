import { NextResponse, type NextRequest } from 'next/server';
import { googleCallback } from '@/lib/actions/auth';
import { resolveCallbackOrigin } from '@/lib/allowed-hosts';

/**
 * Google OAuth return URL (an Authorised redirect URI on the OAuth client).
 * Google sends the browser here with `?code&state` (or `?error` if the user
 * declined). This MUST be a Route Handler, not a page: completing the exchange
 * calls `setAuthToken` → `cookies().set()`, which Next.js only permits in a
 * Route Handler or an action-dispatched Server Action — never during a Server
 * Component render. On success the customer lands on their account; on failure
 * we bounce to the storefront's Google-error page (route handlers can't render
 * JSX, so the human-readable reason travels as a query param).
 *
 * Origin resolution (resolveCallbackOrigin) lives in @/lib/allowed-hosts, not
 * here: a Route Handler module may only export the recognised HTTP-method/
 * config names, and an extra export fails the generated route type check.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams } = request.nextUrl;

  const host =
    request.headers.get('x-forwarded-host') ?? request.headers.get('host');
  const origin = resolveCallbackOrigin(
    host,
    request.headers.get('x-forwarded-proto'),
  );

  // Fail closed: an unrecognised/missing host means we can't safely build an
  // absolute self-URL. Bounce relative to the current request instead of
  // ever falling back to `request.url` (see resolveCallbackOrigin).
  if (!origin) {
    return NextResponse.redirect(
      new URL('/auth/google/failed?reason=origin', request.nextUrl),
    );
  }

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
