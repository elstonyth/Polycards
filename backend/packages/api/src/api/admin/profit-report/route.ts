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
  // A repeated ?range= arrives as an array: refused, never read as "this
  // month" (a dropped filter would answer a question nobody asked).
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

  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  // One after the other, not Promise.all: each statement takes a pool
  // connection, the pool is small and shared with the storefront, and the
  // heavier ones scan the whole ledger. A report load must never starve
  // pack opens or gateway callbacks.
  const fx = await resolveFxRate(packs);
  const cash = await packs.profitCashTotals(windows, scope);
  const owed = await packs.profitOwed(scope, fx);
  const reasons = await packs.ledgerReasonTotals(
    windows?.current.from.toISOString(),
    windows?.current.to.toISOString(),
    scope,
  );
  const rtp = await packRtpRows(packs, fx);

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
    cash: profitCash(cash.current, cash.previous),
    owed: profitOwed(owed, cash.allTime),
    activity: profitActivity(reasons),
    packs: rtp,
  });
}
