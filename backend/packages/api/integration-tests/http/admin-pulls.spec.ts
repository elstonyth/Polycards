import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { Modules } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { mintSuperAdmin, unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

const PASSWORD = 'admin-pulls-test-password-1';
const ADMIN_EMAIL = 'admin-pulls@test.dev';
const PACK_SLUG = 'admin-pulls-pack';
const PACK_TITLE = 'Admin Pulls Test Pack';
const CARD_HANDLE = 'admin-pulls-card';
const PACK_PRICE = 10;

// Regression guard for the admin pull ledger join key: Pull.pack_id holds the
// pack SLUG (not the pack id), so GET /admin/pulls must filter/lookup packs by
// slug. Filtering by id (the shipped bug) matched no rows and every ledger
// row's pack_title came back null. This asserts the title is populated.
medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('GET /admin/pulls — pack_title joins by slug', () => {
      let storeHeaders: Record<string, string>;

      beforeEach(async () => {
        const container = getContainer();

        const apiKeyModule = container.resolve(Modules.API_KEY);
        const key = await apiKeyModule.createApiKeys({
          title: 'admin-pulls-test',
          type: 'publishable',
          created_by: 'admin-pulls-test',
        });
        storeHeaders = { 'x-publishable-api-key': key.token };

        // Single-card pool so the roll is deterministic.
        const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
        await packs.createPacks([
          {
            slug: PACK_SLUG,
            title: PACK_TITLE,
            category: 'pokemon',
            price: PACK_PRICE,
            image: '/cdn/test-pack.webp',
            buyback_percent: 96,
          },
        ]);
        await packs.createCards([
          {
            handle: CARD_HANDLE,
            name: 'Admin Pulls Test Card PSA 10',
            set: 'Test Set',
            grader: 'PSA',
            grade: '10',
            market_value: 100,
            image: '/cdn/test-card.webp',
          },
        ]);
        await packs.createPackOdds([
          {
            pack_id: PACK_SLUG,
            card_id: CARD_HANDLE,
            weight: 100,
            locked: false,
            rarity: 'Rare' as const,
          },
        ]);
      });

      const authed = (token: string): Record<string, string> => ({
        ...storeHeaders,
        authorization: `Bearer ${token}`,
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
        return login.data.token;
      };

      it('ledger row for an opened pack carries the pack title (not null)', async () => {
        const token = await registerCustomer('admin-pulls-customer@test.dev');
        await api.post(
          '/store/credits/topup',
          { amount: PACK_PRICE },
          { headers: { ...authed(token), 'idempotency-key': 'admin-pulls-topup' } },
        );

        const open = await unwrapResponse(
          api.post(`/store/packs/${PACK_SLUG}/open`, {}, { headers: authed(token) }),
        );
        expect(open.status).toBe(200);
        expect(open.data.card.handle).toBe(CARD_HANDLE);

        const adminToken = await mintSuperAdmin(
          getContainer(),
          api,
          ADMIN_EMAIL,
          PASSWORD,
        );
        const ledger = await unwrapResponse(
          api.get('/admin/pulls', {
            headers: { authorization: `Bearer ${adminToken}` },
          }),
        );
        expect(ledger.status).toBe(200);

        const row = ledger.data.pulls.find(
          (p: { pack_id: string }) => p.pack_id === PACK_SLUG,
        );
        expect(row).toBeDefined();
        // The bug: filtering listPacks by id (not slug) left this null.
        expect(row.pack_title).toBe(PACK_TITLE);
      });
    });
  },
});
