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
  createAdminActionRateLimit,
  createAuthRateLimit,
  createCreditTopupRateLimit,
  createDeliveryWriteRateLimit,
  createNotificationReadAllRateLimit,
  createNotificationReadRateLimit,
  createPackOpenBatchRateLimit,
  createPackOpenRateLimit,
  createProfileAppearanceRateLimit,
  createProfileReadRateLimit,
  createPullRevealRateLimit,
  createReferralRecruitRateLimit,
  createStoreReadRateLimit,
  createVaultBuybackRateLimit,
} from './utils/rate-limit';
import { createResetTokenSingleUseGuard } from './utils/reset-token-guard';
import { rejectCustomerMetadata } from './utils/customer-metadata-guard';
import { validateDeliverableAddress } from './utils/address-guard';

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
// Shared by ALL write-tier matchers below (delivery-order writes, rewards
// claim/withdraw, daily draw, avatar upload): one budget + one Redis
// connection, distinct from the read budget. The 429 label resolves per
// request so a rewards claim is never told "Too many delivery requests."
// (sim finding P3-10).
const deliveryWriteRateLimit = createDeliveryWriteRateLimit((req) => {
  if (req.path.startsWith('/store/rewards/'))
    return 'Too many reward requests.';
  if (req.path.startsWith('/store/daily/')) return 'Too many draw attempts.';
  if (req.path.startsWith('/store/profile/')) return 'Too many uploads.';
  return 'Too many delivery requests.';
});
// Frame equip/unequip — cosmetic metadata write with its own generous budget
// (sharing the delivery-write tier 429'd a collector's 11th frame swap).
const profileAppearanceRateLimit = createProfileAppearanceRateLimit();
// One instance shared by all admin money-mutation matchers: they share one
// budget and one Redis connection (a compromised admin token is throttled
// across all mutation routes together).
const adminActionRateLimit = createAdminActionRateLimit();

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

// SECURITY (audit 2026-07-15): this is a single-house-seller deploy with no
// peer-to-peer vendor onboarding. The bundled @mercurjs/core plugin still mounts
// the public vendor self-registration surface, and Mercur's `seller_registration:
// false` flag is UI-visibility only — it does NOT gate the API. `POST
// /vendor/sellers` is guarded by authenticate('member', …, { allowUnregistered:
// true }), so anyone could POST /auth/member/emailpass/register then POST
// /vendor/sellers to create a real seller+store+membership in prod. This
// middleware hard-404s the two registration entrypoints so the surface is
// genuinely closed (app middleware applies to plugin routes here, same as the
// /auth/*/emailpass rate-limit entries below). The house seller is seeded
// server-side (not via this HTTP route) and logs in via POST /auth/member/
// emailpass (authenticate, NOT /register), so neither is affected.
//
// NOTE: blocking /auth/member/emailpass/register also gates seller-STAFF
// onboarding — invite-accept (POST /vendor/members/invites/accept) needs an
// invitee to first mint a member auth identity via /register. That flow is
// dormant here (single house seller, no staff invites) and intentionally
// closed. When P2P/staff onboarding is built, re-open /register behind the
// invite-gating rather than removing this block wholesale.
const blockUnusedVendorSelfRegistration = (
  _req: MedusaRequest,
  _res: MedusaResponse,
  next: MedusaNextFunction,
): void => {
  // next(err) — the repo convention for surfacing a middleware error into
  // Medusa's error handler (see mediaUploadMiddleware above and
  // utils/reset-token-guard.ts), rather than throwing.
  next(new MedusaError(MedusaError.Types.NOT_FOUND, 'Not found'));
};

// Root landing (GET /). This is a headless Medusa/Mercur server with no page at
// "/", so hitting the bare origin (admin.polycards.gg) returned Express's default
// "Cannot GET /" 404. Bounce the root to the admin dashboard (/dashboard, itself
// 301→/dashboard/login when signed out) — the only human-facing surface here.
//
// WHY matcher '/*' AND a req.path==='/' guard (not a plain matcher:'/'):
// Medusa's RoutesSorter (routes-sorter.js) buckets every route/middleware by its
// path SEGMENTS — `matcher.split('/').filter(s => s.length)`. For matcher '/'
// that is an EMPTY array, so the loop that inserts the entry into the sort tree
// never runs and the handler is silently DROPPED — it is never registered on
// Express. (Verified in prod: both a src/api/route.ts at '/' and a matcher:'/'
// middleware 404'd, while every sibling matcher with ≥1 segment worked.) The
// smallest matcher that survives is '/*' (one wildcard segment) → registers as
// app.get('/*', …). It matches EVERY GET, so the guard restricts the redirect to
// the exact root and next()s everything else through untouched. Confirmed against
// the app's express@4.22 / path-to-regexp@0.1: '/*' compiles and matches '/'.
// Cost: this runs one string compare on every GET — negligible. 302 (not 301):
// the target is an internal path we may repoint, and a 301 would be cached past
// that change.
const redirectRootToDashboard = (
  req: MedusaRequest,
  res: MedusaResponse,
  next: MedusaNextFunction,
): void => {
  if (req.path === '/') {
    res.redirect(302, '/dashboard');
    return;
  }
  next();
};

