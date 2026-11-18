import type { MiddlewareRoute } from '@medusajs/framework/http';

// RBAC for the custom admin API (2026-10-17). RBAC is on (medusa-config
// `rbac: true`), but only routes a middleware entry gives `policies` are
// checked, and core only guards its own prefixes. Until this table, every
// custom route outside a core prefix (`/admin/referrals/*/pay`,
// `/admin/packs/*`, …) ran for ANY logged-in admin whatever their role, and
// custom writes under a core prefix needed only core's read policy
// (`customer:read` was enough to POST `/admin/customers/:id/credits`).
//
// Every role in use passes unchanged: staff hold role_super_admin (`*:*`) and
// the desk bots hold `*:read`, which every GET below asks for. A request
// whose token carries no role at all is refused by the framework's check.
//
// One table drives the middleware entries (middlewares.ts), the declared
// policies (src/policies/admin-surfaces.ts) and the coverage guards
// (__tests__/admin-rbac-coverage.unit.spec.ts and
// admin-rate-limit-coverage.unit.spec.ts), so they cannot drift. Per-route
// protection (a route's own policy, limiters, secret read, desk-bot block)
// lives in ADMIN_ROUTES below, one record per route.

type Operation = 'read' | 'create' | 'update' | 'delete';

/** What each HTTP method asks of a custom surface. Custom writes are not split
 *  into create/update: one `update` per resource keeps future roles simple. */
export const OPERATION_BY_METHOD = {
  GET: 'read',
  POST: 'update',
  PUT: 'update',
  PATCH: 'update',
  DELETE: 'delete',
} as const satisfies Record<string, Operation>;

/** Admin prefixes no core middleware guards, each with its own resource.
 *  Resources are snake_case already, so definePolicies' normalisation keeps
 *  them byte-identical to what the middleware entries check. */
export const CUSTOM_ADMIN_RESOURCES = {
  announcements: 'announcement',
  assistant: 'assistant',
  'assistant-review': 'assistant_review',
  'assistant-settings': 'assistant_setting',
  automation: 'automation',
  'avatar-frames': 'avatar_frame',
  cards: 'card',
  challenge: 'challenge',
  'coin-flips': 'coin_flip',
  'daily-rewards': 'daily_reward',
  'delivery-orders': 'delivery_order',
  economy: 'economy',
  gacha: 'gacha',
  'goods-receive-notes': 'goods_receive_note',
  inventory: 'inventory',
  ledger: 'ledger',
  'lossless-schedules': 'lossless_schedule',
  'lucky-draw': 'lucky_draw',
  media: 'media',
  'pack-gifts': 'pack_gift',
  packs: 'pack',
  'pixel-pokemon': 'pixel_pokemon',
  players: 'player',
  pricecharting: 'pricecharting',
  pricing: 'pricing',
  procurement: 'procurement',
  'profit-report': 'profit_report',
  pulls: 'pull',
  'purchase-invoices': 'purchase_invoice',
  referrals: 'referral',
  'rewards-settings': 'rewards_setting',
  'site-settings': 'site_setting',
  stats: 'stats',
  tasks: 'task',
  tcg: 'tcg',
  'tier-settings': 'tier_setting',
  'vip-levels': 'vip_level',
} as const;

/** Core prefixes whose own `/admin/<prefix>/*` entry already asks for read on
 *  EVERY method, so custom GETs under them are covered. Resources are core's
 *  own strings (its query-config `Entities`). */
export const CORE_READ_PREFIXES = {
  customers: 'customer',
  'customer-groups': 'customer_group',
  products: 'product',
  payments: 'payment',
} as const;

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
type Policy = { resource: string; operation: Operation };

/** The limiters an admin route can carry; middlewares.ts binds each one once. */
export type AdminLimiter =
  | 'admin-action'
  | 'assistant-chat'
  | 'assistant-speak';

