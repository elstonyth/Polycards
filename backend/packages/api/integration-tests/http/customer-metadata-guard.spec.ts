import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import {
  ContainerRegistrationKeys,
  generateJwtToken,
  Modules,
} from '@medusajs/framework/utils';
import { supportViewerRoleId } from '../../src/scripts/create-support-viewer';
import { mintSuperAdmin, postStoreCustomer, unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

const PASSWORD = 'metadata-guard-test-password-1';

// Medusa's stock POST /store/customers/me accepts arbitrary `metadata` — read
// from the installed package, not assumed:
// node_modules/@medusajs/medusa/dist/api/store/customers/validators.js declares
// StoreUpdateCustomer with `metadata: z.record(z.unknown()).nullish()` and
// .../customers/me/route.js forwards req.validatedBody into
// updateCustomersWorkflow. The ONLY thing that refuses it is this app's
// rejectCustomerMetadata (src/api/utils/customer-metadata-guard.ts), wired at
// middlewares.ts:405 (/store/customers) and :419 (/store/customers/me). Unwire
// either entry and the matching case below goes red — that is what this file is
// for.
//
// It started as a cosmetic guard: metadata holds server-validated keys
// (avatar_url, equipped_frame_level, handle) written only by dedicated routes,
// and a client-supplied blob bought a locked frame or an arbitrary avatar URL.
// Plan 088 put saved payout bank accounts in the SAME blob and made that list
// the enforcement point for where a withdrawal goes, so the guard is now a
// money control: without it a stolen bearer token plants a bank_accounts entry
// with a backdated `savedAt` (clearing the cooling-off window) and withdraws
// to it.
//
// Both cases assert the guard's EXACT message, not just the 400. Status alone
// is satisfied by any rejection — stock validation, or the phone guards sharing
// these two matchers — so a message-less assertion would stay green while the
// thing it names was gone.
medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('customer metadata guard', () => {
      let storeHeaders: Record<string, string>;

      beforeEach(async () => {
        const apiKeyModule = getContainer().resolve(Modules.API_KEY);
        const key = await apiKeyModule.createApiKeys({
          title: 'metadata-guard-test',
          type: 'publishable',
          created_by: 'metadata-guard-test',
        });
        storeHeaders = { 'x-publishable-api-key': key.token };
      });

      const registerCustomer = async (email: string): Promise<string> => {
        const reg = await api.post('/auth/customer/emailpass/register', {
          email,
          password: PASSWORD,
        });
        await postStoreCustomer(
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
        return login.data.token as string;
      };

      it('rejects a body containing metadata, allows one without', async () => {
        const token = await registerCustomer('metadata-guard@test.dev');
        const headers = { ...storeHeaders, authorization: `Bearer ${token}` };

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const rejected = await api
          .post(
            '/store/customers/me',
            { metadata: { equipped_frame_level: 100 } },
            { headers },
          )
          .catch((e: any) => e.response);
        expect(rejected.status).toBe(400);
        expect(rejected.data.message).toBe(
          'metadata is not updatable on this route.',
        );

        const ok = await unwrapResponse(
          api.post('/store/customers/me', { first_name: 'Ash' }, { headers }),
        );
        expect(ok.data.customer.first_name).toBe('Ash');
        expect(ok.data.customer.metadata ?? {}).not.toHaveProperty(
          'equipped_frame_level',
        );
      });

      it('rejects create with metadata, allows create without', async () => {
        // Register only (do NOT complete /store/customers yet) so the same
        // auth identity is still uncustomered for both create attempts below.
        const email = 'metadata-guard-create@test.dev';
        const reg = await api.post('/auth/customer/emailpass/register', {
          email,
          password: PASSWORD,
        });
        const headers = {
          ...storeHeaders,
          authorization: `Bearer ${reg.data.token}`,
        };

        // Create WITH reserved metadata → rejected before the create workflow,
        // so no customer record is written and the identity stays uncustomered.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const rejected = await api
          .post(
            '/store/customers',
            { email, metadata: { equipped_frame_level: 100 } },
            { headers },
          )
          .catch((e: any) => e.response);
        expect(rejected.status).toBe(400);
        expect(rejected.data.message).toBe(
          'metadata is not updatable on this route.',
        );

        // Same identity, no metadata → the legitimate register-completion flow
        // still succeeds (the guard doesn't break account creation).
        const ok = await unwrapResponse(
          postStoreCustomer(api, getContainer(), { email }, { headers }),
        );
        expect(ok.data.customer.email).toBe(email);
        expect(ok.data.customer.metadata ?? {}).not.toHaveProperty(
          'equipped_frame_level',
        );
      });

      // The read side. Core returns metadata whole to anything that can reach
      // the customer, and it holds full bank numbers and partner passwords.
      it('keeps secret metadata from a role without its own read policy', async () => {
        const container = getContainer();
        const customers = container.resolve(Modules.CUSTOMER);
        const secrets = {
          bank_accounts: [{ accountNumber: '4012340503' }],
          partner_credential: { password: 'partner-secret-pw' },
        };
        const [player] = await customers.createCustomers([
          {
            email: 'guard-secrets@test.dev',
            has_account: true,
            metadata: { handle: 'ace', ...secrets },
          },
        ]);
        const { http } = container.resolve(
          ContainerRegistrationKeys.CONFIG_MODULE,
        ).projectConfig;
        const tokenFor = (name: string, roleId: string) =>
          generateJwtToken(
            {
              actor_id: name,
              actor_type: 'user',
              auth_identity_id: '',
              app_metadata: { user_id: name, roles: [roleId] },
            },
            {
              secret: http.jwtSecret,
              expiresIn: 300,
              jwtOptions: http.jwtOptions,
            },
          );
        // A role with exactly these policies, none of the secret reads.
        const mintRole = async (
          name: string,
          resource: string[],
          operation: string[],
        ) => {
          const rbac = container.resolve(Modules.RBAC) as any;
          const [role] = await rbac.createRbacRoles([{ name }]);
          const policies = await rbac.listRbacPolicies({ resource, operation });
          await rbac.createRbacRolePolicies(
            policies.map((p: { id: string }) => ({
              role_id: role.id,
              policy_id: p.id,
            })),
          );
          return tokenFor(name, role.id);
        };
        const viewer = tokenFor(
          'guard-viewer',
          await supportViewerRoleId(container),
        );
        const staff = await mintSuperAdmin(
          container,
          api,
          'guard-admin@test.dev',
          'guard-admin-password-1',
        );
        const get = (path: string, token: string) =>
          unwrapResponse(
            api.get(path, { headers: { authorization: `Bearer ${token}` } }),
          );
        const detail = `/admin/customers/${player.id}`;
        // The player sits in a group with themselves as a member, and has an
        // order: `?fields=` walks both back to the same blob.
        const [group] = await customers.createCustomerGroups([
          { name: 'guard-secrets-group' },
        ]);
        await customers.addCustomerToGroup({
          customer_id: player.id,
          customer_group_id: group.id,
        });
        const order = await (
          container.resolve(Modules.ORDER) as any
        ).createOrders({
          email: 'guard-secrets@test.dev',
          customer_id: player.id,
          currency_code: 'myr',
          items: [],
        });
        const groupReader = await mintRole(
          'guard-groups',
          ['customer_group', 'customer'],
          ['read'],
        );
        const orderReader = await mintRole('guard-orders', ['order'], ['read']);
        const writer = await mintRole(
          'guard-writer',
          ['customer'],
          ['read', 'update'],
        );
        // Each path must reach the blob, or this would pass on an empty answer.
        const redacted = (res: { status: number; data: unknown }) => {
          expect(res.status).toBe(200);
          const text = JSON.stringify(res.data);
          expect(text).toContain('"handle":"ace"');
          expect(text).not.toContain('4012340503');
          expect(text).not.toContain('partner-secret-pw');
        };

        const reads: [string, string][] = [
          [detail, viewer],
          [`${detail}?fields=metadata`, viewer],
          [`/admin/customers?q=guard-secrets&fields=%2Bmetadata`, viewer],
          [`${detail}?fields=*groups.customers`, viewer],
          [
            `/admin/customer-groups/${group.id}?fields=customers.metadata`,
            groupReader,
          ],
          [`/admin/orders/${order.id}?fields=customer.metadata`, orderReader],
          [`/admin/orders?fields=*customer`, orderReader],
        ];
        for (const [path, token] of reads) {
          redacted(await get(path, token));
        }
        // A write echoes the record.
        redacted(
          await unwrapResponse(
            api.post(
              `${detail}?fields=metadata`,
              {},
              { headers: { authorization: `Bearer ${writer}` } },
            ),
          ),
        );
        // The rest of the blob survives: the player page reads the handle.
        expect((await get(detail, viewer)).data.customer.metadata).toEqual({
          handle: 'ace',
        });
        // Staff holding the policies see exactly what they always did.
        expect((await get(detail, staff)).data.customer.metadata).toEqual({
          handle: 'ace',
          ...secrets,
        });
        expect(
          (
            await get(
              `/admin/orders/${order.id}?fields=customer.metadata`,
              staff,
            )
          ).data.order.customer.metadata,
        ).toEqual({ handle: 'ace', ...secrets });
      });
    });
  },
});
