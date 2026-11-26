/**
 * Hosts that are never a public site: this machine, a private network, the
 * Tailscale tailnet (100.64.0.0/10, *.ts.net) and bare local names such as a
 * MagicDNS short name. Used to tell a local preview from the live site.
 */
const PRIVATE_HOST = [
  /^localhost$/,
  /\.localhost$/,
  /^127\.\d+\.\d+\.\d+$/,
  /^\[::1\]$/,
  /^::1$/,
  /^10\.\d+\.\d+\.\d+$/,
  /^192\.168\.\d+\.\d+$/,
  /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+$/,
  /\.ts\.net$/,
  /^[a-z0-9-]+$/i, // one label, no dot: a local name, never a public site
];

export function isPrivateHost(hostname: string): boolean {
  if (!hostname) return false;
  return PRIVATE_HOST.some((re) => re.test(hostname));
}

/** The name in a Host header, without its port (`[::1]:4320` keeps its brackets). */
export function hostnameOf(host: string): string {
  if (host.startsWith('[')) return host.slice(0, host.indexOf(']') + 1);
  return host.split(':')[0] ?? '';
}

/**
 * Whether a cookie is Secure. Always on the live site and on https; off only
 * for a production build served over plain http on a private host (the local
 * and tailnet preview), where a browser drops a Secure cookie and the page
 * then looks signed in to a server that sees no session (an iPhone recording,
 * 11-23: every tap on Me bounced home).
 */
export function secureCookieFor(req: {
  prod: boolean;
  /** x-forwarded-proto, when a proxy set it */
  proto: string | null;
  /** the Host header */
  host: string;
}): boolean {
  if (!req.prod) return false;
  if (req.proto?.split(',')[0]?.trim() === 'https') return true;
  return !isPrivateHost(hostnameOf(req.host));
}
