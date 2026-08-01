import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { Modules, ProductStatus } from '@medusajs/framework/utils';
import { unzipSync, strFromU8 } from 'fflate';
import { mintSuperAdmin, unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

const PASSWORD = 'inventory-export-test-pw-1'; // gitleaks:allow
const ADMIN_EMAIL = 'inventory-export-admin@test.dev';

const XLSX_MIME =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// Two fixtures whose titles share no substring, so `?q=` can only match one.
const MATCH = 'inv-export-zzyzx';
const EXCLUDED = 'inv-export-qqq';

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('GET /admin/inventory/export.xlsx', () => {
      let adminToken: string;

      beforeEach(async () => {
        adminToken = await mintSuperAdmin(
          getContainer(),
          api,
          ADMIN_EMAIL,
          PASSWORD,
        );
        // No FX pin: this suite asserts on WHICH ROWS and which columns are in
        // the sheet, never on a money VALUE, so the display resolver's
        // DEFAULT_USD_MYR fallback on a fresh DB is harmless here. (The list
        // suite pins a rate because it does assert money.)
        const productModule = getContainer().resolve(Modules.PRODUCT);
        await productModule.createProducts([
          {
            title: 'Zzyzx Export Fixture',
            handle: MATCH,
            status: ProductStatus.PUBLISHED,
            metadata: { fmv: 77, grader: 'PSA' },
          },
          {
            title: 'Qqq Export Fixture',
            handle: EXCLUDED,
            status: ProductStatus.DRAFT,
            metadata: {},
          },
        ]);
      });

      // `responseType: 'arraybuffer'` is LOAD-BEARING, not tidiness: without it
      // axios decodes the zip as utf-8 text, and both the PK-magic check and
      // the byte length below would then be measuring a mangled string that
      // happens to still start with "PK".
      const getXlsx = async (qs = '') =>
        unwrapResponse(
          api.get(`/admin/inventory/export.xlsx${qs}`, {
            headers: { authorization: `Bearer ${adminToken}` },
            responseType: 'arraybuffer',
          }),
        );

      // The workbook's strings (handles, names, headers) all live in
      // sharedStrings.xml, so that one entry answers "is this row in the
      // sheet?" exactly -- no cell addressing needed.
      const sharedStrings = (body: Buffer): string => {
        const files = unzipSync(new Uint8Array(body));
        return strFromU8(files['xl/sharedStrings.xml']);
      };

      it('serves a real .xlsx as an attachment', async () => {
        const res = await getXlsx();
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toBe(XLSX_MIME);
        // Regex, not today's date: an equality check against a computed
        // YYYY-MM-DD breaks whenever the run straddles UTC midnight.
        expect(res.headers['content-disposition']).toMatch(
          /^attachment; filename="inventory-\d{4}-\d{2}-\d{2}\.xlsx"$/,
        );

        const body = Buffer.from(res.data);
        // A zip container, not an error page or a JSON envelope. The length
        // floor is what stops a 22-byte EMPTY zip (a valid PK file) passing.
        expect(body.subarray(0, 2).toString('latin1')).toBe('PK');
        expect(body.length).toBeGreaterThan(1000);

        const strings = sharedStrings(body);
        // The header row proves the column set survived the round trip.
        expect(strings).toContain('<t>Handle</t>');
        expect(strings).toContain('<t>Listing Show</t>');
      });

      it('applies ?q= -- the filtered sheet drops the non-matching row', async () => {
        // Unfiltered FIRST: proves both fixtures reach the sheet at all, so
        // the absence below is the filter working and not a product that was
        // never created.
        const all = sharedStrings(Buffer.from((await getXlsx()).data));
        expect(all).toContain(`<t>${MATCH}</t>`);
        expect(all).toContain(`<t>${EXCLUDED}</t>`);

        const filtered = sharedStrings(
          Buffer.from((await getXlsx('?q=Zzyzx')).data),
        );
        // Both halves are required. Asserting only the absence would also pass
        // if the export had come back empty, or if `q` had been read as a
        // filter that matches nothing.
        expect(filtered).toContain(`<t>${MATCH}</t>`);
        expect(filtered).not.toContain(`<t>${EXCLUDED}</t>`);
      });

      // Error rather than truncate (route.ts's documented posture): a sheet
      // silently cut off at N rows would read as "this is the whole
      // inventory" when it isn't. Cap of 1 is guaranteed under the seeded row
      // count -- both beforeEach fixtures reach the sheet with no ?q= per the
      // unfiltered assertion above -- without hardcoding the catalog's total
      // size. Plain (non-arraybuffer) request: this asserts the JSON error
      // body, not the workbook.
      it('caps the export at INVENTORY_EXPORT_MAX_ROWS -- 400s rather than truncating', async () => {
        const prevCap = process.env.INVENTORY_EXPORT_MAX_ROWS;
        process.env.INVENTORY_EXPORT_MAX_ROWS = '1';
        try {
          const res = await unwrapResponse(
            api.get('/admin/inventory/export.xlsx', {
              headers: { authorization: `Bearer ${adminToken}` },
            }),
          );
          expect(res.status).toBe(400);
          // Specific to the CAP, not just any 400 -- same reasoning as
          // delivery-orders.spec's `pull_ids` cap case.
          expect(res.data.message).toMatch(/1-row cap/);
          expect(res.data.message).toMatch(/\bq=/);
        } finally {
          if (prevCap === undefined) {
            delete process.env.INVENTORY_EXPORT_MAX_ROWS;
          } else {
            process.env.INVENTORY_EXPORT_MAX_ROWS = prevCap;
          }
        }

        // Restore actually took effect -- the SAME request that 400'd above
        // now serves the workbook once the env override is undone.
        const restored = await getXlsx();
        expect(restored.status).toBe(200);
        expect(restored.headers['content-type']).toBe(XLSX_MIME);
      });

      // The negative control for the whole route. `export.xlsx` is a STATIC
      // sibling of admin/inventory/[handle]/route.ts, and `:handle` matches the
      // literal string "export.xlsx" perfectly well -- so the two routes are
      // ordered, not merely distinct. Reading Medusa's RoutesSorter is not
      // proof: inspection is what missed the core-page collision this epic
      // already had to undo twice.
      it('does not shadow the [handle] detail route', async () => {
        const res = await unwrapResponse(
          api.get(`/admin/inventory/${MATCH}`, {
            headers: { authorization: `Bearer ${adminToken}` },
          }),
        );
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toMatch(/application\/json/);
        expect(res.data.item.handle).toBe(MATCH);
        expect(res.data.associated).toBeDefined();
        expect(res.data.movements).toBeDefined();
      });

      // The export carries every product's cost basis and stock position, so
      // "admin-only by inheritance" is asserted rather than assumed.
      it('requires an admin session', async () => {
        const res = await unwrapResponse(
          api.get('/admin/inventory/export.xlsx'),
        );
        expect(res.status).toBe(401);
      });
    });
  },
});
