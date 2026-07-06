import { randomBytes } from 'crypto';
import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { Modules } from '@medusajs/framework/utils';
import sharp from 'sharp';
import { unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

const PASSWORD = 'profile-avatar-test-pw-1';

const png = (width: number, height: number): Promise<Buffer> =>
  sharp({
    create: { width, height, channels: 3, background: { r: 20, g: 20, b: 20 } },
  })
    .png()
    .toBuffer();

// A valid PNG bigger than the 5 MB avatar cap (raw noise defeats compression).
const bigPng = (): Promise<Buffer> =>
  sharp(randomBytes(1600 * 1600 * 4), {
    raw: { width: 1600, height: 1600, channels: 4 },
  })
    .png({ compressionLevel: 0 })
    .toBuffer();

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('POST /store/profile/avatar', () => {
      let storeHeaders: Record<string, string>;

      beforeEach(async () => {
        const apiKeyModule = getContainer().resolve(Modules.API_KEY);
        const key = await apiKeyModule.createApiKeys({
          title: 'profile-avatar-test',
          type: 'publishable',
          created_by: 'profile-avatar-test',
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

      const authed = (token: string): Record<string, string> => ({
        ...storeHeaders,
        authorization: `Bearer ${token}`,
      });

      const uploadAvatar = (
        buf: Buffer,
        headers: Record<string, string>,
        type = 'image/png',
        name = 'me.png',
      ) => {
        const form = new FormData();
        form.append('files', new Blob([new Uint8Array(buf)], { type }), name);
        return api.post('/store/profile/avatar', form, { headers });
      };

      it('requires auth', async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const res = await uploadAvatar(await png(128, 128), storeHeaders).catch(
          (e: any) => e.response,
        );
        expect(res.status).toBe(401);
      });

      it('stores the photo and writes metadata.avatar_url (merged)', async () => {
        const token = await registerCustomer('avatar-happy@test.dev');

        // Seed a pre-existing metadata key (lazily assigned handle) so the
        // upload's read-modify-write can be proven to MERGE, not clobber.
        const profile = await unwrapResponse(
          api.get('/store/profiles/me', { headers: authed(token) }),
        );
        const handle = profile.data.handle as string;
        expect(typeof handle).toBe('string');

        const res = await unwrapResponse(
          uploadAvatar(await png(256, 256), authed(token)),
        );
        expect(typeof res.data.avatar_url).toBe('string');
        expect(res.data.avatar_url.length).toBeGreaterThan(0);

        const me = await unwrapResponse(
          api.get('/store/customers/me', { headers: authed(token) }),
        );
        expect(me.data.customer.metadata.avatar_url).toBe(res.data.avatar_url);
        expect(me.data.customer.metadata.handle).toBe(handle);
      });

      it('rejects a disguised non-image and an oversize photo', async () => {
        const token = await registerCustomer('avatar-reject@test.dev');

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const fake = await uploadAvatar(
          Buffer.from('not an image at all'),
          authed(token),
        ).catch((e: any) => e.response);
        expect(fake.status).toBe(400);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const big = await uploadAvatar(await bigPng(), authed(token)).catch(
          (e: any) => e.response,
        );
        expect(big.status).toBe(400);
        expect(String(big.data.message)).toMatch(/5 MB/);
      });
    });
  },
});
