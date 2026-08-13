import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { mintSuperAdmin, unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

const PASSWORD = 'admin-disable-test-password-1'; // gitleaks:allow
const ADMIN_EMAIL = 'admin-disable@test.dev';

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('player disable / enable (POLYCARD-BACK §4.2)', () => {
      let adminToken: string;

      beforeEach(async () => {
        const container = getContainer();
        adminToken = await mintSuperAdmin(container, api, ADMIN_EMAIL, PASSWORD);
      });

      const adminHeaders = (): Record<string, string> => ({
        authorization: `Bearer ${adminToken}`,
      });

      it('POST /admin/customers/:id/disable → 200 { disabled: true } + audit row', async () => {
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        const cid = 'cust_disable_1';

        const res = await unwrapResponse(
          api.post(
            `/admin/customers/${cid}/disable`,
            { reason: 'test disable' },
            { headers: adminHeaders() },
          ),
        );
        expect(res.status).toBe(200);
        expect(res.data.disabled).toBe(true);

        const [aud] = await packs.listAdminActionAudits(
          { entity_type: 'customer', entity_id: cid },
          { take: 1 },
        );
        expect(aud.action).toBe('disable');
        expect(aud.reason).toBe('test disable');
        expect(aud.after).toEqual({ disabled: true });
      });

      it('POST /admin/customers/:id/enable → 200 { disabled: false } + audit row', async () => {
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        const cid = 'cust_disable_2';

        await unwrapResponse(
          api.post(
            `/admin/customers/${cid}/disable`,
            { reason: 'test disable' },
            { headers: adminHeaders() },
          ),
        );
        const res = await unwrapResponse(
          api.post(
            `/admin/customers/${cid}/enable`,
            { reason: 're-enable' },
            { headers: adminHeaders() },
          ),
        );
        expect(res.status).toBe(200);
        expect(res.data.disabled).toBe(false);

        const [aud] = await packs.listAdminActionAudits(
          { entity_type: 'customer', entity_id: cid, action: 'enable' },
          { take: 1 },
        );
        expect(aud.reason).toBe('re-enable');
        expect(aud.after).toEqual({ disabled: false });
      });

      it('POST /admin/customers/:id/disable → 400 on missing, blank or >500-char reason', async () => {
        const cid = 'cust_disable_3';
        const bodies: Record<string, unknown>[] = [
          {},
          { reason: '   ' },
          { reason: 'x'.repeat(501) },
        ];
        for (const body of bodies) {
          const res = await unwrapResponse(
            api.post(`/admin/customers/${cid}/disable`, body, {
              headers: adminHeaders(),
            }),
          );
          expect(res.status).toBe(400);
          expect(res.data.message).toBe('A reason (1–500 chars) is required.');
        }
      });

      it('GET /admin/customers/:id/audit exposes account_state.disabled (null-clean after enable)', async () => {
        const cid = 'cust_disable_4';

        await unwrapResponse(
          api.post(
            `/admin/customers/${cid}/disable`,
            { reason: 'test disable' },
            { headers: adminHeaders() },
          ),
        );
        // While disabled: the audit route must report disabled:true WITHOUT the
        // account being frozen — the two are orthogonal, and the admin player
        // header badges each off this same payload. Asserting only the
        // post-enable `false` would leave the true case unpinned.
        const whileDisabled = await unwrapResponse(
          api.get(`/admin/customers/${cid}/audit`, { headers: adminHeaders() }),
        );
        expect(whileDisabled.status).toBe(200);
        expect(whileDisabled.data.account_state.disabled).toBe(true);
        expect(whileDisabled.data.account_state.frozen).toBe(false);

        await unwrapResponse(
          api.post(
            `/admin/customers/${cid}/enable`,
            { reason: 're-enable' },
            { headers: adminHeaders() },
          ),
        );

        const res = await unwrapResponse(
          api.get(`/admin/customers/${cid}/audit`, { headers: adminHeaders() }),
        );
        expect(res.status).toBe(200);
        expect(res.data.account_state.disabled).toBe(false);
        expect(res.data.account_state.disabled_at).toBeNull();
        expect(res.data.account_state.disabled_by).toBeNull();
      });

      it('disable twice → still 200 { disabled: true } and appends a second audit row', async () => {
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        const cid = 'cust_disable_5';

        for (const reason of ['first disable', 'second disable']) {
          const res = await unwrapResponse(
            api.post(
              `/admin/customers/${cid}/disable`,
              { reason },
              { headers: adminHeaders() },
            ),
          );
          expect(res.status).toBe(200);
          expect(res.data.disabled).toBe(true);
        }

        const audits = await packs.listAdminActionAudits({
          entity_type: 'customer',
          entity_id: cid,
          action: 'disable',
        });
        expect(audits).toHaveLength(2);
        // Append-only log: one row captured the pre-disable state, the other saw
        // the account already disabled. Compared as a set — two rows written in
        // the same tick can share a created_at, so row order isn't stable.
        expect(
          audits
            .map((a) => (a.before as { disabled: boolean }).disabled)
            .sort(),
        ).toEqual([false, true]);
      });

      it('disabled and frozen are orthogonal — neither write clears the other', async () => {
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        const cid = 'cust_disable_6';
        const state = async () =>
          (await packs.listCustomerAccountStates({ customer_id: cid }, { take: 1 }))[0];

        // Freeze (funds lock) first, then disable (login block) on top of it.
        await packs.setManualFreeze({
          customerId: cid,
          adminId: 'admin_setup',
          reason: 'funds hold',
        });
        await unwrapResponse(
          api.post(
            `/admin/customers/${cid}/disable`,
            { reason: 'login block' },
            { headers: adminHeaders() },
          ),
        );
        const afterDisable = await state();
        expect(afterDisable.frozen).toBe(true);
        expect(afterDisable.frozen_reason).toBe('funds hold');
        expect(afterDisable.disabled).toBe(true);

        // …and the other direction: a later freeze write must not clear the
        // login block, nor an enable the funds lock.
        await packs.setManualFreeze({
          customerId: cid,
          adminId: 'admin_setup',
          reason: 'second hold',
        });
        const afterRefreeze = await state();
        expect(afterRefreeze.disabled).toBe(true);
        expect(afterRefreeze.disabled_reason).toBe('login block');

        await unwrapResponse(
          api.post(
            `/admin/customers/${cid}/enable`,
            { reason: 'lift login block' },
            { headers: adminHeaders() },
          ),
        );
        const afterEnable = await state();
        expect(afterEnable.disabled).toBe(false);
        expect(afterEnable.frozen).toBe(true);
        expect(afterEnable.frozen_reason).toBe('second hold');
      });
    });
  },
});
