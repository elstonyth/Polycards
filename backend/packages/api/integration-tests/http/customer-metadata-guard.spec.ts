import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { Modules } from '@medusajs/framework/utils';
import { unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

const PASSWORD = 'metadata-guard-test-password-1';

// Medusa's stock POST /store/customers/me accepts arbitrary `metadata`. This
// app reserves customer metadata for server-validated keys (avatar_url,
// equipped_frame_level, handle) written only by dedicated routes — a
// client-supplied metadata object would bypass frame-unlock validation.
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
        await api.post(
          '/store/customers',
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

        // Same identity, no metadata → the legitimate register-completion flow
        // still succeeds (the guard doesn't break account creation).
        const ok = await unwrapResponse(
          api.post('/store/customers', { email }, { headers }),
        );
        expect(ok.data.customer.email).toBe(email);
        expect(ok.data.customer.metadata ?? {}).not.toHaveProperty(
          'equipped_frame_level',
        );
      });
    });
  },
});
