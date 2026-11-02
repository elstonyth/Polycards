import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { Modules } from '@medusajs/framework/utils';
import { postStoreCustomer, unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

const PASSWORD = 'profile-preset-test-pw-1';

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('POST /store/profile/avatar/preset', () => {
      let storeHeaders: Record<string, string>;

      beforeEach(async () => {
        const apiKeyModule = getContainer().resolve(Modules.API_KEY);
        const key = await apiKeyModule.createApiKeys({
          title: 'profile-preset-test',
          type: 'publishable',
          created_by: 'profile-preset-test',
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

      const authed = (token: string): Record<string, string> => ({
        ...storeHeaders,
        authorization: `Bearer ${token}`,
      });

      it('needs a logged-in customer', async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const res = await api
          .post('/store/profile/avatar/preset', { id: 1 }, { headers: storeHeaders })
          .catch((e: any) => e.response);
        expect(res.status).toBe(401);
      });

      it('takes a catalog id only, never a URL', async () => {
        const token = await registerCustomer('preset-bad@test.dev');
        for (const id of [0, 81, 1.5, '12', 'https://evil.example/x.webp']) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const res = await api
            .post('/store/profile/avatar/preset', { id }, { headers: authed(token) })
            .catch((e: any) => e.response);
          expect(res.status).toBe(400);
        }
        const me = await unwrapResponse(
          api.get('/store/customers/me', { headers: authed(token) }),
        );
        expect(me.data.customer.metadata?.avatar_url ?? null).toBeNull();
      });

      it('replaces a photo, keeps other keys, and shows on the public profile', async () => {
        const token = await registerCustomer('preset-ok@test.dev');
        const before = await unwrapResponse(
          api.get('/store/customers/me', { headers: authed(token) }),
        );
        await getContainer()
          .resolve(Modules.CUSTOMER)
          .updateCustomers(before.data.customer.id, {
            metadata: {
              avatar_url: '/static/me.png',
              equipped_frame_level: 20,
            },
          });

        const picked = await unwrapResponse(
          api.post(
            '/store/profile/avatar/preset',
            { id: 12 },
            { headers: authed(token) },
          ),
        );
        expect(picked.data.avatar_url).toBe('/images/avatars/avatar-12.webp');

        const me = await unwrapResponse(
          api.get('/store/customers/me', { headers: authed(token) }),
        );
        expect(me.data.customer.metadata.avatar_url).toBe(
          '/images/avatars/avatar-12.webp',
        );
        expect(me.data.customer.metadata.avatar_file_id).toBeNull();
        expect(me.data.customer.metadata.equipped_frame_level).toBe(20);

        const own = await unwrapResponse(
          api.get('/store/profiles/me', { headers: authed(token) }),
        );
        const pub = await unwrapResponse(
          api.get(`/store/profiles/${own.data.handle}`, {
            headers: storeHeaders,
          }),
        );
        expect(pub.data.avatar_url).toBe('/images/avatars/avatar-12.webp');
      });
    });
  },
});
