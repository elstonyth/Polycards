import type { PnlFreeSource, PnlPair } from '../../lib/admin-rest';

// The P&L Marketing section (GET /admin/profit-report/pnl → `marketing`),
// mirroring MarketingSection in backend modules/packs/pnl-marketing.ts.

export const PNL_CREDIT_SOURCES = [
  'adjustment',
  'checkin',
  'task',
  'weekly_challenge',
  'returned',
  'lucky_draw',
  'other',
] as const;
export type PnlCreditSource = (typeof PNL_CREDIT_SOURCES)[number];

export const PNL_CARD_SOURCES = [
  'checkin',
  'task',
  'weekly_challenge',
] as const;
export type PnlCardSource = (typeof PNL_CARD_SOURCES)[number];

export type PnlMarketing = {
  total: PnlPair;
  credit_used: {
    total: PnlPair;
    by_source: Record<PnlCreditSource, PnlPair>;
    returned_back: PnlPair;
  };
  credit_given: {
    total: PnlPair;
    by_source: Record<PnlCreditSource, PnlPair>;
    removed: PnlPair;
  };
  free_cards: {
    total: PnlPair;
    by_source: Record<
      PnlCardSource,
      { cards: number; sold: number; value: PnlPair }
    >;
  };
  free_packs: {
    total: PnlPair;
    packs: {
      slug: string;
      title: string;
      price_sen: number;
      qty: Record<PnlFreeSource, number>;
      value: PnlPair;
    }[];
  };
  referral: PnlPair;
  cash_rewards: {
    total: PnlPair;
    by_source: Record<
      'checkin' | 'task' | 'weekly_challenge' | 'other',
      PnlPair
    >;
  };
};
