/**
 * Hosts this deployment may build absolute self-URLs for (the Google OAuth
 * callback_url and post-login redirects). Host / X-Forwarded-Host are
 * client-supplied headers, so anything derived from them must pass this list
 * before landing in a redirect or an OAuth exchange. Mirrors the Authorised
 * redirect URIs on the Google OAuth client (Cloud project `polycards`) — keep
 * the two in sync, and keep this set tracking the domains in
 * `.do/storefront.app.yaml`.
 *
 * Lives outside the 'use server' action modules because those may only export
 * async functions.
 */
export const ALLOWED_SELF_HOSTS = new Set([
  'polycards.gg',
  'www.polycards.gg',
  // :3000 is `next dev` — the origin actually registered as an Authorised
  // redirect URI on the Google OAuth client (see backend/packages/api's
  // GOOGLE_CALLBACK_URL template default), so it stays even though this
  // repo's documented *build* verification flow runs on :4000 instead.
  'localhost:3000',
  // :4000 is the standalone production-style serve
  // (scripts/serve-standalone.ps1 — see CLAUDE.md "Running & verifying").
  // Google login only works there once :4000's callback URI is also
  // registered on the OAuth client; until then this host resolves locally
  // but the exchange fails at Google with redirect_uri_mismatch.
  'localhost:4000',
  '127.0.0.1:4000',
]);

/**
 * Resolve the public origin to build an absolute self-URL from, given the
 * (client-supplied, so allowlisted) forwarded host/proto. Returns null when
 * the host is missing or not on ALLOWED_SELF_HOSTS — callers must fail
 * closed rather than falling back to `request.url`: behind the DO proxy
 * that's the standalone server's own bind origin (http://0.0.0.0:<port>),
 * the exact broken redirect PR #311 fixed.
 *
 * Lives here (not in the route file) because a Next.js Route Handler module
 * may only export the recognised HTTP-method/config names — an extra named
 * export fails the generated route type check at build time.
 */
export function resolveCallbackOrigin(
  host: string | null,
  forwardedProto: string | null,
): string | null {
  if (!host || !ALLOWED_SELF_HOSTS.has(host)) return null;
  const proto =
    forwardedProto ??
    (process.env.NODE_ENV === 'production' ? 'https' : 'http');
  return `${proto}://${host}`;
}