/** One protected admin route: everything that guards it, in one place. */
export interface AdminRoute {
  /** Express matcher: `*` spans `/` (path-to-regexp 0.1.x), `:id` is one segment. */
  matcher: string;
  method: Method;
  /** The policy it asks for on top of its prefix's own entry. Absent: the
   *  prefix's policy alone (CUSTOM_ADMIN_RESOURCES / core's read). */
  policy?: Policy;
  /** A GET that hands out secrets (see SECRET_READS): `policy` is its own read. */
  secret?: true;
  /** Its limiters, in run order. Absent: no limiter. */
  limits?: readonly AdminLimiter[];
  /** The framework body parser is off and the JSON body, up to this size, is
   *  read after the limiters. */
  lateJsonBody?: string;
  /** Why the desk bots' read-only proxy refuses it (ADR 0009). Absent: only
   *  the proxy's prefix-wide blocks apply. */
  deskBotsBlocked?: string;
  /** Core's own handler (no route file here): only its policy is tightened. */
  coreRoute?: true;
}

const ACTION = ['admin-action'] as const;
const update = (resource: string): Policy => ({
  resource,
  operation: 'update',
});
const customerWrite = update(CORE_READ_PREFIXES.customers);
const groupWrite = update(CORE_READ_PREFIXES['customer-groups']);
const paymentWrite = update(CORE_READ_PREFIXES.payments);
/** A secret-bearing GET: its own read policy and the shared admin budget. */
const secretRead = (matcher: string, resource: string): AdminRoute => ({
  matcher,
  method: 'GET',
  policy: { resource, operation: 'read' },
  secret: true,
  limits: ACTION,
});

/** Every admin route that carries its own protection. One table drives the
 *  RBAC entries (adminRbacRoutes), the limiter entries middlewares.ts spreads
 *  in (adminRouteLimits), the desk-bot blocklist (deskBotBlockedRoutes, in
 *  reports/admin/proxy.ts) and the coverage specs in __tests__/.
 *
 *  Limiters. Admin money-mutation routes are already auth-protected by the
 *  framework admin auth, so no explicit authenticate() entry is needed. All
 *  share one admin-action instance (one budget + one Redis connection: a
 *  compromised admin token is throttled across all mutation routes together).
 *  The limiter keys on auth_context.actor_id; if the admin auth hasn't
 *  populated it yet it falls back to the request IP (acceptable — the
 *  framework gate runs first).
 *
 *  /admin/cards, /admin/cards/*, /admin/products/from-pricecharting,
 *  /admin/pixel-pokemon, /admin/packs (bare create) and /admin/packs/*\/top-hits
 *  are deliberately NOT on the admin-action limiter — catalog/display CRUD
 *  driven by client-side per-row loops in shipped bulk operator tooling (#299
 *  PriceCharting collection import, #305 bulk retier), and from-pricecharting
 *  matches the recorded convention that only money-mutation routes carry this
 *  limiter. See the coverage-guard spec's EXEMPT list for the one-line reason
 *  on each.
 *
 *  Policies. Custom write routes under a core prefix ask for the write policy
 *  core would ask for, on EXACT matchers so core's own routes keep exactly
 *  their policies. */
