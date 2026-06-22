import {
  defineMiddlewares,
  authenticate,
  type MedusaRequest,
  type MedusaResponse,
  type MedusaNextFunction,
} from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import multer from 'multer';
import {
  createAuthRateLimit,
  createCreditTopupRateLimit,
  createPackOpenBatchRateLimit,
  createPackOpenRateLimit,
  createProfileReadRateLimit,
  createPullRevealRateLimit,
  createReferralRecruitRateLimit,
  createStoreReadRateLimit,
  createVaultBuybackRateLimit,
} from './utils/rate-limit';
import { createResetTokenSingleUseGuard } from './utils/reset-token-guard';

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

// In-memory multipart parsing for the custom image-upload route. memoryStorage
// hands the route a Buffer (no temp files); the 20 MB cap is the hard edge gate
// (the validateImage gate re-checks it, plus type/resolution/aspect). Field
// name "files" matches the FormData the admin client sends.
const mediaUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});

// multer returns an Express RequestHandler whose generics don't line up with
// Medusa's middleware signature, though the (req, res, next) shape is identical
// at runtime. Cast through unknown so it can be invoked with Medusa's req/res.
const mediaUploadRaw = mediaUpload.array('files') as unknown as (
  req: MedusaRequest,
  res: MedusaResponse,
  next: (err?: unknown) => void,
) => void;

// Translate multer's own errors into MedusaError so they surface as a clean 400
// instead of the framework's default 500 "An unknown error occurred." (which
// also logs them as server errors). LIMIT_FILE_SIZE is the common one — the
// 20 MB cap aborts the stream before the route's validateImage gate runs.
const mediaUploadMiddleware = (
  req: MedusaRequest,
  res: MedusaResponse,
  next: MedusaNextFunction,
) => {
  mediaUploadRaw(req, res, (err?: unknown) => {
    if (err instanceof multer.MulterError) {
      next(
        new MedusaError(
          MedusaError.Types.INVALID_DATA,
          err.code === 'LIMIT_FILE_SIZE'
            ? 'File exceeds the 20 MB limit.'
            : `Upload failed: ${err.message}`,
        ),
      );
      return;
    }
    next(err as Error | undefined);
  });
};

export default defineMiddlewares({
  routes: [
    {
      // Validated admin image upload (POST /admin/media). /admin/* is already
      // auth-protected; multer parses the multipart body into req.files.
      matcher: '/admin/media',
      method: 'POST',
      middlewares: [mediaUploadMiddleware],
    },
    // Brute-force/credential-stuffing protection on the public credential
    // endpoints (login, register, reset/update password) for every actor type
    // (/auth/customer/*, /auth/user/*, ...). Token refresh is NOT matched —
    // it is high-frequency, already requires a valid token, and throttling it
    // would log users out under normal use.
    {
      matcher: '/auth/*/emailpass',
      method: 'POST',
      middlewares: [authRateLimit],
    },
    {
      matcher: '/auth/*/emailpass/*',
      method: 'POST',
      middlewares: [authRateLimit],
    },
    // Password-reset tokens are single-use: core validates the 15m JWT but
    // never invalidates it after a successful update, so a consumed link
    // would otherwise keep working until expiry. The guard 401s replays
    // (same "Invalid token" body as core — no oracle) and only ever rejects;
    // a token it passes still goes through core's full validateToken.
    {
      matcher: '/auth/*/emailpass/update',
      method: 'POST',
      middlewares: [createResetTokenSingleUseGuard()],
    },
    {
      matcher: '/store/packs/*/open',
      middlewares: [
        authenticate('customer', ['bearer']),
        createPackOpenRateLimit(),
      ],
    },
    {
      matcher: '/store/packs/*/open-batch',
      method: 'POST',
      middlewares: [
        authenticate('customer', ['bearer']),
        createPackOpenBatchRateLimit(),
      ],
    },
    {
      // The recruit calls this to set their sponsor. recruitId is taken from the
      // bearer token (auth_context.actor_id) — never from the body.
      matcher: '/store/referral',
      method: 'POST',
      middlewares: [
        authenticate('customer', ['bearer']),
        createReferralRecruitRateLimit(),
      ],
    },
    {
      // The customer's vault list (GET /store/vault).
      matcher: '/store/vault',
      middlewares: [authenticate('customer', ['bearer']), storeReadRateLimit],
    },
    {
      // Instant sell-back (POST /store/vault/:id/buyback).
      matcher: '/store/vault/*/buyback',
      middlewares: [
        authenticate('customer', ['bearer']),
        createVaultBuybackRateLimit(),
      ],
    },
    {
      // Showcase toggle (POST /store/vault/:id/showcase). Per-actor limiter for
      // parity with every other mutating /store endpoint (anti-hammering; it's
      // already authed + ownership-checked + idempotent, so this is hardening).
      matcher: '/store/vault/*/showcase',
      middlewares: [authenticate('customer', ['bearer']), storeReadRateLimit],
    },
    {
      // GET + POST /store/delivery-orders
      matcher: '/store/delivery-orders',
      middlewares: [authenticate('customer', ['bearer']), storeReadRateLimit],
    },
    {
      // GET /store/delivery-orders/:id  +  POST /store/delivery-orders/:id/address
      matcher: '/store/delivery-orders/*',
      middlewares: [authenticate('customer', ['bearer']), storeReadRateLimit],
    },
    {
      // Reveal ping (POST /store/pulls/:id/reveal) — stamps revealed_at so the
      // 30s instant window counts from the card reveal.
      matcher: '/store/pulls/*/reveal',
      method: 'POST',
      middlewares: [
        authenticate('customer', ['bearer']),
        createPullRevealRateLimit(),
      ],
    },
    {
      // Credit balance + ledger (GET /store/credits).
      matcher: '/store/credits',
      middlewares: [authenticate('customer', ['bearer']), storeReadRateLimit],
    },
    {
      // The customer's own profile handle (GET /store/profiles/me) — lazily
      // assigns metadata.handle, so it must be authed. Shares the vault/
      // credits read budget (the account UI fetches them together).
      matcher: '/store/profiles/me',
      method: 'GET',
      middlewares: [authenticate('customer', ['bearer']), storeReadRateLimit],
    },
    {
      // PUBLIC profile read (GET /store/profiles/:handle) — no auth, so the
      // limiter keys on the request IP. This glob also matches /profiles/me,
      // which therefore consumes from both budgets — harmless, and globs
      // can't express an exclusion.
      matcher: '/store/profiles/*',
      method: 'GET',
      middlewares: [createProfileReadRateLimit()],
    },
    {
      // Credit top-up through the (mock) payment gateway
      // (POST /store/credits/topup) — a write, so it gets its own limiter,
      // not the shared read budget.
      matcher: '/store/credits/topup',
      method: 'POST',
      middlewares: [
        authenticate('customer', ['bearer']),
        createCreditTopupRateLimit(),
      ],
    },
  ],
});
