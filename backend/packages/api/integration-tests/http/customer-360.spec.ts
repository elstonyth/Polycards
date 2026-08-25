import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { Modules } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { mintSuperAdmin, postStoreCustomer, unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);
const PASSWORD = 'customer360-pw-1';

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    let storeHeaders: Record<string, string>;
    let adminToken: string;

    beforeEach(async () => {
      const container = getContainer();
      const apiKey = container.resolve(Modules.API_KEY);
      const key = await apiKey.createApiKeys({ title: 'c360-test', type: 'publishable', created_by: 'c360-test' });
      storeHeaders = { 'x-publishable-api-key': key.token };
      adminToken = await mintSuperAdmin(container, api, 'c360-admin@test.dev', PASSWORD);
    });

    const adminHeaders = () => ({ authorization: `Bearer ${adminToken}` });
    const registerCustomer = async (email: string): Promise<string> => {
      const reg = await api.post('/auth/customer/emailpass/register', { email, password: PASSWORD });
      const created = await postStoreCustomer(api, getContainer(), { email },
        { headers: { ...storeHeaders, authorization: `Bearer ${reg.data.token}` } });
      return created.data.customer.id;
    };
    // Task 9 appends `describe('GET /admin/customers/:id/audit', ...)` here.

    describe('GET /admin/customers/:id/audit', () => {
      it('2-way union surfaces freeze + adjust_credit', async () => {
        const customerId = await registerCustomer('c360-aud-customer@test.dev');
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        await packs.setManualFreeze({ customerId, adminId: 'adm_c360', reason: 'test freeze' }); // customer-keyed
        await packs.adminAdjustCredit({ customerId, amount: 5, note: 'test', adminId: 'adm_c360' }); // credit-keyed

        const res = await unwrapResponse(api.get(`/admin/customers/${customerId}/audit`, { headers: adminHeaders() }));
        expect(res.status).toBe(200);
        const actions = res.data.actions.map((a: any) => a.action);
        expect(actions).toEqual(expect.arrayContaining(['freeze', 'adjust_credit']));
        expect(res.data.account_state.frozen).toBe(true);
      });
    });

  },
});
