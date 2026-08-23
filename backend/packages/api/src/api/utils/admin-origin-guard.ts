import type {
  MedusaNextFunction,
  MedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';

// Second layer behind `cookieOptions: { sameSite: 'lax' }` (medusa-config.ts),
// which is the actual fix for audit run-5 finding #1 (admin CSRF). This exists
// because the root fix is ONE config key that nothing else asserts: delete it,
// or set MEDUSA_WORKER_MODE/NODE_ENV somewhere new, and the framework silently
// goes back to sameSite:'none' on the admin session cookie with no test failing.
//
// Why CORS does not already do this: `cors` only short-circuits OPTIONS. On a
// non-preflight request it appends response headers and calls next()
// (node_modules/cors/lib/index.js — the `else { ... next() }` branch), so a
// disallowed origin still reaches the handler and still commits its write. CORS
// stops the attacker READING the reply, never the write itself. And a browser
// sends `application/x-www-form-urlencoded` (or multipart, or text/plain)
// cross-site with NO preflight at all, so nothing is even consulted first.
//
// ── The rules, and why each is what it is ────────────────────────────────────
//
// SAFE METHODS PASS. GET/HEAD/OPTIONS change no state, and OPTIONS in
// particular must reach the cors middleware to get its preflight answer —
// refusing it here would break every legitimate cross-origin admin call.
//
// AN ABSENT Origin PASSES. Origin is omitted on same-origin GETs in older
// browsers and on non-browser clients entirely, so requiring it would break the
// `curl`/CI/script callers that legitimately hold a bearer token or an API key.
// This is not the hole it looks like: a BROWSER always sends Origin on a
// cross-site POST (Fetch §3.1 — it is set for every request whose method is
// not GET/HEAD), so no forged form post can reach here without one, and a
// non-browser client has no ambient cookie to forge with in the first place.
//
// A PRESENT, NON-ALLOWLISTED Origin IS REFUSED. This is the whole guard.
//
// The allowlist is ADMIN_CORS itself, parsed per request rather than latched at
// import (the plan-066 convention), so the guard and the CORS layer can never
// drift to different origin sets. Trailing slashes are stripped on both sides
// because an operator pasting into the DO console will eventually add one.
//
// Deliberately NOT a Referer check: Referer is stripped by privacy extensions
// and by `Referrer-Policy: no-referrer`, so gating on it produces support
// tickets, and it adds nothing Origin does not already cover.

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** ADMIN_CORS as a set of normalised origins. Empty when unset — see below. */
const allowedOrigins = (): Set<string> =>
  new Set(
    (process.env.ADMIN_CORS ?? '')
      .split(',')
      .map((origin) => origin.trim().replace(/\/+$/, ''))
      .filter(Boolean),
  );

/**
 * Refuse a state-changing /admin request that carries a foreign `Origin`.
 *
 * FAILS OPEN when ADMIN_CORS is unset or empty, and that is deliberate: an
 * empty allowlist would refuse EVERY cross-origin admin write, including the
 * dev dashboard on :7000, and this is the belt to sameSite's braces — a
 * second-layer guard that bricks the admin panel on a missing env var is worse
 * than one that quietly stops guarding. Production always sets it
 * (.do/backend.app.yaml), and Medusa's own CORS layer already fails loudly
 * there if it is missing.
 */
export function refuseCrossOriginAdminWrite(
  req: MedusaRequest,
  _res: MedusaResponse,
  next: MedusaNextFunction,
): void {
  if (SAFE_METHODS.has(req.method)) return next();

  const origin = req.headers.origin;
  if (typeof origin !== 'string' || origin === '') return next();

  const allowed = allowedOrigins();
  if (allowed.size === 0) return next();
  if (allowed.has(origin.replace(/\/+$/, ''))) return next();

  // Origin is not echoed back — the message must not confirm to an attacker's
  // page which origins ARE allowed, and the response is unreadable to them
  // anyway. The refused origin is worth logging, but this middleware has no
  // logger of its own and the framework already logs the 4xx with its path.
  throw new MedusaError(
    MedusaError.Types.NOT_ALLOWED,
    'Cross-origin admin request refused.',
  );
}
