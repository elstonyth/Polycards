import { isIP } from 'node:net';
import geoip from 'geoip-country';

/**
 * Visitor countries that may request a phone verification code.
 *
 * Why (2026-10-03): one phone in Egypt cycled ~21 Malaysian numbers in 12
 * minutes to farm free welcome packs. It passed Cloudflare Turnstile as a
 * human, so the human check could not stop it, and every code it requested was
 * a paid SMS. Narrowed from MY+SG to MY on 2026-10-04 (operator request) after
 * the farmer kept returning through a US VPN.
 *
 * The visitor's address comes from `do-connecting-ip`, which DigitalOcean's
 * App Platform ingress sets on every request; App Platform does not forward
 * Cloudflare's CF-IPCountry, so the country is looked up here.
 *
 * The gate runs only here, in the storefront. What keeps it in front of every
 * code request is the backend: once it has STOREFRONT_VISITOR_SECRET it
 * refuses an OTP start that the storefront did not sign
 * (backend/packages/api/src/api/utils/visitor-ip.ts), so a direct call to the
 * backend cannot step around it.
 */
export const OTP_VISITOR_COUNTRIES: readonly string[] = ['MY'];

/**
 * ISO 3166 alpha-2 country of an IPv4 or IPv6 address, or null when unknown.
 *
 * geoip-country carries MaxMind's GeoLite2 country data for both families
 * (loaded from its data files at first use; next.config.ts keeps the package
 * external and traces the files into the standalone build). Private and
 * unparseable addresses return null.
 */
export function countryOfIp(ip: string | null | undefined): string | null {
  const addr = (ip ?? '').trim();
  if (!isIP(addr)) return null;
  return geoip.lookup(addr)?.country ?? null;
}

/**
 * Why a request whose `do-connecting-ip` header is `header` may not ask for a
 * code, or null when it may. No header at all (local dev, tests) passes. A
 * header that is present must name exactly one address in a served country:
 * several addresses (a client-sent value joined with the ingress's own), an
 * unparseable or private address, or one with no known country is refused,
 * never waved through.
 */
export function visitorRefusal(header: string | null): string | null {
  if (header === null) return null;
  if (header.includes(',')) return 'more than one visitor address';
  const country = countryOfIp(header);
  if (!country) return 'a visitor address with no known country';
  return OTP_VISITOR_COUNTRIES.includes(country)
    ? null
    : `visitor country ${country}`;
}
