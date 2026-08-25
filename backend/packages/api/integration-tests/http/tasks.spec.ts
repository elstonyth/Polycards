// integration-tests/http/tasks.spec.ts
// The task system's HTTP surface (spec 2026-08-24 Phase B):
//   (auth)  store routes 401 without a bearer; /admin/tasks 401 unauthed
//   (loop)  admin creates a weekly check-in task → customer checks in →
//           claims → credited once; double actions are polite no-ops
import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { Modules } from '@medusajs/framework/utils';
import { mintSuperAdmin, postStoreCustomer, unwrapResponse } from './utils';

jest.setTimeout(300 * 1000);

const PASSWORD = 'tasks-http-test-pw-1';

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('task HTTP surface', () => {
      let storeHeaders: Record<string, string>;
      let adminToken: string;
      let customerToken: string;

      const authed = (): Record<string, string> => ({
        ...storeHeaders,
        authorization: `Bearer ${customerToken}`,
      });
      const adminHeaders = (): Record<string, string> => ({
        authorization: `Bearer ${adminToken}`,
      });

      beforeEach(async () => {
        const container = getContainer();
        const apiKeyModule = container.resolve(Modules.API_KEY);
        const key = await apiKeyModule.createApiKeys({
          title: 'tasks-test',
          type: 'publishable',
          created_by: 'tasks-test',
        });
        storeHeaders = { 'x-publishable-api-key': key.token };
        adminToken = await mintSuperAdmin(
          container,
          api,
          'tasks-admin@test.dev',
          PASSWORD,
        );
        const reg = await api.post('/auth/customer/emailpass/register', {
          email: 'tasks-player@test.dev',
          password: PASSWORD,
        });
        await postStoreCustomer(
          api,
          container,
          { email: 'tasks-player@test.dev' },
          {
            headers: {
              ...storeHeaders,
              authorization: `Bearer ${reg.data.token}`,
            },
          },
        );
        const login = await api.post('/auth/customer/emailpass', {
          email: 'tasks-player@test.dev',
          password: PASSWORD,
        });
        customerToken = login.data.token;
      });

      it('401s without auth', async () => {
        expect(
          (
            await unwrapResponse(
              api.get('/store/tasks', { headers: storeHeaders }),
            )
          ).status,
        ).toBe(401);
        expect(
          (
            await unwrapResponse(
              api.post('/store/tasks/checkin', {}, { headers: storeHeaders }),
            )
          ).status,
        ).toBe(401);
        expect(
          (await unwrapResponse(api.post('/admin/tasks', {}))).status,
        ).toBe(401);
      });

      it('create → check in → claim → credited once', async () => {
        const created = await unwrapResponse(
          api.post(
            '/admin/tasks',
            {
              kind: 'weekly',
              title: 'Check in 1 day',
              requirement: { type: 'checkin_days', days: 1 },
              reward: { type: 'credit', amount_myr: 3 },
              reason: 'http test seed',
            },
            { headers: adminHeaders() },
          ),
        );
        expect(created.status).toBe(200);
        const taskId: string = created.data.id;

        // Hub shows it, incomplete, not checked in today.
        let hub = await unwrapResponse(
          api.get('/store/tasks', { headers: authed() }),
        );
        expect(hub.status).toBe(200);
        expect(hub.data.checked_in_today).toBe(false);
        expect(hub.data.tasks).toHaveLength(1);
        expect(hub.data.tasks[0].progress.completed).toBe(false);

        // Check in; second tap is a polite no-op.
        const c1 = await unwrapResponse(
          api.post('/store/tasks/checkin', {}, { headers: authed() }),
        );
        expect(c1.data.checked).toBe(true);
        const c2 = await unwrapResponse(
          api.post('/store/tasks/checkin', {}, { headers: authed() }),
        );
        expect(c2.data.checked).toBe(false);

        // Claim pays RM3 exactly once.
        const claim = await unwrapResponse(
          api.post(`/store/tasks/${taskId}/claim`, {}, { headers: authed() }),
        );
        expect(claim.data.claimed).toBe(true);
        const again = await unwrapResponse(
          api.post(`/store/tasks/${taskId}/claim`, {}, { headers: authed() }),
        );
        expect(again.data).toEqual({
          claimed: false,
          reason: 'already_claimed',
        });

        hub = await unwrapResponse(
          api.get('/store/tasks', { headers: authed() }),
        );
        expect(hub.data.checked_in_today).toBe(true);
        expect(hub.data.tasks[0].claimed).toBe(true);

        // Admin list surfaces the definition for editing.
        const list = await unwrapResponse(
          api.get('/admin/tasks', { headers: adminHeaders() }),
        );
        expect(list.data.tasks).toHaveLength(1);
        expect(list.data.tasks[0].reward).toEqual({
          type: 'credit',
          amount_myr: 3,
        });
      });
    });
  },
});