export default defineMiddlewares({
  routes: [
    {
      // Root landing → admin dashboard (see redirectRootToDashboard above).
      // Matcher '/*' (NOT '/': the sorter drops a zero-segment matcher); the
      // handler's req.path==='/' guard scopes the redirect to the bare root.
      matcher: '/*',
      method: 'GET',
      middlewares: [redirectRootToDashboard],
    },
    {
      // See blockUnusedVendorSelfRegistration above — refuse anonymous seller
      // self-registration (the money-irrelevant but prod-DB-polluting surface).
      matcher: '/vendor/sellers',
      method: 'POST',
      middlewares: [blockUnusedVendorSelfRegistration],
    },
    {
      // Defense-in-depth: refuse new `member`-actor self-registration too, so no
      // anonymous member auth identity can be minted. Member LOGIN (POST
      // /auth/member/emailpass, no /register) is deliberately NOT matched — the
      // seeded house seller needs it for the /seller vendor dashboard.
      matcher: '/auth/member/emailpass/register',
      method: 'POST',
      middlewares: [blockUnusedVendorSelfRegistration],
    },
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
      // POST /store/customers (register-completion / create) forwards the whole
      // validated body — including client-supplied `metadata` — into the create
      // workflow, so a public registrant could self-equip a frame, inject an
      // avatar_url, or squat a handle at account creation. Same reserved-key
      // guard as /me. Matcher is an anchored exact match (path-to-regexp; only
      // a trailing /* matches deeper segments), so it does NOT shadow
      // /store/customers/me or /store/customers/me/addresses.
      matcher: '/store/customers',
      method: 'POST',
      middlewares: [rejectCustomerMetadata],
    },
    {
      // /store/customers/me is framework-authenticated; this guard rejects
      // client-supplied `metadata` (reserved for server-validated keys — see
      // utils/customer-metadata-guard.ts).
      matcher: '/store/customers/me',
      method: 'POST',
      middlewares: [rejectCustomerMetadata],
    },
    // Medusa's stock address routes silently accept null country_code +
    // postal_code (sim finding P3-8) — reject undeliverable addresses before
    // the core route. Both are framework-authenticated already.
    {
      // POST /store/customers/me/addresses (create — fields required)
      matcher: '/store/customers/me/addresses',
      method: 'POST',
      middlewares: [validateDeliverableAddress('create')],
    },
    {
      // POST /store/customers/me/addresses/:id (update — no blanking out)
      matcher: '/store/customers/me/addresses/*',
      method: 'POST',
      middlewares: [validateDeliverableAddress('update')],
    },
    {
      matcher: '/store/packs/*/open',
      method: 'POST',
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
      // Referral summary (GET /store/referral) — separate entry because the
      // existing POST entry above pins method:'POST'; omitting method here
      // would protect both verbs with one entry, but method:'GET' keeps the
      // rate-limiting tiers clean: writes use the recruit limiter, reads share
      // the storeReadRateLimit budget with vault/credits/vip/notifications.
      matcher: '/store/referral',
      method: 'GET',
      middlewares: [authenticate('customer', ['bearer']), storeReadRateLimit],
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
      // Bulk sell-back (POST /store/vault/buyback-batch) — sells many pulls in
      // ONE request (see the route). Distinct 2-segment path, so the
      // '/store/vault/*/buyback' matcher above (3-segment) doesn't cover it.
      // Shares the vault-buyback limiter: one bulk sell = one hit, so a large
      // vault clears without the per-card throttle that broke the looped client.
      matcher: '/store/vault/buyback-batch',
      method: 'POST',
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
    // delivery-orders are method-split (audit 2026-06-23): GETs keep the
    // generous read budget; the state-changing POSTs (create + address) get the
    // tighter write-tier limiter, consistent with topup/buyback/referral. Only
    // GET + POST exist on these routes (no DELETE/PATCH), so the two pairs below
    // cover every handler — no method is left unlimited.
    {
      // GET /store/delivery-orders (list)
      matcher: '/store/delivery-orders',
      method: 'GET',
      middlewares: [authenticate('customer', ['bearer']), storeReadRateLimit],
    },
    {
      // POST /store/delivery-orders (create — state-changing write)
      matcher: '/store/delivery-orders',
      method: 'POST',
      middlewares: [
        authenticate('customer', ['bearer']),
        deliveryWriteRateLimit,
      ],
    },
    {
      // GET /store/delivery-orders/:id (detail)
      matcher: '/store/delivery-orders/*',
      method: 'GET',
      middlewares: [authenticate('customer', ['bearer']), storeReadRateLimit],
    },
    {
      // POST /store/delivery-orders/:id/address (re-snapshot — state-changing write)
      matcher: '/store/delivery-orders/*',
      method: 'POST',
      middlewares: [
        authenticate('customer', ['bearer']),
        deliveryWriteRateLimit,
      ],
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
      // Bare balance for hot storefront callers (GET /store/credits/balance).
      matcher: '/store/credits/balance',
      middlewares: [authenticate('customer', ['bearer']), storeReadRateLimit],
    },
    {
      // The customer's own VIP level, progress, and next-rung reward (GET /store/vip).
      matcher: '/store/vip',
      method: 'GET',
      middlewares: [authenticate('customer', ['bearer']), storeReadRateLimit],
    },
    {
      // The customer's in-app notification feed (GET /store/notifications).
      // receiver_id is scoped to the verified bearer token in the route handler —
      // never from query/body — so this entry is the auth + rate-limit gate only.
      matcher: '/store/notifications',
      method: 'GET',
      middlewares: [authenticate('customer', ['bearer']), storeReadRateLimit],
    },
    {
      // Bulk mark-read (POST /store/notifications/read-all). The write set is
      // derived from the caller's own owner-scoped feed inside the handler —
      // there is no id input to forge, so this entry is the auth +
      // rate-limit gate only. Its own limiter tier: a runaway read-all loop
      // must not eat the per-id budget normal feed interaction depends on.
      matcher: '/store/notifications/read-all',
      method: 'POST',
      middlewares: [
        authenticate('customer', ['bearer']),
        createNotificationReadAllRateLimit(),
      ],
    },
    {
      // Mark a feed notification as read (POST /store/notifications/:id/read).
      // IDOR guard runs in the route handler (owner-scoped listNotifications before
      // any write). Glob uses * (not :id) as Medusa middleware matchers are path
      // globs, not express params.
      matcher: '/store/notifications/*/read',
      method: 'POST',
      middlewares: [
        authenticate('customer', ['bearer']),
        createNotificationReadRateLimit(),
      ],
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
    {
      // Reward redemption writes — claim a grant, withdraw a
      // vaulted prize. All state/money mutations, so they share the delivery
      // write-tier budget (the same family as topup/buyback/delivery). The
      // fail-closed redemption gate on claim lives in the route handlers;
      // these entries are the auth + rate-limit gate only. The id (grantId in
      // the path, pull_id/address_id in the body) is never the actor — actor_id
      // comes from the verified bearer token in every handler.
      matcher: '/store/rewards/*',
      method: 'POST',
      middlewares: [
        authenticate('customer', ['bearer']),
        deliveryWriteRateLimit,
      ],
    },
    {
      // Consolidated daily-rewards state (GET /store/daily) — the /daily
      // surface fetches it on load.
      matcher: '/store/daily',
      method: 'GET',
      middlewares: [authenticate('customer', ['bearer']), storeReadRateLimit],
    },
    {
      // Daily-box draw (POST /store/daily/draw) — mints value, so it shares the
      // write-tier budget like /store/rewards/* POSTs. The fail-closed
      // redemption gate lives in the route handler; actor_id comes from the
      // verified bearer token only.
      matcher: '/store/daily/draw',
      method: 'POST',
      middlewares: [
        authenticate('customer', ['bearer']),
        deliveryWriteRateLimit,
      ],
    },
    {
      // Customer profile-photo upload (POST /store/profile/avatar): bearer
      // auth, write-tier budget, then multipart parse (shared 20 MB edge cap —
      // the route enforces the tighter 5 MB avatar cap).
      matcher: '/store/profile/avatar',
      method: 'POST',
      middlewares: [
        authenticate('customer', ['bearer']),
        deliveryWriteRateLimit,
        mediaUploadMiddleware,
      ],
    },
    {
      // Frame equip/unequip (POST /store/profile/frame) — cosmetic metadata
      // write on its own appearance budget (NOT the delivery-write tier: a
      // collector flipping through frames swaps faster than 10/10s).
      matcher: '/store/profile/frame',
      method: 'POST',
      middlewares: [
        authenticate('customer', ['bearer']),
        profileAppearanceRateLimit,
      ],
    },
    // Admin money-mutation routes — already auth-protected by the framework
    // admin auth, so no explicit authenticate() entry is needed here. All share
    // one limiter instance (one budget + one Redis connection). The limiter keys
    // on auth_context.actor_id; if the admin auth hasn't populated it yet it
    // falls back to the request IP (acceptable — the framework gate runs first).
    {
      matcher: '/admin/customers/*/freeze',
      method: 'POST',
      middlewares: [adminActionRateLimit],
    },
    {
      matcher: '/admin/customers/*/unfreeze',
      method: 'POST',
      middlewares: [adminActionRateLimit],
    },
    {
      matcher: '/admin/commissions/*/reverse',
      method: 'POST',
      middlewares: [adminActionRateLimit],
    },
    {
      matcher: '/admin/commissions/*/suspend',
      method: 'POST',
      middlewares: [adminActionRateLimit],
    },
    {
      matcher: '/admin/commissions/*/unsuspend',
      method: 'POST',
      middlewares: [adminActionRateLimit],
    },
    {
      matcher: '/admin/rewards-settings',
      method: 'POST',
      middlewares: [adminActionRateLimit],
    },
    {
      matcher: '/admin/customers/*/credits',
      method: 'POST',
      middlewares: [adminActionRateLimit],
    },
    {
      // Daily-box authoring write (POST /admin/daily-rewards/boxes/:tier) —
      // mutates the reward economy, so it shares the admin money-mutation
      // budget. Auth is the framework default /admin guard.
      matcher: '/admin/daily-rewards/boxes/*',
      method: 'POST',
      middlewares: [adminActionRateLimit],
    },
    {
      // Voucher-ladder write (POST /admin/daily-rewards/vouchers) — rewrites
      // vip_level.voucher_amount, so it shares the admin money-mutation budget.
      matcher: '/admin/daily-rewards/vouchers',
      method: 'POST',
      middlewares: [adminActionRateLimit],
    },
    {
      // VIP-ladder write (POST /admin/vip-levels) — rewrites the ladder incl.
      // vip_level.voucher_amount, so it shares the admin money-mutation budget.
      matcher: '/admin/vip-levels',
      method: 'POST',
      middlewares: [adminActionRateLimit],
    },
    {
      // Challenge reward-stage write (POST /admin/challenge/stages) — rewrites
      // the credit-minting per-rank reward stages; same admin budget.
      matcher: '/admin/challenge/stages',
      method: 'POST',
      middlewares: [adminActionRateLimit],
    },
    {
      // Challenge settings singleton patch (POST /admin/challenge/settings) —
      // retimes the reward cycle (cadence/reset), so it shares the admin
      // money-mutation budget.
      matcher: '/admin/challenge/settings',
      method: 'POST',
      middlewares: [adminActionRateLimit],
    },
    {
      // Global USD->MYR FX-rate write. Sets the multiplier behind every
      // displayed price, so it shares the admin money-mutation budget. Auth is
      // the framework default /admin guard (handler is AuthenticatedMedusaRequest);
      // registered here explicitly so the auth+rate-limit intent is visible.
      matcher: '/admin/pricing/fx',
      method: 'POST',
      middlewares: [adminActionRateLimit],
    },
    {
      // Site-settings write (slab-frame overlay URL). Not a money mutation,
      // but it repaints every card on the storefront — same admin budget.
      matcher: '/admin/site-settings',
      method: 'POST',
      middlewares: [adminActionRateLimit],
    },
    {
      // Avatar-frame catalog write — cosmetic but repaints avatars storefront
      // -wide; same admin money-mutation budget as site-settings.
      matcher: '/admin/avatar-frames',
      method: 'POST',
      middlewares: [adminActionRateLimit],
    },
  ],
});
