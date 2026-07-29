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

// The generated .xlsx unzipped into its OOXML parts, keyed by part name.
const pkg = async (
  rows: InventoryRow[],
): Promise<Record<string, Uint8Array>> => {
  const { default: writeXlsxFile } = await import('write-excel-file/node');
  const buf = await writeXlsxFile(rows, {
    columns: INVENTORY_COLUMNS,
    sheet: 'Inventory',
  }).toBuffer();
  return unzipSync(new Uint8Array(buf));
};

const sheetXml = async (rows: InventoryRow[]): Promise<string> =>
  strFromU8((await pkg(rows))['xl/worksheets/sheet1.xml']);

const must = <T>(v: T | undefined, what: string): T => {
  if (v === undefined) throw new Error(`missing ${what}`);
  return v;
};

// The <Relationship> entries of a .rels part. Split on the trailing space so
// the `<Relationships>` container element is not mistaken for one, and read the
// attributes off each chunk so their order does not matter. Not a real XML
// parser on purpose: pulling in a parser to check the package shape would just
// move the trust into another library.
const rels = (
  xml: string,
): { Id?: string; Type?: string; Target?: string }[] =>
  xml
    .split('<Relationship ')
    .slice(1)
    .map((el) => ({
      Id: /Id="([^"]*)"/.exec(el)?.[1],
      Type: /Type="([^"]*)"/.exec(el)?.[1],
      Target: /Target="([^"]*)"/.exec(el)?.[1],
    }));

// A relationship Target is resolved against the DIRECTORY of the part that owns
// the .rels file, unless it is package-absolute. Resolving is half of the claim
// below, not a detail -- an unresolvable Target is exactly what a repair prompt
// is made of.
const resolvePart = (baseDir: string, target: string): string =>
  target.startsWith('/') ? target.slice(1) : `${baseDir}${target}`;

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

  // NAMING THE CLAIM, because two earlier reports overstated it: this asserts
  // the writer emits a STRUCTURALLY VALID OOXML PACKAGE -- the content-type
  // manifest, the package relationships, the workbook part and the worksheet
  // part are all present, and the workbook's own sheet relationship resolves to
  // a worksheet part that is really in the archive. That is strictly more than
  // the sibling cases prove, which is only that the bytes unzip and one known
  // part name happens to hold the expected cells.
  //
  // It is NOT proof that Excel opens the file without a repair prompt. No
  // assertion in this file can be -- Excel validates far more than the part
  // graph. Opening a real export in Excel remains an OPEN operator acceptance
  // step and must not be reported as closed on the strength of this spec.
  it('emits a structurally valid OOXML package', async () => {
    const parts = await pkg([row({})]);

    // 1. The package manifest and the package-level relationships part.
    expect(parts['[Content_Types].xml']).toBeDefined();
    const rootRels = must(parts['_rels/.rels'], '_rels/.rels');

    // 2. The package relationship of type officeDocument names the workbook,
    //    and that part is in the archive.
    const wbTarget = must(
      rels(strFromU8(rootRels)).find((r) => r.Type?.endsWith('/officeDocument'))
        ?.Target,
      'officeDocument relationship in _rels/.rels',
    );
    const wbPart = resolvePart('', wbTarget);
    const workbook = strFromU8(must(parts[wbPart], wbPart));

    // 3. THE consistency check. The workbook declares its sheet by relationship
    //    id only; the id has to resolve, through the workbook's own .rels, to a
    //    worksheet part that exists. A workbook pointing at a part that is not
    //    in the archive unzips perfectly and is still a broken file.
    const rId = must(
      /<sheet\b[^>]*\br:id="([^"]*)"/.exec(workbook)?.[1],
      'r:id on <sheet> in the workbook part',
    );
    const wbDir = wbPart.slice(0, wbPart.lastIndexOf('/') + 1);
    const wbRelsPart = `${wbDir}_rels/${wbPart.slice(wbDir.length)}.rels`;
    const sheetTarget = must(
      rels(strFromU8(must(parts[wbRelsPart], wbRelsPart))).find(
        (r) => r.Id === rId,
      )?.Target,
      `relationship ${rId} in ${wbRelsPart}`,
    );
    const sheetPart = resolvePart(wbDir, sheetTarget);
    expect(parts[sheetPart]).toBeDefined();

    // 4. ...and it is the same part the cell-level cases above read, so their
    //    hard-coded part name is the resolved one rather than a lucky guess.
    expect(sheetPart).toBe('xl/worksheets/sheet1.xml');

    // 5. Both parts are typed in the manifest. Excel reads content types from
    //    here, not from the extension, so an unlisted part is unreadable even
    //    though the zip entry exists.
    const contentTypes = strFromU8(parts['[Content_Types].xml']);
    expect(contentTypes).toContain(`PartName="/${wbPart}"`);
    expect(contentTypes).toContain(`PartName="/${sheetPart}"`);
  });
});
