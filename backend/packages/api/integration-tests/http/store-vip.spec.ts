// integration-tests/http/store-vip.spec.ts
// TDD: RED first — GET /store/vip does not yet exist, expect 404/401.
// Tests:
//   (auth)     no bearer → 401
//   (positive) authed GET /store/vip → 200, level + spend; if next present,
//              next.level === level+1, next.remaining ≈ next.threshold - spend,
//              next.reward has box_tier
import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { Modules } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { VIP_LEVELS } from '../../src/scripts/vip-levels.data';
import { postStoreCustomer, unwrapResponse } from './utils';

jest.setTimeout(120 * 1000);

const PASSWORD = 'store-vip-test-pw-1';

async function seedLadder(packs: PacksModuleService) {
  const existing = await packs.listVipLevels({}, { take: 1 });
  if (existing.length === 0) {
    await packs.createVipLevels(
      VIP_LEVELS.map((r) => ({
        level: r.level,
        spend_threshold: r.spend_threshold,
        voucher_amount: r.voucher_amount,
        frame_unlock: r.frame_unlock,
        prizes: r.prizes ?? null,
      })),
    );
  }
}

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('GET /store/vip', () => {
      let storeHeaders: Record<string, string>;
      let customerToken: string;

      beforeEach(async () => {
        const container = getContainer();

        // Publishable API key required for /store/* endpoints.
        const apiKeyModule = container.resolve(Modules.API_KEY);
        const key = await apiKeyModule.createApiKeys({
          title: 'store-vip-test',
          type: 'publishable',
          created_by: 'store-vip-test',
        });
        storeHeaders = { 'x-publishable-api-key': key.token };

        // Register + login a customer.
        const reg = await api.post('/auth/customer/emailpass/register', {
          email: 'store-vip-a@test.dev',
          password: PASSWORD,
        });
        await postStoreCustomer(
          api,
          getContainer(),
          { email: 'store-vip-a@test.dev' },
          {
            headers: {
              ...storeHeaders,
              authorization: `Bearer ${reg.data.token}`,
            },
          },
        );
        const login = await api.post('/auth/customer/emailpass', {
          email: 'store-vip-a@test.dev',
          password: PASSWORD,
        });
        customerToken = login.data.token;
      });

      const authed = (token: string): Record<string, string> => ({
        ...storeHeaders,
        authorization: `Bearer ${token}`,
      });

      it('(auth) returns 401 when no bearer token is provided', async () => {
        const res = await unwrapResponse(
          api.get('/store/vip', { headers: storeHeaders }),
        );
        expect(res.status).toBe(401);
      });

      it('GET /store/vip returns level, spend and the next-rung reward; 401 unauth', async () => {
        const res = await unwrapResponse(
          api.get('/store/vip', { headers: authed(customerToken) }),
        );
        expect(res.status).toBe(200);
        expect(res.data).toMatchObject({
          level: expect.any(Number),
          spend: expect.any(Number),
        });
        if (res.data.next) {
          expect(res.data.next.level).toBe(res.data.level + 1);
          expect(res.data.next.remaining).toBeCloseTo(
            res.data.next.threshold - res.data.spend,
            2,
          );
          expect(res.data.next.reward).toHaveProperty('box_tier');
        }
      });

      it('returns the full 100-level ladder with reward columns', async () => {
        await seedLadder(
          getContainer().resolve<PacksModuleService>(PACKS_MODULE),
        );
        const res = await unwrapResponse(
          api.get('/store/vip', { headers: authed(customerToken) }),
        );
        expect(res.status).toBe(200);
        expect(Array.isArray(res.data.levels)).toBe(true);
        expect(res.data.levels).toHaveLength(100);
        const l2 = res.data.levels.find((l: any) => l.level === 2);
        expect(l2).toMatchObject({
          level: 2,
          reward: {
            voucher_amount: expect.any(Number),
            box_tier: expect.any(String),
            frame_unlock: expect.any(Boolean),
          },
        });
        // strictly increasing thresholds
        const thresholds = res.data.levels.map((l: any) => l.threshold);
        expect([...thresholds].sort((a, b) => a - b)).toEqual(thresholds);
      });
    });
  },
});
