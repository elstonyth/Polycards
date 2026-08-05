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
