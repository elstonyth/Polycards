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

/**
 * Whether the policy ships enforcing (vs report-only). One predicate governs
 * both the header *name* (next.config.ts) and the `upgrade-insecure-requests`
 * directive below, so the two can never drift apart.
 *
 * The flag fails OPEN (report-only), so a near-miss spelling — `TRUE`, `1`, a
 * trailing space from a copy-pasted dashboard value — would silently un-enforce
 * the whole policy with no error anywhere. Accept the usual truthy spellings.
 */
export function cspEnforced(): boolean {
  const flag = process.env.CSP_ENFORCE?.trim().toLowerCase();
  return flag === 'true' || flag === '1';
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

  // Meta Pixel (components/MetaPixel.tsx): fbevents.js loads from
  // connect.facebook.net, events fire to facebook.com (script beacons +
  // the <noscript> tracking image).
  const fbScript = 'https://connect.facebook.net';
  const fbTrack = 'https://www.facebook.com';

  const connect = ["'self'", backend, media, sentry, fbScript, fbTrack]
    .filter(Boolean)
    .join(' ');
  // jsDelivr hosts the pixel-Pokémon sprites (src/lib/mock/pokedex.ts) — an
  // enforced policy must allow it or every reel/pokédex sprite is blocked.
  const spriteCdn = 'https://cdn.jsdelivr.net';
  const img = ["'self'", 'data:', 'blob:', backend, media, spriteCdn, fbTrack]
    .filter(Boolean)
    .join(' ');

  const directives = [
    `default-src 'self'`,
    `script-src 'self' 'unsafe-inline' ${fbScript}`,
    `style-src 'self' 'unsafe-inline'`,
    `img-src ${img}`,
    `font-src 'self'`,
    `connect-src ${connect}`,
    `frame-src 'none'`,
    `object-src 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `frame-ancestors 'none'`,
  ];
  // `upgrade-insecure-requests` does nothing in a report-only policy and the
  // browser logs "directive ... is ignored" on EVERY page load, so only emit it
  // in the enforcing policy (same toggle next.config.ts reads for the header name).
  if (cspEnforced()) {
    directives.push(`upgrade-insecure-requests`);
  }
  return directives.join('; ');
}
