import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
// write-excel-file 4 is ESM-ONLY as far as TypeScript is concerned: both its
// root and its node/ package.json declare `"type": "module"` and it ships no
// .d.cts, so under this package's Node16 moduleResolution a plain value
// import of it from CommonJS is TS1479 ('cannot be imported with require')
// and a plain type import is TS1541. Hence the two-part ceremony, which is
// the compiler's own prescribed remedy, not a workaround:
//   * the TYPE comes in with an explicit `resolution-mode: 'import'`, which
//     is erased entirely at build time (verified in swc's emitted output);
//   * the VALUE comes in via `await import()` inside GET. swc lowers that to
//     `Promise.resolve().then(() => require("write-excel-file/node"))`, which
//     hits the package's own `require` condition (node/index.cjs) -- so the
//     runtime never actually loads ESM. Node caches the module after the
//     first request, so this is not a per-request load.
// The library was chosen over exceljs for its dependency surface: one
// transitive (fflate) against exceljs's nine, and no unused read path.
import type { Column } from 'write-excel-file/node' with { 'resolution-mode': 'import' };
import {
  loadInventoryRows,
  type InventoryRow,
} from '../../../../modules/packs/inventory-view';

// The sheet, one entry per column. Exported ONLY so columns.unit.spec can drive
// the real thing: `cell` returning `null` vs `0` is the whole contract here (see
// the note on the money columns), and a spec that rebuilt its own column list
// would prove nothing about what this route ships.
//
// This mirrors routes/inventory/list/page.tsx's Table.HeaderCell set, in the
// same left-to-right order, with THREE deliberate differences -- stated rather
// than papered over, because the "matches the screen" claim below is only worth
// making if its exceptions are named:
//   * `handle` is ADDED as the leading column. The page uses it as the row key
//     and the detail link (/inventory/list/:handle) but never prints it; in a
//     spreadsheet it is the only stable join key back to the system.
//   * `photo` is OMITTED. The page renders it as a 40px <img>; a URL in a cell
//     is a different artifact, not the same one.
//   * `product_id` is OMITTED. It is not on screen at all -- `handle` is the
//     identifier the operator works in.
// `is_card` IS here (as "Registered Card"): the page shows it inline next to
// the name as "(not a card)", so an export without it would show an unpromoted
// catalog product as though it were a registered gacha card.
export const INVENTORY_COLUMNS: Column<InventoryRow>[] = [
  { header: 'Handle', width: 28, cell: (r) => r.handle },
  { header: 'Name', width: 30, cell: (r) => r.name },
  { header: 'Registered Card', width: 16, cell: (r) => r.is_card },
  { header: 'SKU', width: 20, cell: (r) => r.sku },
  { header: 'Title', width: 10, cell: (r) => (r.graded ? 'GRADED' : 'RAW') },
  // Money and counts go out RAW and NULLABLE, never `?? 0`. null and 0 are
  // different facts on every one of these -- cost null = no purchase history vs
  // cost 0 = bought and free; on_hand null = the product tracks no inventory at
  // all vs on_hand 0 = tracked with nothing shippable; fmv/price null = no FMV
  // recorded vs 0 = free (0 is the buyback lever). inventory-view.ts builds all
  // four with `??` and the list page renders null as an em dash, so collapsing
  // them here would make the export assert something the system does not know.
  // write-excel-file emits NO <c> element at all for a null cell (asserted
  // against the generated sheet XML in columns.unit.spec) -- that is the blank
  // cell this distinction needs, an empty cell rather than a zero.
  { header: 'FMV', width: 12, cell: (r) => r.fmv },
  { header: 'Price', width: 12, cell: (r) => r.price },
  { header: 'Cost', width: 12, cell: (r) => r.cost },
  // ISO 8601 (UTC), NOT the page's rendering. orderDateTime() formats in the
  // BROWSER's local zone via Date#getHours, which a server-side export cannot
  // reproduce and must not pretend to; ISO is unambiguous and sorts correctly
  // as text. `created_at` is typed `string | Date` (inventory-view.ts) because
  // the product module hands back a Date -- the constructor takes the union.
  {
    header: 'Created (UTC)',
    width: 26,
    cell: (r) => new Date(r.created_at).toISOString(),
  },
  { header: 'On Hand', width: 10, cell: (r) => r.on_hand },
  { header: 'In Vault', width: 10, cell: (r) => r.in_vault },
  { header: 'Requested', width: 10, cell: (r) => r.requested },
  { header: 'Shipped', width: 10, cell: (r) => r.shipped },
  { header: 'Listing Show', width: 12, cell: (r) => r.listing_count },
];

// GET /admin/inventory/export.xlsx -- the Inventory list as a real .xlsx
// download, with the CURRENT FILTER APPLIED (POLYCARD-BACK section 3.3 baked
// default: .xlsx, not .csv). Admin-only by inheritance: no middlewares.ts
// matcher claims this path, so it takes Medusa's default /admin/* auth.
//
// Reuses loadInventoryRows -- the same loader GET /admin/inventory uses -- so
// the sheet's ROWS are exactly the rows on screen. The ?q= parse below is
// byte-identical to that route's (trim, cap at 100, undefined when blank); that
// identity is what makes "same filter as the visible list" true rather than
// approximately true. See INVENTORY_COLUMNS for how the COLUMN set differs.
//
// UNPAGED for the same reason the list route is: every derived column is
// computed after the product read, so there is nothing to page on.
//
// This path is a sibling of the [handle] detail route, and `:handle` would
// happily match the literal string "export.xlsx". Static-before-params ordering
// is ASSERTED, not assumed: inventory-export.spec drives both legs through a
// booted app, the detail leg as the negative control.
export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const rawQ = req.query.q;
  const q =
    typeof rawQ === 'string' && rawQ.trim() !== ''
      ? rawQ.trim().slice(0, 100)
      : undefined;
  const rows = await loadInventoryRows(req.scope, { q });

  // See the import note at the top of this file for why this is dynamic.
  const { default: writeXlsxFile } = await import('write-excel-file/node');
  const workbook = await writeXlsxFile(rows, {
    columns: INVENTORY_COLUMNS,
    sheet: 'Inventory',
  }).toBuffer();

  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  );
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="inventory-${new Date().toISOString().slice(0, 10)}.xlsx"`,
  );
  res.send(workbook);
}