export const ADMIN_ROUTES: readonly AdminRoute[] = [
  {
    // The admin assistant chat (spec 2026-10-29): screenshots travel as data
    // URLs in the JSON body (up to 4, each shrunk under 1.5 MB), hence the
    // larger body limit. Medusa parses bodies before its login check, so
    // the framework parser is off here and the body is read last, after
    // the login, the role check and the rate limits: nobody signed out can
    // make the server hold and parse 10 MB.
    // Each turn spends OpenRouter credit, hence its own per-admin budget.
    matcher: '/admin/assistant/chat',
    method: 'POST',
    limits: ['admin-action', 'assistant-chat'],
    lateJsonBody: '10mb',
  },
  {
    // Reading an answer aloud (voice.ts) spends OpenRouter credit too; its
    // own looser budget, so Talk mode never hits "too many questions".
    matcher: '/admin/assistant/speak',
    method: 'POST',
    limits: ['admin-action', 'assistant-speak'],
  },
  // Saving a note or task the person tapped Save on (confirm.ts).
  { matcher: '/admin/assistant/confirm', method: 'POST', limits: ACTION },
  {
    matcher: '/admin/assistant/conversations/*',
    method: 'DELETE',
    limits: ACTION,
  },
  { matcher: '/admin/assistant-settings', method: 'POST', limits: ACTION },
  { matcher: '/admin/assistant-settings/test', method: 'POST', limits: ACTION },
  {
    // "Hear it" speaks a sample with OpenRouter credit (unsaved cost).
    matcher: '/admin/assistant-settings/voice-test',
    method: 'POST',
    limits: ['admin-action', 'assistant-chat'],
  },
  ...['freeze', 'unfreeze', 'disable'].map(
    (sub): AdminRoute => ({
      matcher: `/admin/customers/*/${sub}`,
      method: 'POST',
      policy: customerWrite,
      limits: ACTION,
    }),
  ),
  {
    // A Super Admin resetting another admin's two-step sign-in (owner,
    // 2026-11-07): core's own write on users. The route also demands Super
    // Admin.
    matcher: '/admin/users/*/mfa/reset',
    method: 'POST',
    policy: update('user'),
    limits: ACTION,
  },
  // Customer-service corrections (spec 2026-10-06). The phone route's body
  // key is `new_phone` because rejectAdminPhoneWrite on middlewares.ts's
  // '/admin/customers/*' entry also matches this path.
  ...['enable', 'real-name', 'phone', 'payout-details'].map(
    (sub): AdminRoute => ({
      matcher: `/admin/customers/*/${sub}`,
      method: 'POST',
      policy: customerWrite,
      limits: ACTION,
    }),
  ),
  // Other accounts on this player's browser or network: carries IP addresses.
  {
    ...secretRead(
      '/admin/customers/*/visitor-signals',
      'customer_bank_account',
    ),
    deskBotsBlocked: "customers' IP addresses and browser ids",
  },
  // Saved bank accounts: the list carries full numbers (same reasoning as the
  // payout-details GET below), and the writes are support's only way to
  // change a tied account.
  secretRead('/admin/customers/*/bank-accounts', 'customer_bank_account'),
  ...['add', 'remove', 'verify', 'name-clash'].map(
    (sub): AdminRoute => ({
      matcher: `/admin/customers/*/bank-accounts/${sub}`,
      method: 'POST',
      policy: customerWrite,
      limits: ACTION,
    }),
  ),
  {
    // Taking a bank number off the ban list is an unban (owner, 2026-11-04):
    // the same policy as the assistant's unban_bank_number, so one role
    // decides who may lift bans, wherever it is done.
    matcher: '/admin/customers/*/bank-accounts/unban-number',
    method: 'POST',
    policy: update('assistant_unban'),
    limits: ACTION,
  },
  // The GET returns the FULL bank account number, so it needs the limiter at
  // least as much as the write does. It was previously unthrottled, and the
  // coverage guard could not catch that because
  // admin-rate-limit-coverage.unit.spec.ts only scans POST|PUT|PATCH|DELETE
  // exports — it is structurally unable to flag a sensitive READ. Listed as
  // its own record rather than by dropping the method pin, because that guard
  // matches coverage per method.
  secretRead('/admin/customers/*/payout-details', 'customer_bank_account'),
  {
    matcher: '/admin/customers/*/group',
    method: 'POST',
    policy: customerWrite,
    limits: ACTION,
  },
  // Partner account generator (POST /admin/players): mints up to 50 logins
  // per call.
  { matcher: '/admin/players', method: 'POST', limits: ACTION },
  // Serves the generated partner PASSWORDS (GET /admin/players/export) — the
  // payout-details GET precedent: a sensitive read gets the limiter.
  secretRead('/admin/players/export', 'partner_credential'),
  // A player group's partner policy, draft access and odds set
  // (POST /admin/customer-groups/:id/<sub>).
  ...['policy', 'draft-access', 'odds-set'].map(
    (sub): AdminRoute => ({
      matcher: `/admin/customer-groups/*/${sub}`,
      method: 'POST',
      policy: groupWrite,
      limits: ACTION,
    }),
  ),
  { matcher: '/admin/rewards-settings', method: 'POST', limits: ACTION },
  {
    matcher: '/admin/customers/*/credits',
    method: 'POST',
    policy: customerWrite,
    limits: ACTION,
  },
  {
    // Lucky Draw tickets decide RM-valued prizes, so a grant shares the
    // money-mutation budget like /credits (the group editor waits out a 429).
    matcher: '/admin/customers/*/lucky-draw-tickets',
    method: 'POST',
    policy: customerWrite,
    limits: ACTION,
  },
  {
    // Gift packs to a customer / revoke one (spec 2026-10-07) — they mint
    // value like a credit grant, so they share the money-mutation budget.
    matcher: '/admin/customers/*/pack-gifts',
    method: 'POST',
    policy: customerWrite,
    limits: ACTION,
  },
  { matcher: '/admin/pack-gifts/*/revoke', method: 'POST', limits: ACTION },
  // Voucher-ladder write (POST /admin/daily-rewards/vouchers) — rewrites
  // vip_level.voucher_amount, so it shares the admin money-mutation budget.
  { matcher: '/admin/daily-rewards/vouchers', method: 'POST', limits: ACTION },
  // VIP-ladder write (POST /admin/vip-levels) — rewrites the ladder incl.
  // vip_level.voucher_amount, so it shares the admin money-mutation budget.
  { matcher: '/admin/vip-levels', method: 'POST', limits: ACTION },
  // Referral tier table + partner bounds (POST /admin/referrals/settings).
  { matcher: '/admin/referrals/settings', method: 'POST', limits: ACTION },
  // The weekly settlement lifecycle (approve/pay) and per-line void.
  ...[
    '/admin/referrals/settlements/*/approve',
    '/admin/referrals/settlements/*/pay',
    '/admin/referrals/lines/*/void',
    '/admin/referrals/settlements/*/void',
  ].map((matcher): AdminRoute => ({ matcher, method: 'POST', limits: ACTION })),
  // Admin set/fix of attribution (POST /admin/customers/:id/referral) and the
  // partner-rate flag on a customer (POST /admin/customers/:id/partner-rate).
  ...['referral', 'partner-rate'].map(
    (sub): AdminRoute => ({
      matcher: `/admin/customers/*/${sub}`,
      method: 'POST',
      policy: customerWrite,
      limits: ACTION,
    }),
  ),
  // Task-definition CRUD (POST /admin/tasks).
  { matcher: '/admin/tasks', method: 'POST', limits: ACTION },
  // Coin Flip settings write (POST /admin/coin-flips/settings).
  { matcher: '/admin/coin-flips/settings', method: 'POST', limits: ACTION },
  // Announcement popup create/update (POST /admin/announcements) — repaints
  // the storefront for every visitor; same admin budget as site-settings.
  { matcher: '/admin/announcements', method: 'POST', limits: ACTION },
  // Announcement soft delete (DELETE /admin/announcements/:id).
  { matcher: '/admin/announcements/*', method: 'DELETE', limits: ACTION },
  // Challenge reward-stage write (POST /admin/challenge/stages) — rewrites
  // the credit-minting per-rank reward stages; same admin budget.
  { matcher: '/admin/challenge/stages', method: 'POST', limits: ACTION },
  // Queue a challenge to go live later (POST /admin/challenge/schedule) — it
  // becomes the credit-minting stage table on promotion, so it shares the
  // same admin budget as writing those stages directly.
  { matcher: '/admin/challenge/schedule', method: 'POST', limits: ACTION },
  // Edit a queued challenge in place (POST /admin/challenge/schedule/:id) —
  // same credit-minting surface as queueing one, same admin budget.
  { matcher: '/admin/challenge/schedule/*', method: 'POST', limits: ACTION },
  // Drop a queued challenge (DELETE /admin/challenge/schedule/:id).
  { matcher: '/admin/challenge/schedule/*', method: 'DELETE', limits: ACTION },
  // Schedule a Lossless Mode window (POST /admin/lossless-schedules) — it
  // lifts a pack's instant sell to 100%, so it shares the admin money-
  // mutation budget.
  { matcher: '/admin/lossless-schedules', method: 'POST', limits: ACTION },
  // Cancel a window (POST /admin/lossless-schedules/:id/cancel); "*" spans
  // "/" so it covers the nested path.
  { matcher: '/admin/lossless-schedules/*', method: 'POST', limits: ACTION },
  // Lucky Draw event create / rename (POST /admin/lucky-draw/events).
  { matcher: '/admin/lucky-draw/events', method: 'POST', limits: ACTION },
  // Publish an event (POST /admin/lucky-draw/events/:id/publish) — commits
  // every prize's seed hash.
  {
    matcher: '/admin/lucky-draw/events/*/publish',
    method: 'POST',
    limits: ACTION,
  },
  // Withdraw a one_winner event and refund every entrant
  // (POST /admin/lucky-draw/events/:id/withdraw).
  {
    matcher: '/admin/lucky-draw/events/*/withdraw',
    method: 'POST',
    limits: ACTION,
  },
  // Lucky Draw prize create / edit (POST /admin/lucky-draw/prizes).
  { matcher: '/admin/lucky-draw/prizes', method: 'POST', limits: ACTION },
  // Cancel a prize and refund its entrants' tickets
  // (POST /admin/lucky-draw/prizes/:id/cancel).
  {
    matcher: '/admin/lucky-draw/prizes/*/cancel',
    method: 'POST',
    limits: ACTION,
  },
  // Challenge settings singleton patch (POST /admin/challenge/settings) —
  // retimes the reward cycle (cadence/reset), so it shares the admin
  // money-mutation budget.
  { matcher: '/admin/challenge/settings', method: 'POST', limits: ACTION },
  // Tier-defaults singleton write (POST /admin/tier-settings) — the price
  // ranges that default a card's tier in the odds editor. Advisory config,
  // not a money mutation, but it steers every future odds save — same admin
  // budget.
  { matcher: '/admin/tier-settings', method: 'POST', limits: ACTION },
  // Global USD->MYR FX-rate write. Sets the multiplier behind every displayed
  // price, so it shares the admin money-mutation budget. Auth is the
  // framework default /admin guard (handler is AuthenticatedMedusaRequest);
  // listed here explicitly so the auth+rate-limit intent is visible.
  { matcher: '/admin/pricing/fx', method: 'POST', limits: ACTION },
  // Site-settings write (slab-frame overlay URL). Not a money mutation, but
  // it repaints every card on the storefront — same admin budget.
  { matcher: '/admin/site-settings', method: 'POST', limits: ACTION },
  {
    // Automation reads and runs on `automation:*` alone, so the automation
    // operator role (scripts/create-automation-operator.ts) works without
    // `customer:read`. Saving the account list also asks `customer:update`:
    // it accepts ANY registered customer's email, and a live run then opens
    // packs on that customer's wallet. Only staff choose which accounts
    // automation touches. Not `customer:read`, which a view-only role beside
    // the operator role holds (scripts/grant-support-viewer.ts).
    matcher: '/admin/automation/accounts',
    method: 'POST',
    policy: customerWrite,
    limits: ACTION,
  },
  { matcher: '/admin/automation/sandbox', method: 'POST', limits: ACTION },
  { matcher: '/admin/automation/live', method: 'POST', limits: ACTION },
  {
    // Active payment gateway switch (plan 130). Flips where every customer
    // pays and is paid out — same admin budget as the other settings writes.
    matcher: '/admin/payments/gateway',
    method: 'POST',
    policy: paymentWrite,
    limits: ACTION,
  },
  {
    // SGD conversion rate + fees (A3Pay, payment-fx.ts). Reprices every
    // Singapore top-up and payout — same admin budget as the gateway switch.
    matcher: '/admin/payments/fx',
    method: 'POST',
    policy: paymentWrite,
    limits: ACTION,
  },
  {
    // Withdraw / Touch 'n Go switches, schedules and TNG minimum. Opens or
    // closes every customer's payouts — same budget as the gateway switch.
    matcher: '/admin/payments/withdrawal-controls',
    method: 'POST',
    policy: paymentWrite,
    limits: ACTION,
  },
  // Avatar-frame catalog write — cosmetic but repaints avatars storefront
  // -wide; same admin money-mutation budget as site-settings.
  { matcher: '/admin/avatar-frames', method: 'POST', limits: ACTION },
  // Per-row bank-account reveal (GET /admin/payments/withdrawals/:id/account).
  // The generous admin budget (30/10s burst, 200/60s) is what keeps the
  // reveal usable: an operator working a dispute queue must not be 429'd
  // back to the database console. It shares that budget because the
  // withdrawals list masks account_number and this is the only route that
  // still serves one in full: throttled, it stays a per-dispute lookup;
  // unthrottled, a compromised admin token walks the table and re-derives
  // exactly the bulk view the masking removed.
  secretRead('/admin/payments/withdrawals/*/account', 'customer_bank_account'),
  // The held-withdrawal review drawer: banks, names, browsers (ADR 0018).
  secretRead('/admin/payments/withdrawals/*/links', 'customer_bank_account'),
  {
    // Release a HELD payout to the gateway (plan 094). The most literal money
    // mutation on this limiter: one call submits a real bank transfer. The
    // row's own atomic status claim is what stops a double-click paying twice
    // — this budget is the outer bound on how fast a compromised admin token
    // could work the queue at all.
    matcher: '/admin/payments/withdrawals/*/approve',
    method: 'POST',
    policy: paymentWrite,
    limits: ACTION,
  },
  {
    // Refuse a HELD payout and refund the debit — same budget as its approve
    // twin. It mints no credit beyond the one refund the row's shared
    // idempotency anchor allows, but it is still a ledger write driven by an
    // admin token.
    matcher: '/admin/payments/withdrawals/*/deny',
    method: 'POST',
    policy: paymentWrite,
    limits: ACTION,
  },
  {
    // Settlement's Acknowledge: takes a gateway audit finding out of the
    // "payments differ" count. Moves no money, but it can hide a warning, so
    // it shares the admin action budget.
    matcher: '/admin/payments/audit/acknowledge',
    method: 'POST',
    policy: paymentWrite,
    limits: ACTION,
  },
  {
    // Settlement's Credit deposit: a ledger write driven by an admin token.
    matcher: '/admin/payments/deposits/*/credit',
    method: 'POST',
    policy: paymentWrite,
    limits: ACTION,
  },
  {
    // Settlement's Link gateway entry: moves no money, but it lets the audit
    // stop flagging a hand credit, so it is guarded like Acknowledge.
    matcher: '/admin/payments/deposits/*/adjustment-entry',
    method: 'POST',
    policy: paymentWrite,
    limits: ACTION,
  },
  // Purchase-invoice writer (POLYCARD-BACK §3.5) — raises real inventory
  // counters, up to 200 lines x 1,000,000 qty per call; same admin budget.
  { matcher: '/admin/purchase-invoices', method: 'POST', limits: ACTION },
  // Edit — ":id" is one path segment, the same matcher as the GRN edit's.
  { matcher: '/admin/purchase-invoices/:id', method: 'POST', limits: ACTION },
  // Goods receive notes (spec 2026-10-28) — raise the same stock counters as
  // an invoice, and their reversal lowers them; same admin budget.
  { matcher: '/admin/goods-receive-notes', method: 'POST', limits: ACTION },
  // Edit. ":id" is one path segment, so this matches neither "/:id/reverse"
  // nor a create sent to "/admin/goods-receive-notes/" — each is charged once.
  { matcher: '/admin/goods-receive-notes/:id', method: 'POST', limits: ACTION },
  {
    matcher: '/admin/goods-receive-notes/*/reverse',
    method: 'POST',
    limits: ACTION,
  },
  // Delivery-orders bulk status transition — up to 100 order transitions +
  // 100 customer notifications per call; same admin budget.
  { matcher: '/admin/delivery-orders/bulk', method: 'POST', limits: ACTION },
  // "Check tracking" — one carrier call per shipped order (Ninja Van) or per
  // 20 (Pos Laju), plus any completions; same admin budget.
  { matcher: '/admin/delivery-orders/track', method: 'POST', limits: ACTION },
  // Stock page Refresh — every open order's stock read, plus a status move
  // per complete order; same admin budget.
  {
    matcher: '/admin/delivery-orders/allocate',
    method: 'POST',
    limits: ACTION,
  },
  // Pack list reorder — batch rank write across the packs list; same admin
  // budget.
  { matcher: '/admin/packs/reorder', method: 'POST', limits: ACTION },
  // Pack odds write (POST /admin/packs/:slug/odds) — rewrites the pull table
  // an economy relies on; same admin money-mutation budget.
  { matcher: '/admin/packs/*/odds', method: 'POST', limits: ACTION },
  // Pack members write (POST /admin/packs/:slug/members) — rewrites which
  // cards a pack can pull; same admin money-mutation budget.
  { matcher: '/admin/packs/*/members', method: 'POST', limits: ACTION },
  // Ticket pack table write (POST /admin/packs/:slug/ticket-prizes) — the
  // same pull table, for a pack that sells tickets; same budget.
  { matcher: '/admin/packs/*/ticket-prizes', method: 'POST', limits: ACTION },
  {
    // The mailing list carries customer names, addresses, phones and emails:
    // on top of procurement:read (the prefix entry), ask the same permission
    // the Orders page does, so a purchasing-only role cannot read customer
    // details through it.
    matcher: '/admin/procurement/to-ship',
    method: 'GET',
    policy: { resource: 'delivery_order', operation: 'read' },
  },
  {
    // Catalog import: no limiter (see the note above the table).
    matcher: '/admin/products/from-pricecharting',
    method: 'POST',
    policy: { resource: CORE_READ_PREFIXES.products, operation: 'create' },
  },
  // Core routes that ask too little (audit 2026-11-09). Search has no policy
  // and lists every customer's email (staff are open to staff by the owner's
  // choice, so customer:read alone keeps a support viewer's Cmd+K); a
  // workflow run asked only a read policy; an inventory delete asks only read.
  {
    matcher: '/admin/search',
    method: 'GET',
    policy: { resource: 'customer', operation: 'read' },
    coreRoute: true,
  },
  ...[
    '/admin/workflows-executions/*/run',
    '/admin/workflows-executions/*/steps/*',
  ].map(
    (matcher): AdminRoute => ({
      matcher,
      method: 'POST',
      policy: update('workflow_execution'),
      coreRoute: true,
    }),
  ),
  {
    matcher: '/admin/inventory-items/*',
    method: 'DELETE',
    policy: { resource: 'inventory_item', operation: 'delete' },
    coreRoute: true,
  },
];

