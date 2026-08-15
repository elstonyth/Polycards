import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { Modules } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { mintSuperAdmin, postStoreCustomer, unwrapResponse } from './utils';
import { VIP_LEVELS } from '../../src/scripts/vip-levels.data';

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
    async function seedLadder(packs: PacksModuleService) {
      const existing = await packs.listVipLevels({}, { take: 1 });
      if (existing.length === 0) {
        await packs.createVipLevels(VIP_LEVELS.map((r) => ({
          level: r.level, spend_threshold: r.spend_threshold, voucher_amount: r.voucher_amount,
          box_tier: r.box_tier, frame_unlock: r.frame_unlock, direct_referral_pct: r.direct_referral_pct,
          prizes: r.prizes ?? null,
        })));
      }
    }

    describe('GET /admin/customers/:id/referral-tree', () => {
      it('200 with root + descendant nodes carrying handle/email keys', async () => {
        const rootId = await registerCustomer('c360-root@test.dev');
        const childId = await registerCustomer('c360-child@test.dev');
        const grandchildId = await registerCustomer('c360-grandchild@test.dev');
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        await seedLadder(packs);
        // Referral writes were retired with linkSponsor; the model is kept, so the
        // edge is seeded directly for setup.
        await packs.createReferralRelationships([
          { customer_id: childId, sponsor_id: rootId },
        ]);
        await packs.createReferralRelationships([
          { customer_id: grandchildId, sponsor_id: childId },
        ]);

        const res = await unwrapResponse(
          api.get(`/admin/customers/${rootId}/referral-tree?maxDepth=2`, { headers: adminHeaders() }));
        expect(res.status).toBe(200);
        expect(res.data.root.customer_id).toBe(rootId);
        expect(res.data.maxDepth).toBe(2);
        const ids = res.data.nodes.map((n: any) => n.customer_id).sort();
        expect(ids).toEqual([childId, grandchildId].sort());
        for (const n of res.data.nodes) {
          expect(n.email).not.toBeNull();   // real customers — enrichment must populate email
        }
      });
    });

    // Task 9 appends `describe('GET /admin/customers/:id/audit', ...)` here.

    describe('GET /admin/customers/:id/audit', () => {
      it('3-way union surfaces freeze + reverse_commission + adjust_credit', async () => {
        const sponsorId = await registerCustomer('c360-aud-sponsor@test.dev');
        const recruitId = await registerCustomer('c360-aud-recruit@test.dev');
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        await seedLadder(packs);                  // REQUIRED before settleOpen
        await packs.createReferralRelationships([
          { customer_id: recruitId, sponsor_id: sponsorId },
        ]);
        await packs.mutateCreditAtomic({ customerId: recruitId, amount: 30, reason: 'topup' });
        await packs.settleOpen({ customerId: recruitId, amount: -20, sourceTransactionId: 'c360_aud_open' });
        const [comm] = await packs.listCommissions({ beneficiary: sponsorId }, { take: 1 });
        await packs.reverseCommission({ commissionId: comm.id, adminId: 'adm_c360', reason: 'test' });    // commission-keyed
        await packs.setManualFreeze({ customerId: sponsorId, adminId: 'adm_c360', reason: 'test freeze' }); // customer-keyed
        await packs.adminAdjustCredit({ customerId: sponsorId, amount: 5, note: 'test', adminId: 'adm_c360' }); // credit-keyed

        const res = await unwrapResponse(api.get(`/admin/customers/${sponsorId}/audit`, { headers: adminHeaders() }));
        expect(res.status).toBe(200);
        const actions = res.data.actions.map((a: any) => a.action);
        expect(actions).toEqual(expect.arrayContaining(['freeze', 'reverse_commission', 'adjust_credit']));
        expect(res.data.account_state.frozen).toBe(true);
      });
    });

    describe('GET /admin/customers/:id/commissions', () => {
      it('shows the direct commission (opener = recruit), then status reversed after reverseOpen', async () => {
        const sponsorId = await registerCustomer('c360-sponsor@test.dev');
        const recruitId = await registerCustomer('c360-recruit@test.dev');
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        await seedLadder(packs);                  // REQUIRED before settleOpen
        await packs.createReferralRelationships([
          { customer_id: recruitId, sponsor_id: sponsorId },
        ]);
        await packs.mutateCreditAtomic({ customerId: recruitId, amount: 30, reason: 'topup' });
        await packs.settleOpen({ customerId: recruitId, amount: -20, sourceTransactionId: 'c360_open_1' });

        const res = await unwrapResponse(api.get(`/admin/customers/${sponsorId}/commissions`, { headers: adminHeaders() }));
        expect(res.status).toBe(200);
        expect(res.data.commissions).toHaveLength(1);
        expect(res.data.commissions[0].opener.customer_id).toBe(recruitId);  // gen-1 opener = recruit
        expect(res.data.commissions[0].status).not.toBe('reversed');

        await packs.reverseOpen('c360_open_1');
        const after = await unwrapResponse(api.get(`/admin/customers/${sponsorId}/commissions`, { headers: adminHeaders() }));
        expect(after.data.commissions).toHaveLength(1);   // amount<0 guard → no 2-row fan-out
        expect(after.data.commissions[0].status).toBe('reversed');
      });
    });
  },
});
