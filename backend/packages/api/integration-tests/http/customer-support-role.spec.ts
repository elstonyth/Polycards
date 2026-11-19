import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import {
  ContainerRegistrationKeys,
  generateJwtToken,
  Modules,
} from '@medusajs/framework/utils';
import { supportViewerRoleId } from '../../src/scripts/create-support-viewer';
import { mintSuperAdmin, staffIdentityWithAuthenticator } from './utils';

jest.setTimeout(240 * 1000);

// The Customer support role (scripts/create-support-viewer.ts) over real HTTP,
// with core's own customer entries ANDed in. Building the role at all proves
// every policy it names is live after the boot sync, customer_support:update
// included (policies/customer-support.ts). Then both directions: the support
// fixes pass RBAC, and the rest of customer:update (money, phone, name
// clash) is refused. Super admins keep the fixes through `*:*`.
medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('Customer support role', () => {
      it('fixes real names and saved banks, and nothing else on customer:update', async () => {
        const container = getContainer();
        const customers = container.resolve(Modules.CUSTOMER);
        const [player] = await customers.createCustomers([
          {
            email: 'support-role@test.dev',
            has_account: true,
            metadata: { handle: 'support-role' },
          },
        ]);
        const { http } = container.resolve(
          ContainerRegistrationKeys.CONFIG_MODULE,
        ).projectConfig;
        const staffIdentity = await staffIdentityWithAuthenticator(container);
        const roleId = await supportViewerRoleId(container);
        const support = generateJwtToken(
          {
            actor_id: 'support-role-user',
            actor_type: 'user',
            auth_identity_id: staffIdentity,
            app_metadata: { user_id: 'support-role-user', roles: [roleId] },
          },
          {
            secret: http.jwtSecret,
            expiresIn: 300,
            jwtOptions: http.jwtOptions,
          },
        );
        const staff = await mintSuperAdmin(
          container,
          api,
          'support-role-admin@test.dev',
          'support-role-admin-password-1',
        );
        const post = (path: string, body: unknown, token: string) =>
          api
            .post(`/admin/customers/${player.id}${path}`, body, {
              headers: { authorization: `Bearer ${token}` },
            })
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            .catch((e: any) => e.response);

        // Passes RBAC: the real-name fix lands.
        const named = await post(
          '/real-name',
          { real_name: 'Test Support Name', reason: 'support role test' },
          support,
        );
        expect(named.status).toBe(200);
        expect(named.data.real_name).toBe('Test Support Name');
        // Passes RBAC: the bank routes reach their own validation, not a 403.
        for (const sub of ['add', 'remove', 'verify']) {
          const res = await post(`/bank-accounts/${sub}`, {}, support);
          expect([sub, res.status]).not.toEqual([sub, 403]);
        }

        // Refused: money, phone, name clash, freeze and disable.
        for (const [path, body] of [
          ['/credits', { amount: 1, note: 'support role test' }],
          ['/pack-gifts', {}],
          ['/lucky-draw-tickets', {}],
          ['/phone', { new_phone: '+60123456789', reason: 'test' }],
          ['/bank-accounts/name-clash', {}],
          ['/freeze', {}],
          ['/disable', {}],
          ['/group', {}],
        ] as const) {
          const res = await post(path, body, support);
          expect([path, res.status]).toEqual([path, 403]);
        }

        // Super admins keep the fix through `*:*`.
        const staffNamed = await post(
          '/real-name',
          { real_name: 'Test Staff Name', reason: 'support role test' },
          staff,
        );
        expect(staffNamed.status).toBe(200);
      });
    });
  },
});
