/**
 * Hosts this deployment may build absolute self-URLs for (the Google OAuth
 * callback_url and post-login redirects). Host / X-Forwarded-Host are
 * client-supplied headers, so anything derived from them must pass this list
 * before landing in a redirect or an OAuth exchange. Mirrors the Authorised
 * redirect URIs on the Google OAuth client (Cloud project `polycards`) — keep
 * the two in sync.
 *
 * Lives outside the 'use server' action modules because those may only export
 * async functions.
 */
export const ALLOWED_SELF_HOSTS = new Set([
  'polycards.gg',
  'www.polycards.gg',
  'localhost:3000',
]);
