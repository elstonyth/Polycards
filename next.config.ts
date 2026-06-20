import type { NextConfig } from 'next';

// next/image refuses remote hosts unless allowlisted. Card/product art is
// served by the Medusa backend (POST /admin/media stores it; see
// medusa-config.ts). The origin depends on the backend's file provider:
//   - local provider → <NEXT_PUBLIC_MEDUSA_BACKEND_URL>/static/...  (dev AND
//     self-hosted prod). Deriving the pattern from that env var means it is
//     correct per-environment automatically — localhost:9000 in dev, the real
//     backend host in prod — with no separate dev/prod gating.
//   - S3/R2 provider → a dedicated media host; set NEXT_PUBLIC_MEDIA_HOST to it.
// Local /public paths (/cdn, /images, /home, ...) are localPatterns and need no
// entry. Patterns are scoped to /static/** so the optimizer can't be pointed at
// arbitrary paths on these hosts.
const backendUrl =
  process.env.NEXT_PUBLIC_MEDUSA_BACKEND_URL ?? 'http://localhost:9000';

let backend: URL;
try {
  backend = new URL(backendUrl);
} catch {
  // Fail loudly with guidance rather than letting `new URL` throw an opaque
  // TypeError that crashes the whole build.
  throw new Error(
    `NEXT_PUBLIC_MEDUSA_BACKEND_URL is not a valid URL: "${backendUrl}" — expected e.g. http://localhost:9000`,
  );
}
const protocol = backend.protocol.replace(':', '');
if (protocol !== 'http' && protocol !== 'https') {
  // Catches the schemeless case (e.g. "localhost:9000" parses with a bogus
  // "localhost:" protocol) before it silently produces a dead pattern.
  throw new Error(
    `NEXT_PUBLIC_MEDUSA_BACKEND_URL must start with http:// or https:// (got "${backendUrl}")`,
  );
}

const remotePatterns: NonNullable<
  NonNullable<NextConfig['images']>['remotePatterns']
> = [
  {
    protocol,
    hostname: backend.hostname,
    port: backend.port || undefined,
    pathname: '/static/**',
  },
];

// Next 16 added an SSRF guard to the image optimizer: after a remotePattern
// matches, fetchExternalImage() resolves the upstream host and rejects it with
// `400 "url" parameter is not allowed` if it lands on a private/loopback IP —
// the SAME error text as a host-allowlist miss (see node_modules/next/dist/
// server/image-optimizer.js — fetchExternalImage + is-private-ip). The local
// file provider serves from localhost:9000, which resolves to 127.0.0.1/::1, so
// every local card image 400s even though the pattern matches. The opt-out is
// `images.dangerouslyAllowLocalIP`. Scope it to local backends only so prod
// (public DO Spaces CDN host) keeps the guard. Self-hosted-on-LAN backends with
// the local provider also need it, hence the private-range check.
const isLocalHostname = (h: string): boolean => {
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '0.0.0.0' || h === '::1' || h === '[::1]') return true;
  if (/^127\./.test(h)) return true; // loopback
  if (/^10\./.test(h)) return true; // private class A
  if (/^192\.168\./.test(h)) return true; // private class C
  if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(h)) return true; // private class B
  if (/^169\.254\./.test(h)) return true; // link-local
  return false;
};
const dangerouslyAllowLocalIP = isLocalHostname(backend.hostname);

// Optional dedicated S3/R2/CDN media host (prod). It is the bucket's own public
// host, so the whole host is media — scope to its served prefix if you use one.
const mediaHost = process.env.NEXT_PUBLIC_MEDIA_HOST;
if (mediaHost) {
  remotePatterns.push({
    protocol: 'https',
    hostname: mediaHost,
    pathname: '/**',
  });
}

const securityHeaders = [
  // HSTS: 2 years, include subdomains, preload-eligible.
  {
    key: 'Strict-Transport-Security',
    value: 'max-age=63072000; includeSubDomains; preload',
  },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  // Lock down powerful features the storefront never uses.
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), browsing-topics=()',
  },
];

const nextConfig: NextConfig = {
  // Standalone output: the production Dockerfile (and DO App Platform) run the
  // server from `.next/standalone/server.js`. Without this, that dir is never
  // emitted and the Dockerfile's runner stage has nothing to copy.
  output: 'standalone',
  images: { remotePatterns, dangerouslyAllowLocalIP },
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;
