import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../../modules/packs';
import type PacksModuleService from '../../../modules/packs/service';
import { STATS_RANGES, statsWindows } from '../../../modules/packs/stats';
import { parseScope } from '../../../modules/packs/real-customers';
import {
  profitActivity,
  profitCash,
  profitOwed,
} from '../../../modules/packs/profit';
import { resolveFxRate } from '../../../modules/packs/pricing';
import { packRtpRows } from '../economy/pack-rtp';

const RANGES = [...STATS_RANGES, 'all'] as const;

const str = (v: unknown): string | undefined =>
  typeof v === 'string' ? v : undefined;

// GET /admin/profit-report — the operator's cash view (spec
// docs/superpowers/specs/2026-10-14-admin-finance-pages-design.md §4): real
// money in and out through the gateway for a window, what players could
// still cash out right now, where credit moved inside the site, and the
// per-pack payout rate. Real customers by default (scope=default), every
// account with scope=all. Windows are the Stats/Dashboard presets (MYT,
// half-open, with the window before for comparison); range=all has neither.
// Read-only. /admin/economy is left as it was.
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

  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const fx = await resolveFxRate(packs);
  const [current, previous, allTime, owed, reasons, rtp] = await Promise.all([
    packs.profitCashTotals(
      windows?.current.from ?? null,
      windows?.current.to ?? null,
      scope,
    ),
    windows
      ? packs.profitCashTotals(
          windows.previous.from,
          windows.previous.to,
          scope,
        )
      : Promise.resolve(null),
    // range=all: the current window IS all time, so don't count it twice.
    windows
      ? packs.profitCashTotals(null, null, scope)
      : Promise.resolve(null),
    packs.profitOwed(scope, fx),
    packs.ledgerReasonTotals(
      windows?.current.from.toISOString(),
      windows?.current.to.toISOString(),
      scope,
    ),
    packRtpRows(packs, fx),
  ]);

  // Money that varies by nothing but the admin session.
  res.setHeader('Cache-Control', 'no-store');
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
    cash: profitCash(current, previous),
    owed: profitOwed(owed, allTime ?? current),
    activity: profitActivity(reasons),
    packs: rtp,
  });
}
