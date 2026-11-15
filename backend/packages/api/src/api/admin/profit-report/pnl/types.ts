// The JSON body of GET /admin/profit-report/pnl, written once (ADR 0017): the
// handler is checked against it and the admin imports it as
// `@acme/api/admin/profit-report/pnl`. Types only: the admin typecheck reads
// this file and everything it imports, so import only the small modules that
// work out the shape, never service.ts. Amounts are integer sen; dates are ISO
// strings, as sent.
import type { STATS_RANGES } from '../../../../modules/packs/myt-window';
import type { CustomerScope } from '../../../../modules/packs/real-customers';
import type {
  CogsFigures,
  CogsSection,
  PackFigures,
  PackSalesSection,
  PackTree,
  Pair,
  ShippingSection,
  TotalsSection,
} from '../../../../modules/packs/pnl';
import type {
  CoinFlipSection,
  Count,
  LuckyDrawSection,
} from '../../../../modules/packs/pnl-games';
import type {
  CardSource,
  CashRewardSource,
  CreditSource,
  MarketingSection,
} from '../../../../modules/packs/pnl-marketing';
import type {
  AssetsSection,
  BonusSource,
  FloatingSection,
} from '../../../../modules/packs/pnl-balance';

export type PnlRange = (typeof STATS_RANGES)[number] | 'all';
export type PnlWindow = { from: string; to: string };

export type PnlReport = {
  /** When the period's figures were worked out (a closed period is kept 6 h). */
  as_of: string;
  /** When the as-of-now sections (assets, floating money) were worked out. */
  balance_as_of: string;
  scope: CustomerScope;
  range: PnlRange;
  /** Null for range=all, as is every previous_sen / previous. */
  window: PnlWindow | null;
  previous: PnlWindow | null;
  pack_sales: PackSalesSection;
  cogs: CogsSection;
  marketing: MarketingSection;
  coin_flip: CoinFlipSection;
  lucky_draw: LuckyDrawSection;
  shipping: ShippingSection;
  totals: TotalsSection;
  assets: AssetsSection;
  floating: FloatingSection;
};

// The parts the admin cards render, under the admin's names.
export type {
  AssetsSection as PnlAssetsSection,
  BonusSource as PnlBonusSource,
  CardSource as PnlCardSource,
  CashRewardSource as PnlCashRewardSource,
  CogsFigures as PnlCogsFigures,
  CoinFlipSection as PnlCoinFlipSection,
  Count as PnlCount,
  CreditSource as PnlCreditSource,
  FloatingSection as PnlFloatingSection,
  LuckyDrawSection as PnlLuckyDrawSection,
  MarketingSection as PnlMarketing,
  PackFigures as PnlPackFigures,
  PackTree as PnlPackTree,
  Pair as PnlPair,
  ShippingSection as PnlShippingSection,
  TotalsSection as PnlTotalsSection,
};
