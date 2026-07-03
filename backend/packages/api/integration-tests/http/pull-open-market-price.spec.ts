import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { Modules } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { mintSuperAdmin, unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

const PASSWORD = 'op-mp-test-password-1';
const ADMIN_EMAIL = 'admin-open-market-price@test.dev';
const PACK_SLUG = 'op-mp-pack';
const CARD_HANDLE = 'op-mp-card';
// FMV 100 x manual FX 4.0 x multiplier 1.2 = 480 — same golden vector as
// vault-market-price.spec.ts, so both surfaces agree on the exact number.
const FMV = 100;
const MULTIPLIER = 1.2;
const MANUAL_RATE = 4.0;
const EXPECTED_MARKET_PRICE_MYR = 480;
const PACK_PRICE = 10;

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('store pack open / open-batch — computed MYR market price', () => {
      let storeHeaders: Record<string, string>;

      beforeEach(async () => {
        const container = getContainer();

        const apiKeyModule = container.resolve(Modules.API_KEY);
        const key = await apiKeyModule.createApiKeys({
          title: 'open-market-price-test',
          type: 'publishable',
          created_by: 'open-market-price-test',
        });
        storeHeaders = { 'x-publishable-api-key': key.token };

        // Single-card pool so every roll is deterministic (mirrors
        // vault-market-price.spec.ts / vault-buyback.spec.ts).
        const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
        await packs.createPacks([
          {
            slug: PACK_SLUG,
            title: 'Open MP Test Pack',
            category: 'pokemon',
            price: PACK_PRICE,
            image: '/cdn/test-pack.webp',
            buyback_percent: 96,
          },
        ]);
        await packs.createCards([
          {
            handle: CARD_HANDLE,
            name: 'Open MP Test Card PSA 10',
            set: 'Test Set',
            grader: 'PSA',
            grade: '10',
            market_value: FMV,
            market_multiplier: MULTIPLIER,
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

      const pinFxRate = async (): Promise<void> => {
        const adminToken = await mintSuperAdmin(getContainer(), api, ADMIN_EMAIL, PASSWORD);
        const fxPost = await unwrapResponse(
          api.post(
            '/admin/pricing/fx',
            { manual_override: true, manual_rate: MANUAL_RATE },
            { headers: { authorization: `Bearer ${adminToken}` } },
          ),
        );
        expect(fxPost.status).toBe(200);
        expect(fxPost.data.effective).toBe(MANUAL_RATE);
      };

      it('open response card exposes marketPriceMyr = raw x fx x multiplier', async () => {
        await pinFxRate();

        const token = await registerCustomer('op-mp-customer@test.dev');
        await api.post(
          '/store/credits/topup',
          { amount: PACK_PRICE },
          { headers: authed(token) },
        );

        const open = await unwrapResponse(
          api.post(`/store/packs/${PACK_SLUG}/open`, {}, { headers: authed(token) }),
        );
        expect(open.status).toBe(200);
        expect(open.data.card.handle).toBe(CARD_HANDLE);
        // market_value stays RAW USD — untouched by the FX/multiplier math.
        expect(open.data.card.market_value).toBe(FMV);
        expect(open.data.card.marketPriceMyr).toBe(EXPECTED_MARKET_PRICE_MYR);
        // Buyback is a cut of the MYR Value (NOT raw USD): 96% x 480 = 460.80,
        // flat 90% x 480 = 432. Regression guard for the FX-less buyback bug
        // that quoted/credited 96% x 100 = 96 as if it were ringgit.
        expect(open.data.buyback.percent).toBe(96);
        expect(open.data.buyback.amount).toBe(460.8);
        expect(open.data.buyback.vault_percent).toBe(90);
        expect(open.data.buyback.vault_amount).toBe(432);
      });

      it('open-batch response enriches every roll with marketPriceMyr', async () => {
        await pinFxRate();

        const token = await registerCustomer('op-mp-batch-customer@test.dev');
        await api.post(
          '/store/credits/topup',
          { amount: PACK_PRICE * 3 },
          { headers: authed(token) },
        );

        const batch = await unwrapResponse(
          api.post(
            `/store/packs/${PACK_SLUG}/open-batch`,
            { count: 3 },
            { headers: authed(token) },
          ),
        );
        expect(batch.status).toBe(200);
        expect(batch.data.rolls).toHaveLength(3);
        for (const roll of batch.data.rolls) {
          expect(roll.card.handle).toBe(CARD_HANDLE);
          expect(roll.card.market_value).toBe(FMV);
          expect(roll.card.marketPriceMyr).toBe(EXPECTED_MARKET_PRICE_MYR);
          // Buyback quoted off the MYR Value, same as the single-open route.
          expect(roll.buyback.amount).toBe(460.8);
          expect(roll.buyback.vault_amount).toBe(432);
        }
      });
    });
  },
});
