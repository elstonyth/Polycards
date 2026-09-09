import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { Modules } from '@medusajs/framework/utils';
import type { ICustomerModuleService } from '@medusajs/framework/types';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { WITHDRAWALS_BLOCKED_MESSAGE } from '../../src/api/utils/customer-group-guards';
import { mintSuperAdmin, postStoreCustomer, unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

// Partner groups (spec docs/superpowers/specs/2026-09-09-partner-groups-design.md)
// — the HTTP surface end to end:
//   (admin)  POST /admin/customer-groups/:id/policy validates bounds, refuses
//            DEFAULT, writes the audit row
//   (admin)  the prebuilt Edit form's `additional_data` no longer 400s a rename
//   (admin)  POST /admin/customers/:id/partner-rate is refused for a member of
//            a partner group, allowed again once they leave it
//   (admin)  GET /admin/players reports partner: 'group' | 'manual' | null
//   (store)  GET /store/customers/me/account carries the policy block
//   (store)  POST /store/credits/withdraw is refused for a blocked member
//   (store)  GET /store/referral pays the GROUP rate

const PASSWORD = 'player-groups-policy-test-password-1'; // gitleaks:allow
const ADMIN_EMAIL = 'player-groups-policy-admin@test.dev';
const MEMBER_EMAIL = 'player-groups-policy-member@test.dev';
const GROUP_NAME = 'Policy Partners';

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('player group policy (partner groups)', () => {
      let storeHeaders: Record<string, string>;
      let adminToken: string;
      let memberToken: string;
      let memberId: string;
      let groupId: string;

      const adminHeaders = (): Record<string, string> => ({
        authorization: `Bearer ${adminToken}`,
      });
      const memberHeaders = (): Record<string, string> => ({
        ...storeHeaders,
        authorization: `Bearer ${memberToken}`,
      });
      const customerModule = (): ICustomerModuleService =>
        getContainer().resolve<ICustomerModuleService>(Modules.CUSTOMER);
      const packs = (): PacksModuleService =>
        getContainer().resolve<PacksModuleService>(PACKS_MODULE);

      const setPolicy = (
        id: string,
        body: Record<string, unknown>,
      ): Promise<{ status: number; data: Record<string, never> }> =>
        unwrapResponse(
          api.post(`/admin/customer-groups/${id}/policy`, body, {
            headers: adminHeaders(),
          }),
        );

      const moveMember = (targetGroupId: string | null) =>
        unwrapResponse(
          api.post(
            `/admin/customers/${memberId}/group`,
            { group_id: targetGroupId },
            { headers: adminHeaders() },
          ),
        );

      beforeEach(async () => {
        const container = getContainer();
        const apiKeyModule = container.resolve(Modules.API_KEY);
        const key = await apiKeyModule.createApiKeys({
          title: 'player-groups-policy-test',
          type: 'publishable',
          created_by: 'player-groups-policy-test',
        });
        storeHeaders = { 'x-publishable-api-key': key.token };
        adminToken = await mintSuperAdmin(
          container,
          api,
          ADMIN_EMAIL,
          PASSWORD,
        );

        const reg = await api.post('/auth/customer/emailpass/register', {
          email: MEMBER_EMAIL,
          password: PASSWORD,
        });
        const created = await postStoreCustomer(
          api,
          container,
          { email: MEMBER_EMAIL },
          {
            headers: {
              ...storeHeaders,
              authorization: `Bearer ${reg.data.token}`,
            },
          },
        );
        memberId = created.data.customer.id;
        const login = await api.post('/auth/customer/emailpass', {
          email: MEMBER_EMAIL,
          password: PASSWORD,
        });
        memberToken = login.data.token;

        const group = await customerModule().createCustomerGroups({
          name: GROUP_NAME,
          metadata: { odds_set: 1 },
        });
        groupId = group.id;
        // The repo-side move: exclusive membership, out of DEFAULT.
        const moved = await moveMember(groupId);
        expect(moved.status).toBe(200);
      });

      it('validates bounds, refuses DEFAULT, and audits a policy write', async () => {
        // 250 bp is below the default 300–500 partner bounds.
        const low = await setPolicy(groupId, {
          partner_rate_bp: 250,
          reason: 'too low',
        });
        expect(low.status).toBe(400);

        const ok = await setPolicy(groupId, {
          partner_rate_bp: 400,
          withdrawals_blocked: true,
          verification_exempt: true,
          reason: 'partner onboarding',
        });
        expect(ok.status).toBe(200);
        const stored = await customerModule().retrieveCustomerGroup(groupId);
        expect(stored.metadata).toMatchObject({
          odds_set: 1, // sibling key survives the merge
          partner_rate_bp: 400,
          withdrawals_blocked: true,
          verification_exempt: true,
        });

        const [audit] = await packs().listAdminActionAudits(
          { entity_type: 'customer_group', entity_id: groupId },
          { take: 1, order: { created_at: 'DESC' } },
        );
        expect(audit?.action).toBe('edit_group_policy');
        expect(audit?.after).toMatchObject({ partner_rate_bp: 400 });
        expect(audit?.reason).toBe('partner onboarding');

        // Partner off = one switch: the toggles are cleared with the rate.
        const off = await setPolicy(groupId, {
          partner_rate_bp: null,
          withdrawals_blocked: true,
          verification_exempt: true,
          reason: 'partner offboarding',
        });
        expect(off.status).toBe(200);
        const cleared = await customerModule().retrieveCustomerGroup(groupId);
        expect(cleared.metadata).toMatchObject({
          partner_rate_bp: null,
          withdrawals_blocked: false,
          verification_exempt: false,
        });

        // DEFAULT exists (the member landed in it at sign-up) and is locked.
        const [dflt] = await customerModule().listCustomerGroups(
          { name: 'DEFAULT' },
          { take: 1 },
        );
        const locked = await setPolicy(dflt.id, {
          partner_rate_bp: 400,
          reason: 'must fail',
        });
        expect(locked.status).toBe(400);
        expect(locked.data).toMatchObject({
          message: expect.stringMatching(/default player group/i),
        });
      });

      // The prebuilt @mercurjs/admin Edit Customer Group form always posts
      // `additional_data`; before stripAdditionalData this was a guaranteed
      // "Unrecognized fields: 'additional_data'" 400 on every rename.
      it('accepts additional_data on the native customer-group create and update routes', async () => {
        const renamed = await unwrapResponse(
          api.post(
            `/admin/customer-groups/${groupId}`,
            { name: 'Policy Partners Renamed', additional_data: {} },
            { headers: adminHeaders() },
          ),
        );
        expect(renamed.status).toBe(200);
        expect(renamed.data.customer_group.name).toBe(
          'Policy Partners Renamed',
        );
        const created = await unwrapResponse(
          api.post(
            '/admin/customer-groups',
            { name: 'Policy Created Via Form', additional_data: {} },
            { headers: adminHeaders() },
          ),
        );
        expect(created.status).toBe(200);
        expect(created.data.customer_group.name).toBe(
          'Policy Created Via Form',
        );
      });

      it('refuses a manual partner rate while the player is in a partner group, and reports the source', async () => {
        expect(
          (
            await setPolicy(groupId, {
              partner_rate_bp: 450,
              reason: 'partner onboarding',
            })
          ).status,
        ).toBe(200);

        const refused = await unwrapResponse(
          api.post(
            `/admin/customers/${memberId}/partner-rate`,
            { rate_bp: 400, reason: 'should be refused' },
            { headers: adminHeaders() },
          ),
        );
        expect(refused.status).toBe(400);
        expect(refused.data.message).toMatch(/partner group "Policy Partners"/);

        const card = await unwrapResponse(
          api.get(`/admin/customers/${memberId}/referral`, {
            headers: adminHeaders(),
          }),
        );
        expect(card.status).toBe(200);
        expect(card.data.partner_referral_bp).toBeNull();
        expect(card.data.partner_group).toEqual({
          id: groupId,
          name: GROUP_NAME,
          rate_bp: 450,
        });

        const listed = await unwrapResponse(
          api.get(`/admin/players?q=${encodeURIComponent(MEMBER_EMAIL)}`, {
            headers: adminHeaders(),
          }),
        );
        expect(listed.status).toBe(200);
        const row = listed.data.players.find(
          (p: { id: string }) => p.id === memberId,
        );
        expect(row?.partner).toBe('group');

        // The storefront sees the group rate as a partner rate.
        const referral = await unwrapResponse(
          api.get('/store/referral', { headers: memberHeaders() }),
        );
        expect(referral.status).toBe(200);
        expect(referral.data.week.partner).toBe(true);
        expect(referral.data.week.rate_bp).toBe(450);

        // Out of the group: the manual control works again, and the list
        // names the manual source.
        expect((await moveMember(null)).status).toBe(200);
        const allowed = await unwrapResponse(
          api.post(
            `/admin/customers/${memberId}/partner-rate`,
            { rate_bp: 400, reason: 'per-customer partner' },
            { headers: adminHeaders() },
          ),
        );
        expect(allowed.status).toBe(200);
        const listedAfter = await unwrapResponse(
          api.get(`/admin/players?q=${encodeURIComponent(MEMBER_EMAIL)}`, {
            headers: adminHeaders(),
          }),
        );
        const rowAfter = listedAfter.data.players.find(
          (p: { id: string }) => p.id === memberId,
        );
        expect(rowAfter?.partner).toBe('manual');
      });

      it('exposes the policy to the account and blocks the withdrawal', async () => {
        expect(
          (
            await setPolicy(groupId, {
              partner_rate_bp: 300,
              withdrawals_blocked: true,
              verification_exempt: true,
              reason: 'partner onboarding',
            })
          ).status,
        ).toBe(200);

        const account = await unwrapResponse(
          api.get('/store/customers/me/account', { headers: memberHeaders() }),
        );
        expect(account.status).toBe(200);
        expect(account.data.policy).toEqual({
          partner: true,
          withdrawals_blocked: true,
          verification_exempt: true,
        });

        const withdraw = await unwrapResponse(
          api.post(
            '/store/credits/withdraw',
            { amount: 10, account_id: 'acct_none' },
            { headers: memberHeaders() },
          ),
        );
        expect(withdraw.status).toBe(400);
        expect(withdraw.data.message).toBe(WITHDRAWALS_BLOCKED_MESSAGE);

        // An ordinary group member is not blocked — the refusal, if any, is
        // the route's own (no gateway configured in tests), never ours.
        expect(
          (
            await setPolicy(groupId, {
              partner_rate_bp: 300,
              withdrawals_blocked: false,
              reason: 'unblock',
            })
          ).status,
        ).toBe(200);
        const unblocked = await unwrapResponse(
          api.post(
            '/store/credits/withdraw',
            { amount: 10, account_id: 'acct_none' },
            { headers: memberHeaders() },
          ),
        );
        expect(unblocked.data.message).not.toBe(WITHDRAWALS_BLOCKED_MESSAGE);
      });
    });
  },
});
