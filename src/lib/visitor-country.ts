import ip3country from 'ip3country';

/**
 * Visitor countries that may request a phone verification code.
 *
 * Why (2026-10-03): one phone in Egypt cycled ~21 Malaysian numbers in 12
 * minutes to farm free welcome packs. It passed Cloudflare Turnstile as a
 * human, so the human check could not stop it, and every code it requested was
 * a paid SMS. Polycards serves Malaysia and Singapore only.
 *
 * The visitor's address comes from `do-connecting-ip`, which DigitalOcean's
 * App Platform ingress sets on every request; App Platform does not forward
 * Cloudflare's CF-IPCountry, so the country is looked up here.
 */
export const OTP_VISITOR_COUNTRIES: readonly string[] = ['MY', 'SG'];

let initialised = false;

/**
 * ISO 3166 alpha-2 country of an IPv4 address, or null when unknown.
 *
 * ponytail: IPv4 only (ip3country, IP2Location LITE data, ~0.5 MB). IPv6,
 * private and unparseable addresses return null and are let through, so a
 * Malaysian on IPv6 is never blocked. If abuse moves to IPv6, swap in a v4+v6
 * database such as geoip-country.
 */
export function countryOfIp(ip: string | null | undefined): string | null {
  const v4 = (ip ?? '').trim().replace(/^::ffff:/i, '');
  const octets = v4.split('.');
  if (
    octets.length !== 4 ||
    !octets.every((o) => /^\d{1,3}$/.test(o) && Number(o) <= 255)
  )
    return null;
  if (!initialised) {
    ip3country.init();
    initialised = true;
  }
  return ip3country.lookupStr(v4);
}
