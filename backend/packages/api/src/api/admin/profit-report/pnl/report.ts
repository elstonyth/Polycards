import type { MedusaRequest } from '@medusajs/framework/http';
import type { ICacheService } from '@medusajs/framework/types';
import { MedusaError, Modules } from '@medusajs/framework/utils';
import { STATS_RANGES, statsWindows } from '../../../../modules/packs/stats';
import { parseScope } from '../../../../modules/packs/real-customers';
import {
  cogsSection,
  cogsSlugsOf,
  costAsOf,
  packSalesSection,
  shippingSection,
  slugsOf,
  totalsSection,
} from '../../../../modules/packs/pnl';
import { marketingSection } from '../../../../modules/packs/pnl-marketing';
import {
  assetsSection,
  floatingSection,
} from '../../../../modules/packs/pnl-balance';
import { marketingWindowRows } from './queries-marketing';
import {
  freeCreditUnused,
  stockRows,
  vaultCards,
  walletRows,
} from './queries-balance';
import { PACKS_MODULE } from '../../../../modules/packs';
import type PacksModuleService from '../../../../modules/packs/service';
import { resolveFxRate } from '../../../../modules/packs/pricing';
import { reportDb } from '../../../reports/sql';
import { cached, CACHE_S, CLOSED_CACHE_S } from './cache';
import {
  capsuleSlugsOf,
  coinFlipSection,
  luckyDrawSection,
} from '../../../../modules/packs/pnl-games';
import { gamesWindowRows } from './queries-games';
import {
  cardCostLines,
  cardCosts,
  cogsWindowRows,
  dayRates,
  packMeta,
  packWindowRows,
  shippingWindow,
} from './queries';

const RANGES = [...STATS_RANGES, 'all'] as const;

const str = (v: unknown): string | undefined =>
  typeof v === 'string' ? v : undefined;

