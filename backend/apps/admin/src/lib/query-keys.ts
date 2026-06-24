// Centralized query keys for the gacha admin pages. Hierarchical so a pack-level
// invalidation can target the odds without touching the pack list.
export const qk = {
  packs: ['admin', 'packs'] as const,
  pack: (slug: string) => ['admin', 'pack', slug] as const,
  packOdds: (slug: string) => ['admin', 'pack', slug, 'odds'] as const,
  cards: ['admin', 'cards'] as const,
  pulls: ['admin', 'pulls'] as const,
  economy: ['admin', 'economy'] as const,
  eligibleProducts: ['admin', 'eligible-products'] as const,
  customerGacha: (id: string) => ['admin', 'customer', id, 'gacha'] as const,
  referralTree: (id: string, d: number) => ['admin', 'customer', id, 'referral-tree', d] as const,
  customerCommissions: (id: string, page: number) => ['admin', 'customer', id, 'commissions', page] as const,
  deliveryOrders: (status?: string) =>
    ['admin', 'delivery-orders', status ?? 'all'] as const,
  deliveryOrder: (id: string) => ['admin', 'delivery-order', id] as const,
};
