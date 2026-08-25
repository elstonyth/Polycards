import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { Modules } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { VIP_LEVELS } from '../../src/scripts/vip-levels.data';
import { postStoreCustomer, unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

const PASSWORD = 'grant-origin-test-password-1';

// GET /store/daily grant views must carry `origin` so the storefront can badge
// one-time level-up vouchers ('ladder') apart from box-won vouchers ('box').
medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('GET /store/daily — grant origin', () => {
      let storeHeaders: Record<string, string>;

      beforeEach(async () => {
        const container = getContainer();
        const apiKeyModule = container.resolve(Modules.API_KEY);
        const key = await apiKeyModule.createApiKeys({
          title: 'grant-origin-test',
          type: 'publishable',
          created_by: 'grant-origin-test',
        });
        storeHeaders = { 'x-publishable-api-key': key.token };

        const svc = container.resolve<PacksModuleService>(PACKS_MODULE);
        if ((await svc.listVipLevels({}, { take: 1 })).length === 0) {
          await svc.createVipLevels(
            VIP_LEVELS.map((r) => ({
              level: r.level,
              spend_threshold: r.spend_threshold,
              voucher_amount: r.voucher_amount,
              frame_unlock: r.frame_unlock,
              prizes: r.prizes ?? null,
            })),
          );
        }
      });

      const authed = (token: string): Record<string, string> => ({
        ...storeHeaders,
        authorization: `Bearer ${token}`,
      });

      const registerCustomer = async (email: string): Promise<string> => {
        const reg = await api.post('/auth/customer/emailpass/register', {
          email,
          password: PASSWORD,
        });
        await postStoreCustomer(
          api,
          getContainer(),
          { email },
          {
            headers: {
              ...storeHeaders,
              authorization: `Bearer ${reg.data.token}`,
            },
          },
        );
        const login = await api.post('/auth/customer/emailpass', {
          email,
          password: PASSWORD,
        });
        return login.data.token as string;
      };

      it('marks ladder and box grants with their origin', async () => {
        const token = await registerCustomer('grant-origin@test.dev');
        const me = await unwrapResponse(
          api.get('/store/customers/me', { headers: authed(token) }),
        );
        const customerId = me.data.customer.id as string;

        const svc =
          getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        await svc.createVipRewardGrants([
          {
            customer_id: customerId,
            level: 2,
            kind: 'voucher',
            payload: { amount_myr: 2 },
            status: 'granted',
            origin: 'ladder',
          },
          {
            customer_id: customerId,
            level: 2,
            kind: 'voucher',
            payload: { amount_myr: 5 },
            status: 'granted',
            origin: 'box',
          },
        ]);

        const state = await unwrapResponse(
          api.get('/store/daily', { headers: authed(token) }),
        );
        const claimable = state.data.vouchers.claimable as {
          origin?: string;
          payload: { amount_myr: number };
        }[];
        expect(claimable).toHaveLength(2);
        const byAmount = new Map(
          claimable.map((g) => [g.payload.amount_myr, g.origin]),
        );
        expect(byAmount.get(2)).toBe('ladder');
        expect(byAmount.get(5)).toBe('box');
      });
    });
  },
});
