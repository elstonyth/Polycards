import { defineMiddlewares, authenticate } from "@medusajs/framework/http";
import {
  createAuthRateLimit,
  createPackOpenRateLimit,
  createStoreReadRateLimit,
  createVaultBuybackRateLimit,
} from "./utils/rate-limit";

// Custom-route middleware. /store/* is NOT a default customer-protected prefix
// (only /store/customers/me/* is), so every customer-owned route here must opt
// in to auth explicitly. Matchers stay narrow so the public, publishable-key-
// scoped GET /store/packs[/:slug] (catalog/detail) stay anonymous — verified by
// the middleware-regression probe.
//
// Customer auth is BEARER-ONLY: this backend never issues customer session
// cookies (POST /auth/session with a customer bearer returns 200 but sets no
// cookie — verified 2026-06-10; the storefront keeps the JWT in its own
// httpOnly cookie and always sends Bearer). Leaving "session" in the list
// would only re-open the cookie-auth CSRF surface on these POSTs the moment
// session transport ever started working, so it is dropped deliberately.
// (Admin SPA sessions are a different actor path and are not affected.)
//
// Rate limiters MUST stay after authenticate(): the array order is the
// execution order, so auth_context.actor_id is populated for keying, and
// unauthenticated requests are rejected with 401 before consuming any budget.
// The auth endpoints have no auth_context by nature — that limiter keys on the
// request IP (the middleware's designed fallback).

// One instance shared by the vault + credits matchers: the two reads travel
// together in the UI, so they share one budget (and one Redis connection).
const storeReadRateLimit = createStoreReadRateLimit();
const authRateLimit = createAuthRateLimit();

export default defineMiddlewares({
  routes: [
    // Brute-force/credential-stuffing protection on the public credential
    // endpoints (login, register, reset/update password) for every actor type
    // (/auth/customer/*, /auth/user/*, ...). Token refresh is NOT matched —
    // it is high-frequency, already requires a valid token, and throttling it
    // would log users out under normal use.
    {
      matcher: "/auth/*/emailpass",
      method: "POST",
      middlewares: [authRateLimit],
    },
    {
      matcher: "/auth/*/emailpass/*",
      method: "POST",
      middlewares: [authRateLimit],
    },
    {
      matcher: "/store/packs/*/open",
      middlewares: [
        authenticate("customer", ["bearer"]),
        createPackOpenRateLimit(),
      ],
    },
    {
      // The customer's vault list (GET /store/vault).
      matcher: "/store/vault",
      middlewares: [authenticate("customer", ["bearer"]), storeReadRateLimit],
    },
    {
      // Instant sell-back (POST /store/vault/:id/buyback).
      matcher: "/store/vault/*/buyback",
      middlewares: [
        authenticate("customer", ["bearer"]),
        createVaultBuybackRateLimit(),
      ],
    },
    {
      // Credit balance + ledger (GET /store/credits).
      matcher: "/store/credits",
      middlewares: [authenticate("customer", ["bearer"]), storeReadRateLimit],
    },
  ],
});
