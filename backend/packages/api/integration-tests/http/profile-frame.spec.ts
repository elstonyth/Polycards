import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { Modules } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

const PASSWORD = 'profile-frame-test-pw-1';

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('POST /store/profile/frame', () => {
      let storeHeaders: Record<string, string>;

      const packs = () =>
        getContainer().resolve<PacksModuleService>(PACKS_MODULE);

      beforeEach(async () => {
        const apiKeyModule = getContainer().resolve(Modules.API_KEY);
        const key = await apiKeyModule.createApiKeys({
          title: 'profile-frame-test',
          type: 'publishable',
          created_by: 'profile-frame-test',
        });
        storeHeaders = { 'x-publishable-api-key': key.token };
        // Catalog for the equip checks: frames exist for LV 20 and LV 40.
        await packs().editAvatarFrames({
          frames: { '20': '/static/frame-20.webp', '40': '/static/frame-40.webp' },
          adminId: 'test-admin',
          reason: 'seed frames for test',
        });
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

      const customerIdOf = async (token: string): Promise<string> => {
        const me = await unwrapResponse(
          api.get('/store/customers/me', { headers: authed(token) }),
        );
        return me.data.customer.id as string;
      };

      const setFrame = (level: number | null, headers: Record<string, string>) =>
        api.post('/store/profile/frame', { level }, { headers });

      it('enforces milestone + unlock + catalog rules, merges metadata', async () => {
        const token = await registerCustomer('frame-rules@test.dev');
        const customerId = await customerIdOf(token);

        // Not a milestone.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const notMilestone = await setFrame(15, authed(token)).catch(
          (e: any) => e.response,
        );
        expect(notMilestone.status).toBe(400);

        // Locked (fresh customer floor is LV 1).
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const locked = await setFrame(20, authed(token)).catch(
          (e: any) => e.response,
        );
        expect(locked.status).toBe(400);

        // Unlock LV 20-49 and pre-set an avatar_url to prove the merge.
        await packs().createVipMemberStates([
          { customer_id: customerId, highest_level_ever: 40, current_level: 40 },
        ]);
        const customers = getContainer().resolve(Modules.CUSTOMER);
        await customers.updateCustomers(customerId, {
          metadata: { avatar_url: '/static/me.png' },
        });

        // Unlocked + in catalog → equips.
        const equipped = await unwrapResponse(setFrame(20, authed(token)));
        expect(equipped.data.equipped_frame_level).toBe(20);

        // Unlocked but NOT in catalog (LV 30 has no image) → 400.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const noImage = await setFrame(30, authed(token)).catch(
          (e: any) => e.response,
        );
        expect(noImage.status).toBe(400);

        // Metadata merged: avatar_url survived the equip.
        const me = await unwrapResponse(
          api.get('/store/customers/me', { headers: authed(token) }),
        );
        expect(me.data.customer.metadata.equipped_frame_level).toBe(20);
        expect(me.data.customer.metadata.avatar_url).toBe('/static/me.png');

        // Unequip.
        const cleared = await unwrapResponse(setFrame(null, authed(token)));
        expect(cleared.data.equipped_frame_level).toBeNull();
      });
    });
  },
});
