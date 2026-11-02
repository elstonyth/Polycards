/**
 * The storefront vouches for its visitor to the backend.
 *
 * On its own the backend cannot tell storefront visitors apart: this server
 * makes every call, and on App Platform the backend's `req.ip` names
 * DigitalOcean's ingress for every caller. So a backend request made on a
 * visitor's behalf carries the address DigitalOcean's ingress reported for
 * them (`do-connecting-ip`), signed with STOREFRONT_VISITOR_SECRET, which the
 * backend shares and checks (backend/packages/api/src/api/utils/visitor-ip.ts):
 *
 *   x-visitor-ip:  <address>
 *   x-visitor-sig: <unix seconds>.<hex HMAC-SHA256(secret, address + "|" + seconds)>
 *
 * With a valid pair the backend keys its IP rate limits on the visitor instead
 * of on this server, and once it has the secret it refuses an OTP start that
 * carries none — which is what keeps the visitor-country gate
 * (src/lib/visitor-country.ts) in front of every code request.
 *
 * No secret, no header, or a header that is not exactly one address: nothing
 * is added, and the backend keys that request as it always has. Server-only:
 * the secret must never reach a browser bundle.
 *
 * Beside the pair goes a random id for this browser (x-visitor-device, from the
 * DEVICE_COOKIE first-party cookie), for support's same-device flag (ADR 0016). A
 * security cookie, so it is set whichever way the cookie banner was answered.
 * It is created on a write only: an anonymous page must not carry a Set-Cookie,
 * or the CDN stops caching it.
 */
import 'server-only';
import { createHmac, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { cookies, headers } from 'next/headers';
import type { FetchArgs } from '@medusajs/js-sdk';

const DEVICE_COOKIE = '_polycards_device';
const DEVICE_COOKIE_MAX_AGE = 60 * 60 * 24 * 400; // the most browsers allow
const DEVICE_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** This browser's id, or null: none yet on a read, or nowhere to set one (a
 *  render reads cookies but only a server action or route handler can set them). */
async function deviceId(write: boolean): Promise<string | null> {
  try {
    const store = await cookies();
    const current = store.get(DEVICE_COOKIE)?.value;
    if (current && DEVICE_ID.test(current)) return current;
    if (!write) return null;
    const fresh = randomUUID();
    store.set(DEVICE_COOKIE, fresh, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: DEVICE_COOKIE_MAX_AGE,
    });
    return fresh;
  } catch {
    return null;
  }
}

async function visitorPair(
  secret: string,
): Promise<Record<string, string> | null> {
  let ip: string | null;
  try {
    ip = (await headers()).get('do-connecting-ip');
  } catch {
    return null; // no request scope: build, cron
  }
  // isIP is 0 for a comma-joined list as well as for anything unreadable.
  if (!ip || !isIP(ip)) return null;
  const ts = Math.floor(Date.now() / 1000);
  const mac = createHmac('sha256', secret).update(`${ip}|${ts}`).digest('hex');
  return { 'x-visitor-ip': ip, 'x-visitor-sig': `${ts}.${mac}` };
}

/**
 * `init` with the visitor's signed address added — for a write, or for a read
 * that asked for `no-store`. Any other read goes out as it is, without even a
 * look at the request headers: the Store port's public `cache: 'auto'` loaders
 * run inside static and ISR renders (src/app/page.tsx, getPackHighlights'
 * unstable_cache), and reading the request's headers there would turn the
 * route dynamic. A write never runs in a render, and a no-store read already
 * makes its route dynamic (Next 16 docs, functions/fetch.md).
 */
export async function withVisitor(
  init?: FetchArgs,
): Promise<FetchArgs | undefined> {
  const secret = process.env.STOREFRONT_VISITOR_SECRET;
  if (!secret) return init;
  const method = (init?.method ?? 'GET').toUpperCase();
  const read = method === 'GET' || method === 'HEAD';
  if (read && init?.cache !== 'no-store') return init;
  const pair = await visitorPair(secret);
  if (!pair) return init;
  const device = await deviceId(!read);
  return {
    ...init,
    // Last, so the pair always names the address that was signed.
    headers: {
      ...init?.headers,
      ...(device ? { 'x-visitor-device': device } : {}),
      ...pair,
    },
  };
}
