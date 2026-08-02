import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { mintSuperAdmin, unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

const PASSWORD = 'tier-settings-test-pw-1';
const ADMIN_EMAIL = 'tier-settings-admin@test.dev';

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('/admin/tier-settings', () => {
      let adminToken: string;
      const packs = () =>
        getContainer().resolve<PacksModuleService>(PACKS_MODULE);
      const adminHeaders = (): Record<string, string> => ({
        authorization: `Bearer ${adminToken}`,
      });

      beforeEach(async () => {
        adminToken = await mintSuperAdmin(
          getContainer(),
          api,
          ADMIN_EMAIL,
          PASSWORD,
        );
      });

      it('401s without an admin token', async () => {
        expect(
          (await unwrapResponse(api.get('/admin/tier-settings'))).status,
        ).toBe(401);
        expect(
          (
            await unwrapResponse(
              api.post('/admin/tier-settings', { ranges: {}, reason: 'x' }),
            )
          ).status,
        ).toBe(401);
      });

      it('GET returns an empty map before first save (feature off)', async () => {
        const res = await unwrapResponse(
          api.get('/admin/tier-settings', { headers: adminHeaders() }),
        );
        expect(res.status).toBe(200);
        expect(res.data).toEqual({ ranges: {} });
      });

      it('POST persists, drops unconfigured tiers on read, and audits', async () => {
        const res = await unwrapResponse(
          api.post(
            '/admin/tier-settings',
            {
              ranges: {
                Common: { min: 100, max: 500 },
                Rare: { min: 2000, max: null },
                Mythical: { min: null, max: null },
              },
              reason: 'initial tier ladder',
            },
            { headers: adminHeaders() },
          ),
        );
        expect(res.status).toBe(200);
        expect(res.data).toEqual({
          ranges: {
            Common: { min: 100, max: 500 },
            Rare: { min: 2000, max: null },
          },
        });

        const read = await unwrapResponse(
          api.get('/admin/tier-settings', { headers: adminHeaders() }),
        );
        expect(read.data).toEqual(res.data);

        const audits = await packs().listAdminActionAudits(
          { entity_type: 'tier_settings' },
          { take: 10 },
        );
        expect(audits).toHaveLength(1);
        expect(audits[0].action).toBe('edit');
        expect(audits[0].reason).toBe('initial tier ladder');
      });

      it('POST replaces the WHOLE map — a cleared tier does not survive a merge', async () => {
        const save = (
          ranges: Record<string, { min: number | null; max: number | null }>,
          reason: string,
        ) =>
          unwrapResponse(
            api.post(
              '/admin/tier-settings',
              { ranges, reason },
              { headers: adminHeaders() },
            ),
          );
        await save(
          {
            Common: { min: 100, max: 500 },
            Uncommon: { min: 500, max: 2000 },
          },
          'seed two tiers',
        );
        const res = await save(
          { Common: { min: 50, max: 400 } },
          'drop Uncommon',
        );
        expect(res.status).toBe(200);
        expect(res.data).toEqual({ ranges: { Common: { min: 50, max: 400 } } });

        const read = await unwrapResponse(
          api.get('/admin/tier-settings', { headers: adminHeaders() }),
        );
        expect(read.data).toEqual({
          ranges: { Common: { min: 50, max: 400 } },
        });
      });

      it('POST rejects bad ranges and a missing reason', async () => {
        const post = (body: unknown) =>
          unwrapResponse(
            api.post('/admin/tier-settings', body, {
              headers: adminHeaders(),
            }),
          );
        expect(
          (
            await post({
              ranges: { Shiny: { min: 0, max: 1 } },
              reason: 'x',
            })
          ).status,
        ).toBe(400);
        expect(
          (
            await post({
              ranges: { Common: { min: 500, max: 100 } },
              reason: 'x',
            })
          ).status,
        ).toBe(400);
        expect(
          (await post({ ranges: { Common: { min: 0, max: 1 } } })).status,
        ).toBe(400);
        // Nothing persisted by the rejected posts.
        const read = await unwrapResponse(
          api.get('/admin/tier-settings', { headers: adminHeaders() }),
        );
        expect(read.data).toEqual({ ranges: {} });
      });
    });

    // Per-pack override: pack.tier_ranges (null = inherit the global
    // singleton above; a stored map replaces it wholesale for that pack).
    describe('/admin/packs/:slug tier_ranges override', () => {
      let adminToken: string;
      const SLUG = 'tier-range-pack';
      const PACK_BODY = {
        title: 'Tier Range Pack',
        category: 'pokemon',
        price: 50,
        image: '/cdn/test-pack.webp',
        buyback_percent: 90,
        boost: false,
        rank: 0,
        status: 'draft',
      };
      const adminHeaders = (): Record<string, string> => ({
        authorization: `Bearer ${adminToken}`,
      });
      const listedPack = async () => {
        const res = await unwrapResponse(
          api.get('/admin/packs', { headers: adminHeaders() }),
        );
        expect(res.status).toBe(200);
        return res.data.packs.find(
          (p: { slug: string }) => p.slug === SLUG,
        ) as { tier_ranges: unknown };
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

      it('defaults to null (inherit), round-trips a map, keeps it when the key is absent, and null clears it', async () => {
        expect((await listedPack()).tier_ranges).toBeNull();

        const override = {
          Common: { min: 10, max: 50 },
          Rare: { min: 200, max: null },
        };
        const saved = await unwrapResponse(
          api.post(
            `/admin/packs/${SLUG}`,
            { ...PACK_BODY, tier_ranges: override },
            { headers: adminHeaders() },
          ),
        );
        expect(saved.status).toBe(200);
        expect((await listedPack()).tier_ranges).toEqual(override);

        // Absent key = keep the stored value (deploy-skew safety, same
        // tri-state as published_odds).
        const untouched = await unwrapResponse(
          api.post(`/admin/packs/${SLUG}`, PACK_BODY, {
            headers: adminHeaders(),
          }),
        );
        expect(untouched.status).toBe(200);
        expect((await listedPack()).tier_ranges).toEqual(override);

        const cleared = await unwrapResponse(
          api.post(
            `/admin/packs/${SLUG}`,
            { ...PACK_BODY, tier_ranges: null },
            { headers: adminHeaders() },
          ),
        );
        expect(cleared.status).toBe(200);
        expect((await listedPack()).tier_ranges).toBeNull();
      });

      // The ORM merges json POJOs on update, so these two transitions are the
      // ones a sparse write silently breaks: a removed tier resurrecting, and
      // an emptied override no-opping. Guards the fillTierRanges null-fill in
      // the update step.
      it('a shrunk override drops the removed tier, and {} empties it (map replaces, never merges)', async () => {
        const save = (
          tier_ranges: Record<
            string,
            { min: number | null; max: number | null }
          >,
        ) =>
          unwrapResponse(
            api.post(
              `/admin/packs/${SLUG}`,
              { ...PACK_BODY, tier_ranges },
              { headers: adminHeaders() },
            ),
          );

        await save({
          Common: { min: 10, max: 50 },
          Uncommon: { min: 50, max: 200 },
        });
        const shrunk = await save({ Common: { min: 5, max: 40 } });
        expect(shrunk.status).toBe(200);
        expect((await listedPack()).tier_ranges).toEqual({
          Common: { min: 5, max: 40 },
        });

        // {} = explicit "pack-specific, nothing configured" — distinct from
        // null (inherit global), and it must actually clear the stored tiers.
        const emptied = await save({});
        expect(emptied.status).toBe(200);
        expect((await listedPack()).tier_ranges).toEqual({});
      });

      it('rejects bad override maps', async () => {
        for (const tier_ranges of [
          { Shiny: { min: 0, max: 1 } },
          { Common: { min: 500, max: 100 } },
          { Common: { min: '5', max: null } },
        ]) {
          const res = await unwrapResponse(
            api.post(
              `/admin/packs/${SLUG}`,
              { ...PACK_BODY, tier_ranges },
              { headers: adminHeaders() },
            ),
          );
          expect(res.status).toBe(400);
        }
        expect((await listedPack()).tier_ranges).toBeNull();
      });
    });
  },
});
