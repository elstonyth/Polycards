import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { Modules } from '@medusajs/framework/utils';
import type { ICustomerModuleService } from '@medusajs/framework/types';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { mintSuperAdmin, postStoreCustomer, unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

// Real name + phone lock (spec
// docs/superpowers/specs/2026-10-06-real-name-and-phone-lock-design.md) — the
// HTTP surface end to end, on a database built by the real migrations (so this
// suite also proves Migration20261006120000's SQL runs):
//   (store)  POST /store/customers/me/real-name — validated, set ONCE
//   (store)  GET /store/customers/me/account — realName + phoneVerified
//   (store)  POST /store/phone-verification/change — refused once verified
//   (admin)  POST /admin/customers/:id/real-name — overwrites, audited
//   (admin)  POST /admin/customers/:id/phone — one-phone-one-account, audited,
//            stamps verified; a `phone` body key is still refused by
//            rejectAdminPhoneWrite on the generic wildcard

const PASSWORD = 'real-name-test-password-1'; // gitleaks:allow
const ADMIN_EMAIL = 'real-name-admin@test.dev';

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('real name + phone lock', () => {
      let storeHeaders: Record<string, string>;
      let adminToken: string;

      const packs = (): PacksModuleService =>
        getContainer().resolve<PacksModuleService>(PACKS_MODULE);
      const customers = (): ICustomerModuleService =>
        getContainer().resolve<ICustomerModuleService>(Modules.CUSTOMER);
      const adminHeaders = () => ({ authorization: `Bearer ${adminToken}` });

      const createCustomer = async (
        email: string,
      ): Promise<{ id: string; headers: Record<string, string> }> => {
        const reg = await api.post('/auth/customer/emailpass/register', {
          email,
          password: PASSWORD,
        });
        const created = await postStoreCustomer(
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
        return {
          id: created.data.customer.id,
          headers: {
            ...storeHeaders,
            authorization: `Bearer ${login.data.token}`,
          },
        };
      };

      const setRealName = (body: unknown, headers: Record<string, string>) =>
        unwrapResponse(
          api.post('/store/customers/me/real-name', body, { headers }),
        );

      beforeEach(async () => {
        const container = getContainer();
        const key = await container.resolve(Modules.API_KEY).createApiKeys({
          title: 'real-name-test',
          type: 'publishable',
          created_by: 'real-name-test',
        });
        storeHeaders = { 'x-publishable-api-key': key.token };
        adminToken = await mintSuperAdmin(
          container,
          api,
          ADMIN_EMAIL,
          PASSWORD,
        );
      });

      it('sets the real name once, normalized, and refuses a second write', async () => {
        const { headers } = await createCustomer('rn-once@test.dev');
        const readName = async () =>
          (
            await unwrapResponse(
              api.get('/store/customers/me/real-name', { headers }),
            )
          ).data;
        expect(await readName()).toEqual({ real_name: null });

        const bad = await setRealName({ real_name: 'Tan 123' }, headers);
        expect(bad.status).toBe(400);

        const ok = await setRealName(
          { real_name: '  Tan   Ah  Kow ' },
          headers,
        );
        expect(ok.status).toBe(200);
        expect(ok.data).toEqual({ real_name: 'Tan Ah Kow' });
        expect(await readName()).toEqual({ real_name: 'Tan Ah Kow' });

        const again = await setRealName({ real_name: 'Someone Else' }, headers);
        expect(again.status).toBe(400);
        expect(again.data.message).toMatch(/contact customer service/i);

        const account = await unwrapResponse(
          api.get('/store/customers/me/account', { headers }),
        );
        expect(account.status).toBe(200);
        expect(account.data).toMatchObject({
          realName: 'Tan Ah Kow',
          phoneVerified: false,
        });
      });

      it('401s an unauthenticated real-name write', async () => {
        const res = await setRealName(
          { real_name: 'Tan Ah Kow' },
          storeHeaders,
        );
        expect(res.status).toBe(401);
      });

      it('refuses a phone change once the account has verified a phone', async () => {
        const { id, headers } = await createCustomer('rn-locked@test.dev');
        await packs().markPhoneVerified(id);

        // The lock runs before any proof is examined: no OTP needed to hit it.
        const res = await unwrapResponse(
          api.post(
            '/store/phone-verification/change',
            { phone: '+60107660001', token: 'irrelevant', password: PASSWORD },
            { headers },
          ),
        );
        expect(res.status).toBe(400);
        expect(res.data.message).toMatch(/contact customer service/i);
      });

      it('lets customer service correct a real name, audited', async () => {
        const { id, headers } = await createCustomer('rn-cs@test.dev');
        await setRealName({ real_name: 'Tan Ah Kow' }, headers);

        const noReason = await unwrapResponse(
          api.post(
            `/admin/customers/${id}/real-name`,
            { real_name: 'Tan Ah Kau' },
            { headers: adminHeaders() },
          ),
        );
        expect(noReason.status).toBe(400);

        const ok = await unwrapResponse(
          api.post(
            `/admin/customers/${id}/real-name`,
            { real_name: 'Tan Ah Kau', reason: 'typo, checked against TNG' },
            { headers: adminHeaders() },
          ),
        );
        expect(ok.status).toBe(200);
        expect((await packs().getVerificationState(id)).realName).toBe(
          'Tan Ah Kau',
        );
        const [audit] = await packs().listAdminActionAudits(
          { entity_id: id, action: 'set_real_name' },
          { take: 1 },
        );
        expect(audit).toMatchObject({
          before: { real_name: 'Tan Ah Kow' },
          after: { real_name: 'Tan Ah Kau' },
          reason: 'typo, checked against TNG',
        });
      });

      it('lets customer service move a phone: unclaimed only, audited, verified', async () => {
        const { id } = await createCustomer('rn-phone@test.dev');
        const other = await createCustomer('rn-phone-other@test.dev');
        await customers().updateCustomers(other.id, { phone: '+60107660002' });

        // The generic admin guard still refuses a `phone` key on this path.
        const phoneKey = await unwrapResponse(
          api.post(
            `/admin/customers/${id}/phone`,
            { phone: '+60107660003', reason: 'x' },
            { headers: adminHeaders() },
          ),
        );
        expect(phoneKey.status).toBe(400);

        const taken = await unwrapResponse(
          api.post(
            `/admin/customers/${id}/phone`,
            { new_phone: '+60107660002', reason: 'lost SIM' },
            { headers: adminHeaders() },
          ),
        );
        expect(taken.status).toBe(400);
        expect(taken.data.message).toMatch(/already in use/i);

        const ok = await unwrapResponse(
          api.post(
            `/admin/customers/${id}/phone`,
            { new_phone: '+60107660003', reason: 'lost SIM, identity checked' },
            { headers: adminHeaders() },
          ),
        );
        expect(ok.status).toBe(200);
        expect((await customers().retrieveCustomer(id)).phone).toBe(
          '+60107660003',
        );
        expect(await packs().isPhoneVerified(id)).toBe(true);
        const [audit] = await packs().listAdminActionAudits(
          { entity_id: id, action: 'set_phone' },
          { take: 1 },
        );
        expect(audit).toMatchObject({
          before: { phone: null },
          after: { phone: '+60107660003' },
          reason: 'lost SIM, identity checked',
        });
      });
    });
  },
});
