import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { Modules } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { mintSuperAdmin, unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

const ADMIN_EMAIL = 'published-odds-admin@test.dev';
const PASSWORD = 'published-odds-test-pw-1'; // gitleaks:allow
const SLUG = 'published-odds-pack';
const CARD_HANDLE = 'published-odds-card';

// `active` so the STORE detail route serves the pack (it 404s drafts) and its
// assertion below is never vacuous. Activation requires a rollable pool, which
// the beforeEach builds (card + membership + a saved odds table).
const PACK_BODY = {
  title: 'Published Odds Pack',
  category: 'pokemon',
  price: 50,
  image: '/cdn/test-pack.webp',
  buyback_percent: 90,
  boost: false,
  rank: 0,
  status: 'active',
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
      let storeHeaders: Record<string, string>;
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
        const container = getContainer();
        adminToken = await mintSuperAdmin(container, api, ADMIN_EMAIL, PASSWORD);
        // Store routes are publishable-key scoped (same fixture as
        // store-packs-price-contract.spec).
        const apiKeyModule = container.resolve(Modules.API_KEY);
        const key = await apiKeyModule.createApiKeys({
          title: 'published-odds-test',
          type: 'publishable',
          created_by: 'published-odds-test',
        });
        storeHeaders = { 'x-publishable-api-key': key.token };
        // A rollable pool so the pack can go active (activation guard) and the
        // store route serves it — mirrors pack-target-rtp.spec's fixture.
        const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
        await packs.createCards([
          {
            handle: CARD_HANDLE,
            name: 'Published Odds Card PSA 10',
            set: 'Test Set',
            grader: 'PSA',
            grade: '10',
            market_value: 100,
            image: '/cdn/test-card.webp',
          },
        ]);
        const created = await unwrapResponse(
          api.post(
            '/admin/packs',
            { ...PACK_BODY, slug: SLUG, status: 'draft' },
            { headers: adminHeaders() },
          ),
        );
        expect(created.status).toBe(201);
        const setMembers = await unwrapResponse(
          api.post(
            `/admin/packs/${SLUG}/members`,
            { card_ids: [CARD_HANDLE] },
            { headers: adminHeaders() },
          ),
        );
        expect(setMembers.status).toBe(200);
        const odds = await unwrapResponse(
          api.post(
            `/admin/packs/${SLUG}/odds`,
            {
              entries: [
                { card_id: CARD_HANDLE, locked: false, pct: 100, rarity: 'Common' },
              ],
            },
            { headers: adminHeaders() },
          ),
        );
        expect(odds.status).toBe(200);
        const activated = await unwrapResponse(
          api.post(`/admin/packs/${SLUG}`, PACK_BODY, {
            headers: adminHeaders(),
          }),
        );
        expect(activated.status).toBe(200);
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

        // Store detail route (public payload) must agree — the fixture keeps
        // the pack ACTIVE precisely so this assertion can never go vacuous
        // (the route 404s drafts).
        const store = await unwrapResponse(
          api.get(`/store/packs/${SLUG}`, { headers: storeHeaders }),
        );
        expect(store.status).toBe(200);
        expect(store.data.published_odds).toEqual(expected);
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
