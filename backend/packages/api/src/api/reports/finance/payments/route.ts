import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { DEPOSIT_STATUSES } from '../../../../modules/packs/models/gateway-deposit';
import { WITHDRAWAL_STATUSES } from '../../../../modules/packs/models/gateway-withdrawal';
import { describeScope, loadGroupScope, parseWindow } from '../../params';
import { and, reportDb, scopeFilter, windowFilter } from '../../sql';
import { statusTotals } from '../queries';

// GET /reports/finance/payments: gateway deposits and withdrawals CREATED in
// the window, per status, plus what is open right now whatever the window
// (pending deposits; pending and admin-held withdrawals).
export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const window = parseWindow(req.query);
  const scope = await loadGroupScope(req);
  const db = reportDb(req);
  const inScope = scopeFilter(scope, 'g.customer_id');
  const inWindow = and(windowFilter(window, 'g.created_at'), inScope);
  res.json({
    currency: 'MYR',
    window: { from: window.from ?? null, to: window.to ?? null },
    scope: describeScope(scope),
    deposits: {
      by_status: await statusTotals(db, 'deposits', DEPOSIT_STATUSES, inWindow),
      open_now: await statusTotals(db, 'deposits', ['pending'], inScope),
    },
    withdrawals: {
      by_status: await statusTotals(
        db,
        'withdrawals',
        WITHDRAWAL_STATUSES,
        inWindow,
      ),
      open_now: await statusTotals(
        db,
        'withdrawals',
        ['pending', 'held'],
        inScope,
      ),
    },
  });
}
