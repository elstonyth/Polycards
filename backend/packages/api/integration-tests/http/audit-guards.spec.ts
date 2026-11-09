import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import {
  ContainerRegistrationKeys,
  generateJwtToken,
  Modules,
} from '@medusajs/framework/utils';
import {
  mintSuperAdmin,
  staffIdentityWithAuthenticator,
  unwrapResponse,
} from './utils';

jest.setTimeout(240 * 1000);

// Guards added by the 2026-11-09 audit: staff sign-up needs a live invite,
// core admin routes that asked too little now ask the right policy, and core
// uploads state their size.
medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    const as = (token: string) => ({
      headers: { authorization: `Bearer ${token}` },
    });

    describe('staff sign-up', () => {
      it('needs a live invite for that email', async () => {
        const register = (email: string) =>
          unwrapResponse(
            api.post('/auth/user/emailpass/register', {
              email,
              password: 'invited-pw-1',
            }),
          );
        const uninvited = await register('nobody@test.dev');
        expect(uninvited.status).toBe(404);

        await getContainer()
          .resolve(Modules.USER)
          .createInvites([{ email: 'invited@test.dev' }]);
        // Exactly the invite's email: a padded one would be a login that
        // sign-in, which trims, never finds.
        const padded = await register(' invited@test.dev ');
        expect(padded.status).toBe(404);
        const invited = await register('invited@test.dev');
        expect(invited.status).toBe(200);
        expect(typeof invited.data.token).toBe('string');
      });
    });

    describe('core admin routes', () => {
      // A role with exactly these policies, signed the way the guard specs do.
      const tokenWith = async (
        name: string,
        resource: string,
        operation: string,
      ) => {
        const container = getContainer();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const rbac = container.resolve(Modules.RBAC) as any;
        const [role] = await rbac.createRbacRoles([{ name }]);
        const policies = await rbac.listRbacPolicies({
          resource: [resource],
          operation: [operation],
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

      it('asks customer:read to search', async () => {
        const stock = await tokenWith('stock-only', 'inventory_item', 'read');
        const reader = await tokenWith('customer-reader', 'customer', 'read');
        const search = '/admin/search?entity=customer&limit=5';
        expect((await unwrapResponse(api.get(search, as(stock)))).status).toBe(
          403,
        );
        expect(
          (await unwrapResponse(api.get(search, as(reader)))).status,
        ).not.toBe(403);
      });

      it('asks workflow_execution:update to run a workflow', async () => {
        const viewer = await tokenWith(
          'workflow-viewer',
          'workflow_execution',
          'read',
        );
        const run = await unwrapResponse(
          api.post(
            '/admin/workflows-executions/create-users-workflow/run',
            { input: {} },
            as(viewer),
          ),
        );
        expect(run.status).toBe(403);
      });

      it('asks inventory_item:delete to delete an inventory item', async () => {
        const stock = await tokenWith('stock-keeper', 'inventory_item', 'read');
        const del = await unwrapResponse(
          api.delete('/admin/inventory-items/iitem_missing', as(stock)),
        );
        expect(del.status).toBe(403);
      });

      it('refuses a core upload that does not state its size', async () => {
        const admin = await mintSuperAdmin(
          getContainer(),
          api,
          'uploads-admin@test.dev',
          'uploads-admin-pw-1',
        );
        const res = await unwrapResponse(
          api.post('/admin/uploads', '', {
            headers: {
              ...as(admin).headers,
              'content-type': 'multipart/form-data; boundary=x',
            },
          }),
        );
        expect(res.status).toBe(400);
        expect(res.data.message).toMatch(/state its size/);
        // A sized upload, as a browser sends one, goes on to core.
        const body = [
          '--x',
          'Content-Disposition: form-data; name="files"; filename="a.png"',
          'Content-Type: image/png',
          '',
          'hello',
          '--x--',
          '',
        ].join('\r\n');
        const sized = await unwrapResponse(
          api.post('/admin/uploads', body, {
            headers: {
              ...as(admin).headers,
              'content-type': 'multipart/form-data; boundary=x',
              'content-length': String(Buffer.byteLength(body)),
            },
          }),
        );
        expect(sized.data?.message ?? '').not.toMatch(/state its size/);
        expect(sized.status).not.toBe(400);
      });
    });
  },
});
