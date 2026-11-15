import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import { STATS_RANGES, statsWindows } from '../../../../modules/packs/stats';
import { parseScope } from '../../../../modules/packs/real-customers';
import {
  cogsSection,
  cogsSlugsOf,
  packSalesSection,
  slugsOf,
} from '../../../../modules/packs/pnl';
import { PACKS_MODULE } from '../../../../modules/packs';
import type PacksModuleService from '../../../../modules/packs/service';
import { resolveFxRate } from '../../../../modules/packs/pricing';
import { reportDb } from '../../../reports/sql';
import {
  cardCosts,
  cogsWindowRows,
  dayRates,
  packMeta,
  packWindowRows,
} from './queries';

const RANGES = [...STATS_RANGES, 'all'] as const;

const str = (v: unknown): string | undefined =>
  typeof v === 'string' ? v : undefined;

// GET /admin/profit-report/pnl — the P&L report (owner 2026-11-15; spec
// plans/pnl-report/SPEC.md). Same query contract as the Profit report
// (../route.ts): Stats presets in MYT with the window before for comparison,
// range=all has neither; real customers by default, scope=all for everyone.
// Under the profit-report prefix so profit_report:read guards it. Read-only.
export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
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

  const db = reportDb(req);
  const iso0 = (w: { from: Date; to: Date } | undefined) =>
    w ? { from: w.from.toISOString(), to: w.to.toISOString() } : {};
  // One statement at a time (the pool is small and shared with the storefront).
  const cur = iso0(windows?.current);
  const prev = windows ? iso0(windows.previous) : null;
  const current = await packWindowRows(db, cur, scope);
  const previous = prev ? await packWindowRows(db, prev, scope) : null;
  const cogsCurrent = await cogsWindowRows(db, cur, scope);
  const cogsPrevious = prev ? await cogsWindowRows(db, prev, scope) : null;
  const meta = await packMeta(db, [
    ...new Set([
      ...slugsOf(current, previous),
      ...cogsSlugsOf(cogsCurrent, cogsPrevious),
    ]),
  ]);
  const handles = [
    ...new Set(
      [cogsCurrent, cogsPrevious].flatMap((w) =>
        (w?.shipped ?? []).map((s) => s.handle),
      ),
    ),
  ];
  const costs = await cardCosts(db, handles);
  const rates = await dayRates(db);
  const fallbackRate = await resolveFxRate(
    req.scope.resolve<PacksModuleService>(PACKS_MODULE),
  );

  res.json({
    as_of: now,
    scope,
    range,
    window: windows
      ? { from: windows.current.from, to: windows.current.to }
      : null,
    previous: windows
      ? { from: windows.previous.from, to: windows.previous.to }
      : null,
    pack_sales: packSalesSection(meta, current, previous),
    cogs: cogsSection(
      meta,
      cogsCurrent,
      cogsPrevious,
      costs,
      rates,
      fallbackRate,
    ),
  });
}
