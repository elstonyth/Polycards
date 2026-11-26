import { createHmac, timingSafeEqual } from 'node:crypto';
import { isPrivateHost } from '@/lib/private-host';

/**
 * Sign-in without a password, for testing the storefront locally against the
 * prod-copy backend (reports/ops-monitor/run-on-prod-copy.mjs), where Google
 * sign-in cannot work. It signs the same session token the backend would,
 * with the copy backend's LOCAL secret, so a token it makes is worthless
 * anywhere else.
 *
 * Off unless ALL hold, checked on every request:
 * - `LOCAL_SIGN_IN=1` in the server's environment at run time (only the local
 *   launch sets it; no deploy config does),
 * - `LOCAL_SIGN_IN_SECRET` and `LOCAL_SIGN_IN_ACCOUNTS` set
 *   (`<customer id>:<auth identity id>`, comma separated: only these accounts),
 * - the backend the build talks to is on this machine or a private network
 *   (the live backend is a public host, so the live site can never pass this).
 */

export type LocalAccount = { customerId: string; authIdentityId: string };
export type LocalSignIn = { secret: string; accounts: LocalAccount[] };

type Env = Record<string, string | undefined>;

function isLocalBackend(url: string | undefined): boolean {
  // unset: the SDK's own default, http://localhost:9000 (src/lib/medusa.ts)
  if (url === undefined) return true;
  try {
    return isPrivateHost(new URL(url).hostname);
  } catch {
    return false;
  }
}

export function localSignInConfig(env: Env): LocalSignIn | null {
  if (env.LOCAL_SIGN_IN !== '1') return null;
  if (!isLocalBackend(env.NEXT_PUBLIC_MEDUSA_BACKEND_URL)) return null;
  const secret = env.LOCAL_SIGN_IN_SECRET ?? '';
  if (!secret) return null;
  const accounts = (env.LOCAL_SIGN_IN_ACCOUNTS ?? '')
    .split(',')
    .map((pair) => pair.trim().split(':'))
    .filter((p): p is [string, string] => p.length === 2 && !!p[0] && !!p[1])
    .map(([customerId, authIdentityId]) => ({ customerId, authIdentityId }));
  return accounts.length ? { secret, accounts } : null;
}

const b64 = (v: unknown) =>
  Buffer.from(JSON.stringify(v)).toString('base64url');

/** The claims the backend's `authenticate()` reads (as backend/.../qa-mint-google-customer.ts signs them). */
export function signLocalToken(
  secret: string,
  account: LocalAccount,
  nowSeconds = Math.floor(Date.now() / 1000),
): string {
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64({
    actor_id: account.customerId,
    actor_type: 'customer',
    auth_identity_id: account.authIdentityId,
    app_metadata: { customer_id: account.customerId },
    iat: nowSeconds,
    exp: nowSeconds + 86_400,
  });
  const sig = createHmac('sha256', secret)
    .update(`${head}.${body}`)
    .digest('base64url');
  return `${head}.${body}.${sig}`;
}

/** A token signed with `secret` that has more than an hour left (else the proxy signs a fresh one). */
export function localTokenValid(
  secret: string,
  token: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
  const [head, body, sig, extra] = token.split('.');
  if (!head || !body || !sig || extra !== undefined) return false;
  const want = Buffer.from(
    createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url'),
  );
  const got = Buffer.from(sig);
  if (got.length !== want.length || !timingSafeEqual(got, want)) return false;
  try {
    const { exp } = JSON.parse(Buffer.from(body, 'base64url').toString()) as {
      exp?: unknown;
    };
    return typeof exp === 'number' && exp - nowSeconds > 3_600;
  } catch {
    return false;
  }
}

/**
 * Only a path on this site: not `//host` or `/\host`, which browsers treat as
 * another site, and nothing with a tab or line break, which browsers drop
 * before reading the address (`/<tab>/host` is `//host` to them).
 */
export function safeNextPath(next: string | null): string {
  if (
    !next ||
    !next.startsWith('/') ||
    next.startsWith('//') ||
    /[\t\n\r\\]/.test(next)
  )
    return '/me';
  return next;
}
