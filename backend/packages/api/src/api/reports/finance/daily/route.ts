import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { describeScope, loadGroupScope, parseWindow } from '../../params';
import { and, reportDb, scopeFilter, windowFilter } from '../../sql';
import { ledgerTotalsByDay } from '../queries';

// GET /reports/finance/daily: the economy totals per Malaysia calendar day.
// Both bounds are required and the window is capped, so one call cannot scan
// the whole ledger day by day.
export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const window = parseWindow(req.query, { required: true, maxDays: 93 });
  const scope = await loadGroupScope(req);
  const days = await ledgerTotalsByDay(
    reportDb(req),
    and(
      windowFilter(window, 'ct.created_at'),
      scopeFilter(scope, 'ct.customer_id'),
    ),
  );
  res.json({
    currency: 'MYR',
    window: { from: window.from, to: window.to },
    scope: describeScope(scope),
    days,
  });
}
