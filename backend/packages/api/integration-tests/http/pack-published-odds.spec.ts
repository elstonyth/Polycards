import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { mintSuperAdmin, unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

const ADMIN_EMAIL = 'published-odds-admin@test.dev';
const PASSWORD = 'published-odds-test-pw-1';
const SLUG = 'published-odds-pack';

const PACK_BODY = {
  title: 'Published Odds Pack',
  category: 'pokemon',
  price: 50,
  image: '/cdn/test-pack.webp',
  buyback_percent: 90,
  boost: false,
  rank: 0,
  status: 'draft',
};

// The ORM merges json POJOs on update, so a published_odds.tiers map written
// SPARSELY over a stored one used to resurrect removed tiers — the same bug
// class as pack.tier_ranges (commit 67d66fef). These pin the replace-not-merge
// contract on every surface that serves the value.
medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('/admin/packs/:slug published_odds', () => {
      let adminToken: string;
      const adminHeaders = (): Record<string, string> => ({
        authorization: `Bearer ${adminToken}`,
      });
      const save = (published_odds: unknown) =>
        unwrapResponse(
          api.post(
            `/admin/packs/${SLUG}`,
            { ...PACK_BODY, published_odds },
            { headers: adminHeaders() },
          ),
        );
      const detailOdds = async () => {
        const res = await unwrapResponse(
          api.get(`/admin/packs/${SLUG}`, { headers: adminHeaders() }),
        );
        expect(res.status).toBe(200);
        return res.data.pack.published_odds;
      };
      const listedOdds = async () => {
        const res = await unwrapResponse(
          api.get('/admin/packs', { headers: adminHeaders() }),
        );
        expect(res.status).toBe(200);
        return res.data.packs.find((p: { slug: string }) => p.slug === SLUG)
          .published_odds;
      };

      beforeEach(async () => {
        adminToken = await mintSuperAdmin(
          getContainer(),
          api,
          ADMIN_EMAIL,
          PASSWORD,
        );
        const created = await unwrapResponse(
          api.post(
            '/admin/packs',
            { ...PACK_BODY, slug: SLUG },
            { headers: adminHeaders() },
          ),
        );
        expect(created.status).toBe(201);
      });

      it('a shrunk tiers map drops the removed tier on every serving route (replace, never merge)', async () => {
        const first = await save({
          overall: 95,
          tiers: { Common: 43, Rare: 22 },
        });
        expect(first.status).toBe(200);
        expect(await detailOdds()).toEqual({
          overall: 95,
          tiers: { Common: 43, Rare: 22 },
        });

        const shrunk = await save({ overall: 95, tiers: { Common: 43 } });
        expect(shrunk.status).toBe(200);

        const expected = { overall: 95, tiers: { Common: 43 } };
        expect(await detailOdds()).toEqual(expected);
        expect(await listedOdds()).toEqual(expected);

        // Store detail route (public payload) must agree. Draft packs are
        // hidden from the store list but the detail route serves by slug.
        const store = await unwrapResponse(api.get(`/store/packs/${SLUG}`));
        if (store.status === 200) {
          expect(store.data.published_odds).toEqual(expected);
        }
      });

      it('null still clears and an emptied tiers map persists', async () => {
        await save({ overall: 90, tiers: { Common: 40, Uncommon: 30 } });
        const emptied = await save({ overall: 90, tiers: {} });
        expect(emptied.status).toBe(200);
        expect(await detailOdds()).toEqual({ overall: 90, tiers: {} });

        const cleared = await save(null);
        expect(cleared.status).toBe(200);
        expect(await detailOdds()).toBeNull();
      });
    });
  },
});
