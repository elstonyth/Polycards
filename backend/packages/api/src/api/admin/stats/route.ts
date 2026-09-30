import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../../modules/packs';
import type PacksModuleService from '../../../modules/packs/service';
import { STATS_RANGES, statsWindows } from '../../../modules/packs/stats';

const str = (v: unknown): string | undefined =>
  typeof v === 'string' ? v : undefined;

// GET /admin/stats: sign-ups and top-ups for one MYT window, next to the same
// figures for the window before it (the Stats page's "vs previous"). Reads
// only. The window math is pure and unit-tested in modules/packs/stats.ts.
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

  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const [current, previous] = await Promise.all([
    packs.signupTopupStats(windows.current.from, windows.current.to),
    packs.signupTopupStats(windows.previous.from, windows.previous.to),
  ]);
  // Dates serialize to ISO strings.
  res.json({
    as_of: now,
    current: { ...windows.current, stats: current },
    previous: { ...windows.previous, stats: previous },
  });
}
