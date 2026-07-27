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
  economy: ['admin', 'economy'] as const,
  eligibleProducts: ['admin', 'eligible-products'] as const,
  customerGacha: (id: string) => ['admin', 'customer', id, 'gacha'] as const,
  referralTree: (id: string, d: number) =>
    ['admin', 'customer', id, 'referral-tree', d] as const,
  customerCommissions: (id: string, page: number) =>
    ['admin', 'customer', id, 'commissions', page] as const,
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
  // 4-segment prefix — invalidates ALL pages of a customer's commissions in one call
  customerCommissionsKey: (id: string) =>
    ['admin', 'customer', id, 'commissions'] as const,
  // 4-segment prefix — invalidates ALL pages of a customer's audit in one call
  customerAuditKey: (id: string) => ['admin', 'customer', id, 'audit'] as const,
  // 4-segment prefix — invalidates ALL pages of a customer's transaction ledger in one call
  customerTransactionsKey: (id: string) =>
    ['admin', 'customer', id, 'transactions'] as const,
  // 4-segment prefix — invalidates ALL pages of a customer's pull history in one call
  customerPullsKey: (id: string) => ['admin', 'customer', id, 'pulls'] as const,
  // 4-segment prefix — invalidates ALL depths of a customer's referral tree in one call
  referralTreeKey: (id: string) =>
    ['admin', 'customer', id, 'referral-tree'] as const,
  // customerId: same always-rendered-segment rule as qk.pulls above.
  deliveryOrders: (
    status: string | undefined,
    page: number,
    q?: string,
    customerId?: string,
  ) =>
    [
      'admin',
      'delivery-orders',
      status ?? 'all',
      page,
      q ?? '',
      customerId ?? 'all',
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
  challengeSettings: ['admin', 'challenge', 'settings'] as const,

  // ── Epic 2 (Players) ───────────────────────────────────────────────────────
  players: (page: number, q?: string) =>
    ['admin', 'players', page, q ?? ''] as const,
  // 2-segment prefix — invalidates ALL pages/searches of the players list
  playersKey: ['admin', 'players'] as const,
  payoutDetails: (id: string) =>
    ['admin', 'customer', id, 'payout-details'] as const,
  spendReport: (id: string) =>
    ['admin', 'customer', id, 'spend-report'] as const,
};