/** Custom write routes under a core prefix (the write policy core would ask
 *  for). Derived from ADMIN_ROUTES. */
export const CORE_PREFIX_WRITES = ADMIN_ROUTES.filter(
  (r) =>
    r.policy &&
    !r.secret &&
    !r.coreRoute &&
    r.method !== 'GET' &&
    !(r.matcher.split('/')[2] in CUSTOM_ADMIN_RESOURCES),
).map((r) => ({ matcher: r.matcher, method: r.method, ...r.policy! }));

/** GETs that hand out secrets a read role must not see even with the screen's
 *  read policy: partner logins' passwords (the players export) and full bank
 *  account numbers (a customer's payout details, a withdrawal's account). Each
 *  asks for its OWN read policy on top of the prefix's — Medusa ANDs
 *  overlapping entries — so the view-only Support viewer (player / customer /
 *  payment:read, scripts/create-support-viewer.ts) is refused, while `*:*`
 *  staff and the `*:read` desk bots pass as before. Declared in
 *  policies/admin-surfaces.ts. Resources must be NEW names: Mercur already
 *  owns `payout_account` (its seller payouts, key-unique policy rows). Core's
 *  customer reads carry the same values in metadata: redactCustomerSecrets
 *  applies these policies there. Derived from ADMIN_ROUTES (`secret`). */
