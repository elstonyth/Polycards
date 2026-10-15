import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../../../modules/packs';
import type PacksModuleService from '../../../../modules/packs/service';
import { STATS_RANGES, statsWindows } from '../../../../modules/packs/stats';
import { parseScope } from '../../../../modules/packs/real-customers';

const str = (v: unknown): string | undefined =>
  typeof v === 'string' ? v : undefined;

/**
 * GET /admin/stats/leaders?range=…&scope=default|all: the window's top
 * players (PacksModuleService.periodLeaders), for the All Players page. The
 * same range rules as GET /admin/stats; current window only. Kept off that
 * route because the Dashboard polls it every 30s and shows none of this.
 */
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
  const scope = parseScope(req.query.scope, 'all');
  if (!scope) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'scope must be default or all.',
    );
  }
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const { from, to } = windows.current;
  res.json({
    as_of: now,
    scope,
    from,
    to,
    leaders: await packs.periodLeaders(from, to, scope),
  });
}
