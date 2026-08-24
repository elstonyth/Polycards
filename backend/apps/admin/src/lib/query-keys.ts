// Centralized query keys for the gacha admin pages. Hierarchical so a pack-level
// invalidation can target the odds without touching the pack list.
export const qk = {
  packs: ['admin', 'packs'] as const,
  pack: (slug: string) => ['admin', 'pack', slug] as const,
  packOdds: (slug: string) => ['admin', 'pack', slug, 'odds'] as const,
  cards: ['admin', 'cards'] as const,
  // The customer segment always renders (defaulting to 'all', same rule as the
  // source segment): appended-only, the site-wide key would be a strict PREFIX
  // of the player-scoped one and an exact-key invalidation of one would nuke
  // the other. Disjoint siblings can't.
  pulls: (page: number, source?: string, customerId?: string) =>
    ['admin', 'pulls', page, source ?? 'all', customerId ?? 'all'] as const,
  // 2-segment prefix — invalidates ALL pages of the pull ledger in one call
  pullsKey: ['admin', 'pulls'] as const,
  // Keyed on (view, page): each deposit view caches independently, so
  // switching filters never shows another view's rows. `sort` always renders
  // (default '' = the route's status-dependent default order) — same
  // always-rendered-segment rule as qk.pulls.
  globepayDeposits: (page: number, status: string, sort?: string) =>
    ['admin', 'globepay-deposits', status, page, sort ?? ''] as const,
  globepayWithdrawals: (page: number, status: string, sort?: string) =>
    ['admin', 'globepay-withdrawals', status, page, sort ?? ''] as const,
  // 2-segment prefix — invalidates EVERY view/page/sort of the withdrawals
  // list in one call. Needed because approve/deny (Task 6, plan 094) move a
  // row across views (out of 'held', into 'pending' or 'failed'), unlike a
  // plain read that only ever touches the one (page, status, sort) it fetched.
  globepayWithdrawalsKey: ['admin', 'globepay-withdrawals'] as const,
  economy: ['admin', 'economy'] as const,
  // (granularity, periods) always render — same always-rendered-segment rule
  // as qk.pulls: week and month views cache independently.
  settlement: (granularity: string, periods: number) =>
    ['admin', 'globepay-settlement', granularity, periods] as const,
  globepayBalance: ['admin', 'globepay-balance'] as const,
  // Referral rebuild (spec 2026-08-24).
  referralSettings: ['admin', 'referral-settings'] as const,
  taskDefinitions: ['admin', 'task-definitions'] as const,
  referralSettlements: ['admin', 'referral-settlements'] as const,
  referralSettlement: (id: string) =>
    ['admin', 'referral-settlements', id] as const,
  customerReferral: (id: string) =>
    ['admin', 'customer', id, 'referral'] as const,
  eligibleProducts: ['admin', 'eligible-products'] as const,
  customerGacha: (id: string) => ['admin', 'customer', id, 'gacha'] as const,
  customerAudit: (id: string, page: number) =>
    ['admin', 'customer', id, 'audit', page] as const,
  customerTransactions: (id: string, page: number) =>
    ['admin', 'customer', id, 'transactions', page] as const,
  // The status segment always renders (defaulting to 'all', same shape as
  // qk.pulls' source segment) rather than being appended only when filtered:
  // an appended segment would make the unfiltered key a strict PREFIX of the
  // filtered one, so an exact-key invalidation of the support page's full
  // history would also nuke the Vault tab's vaulted-only cache. Disjoint
  // siblings can't do that.
  customerPulls: (id: string, page: number, status?: string) =>
    ['admin', 'customer', id, 'pulls', page, status ?? 'all'] as const,
  // 4-segment prefix — invalidates ALL pages of a customer's audit in one call
  customerAuditKey: (id: string) => ['admin', 'customer', id, 'audit'] as const,
  // 4-segment prefix — invalidates ALL pages of a customer's transaction ledger in one call
  customerTransactionsKey: (id: string) =>
    ['admin', 'customer', id, 'transactions'] as const,
  // 4-segment prefix — invalidates ALL pages of a customer's pull history in one call
  customerPullsKey: (id: string) => ['admin', 'customer', id, 'pulls'] as const,
  // customerId: same always-rendered-segment rule as qk.pulls above.
  deliveryOrders: (
    status: string | undefined,
    page: number,
    q?: string,
    customerId?: string,
    sort?: string,
  ) =>
    [
      'admin',
      'delivery-orders',
      status ?? 'all',
      page,
      q ?? '',
      customerId ?? 'all',
      sort ?? 'created_at:desc',
    ] as const,
  // 2-segment prefix — invalidates ALL delivery-order pages/filters in one call
  deliveryOrdersKey: ['admin', 'delivery-orders'] as const,
  deliveryOrder: (id: string) => ['admin', 'delivery-order', id] as const,
  fxRate: ['admin', 'pricing', 'fx'] as const,
  fxHistory: ['admin', 'pricing', 'fx', 'history'] as const,
  dailyBoxes: ['admin', 'daily-rewards', 'boxes'] as const,
  dailyBox: (tier: string) =>
    ['admin', 'daily-rewards', 'boxes', tier] as const,
  voucherLadder: ['admin', 'daily-rewards', 'vouchers'] as const,
  rewardsSettings: ['admin', 'rewards-settings'] as const,
  siteSettings: ['admin', 'site-settings'] as const,
  avatarFrames: ['admin', 'avatar-frames'] as const,
  vipLevels: ['admin', 'vip-levels'] as const,
  challengeStages: ['admin', 'challenge', 'stages'] as const,
  challengeSchedules: ['admin', 'challenge', 'schedule'] as const,
  challengeWinners: (week: string) =>
    ['admin', 'challenge', 'winners', week] as const,
  challengeSettings: ['admin', 'challenge', 'settings'] as const,
  tierSettings: ['admin', 'tier-settings'] as const,

  // ── Epic 2 (Players) ───────────────────────────────────────────────────────
  players: (page: number, q?: string, sort?: string) =>
    ['admin', 'players', page, q ?? '', sort ?? 'created_at:desc'] as const,
  // 2-segment prefix — invalidates ALL pages/searches of the players list
  playersKey: ['admin', 'players'] as const,
  // The core Medusa customer record behind the Profile tab. Named rather than
  // hand-built at both ends: the group card only re-reads the server value
  // because useSetPlayerGroup invalidates this exact key, and two inline array
  // literals agreeing was a coupling nothing checked.
  customerDetail: (id: string) => ['admin', 'customer', id, 'detail'] as const,
  payoutDetails: (id: string) =>
    ['admin', 'customer', id, 'payout-details'] as const,
  spendReport: (id: string) =>
    ['admin', 'customer', id, 'spend-report'] as const,
  // ── Epic 3 (Odds) ──
  customerGroups: ['admin', 'customer-groups'] as const,
  // SIBLING namespace, not a child of customerGroups: the member count comes
  // from a different endpoint (/admin/customers?groups=), and nesting it would
  // make every odds-set save refetch every group's count for nothing.
  customerGroupCount: (id: string) =>
    ['admin', 'customer-group-counts', id] as const,
  // 2-segment prefix — invalidates EVERY group's member count in one call
  // (moving one player changes the count of two groups, not one).
  customerGroupCounts: ['admin', 'customer-group-counts'] as const,

  // ── Epic 4 (Ledger) ──
  // Every filter segment always renders (defaulting to 'all'/'') — same rule as
  // qk.players/qk.pulls: an appended-only segment would make the unfiltered key
  // a strict PREFIX of a filtered one.
  ledger: (
    page: number,
    type?: string,
    q?: string,
    from?: string,
    to?: string,
    sort?: string,
  ) =>
    [
      'admin',
      'ledger',
      page,
      type ?? 'all',
      q ?? '',
      from ?? '',
      to ?? '',
      sort ?? 'occurred_at:desc',
    ] as const,
  // 2-segment prefix — invalidates ALL pages/filters of the ledger in one call
  ledgerKey: ['admin', 'ledger'] as const,
  // ── Epic 5 (Inventory) ─────────────────────────────────────────────────────
  // q and sort ALWAYS render (defaulting to '' / 'created_at:desc') rather than
  // being appended only when set, same rule as qk.players/qk.pulls: an
  // appended-only segment makes the unsorted key a strict PREFIX of the sorted
  // one, so invalidating one would nuke the other.
  purchaseInvoices: (page: number, q?: string, sort?: string) =>
    [
      'admin',
      'purchase-invoices',
      page,
      q ?? '',
      sort ?? 'created_at:desc',
    ] as const,
  // 2-segment prefix — invalidates ALL pages/searches/sorts of the list
  purchaseInvoicesKey: ['admin', 'purchase-invoices'] as const,
  // SINGULAR namespace, so the detail cache is a SIBLING of the list, not a
  // descendant (same shape as deliveryOrder vs deliveryOrders, pack vs packs).
  // An invoice is immutable — there is no PUT/DELETE route — so a detail entry
  // never needs invalidating, and nesting it under purchaseInvoicesKey would
  // only make every create refetch details nothing changed about.
  purchaseInvoice: (id: string) => ['admin', 'purchase-invoice', id] as const,
  // The Inventory list is UNPAGED (the route returns every catalog row), so `q`
  // is the only variable. It ALWAYS renders, defaulting to '' — same
  // always-rendered-segment rule as qk.players/qk.purchaseInvoices: appended
  // only when set, the unfiltered key would be a strict PREFIX of every
  // filtered one and invalidating it would nuke them all.
  inventory: (q?: string) => ['admin', 'inventory', q ?? ''] as const,
  // 2-segment prefix — invalidates EVERY search of the inventory list. The bulk
  // "List to gacha card" tool flips is_card on rows that are also cached under
  // other `q` values, so it has to reach the whole namespace; refetching just
  // the key on screen would leave the operator's earlier searches lying. Creating
  // a purchase invoice reaches it for the same reason — it moves on_hand and the
  // weighted-average cost on rows cached under every `q`, not just the one shown.
  inventoryKey: ['admin', 'inventory'] as const,
  // SINGULAR sibling namespace, same shape as purchaseInvoice/purchaseInvoices
  // and deliveryOrder/deliveryOrders. NOT nested under the list key: slot 2 of
  // qk.inventory holds the operator's SEARCH STRING, so ['admin','inventory',
  // handle, page] would make qk.inventory('charizard') a strict prefix of the
  // detail key for the card 'charizard' — two unrelated concepts sharing a key
  // space, which is exactly the prefix hazard every comment above guards
  // against. `page` is the movement-history page; the item itself is re-sent
  // whole with each one.
  inventoryItem: (handle: string, page: number) =>
    ['admin', 'inventory-item', handle, page] as const,
  // 2-segment prefix — invalidates EVERY handle and EVERY movement page of
  // the item detail. Sibling of inventoryKey, never a parent of it: because the
  // two namespaces are disjoint by design (see above), a prefix invalidation of
  // one cannot reach the other, so anything that mutates BOTH the list and a
  // detail — a purchase invoice, a bulk register — has to name both roots.
  inventoryItemKey: ['admin', 'inventory-item'] as const,
};
