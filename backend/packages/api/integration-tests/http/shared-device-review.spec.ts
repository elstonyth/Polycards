import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import {
  ContainerRegistrationKeys,
  generateJwtToken,
  Modules,
} from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import {
  mintSuperAdmin,
  staffIdentityWithAuthenticator,
  unwrapResponse,
} from './utils';

jest.setTimeout(240 * 1000);

// The held-withdrawal review screen (ADR 0018), through the real routes and SQL:
// two accounts on one browser, the later one's withdrawal held, and what a
// reviewer sees. Details are made up.

const BROWSER = '33333333-2222-4333-8444-555555555555';

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('shared-device review', () => {
      let adminToken: string;
      beforeEach(async () => {
        adminToken = await mintSuperAdmin(
          getContainer(),
          api,
          'shared-device-admin@test.dev',
          'shared-device-test-password-1',
        );
      });
      const as = (token: string) => ({
        headers: { authorization: `Bearer ${token}` },
      });
      const packs = () =>
        getContainer().resolve<PacksModuleService>(PACKS_MODULE);

      // A role with exactly one policy, signed the way the guard specs do.
      const tokenWith = async (
        name: string,
        resource: string,
        operation: 'read' | 'update' = 'read',
      ) => {
        const container = getContainer();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const rbac = container.resolve(Modules.RBAC) as any;
        const [role] = await rbac.createRbacRoles([{ name }]);
        const policies = await rbac.listRbacPolicies({
          resource: [resource],
          operation: operation === 'read' ? ['read'] : ['read', operation],
        });
        await rbac.createRbacRolePolicies(
          policies.map((p: { id: string }) => ({
            role_id: role.id,
            policy_id: p.id,
          })),
        );
        const { http } = container.resolve(
          ContainerRegistrationKeys.CONFIG_MODULE,
        ).projectConfig;
        return generateJwtToken(
          {
            actor_id: name,
            actor_type: 'user',
            auth_identity_id: await staffIdentityWithAuthenticator(container),
            app_metadata: { user_id: name, roles: [role.id] },
          },
          {
            secret: http.jwtSecret,
            expiresIn: 300,
            jwtOptions: http.jwtOptions,
          },
        );
      };

      const seed = async () => {
        const customers = getContainer().resolve(Modules.CUSTOMER);
        const [first] = await customers.createCustomers([
          { email: 'shared-first@test.dev', has_account: true },
        ]);
        const [later] = await customers.createCustomers([
          { email: 'shared-later@test.dev', has_account: true },
        ]);
        const db = getContainer().resolve(
          ContainerRegistrationKeys.PG_CONNECTION,
        );
        await db.raw(
          "UPDATE customer SET created_at = now() - interval '2 days' WHERE id = ?",
          [first.id],
        );
        for (const id of [first.id, later.id]) {
          await packs().recordVisitorSignal({
            customerId: id,
            ip: '10.9.0.1',
            deviceId: BROWSER,
          });
        }
        await packs().createCreditTransactions([
          {
            customer_id: first.id,
            amount: 50,
            reason: 'topup',
            external_funded_cents: 5000,
          },
        ]);
        const [row] = await packs().createGatewayWithdrawals([
          {
            merchant_transaction_id: 'WD-shared-1',
            customer_id: later.id,
            amount: 60,
            bank_code: 'MBBEMYKL',
            account_number: '512345670001',
            account_holder_name: 'Holder Later',
            status: 'held',
            hold_reason: 'shared_device',
            gateway: 'tgpay',
          },
        ]);
        return { first: first.id, later: later.id, withdrawal: row.id };
      };

      it('shows the earlier account on the browser, audits the open, and tags the list row', async () => {
        const s = await seed();
        expect(await packs().sharedDeviceHoldPeers(s.later)).toEqual([s.first]);

        const res = await unwrapResponse(
          api.get(
            `/admin/payments/withdrawals/${s.withdrawal}/links`,
            as(adminToken),
          ),
        );
        expect(res.status).toBe(200);
        expect(res.data.withdrawal).toMatchObject({
          id: s.withdrawal,
          amount: 60,
          hold_reason: 'shared_device',
          last4: '0001',
        });
        expect(res.data.account).toMatchObject({ id: s.later });
        expect(res.data.linked).toEqual([
          expect.objectContaining({
            id: s.first,
            same_browser: true,
            made_earlier_on_browser: true,
            household_verified: false,
            same_network: true,
            topups: 50,
          }),
        ]);
        expect(res.data.unverified_peers).toBe(1);
        expect(res.data.unverified_peer_ids).toEqual([s.first]);
        expect(res.data.invited_total).toBe(0);
        expect(res.headers['cache-control']).toBe('no-store');

        const audits = await packs().listAdminActionAudits({
          entity_id: s.later,
          action: 'reveal',
        });
        expect(audits).toHaveLength(1);
        expect(JSON.stringify(audits[0].after)).not.toContain('512345670001');

        const list = await unwrapResponse(
          api.get('/admin/payments/withdrawals?status=held', as(adminToken)),
        );
        expect(
          list.data.withdrawals.find(
            (w: { id: string }) => w.id === s.withdrawal,
          ),
        ).toMatchObject({ hold_reason: 'shared_device' });

        // Once support confirms the pair, the later account is not held for it.
        await packs().verifyDevicePeers({
          customerId: s.later,
          peerIds: [s.first],
          adminId: 'user_test',
          reason: 'one household',
        });
        expect(await packs().sharedDeviceHoldPeers(s.later)).toEqual([]);
        const again = await unwrapResponse(
          api.get(
            `/admin/payments/withdrawals/${s.withdrawal}/links`,
            as(adminToken),
          ),
        );
        expect(again.data.linked[0]).toMatchObject({
          household_verified: true,
        });
        expect(again.data.unverified_peers).toBe(0);
      });

      it('refuses the household tick from an approver without bank access, before paying', async () => {
        const s = await seed();
        const approver = await tokenWith('payments-approver', 'payment', 'update');
        const refused = await unwrapResponse(
          api.post(
            `/admin/payments/withdrawals/${s.withdrawal}/approve`,
            { verify_device_peers: [s.first] },
            as(approver),
          ),
        );
        expect(refused.status).toBe(400);
        expect(refused.data.message).toMatch(/needs access to bank details/);
        const [row] = await packs().listGatewayWithdrawals({ id: s.withdrawal }, { take: 1 });
        expect(row.status).toBe('held');
        // A super admin passes the tick check and reaches the approve itself
        // (this seeded row was never debited, so the approve refuses it on its own terms).
        const admin = await unwrapResponse(
          api.post(
            `/admin/payments/withdrawals/${s.withdrawal}/approve`,
            { verify_device_peers: [s.first] },
            as(adminToken),
          ),
        );
        expect(admin.data?.message ?? '').not.toMatch(/needs access to bank details/);
      });

      it('needs the bank read policy', async () => {
        const s = await seed();
        const paymentsOnly = await tokenWith('payments-reader', 'payment');
        const res = await unwrapResponse(
          api.get(
            `/admin/payments/withdrawals/${s.withdrawal}/links`,
            as(paymentsOnly),
          ),
        );
        expect(res.status).toBe(403);
      });

      it('a customer cannot stamp a household confirmation on themself', async () => {
        const s = await seed();
        const res = await unwrapResponse(
          api.post(
            `/admin/customers/${s.later}`,
            {
              metadata: {
                device_share_verified: { [s.first]: new Date().toISOString() },
              },
            },
            as(adminToken),
          ),
        );
        expect(res.status).toBe(400);
      });
    });
  },
});
