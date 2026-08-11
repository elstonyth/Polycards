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
  createAuthIdentifierRateLimit,
  createAuthRateLimit,
  createCreditTopupRateLimit,
  createDeliveryWriteRateLimit,
  createGatewayHookRateLimit,
  createNotificationReadAllRateLimit,
  createNotificationReadRateLimit,
  createPackOpenBatchRateLimit,
  createPackOpenRateLimit,
  createPhoneOtpCheckPhoneRateLimit,
  createPhoneOtpCheckRateLimit,
  createPhoneOtpStartPhoneRateLimit,
  createPhoneOtpStartRateLimit,
  createProfileAppearanceRateLimit,
  createProfileReadRateLimit,
  createPullRevealRateLimit,
  createReferralRecruitRateLimit,
  createStoreReadRateLimit,
  createVaultBuybackRateLimit,
} from './utils/rate-limit';
import { createResetTokenSingleUseGuard } from './utils/reset-token-guard';
import {
  rejectCustomerMetadata,
  rejectAdminBankAccountsMetadata,
} from './utils/customer-metadata-guard';
import {
  requireSignupPhoneProof,
  blockUnverifiedPhoneWrite,
  requirePhoneVerified,
} from './utils/phone-verification-guard';
import { validateDeliverableAddress } from './utils/address-guard';
import {
  blockDisabledCustomerSession,
  blockDisabledEmailpassLogin,
} from './utils/disabled-guard';
import {
  noStoreForAuthenticatedAdmin,
  noStoreForAuthenticatedStore,
} from './utils/cache-headers';

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
// The per-identifier (per-email) credential tier. ONE instance shared by every
// credential matcher below: they are one budget per account across login,
// register and reset, and one instance also means one Redis connection fronting
// the single `rl:auth-identifier:` keyspace (two instances would share the
// Redis budget but NOT the in-memory failover budget — split-brain when Redis
// blips).
const authIdentifierRateLimit = createAuthIdentifierRateLimit();
// Shared by ALL write-tier matchers below (delivery-order writes, rewards
// claim/withdraw, daily draw, avatar upload, verified phone change): one
// budget + one Redis connection, distinct from the read budget. The 429
// label resolves per request so a rewards claim is never told "Too many
// delivery requests." (sim finding P3-10).
const deliveryWriteRateLimit = createDeliveryWriteRateLimit((req) => {
  if (req.path.startsWith('/store/rewards/'))
    return 'Too many reward requests.';
  if (req.path.startsWith('/store/daily/')) return 'Too many draw attempts.';
  if (req.path.startsWith('/store/profile/')) return 'Too many uploads.';
  if (req.path.startsWith('/store/phone-verification/'))
    return 'Too many verification requests.';
  return 'Too many delivery requests.';
});
// Frame equip/unequip — cosmetic metadata write with its own generous budget
// (sharing the delivery-write tier 429'd a collector's 11th frame swap).
const profileAppearanceRateLimit = createProfileAppearanceRateLimit();
// One instance shared by all admin money-mutation matchers: they share one
// budget and one Redis connection (a compromised admin token is throttled
// across all mutation routes together).
const adminActionRateLimit = createAdminActionRateLimit();
// One instance for all three GlobePay365 callback routes: they are one
// gateway's traffic against one abuse ceiling, so one budget and one Redis
// connection (see createGatewayHookRateLimit for the sizing rationale).
const gatewayHookRateLimit = createGatewayHookRateLimit();

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
      // Deliberately NOT on adminActionRateLimit: multi-image upload flows
      // fire this per-image from a client-side loop, and the shared 30/10s
      // burst budget would 429 mid-batch (see the EXEMPT note in the
      // coverage-guard spec).
      matcher: '/admin/media',
      method: 'POST',
      middlewares: [mediaUploadMiddleware],
    },
    // Brute-force/credential-stuffing protection on the public credential
    // endpoints (login, register, reset/update password) for every actor type
    // (/auth/customer/*, /auth/user/*, ...). Token refresh is NOT matched —
    // it is high-frequency, already requires a valid token, and throttling it
    // would log users out under normal use.
    //
    // TWO independent tiers, per-identifier FIRST so a hammered account 429s
    // before spending the sitewide budget — the same ordering rule (and the
    // same reason) as the OTP matchers below: the storefront issues every
    // credential request from a server action, so in prod the backend sees ONE
    // egress IP for every visitor and an IP-only limiter here is a single
    // sitewide bucket. See the "Phone-OTP limiters" comment in
    // utils/rate-limit.ts for the full shared-egress-IP rationale.
    //
    // The wildcard matcher also covers .../emailpass/update (reset completion),
    // which carries a token + password and NO identifier. authIdentifierRateLimit
    // is built with skipWhenNoKey, so it steps aside there instead of degrading
    // into a sitewide IP bucket with per-account numbers; that route's budget is
    // authRateLimit alone, exactly as before this tier existed.
    {
      matcher: '/auth/*/emailpass',
      method: 'POST',
      middlewares: [authIdentifierRateLimit, authRateLimit],
    },
    {
      matcher: '/auth/*/emailpass/*',
      method: 'POST',
      middlewares: [authIdentifierRateLimit, authRateLimit],
    },
    {
      // GlobePay365 callbacks (deposit / withdrawal / payout-verify). These
      // routes are deliberately UNAUTHENTICATED — a webhook carries no token
      // and its authentication is the RSA signature over the decrypted
      // payload — so this limiter is the ONLY thing bounding an anonymous
      // caller on an endpoint that must decrypt before it can verify (§1.16).
      // It is a ceiling, never a substitute for the signature check.
      //
      // Matcher shape verified empirically against the INSTALLED packages
      // (express 4.22.2 + path-to-regexp 0.1.13 at packages/api/node_modules),
      // not assumed: this entry carries a `method`, so define-middlewares.js:17
      // gives it `methods: ['POST']` and router.js:189 takes the
      // `app.post(matcher, …)` branch — the ROUTE form, compiled with
      // `end: true` as /^\/hooks\/globepay\/(.*)\/?$/i (the `app.use` branch's
      // `end: false` form does NOT apply here). Booting a real express app with
      // that registration, all three hook paths match, as do their
      // trailing-slash and mixed-case variants (strict:false, caseSensitive:
      // false — and the routes themselves match those too, so coverage is not
      // dodgeable); '/hooks/globepay', '/hooks', '/hooksfoo/bar',
      // '/hooks/globepayfoo/deposit' and '/store/credits/deposit' do not.
      //
      // It also runs BEFORE those routes' own handlers, which is what makes it
      // more than decoration: router.js:107-110 sorts ONE list
      // (`[].concat(middlewares).concat(routes)`) and registers in that order,
      // and under the shared /hooks/globepay branch this entry's last segment
      // '*' lands in the sorter's `wildcard` bucket while each route's
      // 'deposit'/'withdrawal'/'payout-verify' lands in `static` — wildcard
      // precedes static in the default orderBy. Replayed through the real
      // RoutesSorter with the routes listed both after AND before this entry:
      // the middleware sorts first either way.
      matcher: '/hooks/globepay/*',
      method: 'POST',
      middlewares: [gatewayHookRateLimit],
    },
    {
      // OTP send — TWO independent limiter tiers, per-phone FIRST so a
      // hammered number 429s before spending the sitewide budget. The
      // storefront proxies every OTP request server-side (one egress IP in
      // prod), so an IP-only limiter here would be one shared bucket for
      // every visitor — see the "Phone-OTP limiters" comment in
      // utils/rate-limit.ts for the full rationale.
      matcher: '/store/phone-verification/start',
      method: 'POST',
      middlewares: [
        createPhoneOtpStartPhoneRateLimit(),
        createPhoneOtpStartRateLimit(),
      ],
    },
    {
      // OTP check — same two-tier order as start above (bounds code guessing
      // per number; Twilio also caps 5 checks per verification server-side).
      matcher: '/store/phone-verification/check',
      method: 'POST',
      middlewares: [
        createPhoneOtpCheckPhoneRateLimit(),
        createPhoneOtpCheckRateLimit(),
      ],
    },
    {
      // Verified phone change (Task 4) — unlike start/check above, this one is
      // AUTHED: it consumes a 'phone-change'-purpose proof from the OTP flow
      // and is the only way to set a new phone once PHONE_VERIFICATION_REQUIRED
      // is on (blockUnverifiedPhoneWrite closes the direct /me write). Shares
      // the write-tier budget with the rest of the authed mutation matchers.
      matcher: '/store/phone-verification/change',
      method: 'POST',
      middlewares: [
        authenticate('customer', ['bearer']),
        deliveryWriteRateLimit,
      ],
    },
    {
      // Phone-proof → reset-token exchange (Task 5). Public (pre-auth by
      // nature — the caller has no session yet), so it shares the auth
      // brute-force budget rather than deliveryWriteRateLimit (that one's for
      // authed writes; this is a credential-issuing endpoint, same family as
      // login/register below).
      //
      // Deliberately NOT on authIdentifierRateLimit: the body is only
      // { token } — a phone-possession proof, no email — so there is nothing
      // for emailBodyKeyOf to read, and the only identifier available is the
      // phone INSIDE the proof, which a middleware could reach only by
      // re-running the HMAC verification the route already does
      // (utils/phone-verification.ts verifyPhoneProof). Duplicating credential
      // verification inside a rate limiter is not worth it, because this route
      // already has a genuine per-identifier bound one hop upstream: a caller
      // cannot obtain the proof without spending
      // createPhoneOtpCheckPhoneRateLimit's per-number budget (30/24h) on
      // /store/phone-verification/check. authRateLimit (IP) is the sitewide
      // circuit breaker on top of that.
      matcher: '/store/phone-verification/password-reset',
      method: 'POST',
      middlewares: [authRateLimit],
    },
    {
      // POLYCARD-BACK §4.2 login block: a disabled player is refused BEFORE the
      // core route mints a token (401). Customer login only — an admin/member
      // disable is a different lever. Unknown emails fall through untouched, so
      // this is no account-existence oracle (see utils/disabled-guard.ts).
      matcher: '/auth/customer/emailpass',
      method: 'POST',
      middlewares: [blockDisabledEmailpassLogin],
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
      //
      // requireSignupPhoneProof (see utils/phone-verification-guard.ts):
      // when PHONE_VERIFICATION_REQUIRED is on and the body carries a phone,
      // the request must also carry a verified 'signup'-purpose proof for
      // that exact number — the enforcement gate that makes Task 2's OTP
      // routes mandatory instead of opt-in.
      matcher: '/store/customers',
      method: 'POST',
      middlewares: [rejectCustomerMetadata, requireSignupPhoneProof],
    },
    {
      // /store/customers/me is framework-authenticated; this guard rejects
      // client-supplied `metadata` (reserved for server-validated keys — see
      // utils/customer-metadata-guard.ts).
      //
      // blockUnverifiedPhoneWrite (see utils/phone-verification-guard.ts):
      // when PHONE_VERIFICATION_REQUIRED is on, a direct string `phone` write
      // here is rejected — phone CHANGES must go through the verified
      // store/phone-verification/change route (Task 4); clearing to null
      // stays allowed.
      matcher: '/store/customers/me',
      method: 'POST',
      middlewares: [rejectCustomerMetadata, blockUnverifiedPhoneWrite],
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
      // Money-dot signal (GET /store/credits/latest). Own entry because the
      // '/store/credits' matcher below is EXACT — same reason
      // '/store/credits/balance' has one.
      matcher: '/store/credits/latest',
      middlewares: [authenticate('customer', ['bearer']), storeReadRateLimit],
    },
    {
      // The customer's vault list (GET /store/vault).
      matcher: '/store/vault',
      middlewares: [authenticate('customer', ['bearer']), storeReadRateLimit],
    },
    {
      // Vault unread-dot signal (GET /store/vault/latest). A separate entry
      // because the matcher above is EXACT — the same reason
      // '/store/vault/buyback-batch' needed its own. Shares the read budget
      // with vault/credits/vip/notifications: it is a one-row indexed read,
      // and the client throttles itself to one call per 30s per session.
      matcher: '/store/vault/latest',
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
      //
      // requirePhoneVerified is on the EXACT matcher, not the wildcard below:
      // shipping cards out needs a verified player, but cancelling an order
      // (POST /store/delivery-orders/:id/cancel) must stay open to everyone,
      // or an unverified player is stuck with a delivery they cannot unwind.
      matcher: '/store/delivery-orders',
      method: 'POST',
      middlewares: [
        authenticate('customer', ['bearer']),
        deliveryWriteRateLimit,
        requirePhoneVerified,
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
      // Close the instant-buyback window (POST /store/pulls/close-instant) —
      // the reveal client calls it on unmount (conclude / in-app nav) so the
      // vault quotes the flat rate. Owner-scoped in the handler; close-only and
      // idempotent, so it shares the reveal limiter (same reveal-lifecycle
      // cadence) — a throttled close simply falls back to the 30s deadline, no
      // harm. Distinct 2-segment path, so the 3-segment '/store/pulls/*/reveal'
      // matcher above doesn't cover it.
      matcher: '/store/pulls/close-instant',
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
        requirePhoneVerified,
      ],
    },
    {
      // Real GlobePay365 deposit (POST /store/credits/deposit). Same tier as
      // the mock top-up above: authenticated write, own limiter. Each call
      // creates a deposit at the gateway, so an unlimited caller could flood
      // their back office even without ever paying.
      //
      // NOTE: the gateway's own callback is POST /hooks/globepay/deposit, which
      // is deliberately OUTSIDE /store/* — a webhook carries no customer token,
      // so it must not hit authenticate(). Its auth is the RSA signature.
      matcher: '/store/credits/deposit',
      method: 'POST',
      middlewares: [
        authenticate('customer', ['bearer']),
        createCreditTopupRateLimit(),
        requirePhoneVerified,
      ],
    },
    {
      // Real GlobePay365 payout (POST /store/credits/withdraw). Money OUT, so
      // it shares the top-up write tier: authenticated, own limiter. The
      // gateway's callback (POST /hooks/globepay/withdrawal) and Payout
      // Verification (POST /hooks/globepay/payout-verify) are deliberately
      // OUTSIDE /store/* — webhook auth is the RSA signature.
      matcher: '/store/credits/withdraw',
      method: 'POST',
      middlewares: [
        authenticate('customer', ['bearer']),
        createCreditTopupRateLimit(),
        // Same phone gate as topup/deposit/delivery (2026-08-05): money OUT
        // was the one money path without it, which made an unverified account
        // able to cash out what it could never have topped up. Flag-gated by
        // PHONE_VERIFICATION_REQUIRED like every other requirePhoneVerified
        // site, so dev/CI (flag unset) are unaffected.
        requirePhoneVerified,
      ],
    },
    {
      // Bank picker for the withdrawal form. Read-only proxy, but
      // authenticated so the bank list (with our merchant context) is not a
      // public unauthenticated endpoint.
      matcher: '/store/credits/withdraw/banks',
      method: 'GET',
      middlewares: [authenticate('customer', ['bearer'])],
    },
    {
      // Saved payout accounts (GET /store/credits/withdraw/accounts) — the
      // withdraw form's picker source. Per-customer metadata read, so it
      // shares the store read budget.
      matcher: '/store/credits/withdraw/accounts',
      method: 'GET',
      middlewares: [authenticate('customer', ['bearer']), storeReadRateLimit],
    },
    {
      // Add/remove a saved payout account — metadata writes on the delivery
      // write-tier budget (rare, deliberate mutations; NOT the appearance
      // budget, which exists for rapid cosmetic swaps). The actual payout
      // still re-validates on submit; these only shape the picker.
      matcher: '/store/credits/withdraw/accounts',
      method: 'POST',
      middlewares: [
        authenticate('customer', ['bearer']),
        deliveryWriteRateLimit,
      ],
    },
    {
      matcher: '/store/credits/withdraw/accounts',
      method: 'DELETE',
      middlewares: [
        authenticate('customer', ['bearer']),
        deliveryWriteRateLimit,
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
      matcher: '/admin/customers/*/disable',
      method: 'POST',
      middlewares: [adminActionRateLimit],
    },
    {
      matcher: '/admin/customers/*/enable',
      method: 'POST',
      middlewares: [adminActionRateLimit],
    },
    {
      // The framework's own POST /admin/customers/:id writes customer.metadata
      // directly, and mergeMetadata is a SHALLOW top-level merge — so a request
      // could inject bank_accounts (a live payout destination) with no audit
      // row and without the metadata:<customer> advisory lock the store-side
      // writer holds. The admin SPA never round-trips metadata, so nothing
      // legitimate is refused here.
      matcher: '/admin/customers/*',
      method: 'POST',
      middlewares: [rejectAdminBankAccountsMetadata],
    },
    {
      matcher: '/admin/customers/*/payout-details',
      method: 'POST',
      middlewares: [adminActionRateLimit],
    },
    {
      // The GET returns the FULL bank account number, so it needs the limiter at
      // least as much as the write does. It was previously unthrottled, and the
      // coverage guard could not catch that because
      // admin-rate-limit-coverage.unit.spec.ts only scans POST|PUT|PATCH|DELETE
      // exports — it is structurally unable to flag a sensitive READ. Listed as
      // its own entry rather than by dropping the method pin, because that guard
      // matches coverage per method.
      matcher: '/admin/customers/*/payout-details',
      method: 'GET',
      middlewares: [adminActionRateLimit],
    },
    {
      matcher: '/admin/customers/*/group',
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
      // Queue a challenge to go live later (POST /admin/challenge/schedule) —
      // it becomes the credit-minting stage table on promotion, so it shares
      // the same admin budget as writing those stages directly.
      matcher: '/admin/challenge/schedule',
      method: 'POST',
      middlewares: [adminActionRateLimit],
    },
    {
      // Edit a queued challenge in place (POST /admin/challenge/schedule/:id)
      // — same credit-minting surface as queueing one, same admin budget.
      matcher: '/admin/challenge/schedule/*',
      method: 'POST',
      middlewares: [adminActionRateLimit],
    },
    {
      // Drop a queued challenge (DELETE /admin/challenge/schedule/:id).
      matcher: '/admin/challenge/schedule/*',
      method: 'DELETE',
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
      // Tier-defaults singleton write (POST /admin/tier-settings) — the price
      // ranges that default a card's tier in the odds editor. Advisory config,
      // not a money mutation, but it steers every future odds save — same
      // admin budget.
      matcher: '/admin/tier-settings',
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
    {
      // Per-row bank-account reveal (GET /admin/globepay/withdrawals/:id/account).
      // The ONE deliberate READ on this limiter — every other matcher sharing
      // adminActionRateLimit is a POST or a DELETE (checked across the whole
      // array, not just the neighbours), so do not read this as a mutation.
      // The generous admin budget (30/10s burst, 200/60s) is what keeps the
      // reveal usable: an operator working a dispute queue must not be 429'd
      // back to the database console. It shares that budget
      // because the withdrawals list masks account_number and this is the only
      // route that still serves one in full: throttled, it stays a per-dispute
      // lookup; unthrottled, a compromised admin token walks the table and
      // re-derives exactly the bulk view the masking removed.
      matcher: '/admin/globepay/withdrawals/*/account',
      method: 'GET',
      middlewares: [adminActionRateLimit],
    },
    {
      // Purchase-invoice writer (POLYCARD-BACK §3.5) — raises real inventory
      // counters, up to 200 lines x 1,000,000 qty per call; same admin budget.
      matcher: '/admin/purchase-invoices',
      method: ['POST'],
      middlewares: [adminActionRateLimit],
    },
    {
      // Delivery-orders bulk status transition — up to 100 order transitions +
      // 100 customer notifications per call; same admin budget.
      matcher: '/admin/delivery-orders/bulk',
      method: ['POST'],
      middlewares: [adminActionRateLimit],
    },
    {
      // Pack list reorder — batch rank write across the packs list; same admin
      // budget.
      matcher: '/admin/packs/reorder',
      method: ['POST'],
      middlewares: [adminActionRateLimit],
    },
    {
      // Pack odds write (POST /admin/packs/:slug/odds) — rewrites the pull
      // table an economy relies on; same admin money-mutation budget.
      matcher: '/admin/packs/*/odds',
      method: ['POST'],
      middlewares: [adminActionRateLimit],
    },
    {
      // Pack members write (POST /admin/packs/:slug/members) — rewrites which
      // cards a pack can pull; same admin money-mutation budget.
      matcher: '/admin/packs/*/members',
      method: ['POST'],
      middlewares: [adminActionRateLimit],
    },
    // /admin/cards, /admin/cards/*, /admin/products/from-pricecharting,
    // /admin/pixel-pokemon, /admin/packs (bare create) and
    // /admin/packs/*/top-hits are deliberately NOT on adminActionRateLimit —
    // catalog/display CRUD driven by client-side per-row loops in shipped
    // bulk operator tooling (#299 PriceCharting collection import, #305 bulk
    // retier), and from-pricecharting matches the recorded convention that
    // only money-mutation routes carry this limiter. See the coverage-guard
    // spec's EXEMPT list for the one-line reason on each.
    // POLYCARD-BACK §4.2 session block — LAST entry on purpose. Blocking login
    // alone would leave every already-minted bearer (including a Google-minted
    // one, whose callback this does not touch) working until it expired, so a
    // disabled player is also cut off at the request door: any /store request
    // carrying a disabled customer's verified bearer → 403.
    //
    // Why one blanket matcher is enough: the framework itself registers
    // `app.use('/store', authenticate('customer', ['bearer','session'],
    // { allowUnauthenticated: true }))` BEFORE any middleware from this file
    // (router.js #applyAuthMiddleware), so req.auth_context is already
    // populated whenever a valid bearer is present — no matter where the
    // sorter places this entry — and is empty on public/anonymous store
    // traffic, which the guard passes straight through. That also means this
    // covers the framework-authed routes that have no entry in this array
    // (/store/customers/me and its addresses), which per-matcher wiring would
    // have missed.
    {
      matcher: '/store/*',
      middlewares: [
        noStoreForAuthenticatedStore,
        blockDisabledCustomerSession,
      ],
    },
    // The /admin twin of the entry above — read the two as a pair. Same
    // blanket-matcher rationale: the framework registers
    // `app.use('/admin', authenticate('user', ['bearer','session','api-key']))`
    // (router.js:89) BEFORE any middleware from this file, so req.auth_context
    // is populated wherever the sorter places this, and every /admin route —
    // including the 61 with no Cache-Control of their own and any added next
    // month — is covered without anyone remembering to opt in.
    //
    // Matcher '/admin/*', not '/admin': the sorter DROPS a zero-segment
    // matcher (see the '/*' comment above), and a bare '/admin' would match
    // only the namespace root, which has no route.ts here. '*' spans '/' under
    // the installed path-to-regexp 0.1.13, so '/admin/*' covers every nested
    // admin path. Compiled regex, checked against the installed package rather
    // than recalled: /^\/admin\/(.*)\/?$/i in route form, and — because this
    // entry has no `method`, so registerExpressHandler takes the
    // `app.use(matcher, …)` branch (router.js:200) — /^\/admin\/(.*)\/?(?=\/|$)/i
    // as actually registered. Both match every /admin/… path and neither
    // matches bare '/admin', '/cdn/cards/*', '/store/*' or '/adminfoo/bar'.
    //
    // This is additive, never a reorder: no method filter, no early return,
    // just setHeader + next(). The sorter puts a wildcard entry ahead of the
    // static/params ones, so it runs BEFORE adminActionRateLimit on the
    // money-mutation routes — both still run, and their relative order is
    // unchanged (verified by replaying the real RoutesSorter over the matcher
    // list with and without this entry).
    {
      matcher: '/admin/*',
      middlewares: [noStoreForAuthenticatedAdmin],
    },
  ],
});