export const SECRET_READS = ADMIN_ROUTES.filter((r) => r.secret).map((r) => ({
  matcher: r.matcher,
  resource: r.policy!.resource,
}));

const METHODS_BY_OPERATION = Object.entries(OPERATION_BY_METHOD).reduce<
  Record<string, Method[]>
>((acc, [method, operation]) => {
  (acc[operation] ??= []).push(method as keyof typeof OPERATION_BY_METHOD);
  return acc;
}, {});

/** The RBAC entries middlewares.ts spreads in: one policy per custom prefix
 *  and method, then every ADMIN_ROUTES policy. Two matchers per prefix
 *  (`/admin/x` and `/admin/x/*`, a `*` spanning `/` under path-to-regexp
 *  0.1.x), never a bare `/admin/x*`, which would also catch any future
 *  sibling prefix that merely starts with the same letters. */
export const adminRbacRoutes: MiddlewareRoute[] = [
  ...Object.entries(CUSTOM_ADMIN_RESOURCES).flatMap(([prefix, resource]) =>
    [`/admin/${prefix}`, `/admin/${prefix}/*`].flatMap((matcher) =>
      Object.entries(METHODS_BY_OPERATION).map(([operation, methods]) => ({
        matcher,
        methods,
        policies: [{ resource, operation }],
      })),
    ),
  ),
  ...ADMIN_ROUTES.flatMap((r) =>
    r.policy
      ? [{ matcher: r.matcher, methods: [r.method], policies: [r.policy] }]
      : [],
  ),
];