// The P&L report body for a request's query (owner 2026-11-15; spec
// plans/pnl-report/SPEC.md), shared by the page (./route.ts) and the Excel
// export (./export/route.ts) under one cache key, so an export after the page
// has loaded costs nothing. Same query contract as the Profit report
// (../route.ts): Stats presets in MYT with the window before for comparison,
// range=all has neither; real customers by default, scope=all for everyone.
// Read-only.
export async function loadPnlReport(req: MedusaRequest) {
  const scope = parseScope(req.query.scope, 'default');
  if (!scope) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'scope must be default or all.',
    );
  }
  if (req.query.range !== undefined && typeof req.query.range !== 'string') {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `range must be one of ${RANGES.join(', ')}.`,
    );
  }
  const range = str(req.query.range) || 'month';
  const now = new Date();
  const windows =
    range === 'all'
      ? null
      : statsWindows(range, now, str(req.query.from), str(req.query.to));
  if (range !== 'all' && !windows) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `range must be one of ${RANGES.join(', ')}; custom needs from <= to as YYYY-MM-DD, starting no later than today.`,
    );
  }

  // Keyed by the window actually used: its start (each preset starts on a MYT
  // day or month boundary, so the key turns over when the period does) and,
  // for custom, the requested end day. A preset ignores from/to, so they never
  // make a new key.
  const key = [
    range,
    windows ? windows.current.from.toISOString() : 'all',
    range === 'custom' ? (str(req.query.to) ?? '') : '',
    scope,
  ].join('|');
  const store = req.scope.resolve<ICacheService>(Modules.CACHE);
  const db = reportDb(req);
  // Both windows ended before now: nothing in them moves but late supplier
  // costs and today's card prices. The window before always ends first.
  const closed = !!windows && windows.current.to.getTime() < now.getTime();
  const period = await cached(
    store,
    key,
    async () => {
      const iso0 = (w: { from: Date; to: Date } | undefined) =>
        w ? { from: w.from.toISOString(), to: w.to.toISOString() } : {};
      // One statement at a time (the pool is small and shared with the storefront).
      const cur = iso0(windows?.current);
      const prev = windows ? iso0(windows.previous) : null;
      const current = await packWindowRows(db, cur, scope);
      const previous = prev ? await packWindowRows(db, prev, scope) : null;
      const cogsCurrent = await cogsWindowRows(db, cur, scope);
      const cogsPrevious = prev ? await cogsWindowRows(db, prev, scope) : null;
      const gamesCurrent = await gamesWindowRows(db, cur, scope);
      const gamesPrevious = prev
        ? await gamesWindowRows(db, prev, scope)
        : null;
      const mkCurrent = await marketingWindowRows(db, cur, scope);
      const mkPrevious = prev
        ? await marketingWindowRows(db, prev, scope)
        : null;
      const meta = await packMeta(db, [
        ...new Set([
          ...slugsOf(current, previous),
          ...cogsSlugsOf(cogsCurrent, cogsPrevious),
          ...capsuleSlugsOf(gamesCurrent, gamesPrevious),
        ]),
      ]);
      const handles = [
        ...new Set(
          [cogsCurrent, cogsPrevious].flatMap((w) =>
            (w?.shipped ?? []).map((s) => s.handle),
          ),
        ),
      ];
      const costLines = await cardCostLines(db, handles);
      const costOf = (handle: string, day: string) =>
        costAsOf(costLines.get(handle) ?? [], day);
      const rates = await dayRates(db);
      const fallbackRate = await resolveFxRate(
        req.scope.resolve<PacksModuleService>(PACKS_MODULE),
      );
      const shipCurrent = await shippingWindow(db, cur, scope);
      const shipPrevious = prev ? await shippingWindow(db, prev, scope) : null;

      const packSales = packSalesSection(meta, current, previous);
      const cogs = cogsSection(
        meta,
        cogsCurrent,
        cogsPrevious,
        costOf,
        rates,
        fallbackRate,
      );
      const coinFlip = coinFlipSection(gamesCurrent, gamesPrevious);
      const luckyDraw = luckyDrawSection(
        meta,
        gamesCurrent,
        gamesPrevious,
        rates,
        fallbackRate,
      );
      const shipping = shippingSection(shipCurrent, shipPrevious);
      const marketing = marketingSection(
        meta,
        current,
        previous,
        mkCurrent,
        mkPrevious,
        fallbackRate,
        rates,
      );

      return {
        as_of: now,
        scope,
        range,
        window: windows
          ? { from: windows.current.from, to: windows.current.to }
          : null,
        previous: windows
          ? { from: windows.previous.from, to: windows.previous.to }
          : null,
        pack_sales: packSales,
        cogs,
        marketing,
        coin_flip: coinFlip,
        lucky_draw: luckyDraw,
        shipping,
        totals: totalsSection({
          revenue: {
            pack_sales: packSales.total,
            coin_flip: coinFlip.revenue,
            lucky_draw: luckyDraw.revenue,
          },
          other_revenue: { shipping: shipping.total },
          cogs: {
            packs: cogs.total,
            coin_flip: coinFlip.cost,
            lucky_draw: luckyDraw.cost,
          },
          marketing: marketing.total,
        }),
      };
    },
    closed ? CLOSED_CACHE_S : CACHE_S,
  );
  // Point in time (as of now): the range does not apply, so one run per scope
  // serves every range for 5 minutes, and a long-kept closed period still
  // shows current balances.
  const balance = await cached(store, `balance|${scope}`, async () => {
    const fallbackRate = await resolveFxRate(
      req.scope.resolve<PacksModuleService>(PACKS_MODULE),
    );
    const stock = await stockRows(db);
    const stockCosts = await cardCosts(
      db,
      stock.map((x) => x.handle),
    );
    const wallets = await walletRows(db, scope);
    const freeCredit = await freeCreditUnused(db, scope);
    const balanceCards = await vaultCards(db, scope, fallbackRate);
    return {
      as_of: new Date(),
      assets: assetsSection(stock, stockCosts),
      floating: floatingSection(wallets, freeCredit, balanceCards),
    };
  });
  return {
    ...period,
    balance_as_of: balance.as_of,
    assets: balance.assets,
    floating: balance.floating,
  };
}

export type PnlReportBody = Awaited<ReturnType<typeof loadPnlReport>>;
