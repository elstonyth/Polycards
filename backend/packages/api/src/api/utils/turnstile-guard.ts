import type {
  MedusaNextFunction,
  MedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';

// Cloudflare Turnstile in front of POST /store/phone-verification/start.
//
// That route is public and every call it lets through bills a real SMS
// (Malaysia: $0.3389 a segment) or a voice call. Its other limits cannot tell a
// script from a person: the per-phone tier is useless against a pumping run
// over fresh numbers, the IP tier at best sees one address per visitor (the
// storefront's signature, utils/visitor-ip.ts) and a run can rotate those
// too, and the sitewide budget only turns the spend into a lockout of real
// customers once a bot drains it. On 2026-10-01 a script was still requesting
// a signup code for a fresh +60 number every ten minutes through the
// storefront's server action and never checking one. A human check per send
// is the control that tells them apart.
//
// Runs ahead of both limiter tiers on the start matcher (middlewares.ts; only
// the storefront-signature check, which costs no network call, runs before
// it), so a request without a valid token spends neither a per-phone slot nor
// the sitewide budget, and the refusal is identical for every purpose — it
// says nothing about accounts.
//
// TURNSTILE_SECRET_KEY unset = skip. That is how this ships dark, and unsetting
// it is the rollback lever. Set it only once a storefront build carrying
// NEXT_PUBLIC_TURNSTILE_SITE_KEY is live, or every code request is refused.

/** Must equal the storefront widget's `action` (src/lib/turnstile.ts). */
export const TURNSTILE_ACTION = 'phone-otp';

const SITEVERIFY_URL =
  'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const SITEVERIFY_TIMEOUT_MS = 5_000;
// Cloudflare's documented maximum; anything longer is not a token.
const MAX_TOKEN_LENGTH = 2048;

/** Why the token was refused, or null when Cloudflare vouches for it. */
async function refusal(secret: string, token: unknown): Promise<string | null> {
  if (typeof token !== 'string' || !token) return 'missing token';
  if (token.length > MAX_TOKEN_LENGTH) return 'oversized token';
  let res: Response;
  try {
    res = await fetch(SITEVERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret, response: token }).toString(),
      signal: AbortSignal.timeout(SITEVERIFY_TIMEOUT_MS),
    });
  } catch {
    // Fail CLOSED. Both apps sit behind Cloudflare, so an outage that hides
    // siteverify has usually taken the storefront down with it — failing open
    // here would buy nothing but a window of unchallenged paid sends.
    return 'siteverify unreachable';
  }
  if (!res.ok) return `siteverify ${res.status}`;
  const body = (await res.json().catch(() => ({}))) as {
    success?: unknown;
    action?: unknown;
    'error-codes'?: unknown;
  };
  if (body.success !== true) {
    const codes = Array.isArray(body['error-codes'])
      ? body['error-codes'].join(',')
      : '';
    // invalid-input-secret here means the deploy carries the wrong secret and
    // EVERY send is being refused — the code is the whole diagnosis.
    return `rejected: ${codes || 'no error codes'}`;
  }
  // Cloudflare's testing secrets answer without an `action`; a real key always
  // echoes the widget's, so only a mismatch is refused.
  if ((body.action ?? TURNSTILE_ACTION) !== TURNSTILE_ACTION)
    return 'wrong action';
  return null;
}

export async function requireTurnstile(
  req: MedusaRequest,
  _res: MedusaResponse,
  next: MedusaNextFunction,
): Promise<void> {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) return next();
  const why = await refusal(
    secret,
    (req.body as { turnstile_token?: unknown } | undefined)?.turnstile_token,
  );
  if (!why) return next();
  // Never the token or the phone — the reason alone is the diagnosis.
  (req.scope.resolve('logger') as { warn: (msg: string) => void }).warn(
    `[phone-otp] turnstile refused the send (${why})`,
  );
  // Deliberately not the "Try again in Ns" shape: the storefront reads that as
  // a cooldown, and no slot was spent, so the caller may retry at once.
  next(
    new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      'Security check failed. Please try again.',
    ),
  );
}
