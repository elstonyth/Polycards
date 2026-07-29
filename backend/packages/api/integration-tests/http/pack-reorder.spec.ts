import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { mintSuperAdmin, unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

// Batch reorder: the packs list persists a swap as rank writes for every row
// whose position changed. The old path (N parallel full-payload pack updates)
// half-applied the swap whenever one row tripped the activation guard — an
// ACTIVE pack with an empty pool 400'd its own rank write while the neighbour's
// succeeded, corrupting the list order. Rank is display-only (never affects
// rollability), so /admin/packs/reorder applies all ranks in one request with
// no activation guard.

const ADMIN_EMAIL = 'pack-reorder-admin@polycards.test';
const PASSWORD = 'supersecret-test-pw';

const PACK_BODY = {
  title: 'Reorder Test Pack',
  category: 'pokemon',
  price: 10,
  image: '/cdn/test-pack.webp',
  buyback_percent: 90,
  boost: false,
  status: 'draft',
};

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('POST /admin/packs/reorder', () => {
      let adminHeaders: Record<string, string>;
      let packs: PacksModuleService;

      beforeEach(async () => {
        const container = getContainer();
        const token = await mintSuperAdmin(
          container,
          api,
          ADMIN_EMAIL,
          PASSWORD,
        );
        adminHeaders = { Authorization: `Bearer ${token}` };
        packs = container.resolve<PacksModuleService>(PACKS_MODULE);

        for (const [slug, rank] of [
          ['reorder-a', 0],
          ['reorder-b', 1],
        ] as const) {
          const created = await unwrapResponse(
            api.post(
              '/admin/packs',
              { ...PACK_BODY, slug, rank },
              { headers: adminHeaders },
            ),
          );
          expect(created.status).toBe(201);
        }
      });

      const ranksOf = async (): Promise<Record<string, number>> => {
        const rows = await packs.listPacks(
          { slug: ['reorder-a', 'reorder-b'] },
          { take: 10 },
        );
        return Object.fromEntries(rows.map((p) => [p.slug, p.rank]));
      };

      it('swaps ranks even when one pack is ACTIVE with an empty pool', async () => {
        // Force the broken-but-real prod state the activation guard exists to
        // prevent: active pack, no odds rows. Written via the module service
        // because every API path correctly refuses to produce it.
        const [a] = await packs.listPacks({ slug: 'reorder-a' }, { take: 1 });
        await packs.updatePacks([{ id: a.id, status: 'active' }]);

        const res = await unwrapResponse(
          api.post(
            '/admin/packs/reorder',
            {
              order: [
                { slug: 'reorder-a', rank: 1 },
                { slug: 'reorder-b', rank: 0 },
              ],
            },
            { headers: adminHeaders },
          ),
        );
        expect(res.status).toBe(200);
        expect(res.data.updated).toBe(2);
        expect(await ranksOf()).toEqual({ 'reorder-a': 1, 'reorder-b': 0 });

        // The activation guard itself is untouched: a FULL update keeping the
        // empty-pool pack active still 400s.
        const fullEdit = await unwrapResponse(
          api.post(
            '/admin/packs/reorder-a',
            { ...PACK_BODY, status: 'active', rank: 1 },
            { headers: adminHeaders },
          ),
        );
        expect(fullEdit.status).toBe(400);
        expect(fullEdit.data.message).toMatch(/prize pool/i);
      });

      it('rejects an unknown slug without applying any rank', async () => {
        const res = await unwrapResponse(
          api.post(
            '/admin/packs/reorder',
            {
              order: [
                { slug: 'reorder-a', rank: 1 },
                { slug: 'no-such-pack', rank: 0 },
              ],
            },
            { headers: adminHeaders },
          ),
        );
        expect(res.status).toBe(400);
        expect(res.data.message).toMatch(/no-such-pack/);
        expect(await ranksOf()).toEqual({ 'reorder-a': 0, 'reorder-b': 1 });
      });

      it('rejects malformed bodies', async () => {
        for (const body of [
          {},
          { order: [] },
          { order: [{ slug: 'reorder-a' }] },
          { order: [{ slug: 'reorder-a', rank: -1 }] },
          { order: [{ slug: 'Not A Slug', rank: 0 }] },
          {
            order: [
              { slug: 'reorder-a', rank: 0 },
              { slug: 'reorder-a', rank: 1 },
            ],
          },
        ]) {
          const res = await unwrapResponse(
            api.post('/admin/packs/reorder', body, { headers: adminHeaders }),
          );
          expect(res.status).toBe(400);
        }
      });
    });
  },
});
