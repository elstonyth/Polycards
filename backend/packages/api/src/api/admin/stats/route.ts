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
  // One query at a time, like profit-report: this page polls every 30 s and
  // four parallel scans took 4 of the 5 pool connections pack opens use
  // (audit 2026-11-11).
  const figures = async ({ from, to }: StatsWindow) => ({
    ...(await packs.signupTopupStats(from, to, scope)),
    ...(await packs.withdrawalStats(from, to, scope)),
  });
  const current = await figures(windows.current);
  const previous = await figures(windows.previous);
  // Dates serialize to ISO strings.
  res.json({
    as_of: now,
    scope,
    current: { ...windows.current, stats: current },
    previous: { ...windows.previous, stats: previous },
  });
}
