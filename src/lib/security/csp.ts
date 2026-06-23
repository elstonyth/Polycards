// Builds the Content-Security-Policy.
//
// This policy is deliberately NONCE-FREE. A nonce + 'strict-dynamic' script-src
// is the stronger pattern, but Next can only inject a nonce into pages it renders
// per-request — most of this app is statically prerendered (`/`, `/how-it-works`,
// `/about`, …), and a static page has no request at render time, so its scripts
// never receive the nonce. Under 'strict-dynamic' (which disables the 'self'
// allowlist) every script on those pages would be blocked, making the policy
// impossible to *enforce* site-wide. See the Next CSP guide: "when you use nonces,
// all pages must be dynamically rendered."
//
// `script-src 'self' 'unsafe-inline'` is enforceable on static AND dynamic pages
// and still blocks the main injection vector — loading a script from a foreign
// origin. Styles already use 'unsafe-inline' (Tailwind v4 / `motion` write inline
// styles the browser can't nonce). Network + image origins are derived from the
// same env the image optimizer uses, so prod/dev stay correct automatically.
function originOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

export function buildCsp(): string {
  // Default matches lib/medusa.ts (SDK) and next.config.ts (image optimizer): an
  // unset env var means local dev on :9000, so the policy must allow it too.
  const backend = originOf(
    process.env.NEXT_PUBLIC_MEDUSA_BACKEND_URL ?? 'http://localhost:9000',
  );
  const mediaHost = process.env.NEXT_PUBLIC_MEDIA_HOST;
  const media = mediaHost ? `https://${mediaHost}` : null;
  // Sentry ingest (browser → SDK transport). Covers *.ingest.sentry.io / *.sentry.io.
  const sentry = 'https://*.sentry.io https://*.ingest.sentry.io';

  const connect = ["'self'", backend, media, sentry].filter(Boolean).join(' ');
  const img = ["'self'", 'data:', 'blob:', backend, media]
    .filter(Boolean)
    .join(' ');

  const directives = [
    `default-src 'self'`,
    `script-src 'self' 'unsafe-inline'`,
    `style-src 'self' 'unsafe-inline'`,
    `img-src ${img}`,
    `font-src 'self'`,
    `connect-src ${connect}`,
    `frame-src 'none'`,
    `object-src 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `frame-ancestors 'none'`,
    `upgrade-insecure-requests`,
  ];
  return directives.join('; ');
}
