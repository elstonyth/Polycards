import type {
  MedusaNextFunction,
  MedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { isIP, isIPv6 } from 'node:net';

// The visitor address the storefront vouches for.
//
// On its own the backend cannot tell storefront visitors apart: the storefront
// calls it from its own servers, and on App Platform req.ip names
// DigitalOcean's ingress for every caller. So the storefront signs the
// address its own ingress reported for the visitor (`do-connecting-ip`) onto
// each request it makes on that visitor's behalf (src/lib/visitor-ip.ts in
// the storefront):
//
//   x-visitor-ip:  <address>
//   x-visitor-sig: <unix seconds>.<hex HMAC-SHA256(secret, address + "|" + seconds)>
//
// keyed with STOREFRONT_VISITOR_SECRET, which both apps carry. A valid pair
// lets the IP-keyed rate limiters key on the visitor (rate-limit.ts), and lets
// POST /store/phone-verification/start insist the request came through the
// storefront, where the visitor-country gate runs (requireVouchedVisitor).
//
// STOREFRONT_VISITOR_SECRET unset = nothing is vouched for and nothing is
// enforced, which is how this ships dark. Give the storefront the secret
// first and let it sign; only then give it to the backend.

const VISITOR_IP_HEADER = 'x-visitor-ip';
const VISITOR_SIG_HEADER = 'x-visitor-sig';
// Both apps keep synced clocks. Five minutes absorbs drift and a slow hop, and
// bounds how long one signed pair stays usable.
const MAX_SKEW_S = 300;

type RequestHeaders = Record<string, string | string[] | undefined>;

/** The vouched address, or why the request's pair does not vouch for one. */
function verify(
  headers: RequestHeaders | undefined,
  secret: string,
  nowMs: number,
): { ip: string } | { why: string } {
  const ip = headers?.[VISITOR_IP_HEADER];
  const sig = headers?.[VISITOR_SIG_HEADER];
  if (ip === undefined && sig === undefined) return { why: 'missing' };
  // A string[] is a repeated header; isIP is 0 for a comma-joined list.
  const parts =
    typeof sig === 'string' ? /^(\d{1,12})\.([0-9a-f]{64})$/.exec(sig) : null;
  if (typeof ip !== 'string' || !isIP(ip) || !parts)
    return { why: 'malformed' };
  if (Math.abs(Math.floor(nowMs / 1000) - Number(parts[1])) > MAX_SKEW_S)
    return { why: 'stale' };
  const expected = createHmac('sha256', secret)
    .update(`${ip}|${parts[1]}`)
    .digest();
  return timingSafeEqual(expected, Buffer.from(parts[2], 'hex'))
    ? { ip }
    : { why: 'mismatch' };
}

/**
 * The visitor address the storefront vouched for on this request, or null:
 * no secret configured, no pair, or a pair that does not verify.
 *
 * Only `headers` is needed, so the parameter is a narrow structural type (the
 * payer-ip.ts convention): callable from any route shape, testable with plain
 * objects.
 */
export function vouchedVisitorIp(
  req: { headers?: RequestHeaders },
  nowMs: number = Date.now(),
): string | null {
  const secret = process.env.STOREFRONT_VISITOR_SECRET;
  if (!secret) return null;
  const verdict = verify(req.headers, secret, nowMs);
  return 'ip' in verdict ? verdict.ip : null;
}

/**
 * The rate-limit identity of a vouched address: an IPv4 address itself, and
 * for IPv6 its /64. One subscriber is normally handed a whole /64 and the
 * device picks the low 64 bits itself, so keying on the full address would
 * let one visitor step through fresh budgets inside their own block.
 */
export function visitorBucket(ip: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped) return mapped[1];
  if (!isIPv6(ip)) return ip;
  const [head, tail] = ip.split('%')[0].split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  // An embedded dotted quad is the last 32 bits: two groups, never in the /64.
  const rightGroups = right.reduce((n, g) => n + (g.includes('.') ? 2 : 1), 0);
  const groups =
    tail === undefined
      ? left
      : [...left, ...Array(8 - left.length - rightGroups).fill('0'), ...right];
  const prefix = groups
    .slice(0, 4)
    .map((g) => parseInt(g, 16).toString(16))
    .join(':');
  return `${prefix}::/64`;
}

/**
 * POST /store/phone-verification/start only takes requests the storefront
 * signed. The visitor-country gate (src/lib/visitor-country.ts) runs in the
 * storefront alone, so this is what keeps it in front of every code request.
 * Runs FIRST on that matcher (middlewares.ts): a refused request costs no
 * Turnstile check, no per-phone slot and no sitewide budget.
 *
 * Steps aside while STOREFRONT_VISITOR_SECRET is unset, so the storefront can
 * be given the secret and start signing before this starts refusing. Only the
 * start route enforces; everywhere else an unsigned request is served and
 * simply keyed on req.ip, as before.
 */
export function requireVouchedVisitor(
  req: MedusaRequest,
  _res: MedusaResponse,
  next: MedusaNextFunction,
): void {
  const secret = process.env.STOREFRONT_VISITOR_SECRET;
  if (!secret) return next();
  const verdict = verify(req.headers, secret, Date.now());
  if ('ip' in verdict) return next();
  // The reason alone is the diagnosis: 'mismatch' on every request means the
  // two apps carry different secrets, 'stale' a clock that has drifted.
  (req.scope.resolve('logger') as { warn: (msg: string) => void }).warn(
    `[phone-otp] refused a code request without a valid storefront signature (${verdict.why})`,
  );
  next(
    new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      'Please request your code from polycards.gg.',
    ),
  );
}
