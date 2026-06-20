// Builds the Content-Security-Policy. Script execution is pinned to a per-request
// nonce + 'strict-dynamic' (host allowlists are ignored for scripts by design).
// Styles keep 'unsafe-inline' because Tailwind v4 and `motion` write inline
// styles the browser can't nonce. Network + image origins are derived from the
// same env the image optimizer uses, so prod/dev are correct automatically.
function originOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

export function buildCsp(nonce: string): string {
  const backend = originOf(process.env.NEXT_PUBLIC_MEDUSA_BACKEND_URL);
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
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
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
