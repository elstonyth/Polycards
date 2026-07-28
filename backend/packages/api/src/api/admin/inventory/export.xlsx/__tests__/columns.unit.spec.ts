import { unzipSync, strFromU8 } from 'fflate';
import { INVENTORY_COLUMNS } from '../route';
import type { InventoryRow } from '../../../../../modules/packs/inventory-view';

// What this spec exists for: `cost`/`on_hand`/`fmv`/`price` are THREE-STATE on
// an InventoryRow -- null and 0 are different facts, not two spellings of
// "nothing" (inventory-view.ts builds all four with `??` and never `||`, and
// the list page renders null as an em dash and 0 as a real value). An export
// that flattened null to 0 would tell the operator a card cost RM 0.00 when the
// truth is that no purchase was ever recorded against it, and NO other gate in
// this repo can see that: tsc is happy either way, and the integration spec
// asserts headers and byte-length, not cell contents.
//
// So this drives the SHIPPED column array through the SHIPPED writer and reads
// the generated sheet XML back. fflate is write-excel-file's own zip codec (its
// single dependency), which is why it is available here without adding one; if
// a future upgrade drops it, this import failing is the correct signal to
// re-check the null handling rather than a reason to stub the reader out.

const row = (over: Partial<InventoryRow>): InventoryRow => ({
  handle: 'h',
  product_id: 'prod_1',
  photo: null,
  name: 'N',
  sku: 'S',
  is_card: true,
  graded: false,
  fmv: 1,
  price: 1,
  cost: 1,
  created_at: '2026-07-28T00:00:00.000Z',
  on_hand: 1,
  in_vault: 0,
  requested: 0,
  shipped: 0,
  listing_count: 0,
  ...over,
});

const NULLABLE = ['FMV', 'Price', 'Cost', 'On Hand'] as const;

const colIndex = (header: string): number => {
  const i = INVENTORY_COLUMNS.findIndex((c) => c.header === header);
  if (i < 0) throw new Error(`no column named ${header}`);
  return i;
};

// 0 -> 'A', 25 -> 'Z', 26 -> 'AA'. The sheet is 14 columns wide today, but the
// second letter costs nothing and stops this from silently mis-addressing if a
// column is ever appended.
const colLetter = (i: number): string =>
  i < 26
    ? String.fromCharCode(65 + i)
    : String.fromCharCode(64 + Math.floor(i / 26)) +
      String.fromCharCode(65 + (i % 26));

const sheetXml = async (rows: InventoryRow[]): Promise<string> => {
  const { default: writeXlsxFile } = await import('write-excel-file/node');
  const buf = await writeXlsxFile(rows, {
    columns: INVENTORY_COLUMNS,
    sheet: 'Inventory',
  }).toBuffer();
  const files = unzipSync(new Uint8Array(buf));
  return strFromU8(files['xl/worksheets/sheet1.xml']);
};

describe('inventory export columns', () => {
  it('writes an EMPTY cell for a null money/count, and a real 0 for zero', async () => {
    // Row 2 is all-null, row 3 is all-zero (row 1 is the header).
    const xml = await sheetXml([
      row({ fmv: null, price: null, cost: null, on_hand: null }),
      row({ fmv: 0, price: 0, cost: 0, on_hand: 0 }),
    ]);

    for (const header of NULLABLE) {
      const letter = colLetter(colIndex(header));
      // A null cell must be ABSENT from the XML entirely -- that is what Excel
      // renders as blank. Matching on `<c r="X2"` (no closing bracket) so a
      // styled cell would still be caught.
      expect(xml).not.toContain(`<c r="${letter}2"`);
      // ...while the zero row carries an explicit numeric 0. Both halves are
      // needed: asserting only the absence would also pass if the writer had
      // dropped every numeric cell.
      expect(xml).toContain(`<c r="${letter}3"><v>0</v></c>`);
    }
  });

  it('mirrors the list page column set, in order', async () => {
    // Pinned as a literal, not derived from INVENTORY_COLUMNS, so a header
    // rename or a dropped column has to be an intentional edit here too. The
    // three documented divergences from the screen (handle added, photo and
    // product_id omitted) are visible in this list by construction.
    expect(INVENTORY_COLUMNS.map((c) => c.header)).toEqual([
      'Handle',
      'Name',
      'Registered Card',
      'SKU',
      'Title',
      'FMV',
      'Price',
      'Cost',
      'Created (UTC)',
      'On Hand',
      'In Vault',
      'Requested',
      'Shipped',
      'Listing Show',
    ]);
  });

  // Straight against the shipped `cell` functions, with no workbook built: the
  // writer path is already pinned by the null/zero case above, and generating a
  // sheet here would only let a non-discriminating assertion (any single-row
  // export contains a row 2) look like coverage.
  it('renders graded/raw and card/not-a-card the way the list page does', () => {
    // `graded` must become the page's GRADED/RAW label, not a bare boolean.
    expect(INVENTORY_COLUMNS[colIndex('Title')].cell(row({ graded: true }), 0)).toBe(
      'GRADED',
    );
    expect(INVENTORY_COLUMNS[colIndex('Title')].cell(row({ graded: false }), 0)).toBe(
      'RAW',
    );
    // is_card goes out as a real boolean so the sheet can be filtered on it.
    expect(
      INVENTORY_COLUMNS[colIndex('Registered Card')].cell(
        row({ is_card: false }),
        0,
      ),
    ).toBe(false);
    // created_at is typed `string | Date`; BOTH must land as an ISO string.
    expect(
      INVENTORY_COLUMNS[colIndex('Created (UTC)')].cell(
        row({ created_at: new Date(0) }),
        0,
      ),
    ).toBe('1970-01-01T00:00:00.000Z');
    expect(
      INVENTORY_COLUMNS[colIndex('Created (UTC)')].cell(
        row({ created_at: '2026-07-28T09:30:00.000Z' }),
        0,
      ),
    ).toBe('2026-07-28T09:30:00.000Z');
  });
});
