// integration-tests/http/admin-rbac.spec.ts
// RBAC on the custom admin routes (api/admin-rbac.ts): a read-only role
// (the desk bots' `*:read`) is refused every custom write with the policy it
// lacks, still reads the custom screens, and the super admin passes.
import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import {
  ContainerRegistrationKeys,
  generateJwtToken,
} from '@medusajs/framework/utils';
import {
  DESK_BOT_ACTOR,
  deskBotRoleId,
} from '../../src/api/reports/admin/proxy';
import { createAutomationOperator } from '../../src/scripts/create-automation-operator';
import { mintSuperAdmin, unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

// Writes a read-only role must not reach, with the policy each asks for. Ids
// are bogus on purpose: the policy check runs before the handler, so the
// read-only token is refused first and the super admin gets the handler's own
// 4xx (never 403).
const WRITES: { method: 'post' | 'delete'; path: string; policy: string }[] = [
  {
    method: 'post',
    path: '/admin/automation/accounts',
    policy: 'automation:update',
  },
  {
    method: 'post',
    path: '/admin/referrals/settlements/wset_none/approve',
    policy: 'referral:update',
  },
  {
    method: 'post',
    path: '/admin/referrals/settlements/wset_none/pay',
    policy: 'referral:update',
  },
  {
    method: 'post',
    path: '/admin/customers/cus_none/credits',
    policy: 'customer:update',
  },
  {
    method: 'post',
    path: '/admin/customers/cus_none/partner-rate',
    policy: 'customer:update',
  },
  {
    method: 'post',
    path: '/admin/payments/withdrawals/gwd_none/approve',
    policy: 'payment:update',
  },
  { method: 'post', path: '/admin/packs/reorder', policy: 'pack:update' },
  {
    method: 'delete',
    path: '/admin/packs/no-such-pack',
    policy: 'pack:delete',
  },
];

const READS = [
  '/admin/referrals/settlements',
  '/admin/packs',
  '/admin/ledger',
  '/admin/automation',
];

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('admin RBAC on custom routes', () => {
      let adminToken: string;
      let readOnlyToken: string;

      beforeEach(async () => {
        const container = getContainer();
        adminToken = await mintSuperAdmin(
          container,
          api,
          'rbac-admin@test.dev',
          'rbac-admin-pw-1',
        );
        // The same token the desk-bot proxy mints: one role, `*:read`.
        const { http } = container.resolve(
          ContainerRegistrationKeys.CONFIG_MODULE,
        ).projectConfig;
        readOnlyToken = generateJwtToken(
          {
            actor_id: DESK_BOT_ACTOR,
            actor_type: 'user',
            auth_identity_id: '',
            app_metadata: {
              user_id: DESK_BOT_ACTOR,
              roles: [await deskBotRoleId(container)],
            },
          },
          {
            secret: http.jwtSecret,
            expiresIn: 300,
            jwtOptions: http.jwtOptions,
          },
        );
      });

      const call = (
        method: 'post' | 'delete' | 'get',
        path: string,
        token: string,
      ) => {
        const headers = { authorization: `Bearer ${token}` };
        return unwrapResponse(
          method === 'post'
            ? api.post(path, {}, { headers })
            : method === 'delete'
              ? api.delete(path, { headers })
              : api.get(path, { headers }),
        );
      };

      it('refuses every custom write to a read-only role, naming the policy', async () => {
        for (const w of WRITES) {
          const res = await call(w.method, w.path, readOnlyToken);
          expect({ path: w.path, status: res.status }).toEqual({
            path: w.path,
            status: 403,
          });
          expect(res.data.message).toContain('Insufficient permissions');
          expect(res.data.message).toContain(w.policy);
        }
      });

      it('still lets a read-only role read the custom screens', async () => {
        for (const path of READS) {
          const res = await call('get', path, readOnlyToken);
          expect({ path, status: res.status }).toEqual({ path, status: 200 });
        }
      });

      it('lets the super admin through to the handler', async () => {
        for (const w of WRITES) {
          const res = await call(w.method, w.path, adminToken);
          expect({ path: w.path, forbidden: res.status === 403 }).toEqual({
            path: w.path,
            forbidden: false,
          });
        }
        for (const path of READS) {
          const res = await call('get', path, adminToken);
          expect({ path, status: res.status }).toEqual({ path, status: 200 });
        }
      });

      it('lets the automation operator run Automation and nothing else', async () => {
        const email = 'operator@test.dev';
        const password = 'operator-pw-1';
        await createAutomationOperator(getContainer(), email, password);
        const login = await api.post('/auth/user/emailpass', {
          email,
          password,
        });
        const token = login.data.token as string;

        const permissions = await call(
          'get',
          '/admin/rbac/me/permissions',
          token,
        );
        expect(permissions.data.permissions).toEqual([
          'automation:delete',
          'automation:read',
          'automation:update',
          'store:read',
        ]);

        // The Automation page's own calls, plus the dashboard shell's.
        for (const path of [
          '/admin/automation',
          '/admin/automation/activity',
          '/admin/automation/leaderboard',
          '/admin/automation/live',
          '/admin/automation/sandbox',
          '/admin/stores',
          '/admin/users/me',
        ]) {
          const res = await call('get', path, token);
          expect({ path, status: res.status }).toEqual({ path, status: 200 });
        }
        // The account list takes any customer's email and a live run spends
        // that customer's wallet, so only staff (customer:read) may change it.
        const save = await call('post', '/admin/automation/accounts', token);
        expect(save.status).toBe(403);
        expect(save.data.message).toContain('customer:read');

        for (const path of [
          '/admin/customers',
          '/admin/customer-groups',
          '/admin/players',
          '/admin/packs',
          '/admin/stats',
          '/admin/ledger',
          '/admin/referrals/settlements',
          '/admin/users',
          '/admin/rbac/roles',
        ]) {
          const res = await call('get', path, token);
          expect({ path, status: res.status }).toEqual({ path, status: 403 });
        }
        for (const w of WRITES.filter(
          (w) => !w.path.startsWith('/admin/automation'),
        )) {
          const res = await call(w.method, w.path, token);
          expect({ path: w.path, status: res.status }).toEqual({
            path: w.path,
            status: 403,
          });
        }
      });
    });
  },
});
