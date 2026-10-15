import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../../modules/packs';
import type PacksModuleService from '../../../modules/packs/service';
import {
  STATS_RANGES,
  statsWindows,
  type StatsWindow,
} from '../../../modules/packs/stats';
import { parseScope } from '../../../modules/packs/real-customers';

const str = (v: unknown): string | undefined =>
  typeof v === 'string' ? v : undefined;

// GET /admin/stats: sign-ups, top-ups and withdrawals for one MYT window, next
// to the same figures for the window before it (the Stats page's "vs
// previous"). Reads only. The window math is pure and unit-tested in
// modules/packs/stats.ts.
export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const now = new Date();
  const windows = statsWindows(
    str(req.query.range) ?? 'today',
    now,
    str(req.query.from),
    str(req.query.to),
  );
  if (!windows) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `range must be one of ${STATS_RANGES.join(', ')}; custom needs from <= to as YYYY-MM-DD, starting no later than today.`,
    );
  }

  // Real customers only, or everyone (the default, so old callers keep
  // their answer). The Dashboard's switch sends it.
  const scope = parseScope(req.query.scope, 'all');
  if (!scope) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'scope must be default or all.',
    );
  }

  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const figures = ({ from, to }: StatsWindow) =>
    Promise.all([
      packs.signupTopupStats(from, to, scope),
      packs.withdrawalStats(from, to, scope),
    ]).then(([inflow, outflow]) => ({ ...inflow, ...outflow }));
  // The player of the period is for the current window only: the Dashboard
  // live-polls this route and never shows one for the window before.
  const [current, previous, topTopup] = await Promise.all([
    figures(windows.current),
    figures(windows.previous),
    packs.topTopupCustomer(windows.current.from, windows.current.to, scope),
  ]);
  // Dates serialize to ISO strings.
  res.json({
    as_of: now,
    scope,
    current: { ...windows.current, stats: current, top_topup: topTopup },
    previous: { ...windows.previous, stats: previous },
  });
}
