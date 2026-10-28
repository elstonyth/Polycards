import {
  callbackIpAllowed,
  parseCallbackAllowlist,
  tgpayCallbackIpVerdict,
  tgpayEnvName,
  type TgpayKind,
} from '../../modules/packs/tgpay-client';
import {
  A3PAY_FAMILY,
  type A3payKind,
} from '../../modules/packs/a3pay-client';
// The IP a money route reports to the gateway as the payer IP.
//
// THEIR requirement is the paying customer's IP, not ours. req.ip FIRST:
// Medusa's express-loader sets `trust proxy` 1 unconditionally, so req.ip is
// derived from the proxy chain and a client cannot set it. The raw
// X-Forwarded-For first hop is client-controlled — reading it first let a
// caller choose the IP we report to the gateway, so it is only a fallback for
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
 * The address a CALLBACK really came from, for allow-listing.
 *
 * On DigitalOcean App Platform the client's address is in the
 * `do-connecting-ip` header the ingress sets on every request; there,
 * `x-forwarded-for` (and therefore Express's `req.ip`) names the DigitalOcean
 * ingress server, not the caller (docs.digitalocean.com/support/where-can-i-
 * find-the-client-ip-address-of-a-request-connecting-to-my-app). So the
 * order is: the ingress's header, then `req.ip` (Medusa sets `trust proxy`
 * 1, so behind a single ordinary proxy that is the proxy-appended client),
 * then the socket peer. The raw x-forwarded-for value is never read here — a
 * caller writes that header and can name any address, which is exactly what
 * TGPay warned against ("不要用 x-forwarded-for 做白名单"). The same holds
 * for a caller-written `do-connecting-ip` OUTSIDE App Platform; in
 * production every request reaches us through the ingress, which sets it.
 * IPv4-mapped IPv6 ("::ffff:1.2.3.4") is unwrapped so it compares as IPv4.
 */
export function callbackSourceIp(req: {
  ip?: string;
  headers?: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string };
}): string {
  const fromIngress = req.headers?.['do-connecting-ip'];
  const ingress = Array.isArray(fromIngress) ? fromIngress[0] : fromIngress;
  const raw =
    (typeof ingress === 'string' && ingress.trim()) ||
    req.ip ||
    req.socket?.remoteAddress ||
    '';
  return raw.replace(/^::ffff:/i, '');
}

/**
 * Express middleware for `/hooks/<gateway>/*`: that gateway's source
 * allowlist, applied once for every callback route of the gateway so its
 * hooks cannot drift. Runs after the hook rate limiter (keyed on the same
 * source address, so a flood from a foreign address is throttled before it is
 * even judged) and before any handler work. One accepted line per callback —
 * how the first production callback proves which address the ingress really
 * reports — and a refusal is a constant 403 body plus one log line naming the
 * address and the reason, never a header or a key. `judge` is the gateway's
 * own rule (env name, default list, sandbox leniency).
 */
function callbackAllowlist(
  tag: string,
  judge: (sourceIp: string) => { allowed: true } | { allowed: false; reason: string },
): CallbackAllowlist {
  return (req, res, next) => {
    const sourceIp = callbackSourceIp(req);
    const verdict = judge(sourceIp);
    if (verdict.allowed) {
      req.scope
        .resolve<{ info: (m: string) => void }>('logger')
        .info(`[${tag}] callback from ${sourceIp || 'unknown'} accepted`);
      next();
      return;
    }
    req.scope
      .resolve<{ warn: (m: string) => void }>('logger')
      .warn(
        `[${tag}] rejected callback from ${sourceIp || 'unknown'}: ${verdict.reason}`,
      );
    res.status(403).send('rejected');
  };
}

type CallbackAllowlist = (
  req: {
    ip?: string;
    headers?: Record<string, string | string[] | undefined>;
    socket?: { remoteAddress?: string };
    scope: { resolve: <T>(key: string) => T };
  },
  res: { status: (code: number) => { send: (body: string) => unknown } },
  next: () => void,
) => void;

/** TGPay's platform (TGPay, The 7 Pay): <PREFIX>_CALLBACK_IPS, header-only in
 *  the sandbox, refused in production when unset. */
export function createTgpayCallbackAllowlist(
  kind: TgpayKind = 'tgpay',
): CallbackAllowlist {
  const listName = tgpayEnvName(kind, 'CALLBACK_IPS');
  return callbackAllowlist(kind, (sourceIp) => {
    const verdict = tgpayCallbackIpVerdict(sourceIp, process.env, kind);
    if (verdict.allowed) return verdict;
    return {
      allowed: false,
      reason:
        verdict.reason +
        (verdict.reason === 'unset-in-production'
          ? ` — ${listName} is not set; refusing outside the sandbox`
          : verdict.reason === 'unparseable'
            ? ` — ${listName} has no valid entries`
            : ''),
    };
  });
}

/**
 * A3Pay's documented outbound address ("A3pay Outgoing IP", handbook
 * v3.3.5). A3PAY_CALLBACK_IPS overrides it (IPv4 / CIDR, comma separated) —
 * locally that is 127.0.0.1 for scripts/a3pay-mock.mjs.
 */
export const A3PAY_DEFAULT_CALLBACK_IPS = '13.192.222.226';

/**
 * GlobePay365's PRODUCTION outbound address (API doc, 2026-10-12). Its
 * staging callbacks come from 160.250.92.219 instead — set
 * GP365_CALLBACK_IPS to that while pointed at staging.
 */
export const GP365_DEFAULT_CALLBACK_IPS = '13.159.14.239';

const A3PAY_FAMILY_CALLBACK_IPS: Record<A3payKind, string> = {
  a3pay: A3PAY_DEFAULT_CALLBACK_IPS,
  gp365: GP365_DEFAULT_CALLBACK_IPS,
};

/**
 * `/hooks/<kind>/*` for a tenant of the A3Pay platform (A3Pay, GlobePay365).
 * Defence in depth only: the RSA signature over the decrypted payload is the
 * real gate, checked inside each handler. A list that is set but parses to
 * nothing refuses everything rather than quietly disabling the check.
 */
export function createA3payCallbackAllowlist(
  env: Partial<Record<string, string>> = process.env,
  kind: A3payKind = 'a3pay',
): CallbackAllowlist {
  const listName = `${A3PAY_FAMILY[kind].envPrefix}_CALLBACK_IPS`;
  return callbackAllowlist(kind, (sourceIp) => {
    const entries = parseCallbackAllowlist(
      env[listName]?.trim() || A3PAY_FAMILY_CALLBACK_IPS[kind],
    );
    if (entries.length === 0)
      return {
        allowed: false,
        reason: `unparseable — ${listName} has no valid entries`,
      };
    return callbackIpAllowed(sourceIp, entries)
      ? { allowed: true }
      : { allowed: false, reason: 'not-listed' };
  });
}