type Middleware = NonNullable<MiddlewareRoute['middlewares']>[number];

/** The limiter entries middlewares.ts spreads in right after adminRbacRoutes,
 *  one per ADMIN_ROUTES record with `limits`. middlewares.ts passes its one
 *  instance of each limiter, so routes on the same tier share one budget,
 *  and the parser for a `lateJsonBody` record (this file loads no express). */
export function adminRouteLimits(
  limiters: Record<AdminLimiter, Middleware>,
  lateJson: (limit: string) => Middleware,
): MiddlewareRoute[] {
  return ADMIN_ROUTES.flatMap((r) =>
    r.limits
      ? [
          {
            matcher: r.matcher,
            methods: [r.method],
            ...(r.lateJsonBody && { bodyParser: false as const }),
            middlewares: [
              ...r.limits.map((l) => limiters[l]),
              ...(r.lateJsonBody ? [lateJson(r.lateJsonBody)] : []),
            ],
          },
        ]
      : [],
  );
}

/** The per-route desk-bot blocks reports/admin/proxy.ts adds to its
 *  prefix-wide ones. A matcher's `*` (and any `:param`) is one segment here,
 *  as the proxy's own patterns write it. */
export const deskBotBlockedRoutes: [RegExp, string][] = ADMIN_ROUTES.flatMap(
  (r): [RegExp, string][] =>
    r.deskBotsBlocked
      ? [
          [
            new RegExp(
              `^${r.matcher
                .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
                .replace(/\*|:[A-Za-z_]\w*/g, '[^/]+')}(/|$)`,
            ),
            r.deskBotsBlocked,
          ],
        ]
      : [],
);
