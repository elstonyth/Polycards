import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { Modules } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { postStoreCustomer, unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

// B2 — reward_box isolation guard (HTTP layer).
// Verifies that the public pack catalog and open routes treat reward_box packs
// as invisible: the catalog omits them, the slug detail 404s, and the open +
// open-batch endpoints 404. Normal packs are unaffected.

const REWARD_BOX_SLUG = 'vip-c-reward-box';
const NORMAL_PACK_SLUG = 'b2-normal-pack';
const CARD_HANDLE = 'b2-test-card';
const PASSWORD = 'b2-test-password-1';

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('reward_box isolation (B2)', () => {
      let storeHeaders: Record<string, string>;
      let customerToken: string;

      beforeEach(async () => {
        const container = getContainer();

        const apiKeyModule = container.resolve(Modules.API_KEY);
        const key = await apiKeyModule.createApiKeys({
          title: 'b2-isolation-test',
          type: 'publishable',
          created_by: 'b2-isolation-test',
        });
        storeHeaders = { 'x-publishable-api-key': key.token };

        const packs = container.resolve<PacksModuleService>(PACKS_MODULE);

        // Seed a reward_box pack (internal, must be invisible publicly).
        await packs.createPacks([
          {
            slug: REWARD_BOX_SLUG,
            title: 'VIP C Reward Box',
            category: 'reward_box',
            price: 0,
            image: '/cdn/reward-box.webp',
            pool_enabled: true,
            draws_per_day: 3,
          } as Parameters<typeof packs.createPacks>[0][number],
        ]);

        // Seed a normal pack (should stay visible and openable).
        await packs.createPacks([
          {
            slug: NORMAL_PACK_SLUG,
            title: 'B2 Normal Pack',
            category: 'pokemon',
            price: 0,
            image: '/cdn/normal-pack.webp',
          },
        ]);
        await packs.createCards([
          {
            handle: CARD_HANDLE,
            name: 'B2 Test Card PSA 9',
            set: 'Test Set',
            grader: 'PSA',
            grade: '9',
            market_value: 10,
            image: '/cdn/b2-card.webp',
          },
        ]);
        await packs.createPackOdds([
          {
            pack_id: NORMAL_PACK_SLUG,
            card_id: CARD_HANDLE,
            weight: 100,
            locked: false,
            rarity: 'Common' as const,
          },
        ]);

        // Register + login a customer for authenticated open attempts.
        const email = 'b2-customer@test.dev';
        const reg = await api.post('/auth/customer/emailpass/register', {
          email,
          password: PASSWORD,
        });
        await postStoreCustomer(
          api,
          getContainer(),
          { email },
          { headers: { ...storeHeaders, authorization: `Bearer ${reg.data.token}` } },
        );
        const login = await api.post('/auth/customer/emailpass', { email, password: PASSWORD });
        customerToken = login.data.token;
      });

      const authed = (): Record<string, string> => ({
        ...storeHeaders,
        authorization: `Bearer ${customerToken}`,
      });

      it('GET /store/packs omits the reward_box pack and includes the normal pack', async () => {
        const res = await unwrapResponse(api.get('/store/packs', { headers: storeHeaders }));
        expect(res.status).toBe(200);

        const slugs = (res.data.packs as { slug: string }[]).map((p) => p.slug);
        expect(slugs).not.toContain(REWARD_BOX_SLUG);
        expect(slugs).toContain(NORMAL_PACK_SLUG);
      });

      it('GET /store/packs/:slug 404s for the reward_box pack', async () => {
        const res = await unwrapResponse(
          api.get(`/store/packs/${REWARD_BOX_SLUG}`, { headers: storeHeaders }),
        );
        expect(res.status).toBe(404);
      });

      it('GET /store/packs/:slug 200s for the normal pack', async () => {
        const res = await unwrapResponse(
          api.get(`/store/packs/${NORMAL_PACK_SLUG}`, { headers: storeHeaders }),
        );
        expect(res.status).toBe(200);
        expect(res.data.pack.slug).toBe(NORMAL_PACK_SLUG);
      });

      it('POST /store/packs/:slug/open 404s for the reward_box pack', async () => {
        const res = await unwrapResponse(
          api.post(`/store/packs/${REWARD_BOX_SLUG}/open`, {}, { headers: authed() }),
        );
        expect(res.status).toBe(404);
      });

      it('POST /store/packs/:slug/open-batch 404s for the reward_box pack', async () => {
        const res = await unwrapResponse(
          api.post(
            `/store/packs/${REWARD_BOX_SLUG}/open-batch`,
            { count: 1 },
            { headers: authed() },
          ),
        );
        expect(res.status).toBe(404);
      });
    });
  },
});
