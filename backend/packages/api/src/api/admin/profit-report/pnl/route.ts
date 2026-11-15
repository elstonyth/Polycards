import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { loadPnlReport } from './report';
import type { PnlReport } from './types';

// GET /admin/profit-report/pnl — the P&L report (see ./report.ts). Under the
// profit-report prefix so profit_report:read guards it. Read-only.
export async function GET(
  req: MedusaRequest,
  res: MedusaResponse<PnlReport>,
): Promise<void> {
  res.json(await loadPnlReport(req));
}
