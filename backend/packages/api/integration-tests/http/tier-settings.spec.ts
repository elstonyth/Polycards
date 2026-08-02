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
  },
});
