import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { loadPnlReport } from '../report';
import { pnlSheets } from '../sheets';

// GET /admin/profit-report/pnl/export — the P&L report as a .xlsx, one sheet
// per section. Same query and the same cache entry as the page
// (../report.ts), so exporting what is on screen runs no queries. No dot in
// the path: a `[name].xlsx` folder breaks the Mercur codegen (see
// ../../../players/export/route.ts). profit_report:read guards it by prefix.
export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const report = await loadPnlReport(req);
  // ESM-only package from CommonJS: a dynamic import (see sheets.ts).
  const { default: writeXlsxFile } = await import('write-excel-file/node');
  const workbook = await writeXlsxFile(pnlSheets(report)).toBuffer();
  const period = report.window
    ? new Date(report.window.from).toISOString().slice(0, 10)
    : 'all-time';
  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  );
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="pnl-${report.range}-${period}.xlsx"`,
  );
  res.send(workbook);
}
