import { tgpayCallbackIpVerdict } from '../../modules/packs/tgpay-client';
// The IP a money route reports to GlobePay365 in its `IPAddress` field.
//
// THEIR requirement is the paying customer's IP, not ours. req.ip FIRST:
// Medusa's express-loader sets `trust proxy` 1 unconditionally, so req.ip is
// derived from the proxy chain and a client cannot set it. The raw
// X-Forwarded-For first hop is client-controlled — reading it first let a
// caller choose the IP we report to GlobePay365, so it is only a fallback for
// a deployment where req.ip is somehow empty.
//
// This lives here because the deposit and withdrawal routes landed in the same
// commit with OPPOSITE orderings: deposit read req.ip first, withdrawal read
// the header first, so the money-OUT direction — the one a PSP runs geo,
// velocity and AML checks on — was the unhardened half. One helper, both
// routes, and the pair cannot drift again.
//
// KNOW WHAT THIS VALUE IS. In the shipped topology both money routes are
// called from storefront `'use server'` actions, which forward no client
// headers, so this resolves to the STOREFRONT'S EGRESS IP — one constant for
// every customer, not the end customer's address. Its job is to be
// UN-FORGEABLE, not geolocatable: the route is reachable directly with a
// customer bearer, and the old header-first ordering let that caller choose
// the IP we reported. Don't build anything on this being per-customer.
//
// Only `ip`, `headers` and `socket` are needed, so the parameter is a narrow
// structural type rather than the full request type: it keeps the helper
// callable from any route shape and keeps its unit tests to plain objects.
export function payerIpOf(req: {
  ip?: string;
  headers: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string };
}): string {
  // The type permits `string[]`. Node's parser never emits one for this header
  // (it comma-joins repeats; only set-cookie is arrayed), but in-process
  // middleware could assign one — so it falls through to the socket rather
  // than being stringified.
  const forwarded = req.headers['x-forwarded-for'];
  return (
    req.ip ||
    (typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : '') ||
    req.socket?.remoteAddress ||
    '0.0.0.0'
  );
}

/**
 * The address a CALLBACK really came from, for allow-listing. Only what the
 * trusted proxy chain established: Express's `req.ip` (Medusa sets
 * `trust proxy` 1, so this is the hop DigitalOcean's load balancer appended)
 * or, without a proxy, the socket peer. The raw X-Forwarded-For header is
 * deliberately NOT a fallback here — a caller writes that header, so it can
 * name any address it likes; payerIpOf tolerates it only because the payer
 * IP is informational. An allowlist that trusted it would be theatre, which
 * is exactly what TGPay warned about ("不要用 x-forwarded-for 做白名单").
 * IPv4-mapped IPv6 ("::ffff:1.2.3.4") is unwrapped so it compares as IPv4.
 */
export function callbackSourceIp(req: {
  ip?: string;
  socket?: { remoteAddress?: string };
}): string {
  const raw = req.ip || req.socket?.remoteAddress || '';
  return raw.replace(/^::ffff:/i, '');
}

/**
 * Express middleware for `/hooks/tgpay/*`: TGPay's source allowlist, applied
 * once for every TGPay callback route so the two hooks cannot drift. Runs
 * after the hook rate limiter (IP-keyed, so a flood from a foreign address
 * is throttled before it is even judged) and before any handler work. A
 * refusal is a constant 403 body plus one log line naming the address and
 * the reason — never a header or a key.
 */
export function createTgpayCallbackAllowlist(): (
  req: {
    ip?: string;
    socket?: { remoteAddress?: string };
    scope: { resolve: <T>(key: string) => T };
  },
  res: { status: (code: number) => { send: (body: string) => unknown } },
  next: () => void,
) => void {
  return (req, res, next) => {
    const sourceIp = callbackSourceIp(req);
    const verdict = tgpayCallbackIpVerdict(sourceIp);
    if (verdict.allowed) {
      next();
      return;
    }
    req.scope
      .resolve<{ warn: (m: string) => void }>('logger')
      .warn(
        `[tgpay] rejected callback from ${sourceIp || 'unknown'}: ${verdict.reason}` +
          (verdict.reason === 'unset-in-production'
            ? ' — TGPAY_CALLBACK_IPS is not set; refusing outside the sandbox'
            : verdict.reason === 'unparseable'
              ? ' — TGPAY_CALLBACK_IPS has no valid entries'
              : ''),
      );
    res.status(403).send('rejected');
  };
}
