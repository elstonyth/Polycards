import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { loadPnlReport } from './report';

// GET /admin/profit-report/pnl — the P&L report (see ./report.ts). Under the
// profit-report prefix so profit_report:read guards it. Read-only.
export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  res.json(await loadPnlReport(req));
}
