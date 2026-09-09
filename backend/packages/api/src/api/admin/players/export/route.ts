import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
// Same two-part ceremony as inventory/export.xlsx/route.ts, for the same
// reason (write-excel-file 4 is ESM-only under this package's Node16
// resolution): the TYPE with an explicit resolution-mode, the VALUE via
// `await import()` inside GET. See that file's import note for the full
// swc-vs-tsc story.
import type { Column } from 'write-excel-file/node' with {
  'resolution-mode': 'import',
};
import {
  listPartnerAccounts,
  type PartnerAccountRow,
} from '../../../../utils/partner-accounts';

// One column per credential field the operator hands out, plus the group and
// an ISO timestamp (UTC — a server export cannot know the browser's zone).
export const PARTNER_ACCOUNT_COLUMNS: Column<PartnerAccountRow>[] = [
  { header: 'Display name', width: 24, cell: (r) => r.name },
  { header: 'Email', width: 34, cell: (r) => r.email },
  { header: 'Password', width: 22, cell: (r) => r.password },
  { header: 'Group', width: 26, cell: (r) => r.group },
  { header: 'Created (UTC)', width: 26, cell: (r) => r.created_at },
];

// GET /admin/players/export[?ids=a,b] — every generated partner account (or
// one batch) as a .xlsx download: the logins the operator hands out. No dot
// in the path on purpose: a `[name].xlsx` route folder makes the Mercur
// codegen emit an unquoted key in .mercur/index.d.ts (the inventory export
// already pays that tax). Rate-limited in middlewares.ts — it returns
// passwords, so it gets the limiter the way the payout-details GET does.
export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const rawIds = req.query.ids;
  if (rawIds !== undefined && typeof rawIds !== 'string') {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'ids must be a comma-separated string.',
    );
  }
  const ids =
    typeof rawIds === 'string'
      ? rawIds
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
          .slice(0, 500)
      : undefined;
  if (ids && ids.length === 0) {
    throw new MedusaError(MedusaError.Types.INVALID_DATA, 'ids is empty.');
  }

  const rows = await listPartnerAccounts(req.scope, ids);

  const { default: writeXlsxFile } = await import('write-excel-file/node');
  const workbook = await writeXlsxFile(rows, {
    columns: PARTNER_ACCOUNT_COLUMNS,
    sheet: 'Partner accounts',
  }).toBuffer();

  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  );
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="partner-accounts-${new Date().toISOString().slice(0, 10)}.xlsx"`,
  );
  res.send(workbook);
}
