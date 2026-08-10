import type {
  MedusaNextFunction,
  MedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';

// Every /store response carrying a verified customer identity is per-customer
// data — a vault, a credit balance, a notification feed, a saved payout
// account. None of it may be stored and replayed across identities
// (CWE-525: sensitive information in a browser cache).
//
// Registered ONCE as a blanket /store/* matcher rather than per route, for the
// same reason blockDisabledCustomerSession is: the framework registers
// `app.use('/store', authenticate('customer', ['bearer','session'],
// { allowUnauthenticated: true }))` before any middleware from
// middlewares.ts, so req.auth_context is already populated whenever a valid
// bearer is present. That buys two things per-route wiring cannot:
//
//   - routes with NO entry in middlewares.ts are still covered
//     (/store/customers/me and its addresses are framework-authed), and
//   - a route added next month is covered without anyone remembering to opt in.
//
// Anonymous store traffic carries no auth_context and passes through
// untouched, so the public catalog stays cacheable.
//
// RFC 9111 §3.5 already bars a SHARED cache from storing a response to an
// Authorization-bearing request without an explicit opt-in. This closes the
// PRIVATE browser cache too, and states the intent in the response rather than
// leaving it to every intermediary to implement that clause correctly.
export function noStoreForAuthenticatedStore(
  req: MedusaRequest,
  res: MedusaResponse,
  next: MedusaNextFunction,
): void {
  const auth = (
    req as { auth_context?: { actor_id?: string; actor_type?: string } }
  ).auth_context;
  if (auth?.actor_id && auth.actor_type === 'customer') {
    res.setHeader('Cache-Control', 'no-store');
  }
  next();
}

// The /admin sibling of the above — same blanket-matcher reasoning (see that
// comment), applied to admin JSON that carries player emails, per-player money
// movement and payout details. Two facts are specific to admin:
//
//   - Admin auth is a COOKIE SESSION (apps/admin/src/lib/admin-rest.ts uses
//     credentials: 'include'), not an Authorization header. RFC 9111 §3.5's bar
//     on a shared cache storing an authenticated response is scoped to
//     `Authorization`, so it does not cover /admin at all — this header is the
//     only thing stating the intent. The threat is admin JSON outliving a
//     session in the browser cache of a shared operator workstation
//     (CWE-524/525), not cross-user CDN leakage.
//   - admin/globepay/{deposits,withdrawals}/route.ts set this by hand and keep
//     doing so; a handler-set header still wins, so those stay a no-op overlap
//     rather than a conflict.
//
// Gated on the actor types the framework itself sets for the /admin namespace,
// read from the installed packages rather than assumed:
// @medusajs/framework/dist/http/router.js:89 mounts
// `app.use('/admin', authenticate('user', ['bearer','session','api-key']))`
// BEFORE any middleware from middlewares.ts is registered, so req.auth_context
// is already populated here. That authenticate() resolves to actor_type 'user'
// for a session/JWT admin and 'api-key' for a secret-API-key caller
// (authenticate-middleware.js:21-26) — both are admin identities on this
// namespace, and covering only 'user' would leave the same "someone has to
// remember" gap this blanket matcher exists to close. A customer actor is
// impossible here (authenticate filters by permitted actor type and 401s
// otherwise) but is excluded explicitly so the two middlewares stay
// independent.
export function noStoreForAuthenticatedAdmin(
  req: MedusaRequest,
  res: MedusaResponse,
  next: MedusaNextFunction,
): void {
  const auth = (
    req as { auth_context?: { actor_id?: string; actor_type?: string } }
  ).auth_context;
  if (
    auth?.actor_id &&
    (auth.actor_type === 'user' || auth.actor_type === 'api-key')
  ) {
    res.setHeader('Cache-Control', 'no-store');
  }
  next();
}
