// GET /admin/profit-report/pnl's point-in-time sections, mirroring
// packages/api/src/modules/packs/pnl-balance.ts. Integer sen, as of now: the
// range is ignored, the scope is not (assets are company stock, never scoped).

export type PnlBonusSource =
  | 'adjustment'
  | 'checkin'
  | 'task'
  | 'weekly_challenge'
  | 'returned'
  | 'lucky_draw';

export type PnlAssetsSection = {
  total_sen: number;
  cards: number;
  no_cost_cards: number;
};

export type PnlCardsLine = { cards: number; sen: number };

export type PnlFloatingSection = {
  wallet: {
    withdrawable_sen: number;
    free_credit_sen: number;
    free_credit_by_source: Record<PnlBonusSource, number>;
    locked_sen: number;
    non_withdrawable_sen: number;
    total_sen: number;
  };
  cards: { vault: PnlCardsLine; processing: PnlCardsLine; total_sen: number };
  total_sen: number;
};
