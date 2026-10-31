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
// policies (src/policies/admin-surfaces.ts) and the coverage guard
// (__tests__/admin-rbac-coverage.unit.spec.ts), so they cannot drift.

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

/** Custom write routes under a core prefix: the write policy core would ask
 *  for, on EXACT matchers so core's own routes keep exactly their policies. */
export const CORE_PREFIX_WRITES: {
  matcher: string;
  method: 'POST';
  resource: string;
  operation: Operation;
}[] = [
  ...[
    'credits',
    'disable',
    'enable',
    'freeze',
    'group',
    'lucky-draw-tickets',
    'pack-gifts',
    'partner-rate',
    'payout-details',
    'phone',
    'real-name',
    'referral',
    'unfreeze',
  ].map((sub) => ({
    matcher: `/admin/customers/*/${sub}`,
    method: 'POST' as const,
    resource: CORE_READ_PREFIXES.customers,
    operation: 'update' as const,
  })),
  ...['odds-set', 'policy'].map((sub) => ({
    matcher: `/admin/customer-groups/*/${sub}`,
    method: 'POST' as const,
    resource: CORE_READ_PREFIXES['customer-groups'],
    operation: 'update' as const,
  })),
  {
    matcher: '/admin/products/from-pricecharting',
    method: 'POST',
    resource: CORE_READ_PREFIXES.products,
    operation: 'create',
  },
  ...[
    'audit/acknowledge',
    'fx',
    'gateway',
    'withdrawals/*/approve',
    'withdrawals/*/deny',
    'withdrawal-controls',
  ].map((sub) => ({
    matcher: `/admin/payments/${sub}`,
    method: 'POST' as const,
    resource: CORE_READ_PREFIXES.payments,
    operation: 'update' as const,
  })),
];

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
 *  applies these policies there. */
export const SECRET_READS = [
  { matcher: '/admin/players/export', resource: 'partner_credential' },
  {
    matcher: '/admin/customers/*/payout-details',
    resource: 'customer_bank_account',
  },
  {
    matcher: '/admin/payments/withdrawals/*/account',
    resource: 'customer_bank_account',
  },
] as const;

const METHODS_BY_OPERATION = Object.entries(OPERATION_BY_METHOD).reduce<
  Record<string, ('GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE')[]>
>((acc, [method, operation]) => {
  (acc[operation] ??= []).push(method as keyof typeof OPERATION_BY_METHOD);
  return acc;
}, {});

/** The middleware entries middlewares.ts spreads in. Two matchers per prefix
 *  (`/admin/x` and `/admin/x/*`, a `*` spanning `/` under path-to-regexp
 *  0.1.x), never a bare `/admin/x*`, which would also catch any future
 *  sibling prefix that merely starts with the same letters.
 *
 *
 *  Automation reads and runs on `automation:*` alone, so the automation
 *  operator role (scripts/create-automation-operator.ts) works without
 *  `customer:read`. Saving the account list also asks `customer:update`: it
 *  accepts ANY registered customer's email, and a live run then opens packs on
 *  that customer's wallet. Only staff choose which accounts automation touches.
 *  Not `customer:read`, which a view-only role beside the operator role holds
 *  (scripts/grant-support-viewer.ts). */
export const adminRbacRoutes: MiddlewareRoute[] = [
  {
    matcher: '/admin/automation/accounts',
    methods: ['POST'],
    policies: [{ resource: 'customer', operation: 'update' }],
  },
  {
    // The mailing list carries customer names, addresses, phones and emails:
    // on top of procurement:read (the prefix entry below), ask the same
    // permission the Orders page does, so a purchasing-only role cannot read
    // customer details through it.
    matcher: '/admin/procurement/to-ship',
    methods: ['GET'],
    policies: [{ resource: 'delivery_order', operation: 'read' }],
  },
  ...Object.entries(CUSTOM_ADMIN_RESOURCES).flatMap(([prefix, resource]) =>
    [`/admin/${prefix}`, `/admin/${prefix}/*`].flatMap((matcher) =>
      Object.entries(METHODS_BY_OPERATION).map(([operation, methods]) => ({
        matcher,
        methods,
        policies: [{ resource, operation }],
      })),
    ),
  ),
  ...CORE_PREFIX_WRITES.map((w) => ({
    matcher: w.matcher,
    methods: [w.method],
    policies: [{ resource: w.resource, operation: w.operation }],
  })),
  ...SECRET_READS.map((s) => ({
    matcher: s.matcher,
    methods: ['GET' as const],
    policies: [{ resource: s.resource, operation: 'read' as const }],
  })),
];
