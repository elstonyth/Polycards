import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { Modules } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { mintSuperAdmin, unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

const PASSWORD = 'mp-test-password-1';
const ADMIN_EMAIL = 'admin-market-price@test.dev';
const PACK_SLUG = 'mp-pack';
const CARD_HANDLE = 'mp-card';
// FMV 100 x manual FX 4.0 x multiplier 1.2 = 480 (the brief's golden vector).
const FMV = 100;
const MULTIPLIER = 1.2;
const MANUAL_RATE = 4.0;
const EXPECTED_MARKET_PRICE_MYR = 480;
const PACK_PRICE = 10;

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('store vault + admin cards — computed MYR market price', () => {
      let storeHeaders: Record<string, string>;

      beforeEach(async () => {
        const container = getContainer();

        const apiKeyModule = container.resolve(Modules.API_KEY);
        const key = await apiKeyModule.createApiKeys({
          title: 'vault-market-price-test',
          type: 'publishable',
          created_by: 'vault-market-price-test',
        });
        storeHeaders = { 'x-publishable-api-key': key.token };

        // Gacha fixtures: an active pack with a single-card pool so the pull is
        // deterministic (mirrors vault-buyback.spec.ts).
        const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
        await packs.createPacks([
          {
            slug: PACK_SLUG,
            title: 'MP Test Pack',
            category: 'pokemon',
            price: PACK_PRICE,
            image: '/cdn/test-pack.webp',
            buyback_percent: 96,
          },
        ]);
        await packs.createCards([
          {
            handle: CARD_HANDLE,
            name: 'MP Test Card PSA 10',
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

      it('vault item exposes marketPriceMyr = raw x fx x multiplier', async () => {
        // Pin the FX rate so the golden vector is deterministic (no live feed).
        const adminToken = await mintSuperAdmin(
          getContainer(),
          api,
          ADMIN_EMAIL,
          PASSWORD,
        );
        const fxPost = await unwrapResponse(
          api.post(
            '/admin/pricing/fx',
            {
              manual_override: true,
              manual_rate: MANUAL_RATE,
              reason: 'test: pin FX',
            },
            { headers: { authorization: `Bearer ${adminToken}` } },
          ),
        );
        expect(fxPost.status).toBe(200);
        expect(fxPost.data.effective).toBe(MANUAL_RATE);

        // Seed a vaulted pull via the real open endpoint (single-card pool
        // guarantees the winner — same technique as vault-buyback.spec.ts).
        const token = await registerCustomer('mp-customer@test.dev');
        await api.post(
          '/store/credits/topup',
          { amount: PACK_PRICE },
          { headers: authed(token) },
        );
        const open = await unwrapResponse(
          api.post(
            `/store/packs/${PACK_SLUG}/open`,
            {},
            { headers: authed(token) },
          ),
        );
        expect(open.status).toBe(200);

        const vault = await unwrapResponse(
          api.get('/store/vault', { headers: authed(token) }),
        );
        expect(vault.status).toBe(200);
        expect(vault.data.items).toHaveLength(1);
        const item = vault.data.items[0];
        expect(item.card.handle).toBe(CARD_HANDLE);
        // market_value stays RAW USD — untouched by the FX/multiplier math.
        expect(item.card.market_value).toBe(FMV);
        expect(item.card.marketPriceMyr).toBe(EXPECTED_MARKET_PRICE_MYR);
      });

      it('admin card read exposes the raw/fx/markup price breakdown', async () => {
        const adminToken = await mintSuperAdmin(
          getContainer(),
          api,
          ADMIN_EMAIL,
          PASSWORD,
        );
        const adminHeaders = {
          headers: { authorization: `Bearer ${adminToken}` },
        };
        await unwrapResponse(
          api.post(
            '/admin/pricing/fx',
            {
              manual_override: true,
              manual_rate: MANUAL_RATE,
              reason: 'test: pin FX',
            },
            adminHeaders,
          ),
        );

        const list = await unwrapResponse(
          api.get('/admin/cards', adminHeaders),
        );
        expect(list.status).toBe(200);
        const listed = list.data.cards.find(
          (c: { handle: string }) => c.handle === CARD_HANDLE,
        );
        expect(listed.priceBreakdown).toMatchObject({
          raw: FMV,
          fxRate: MANUAL_RATE,
          marketMyr: FMV * MANUAL_RATE,
          displayPrice: EXPECTED_MARKET_PRICE_MYR,
          markup:
            Math.round((EXPECTED_MARKET_PRICE_MYR - FMV * MANUAL_RATE) * 100) /
            100,
        });

        const detail = await unwrapResponse(
          api.get(`/admin/cards/${CARD_HANDLE}`, adminHeaders),
        );
        expect(detail.status).toBe(200);
        expect(detail.data.card.priceBreakdown).toMatchObject({
          raw: FMV,
          fxRate: MANUAL_RATE,
          marketMyr: FMV * MANUAL_RATE,
          displayPrice: EXPECTED_MARKET_PRICE_MYR,
        });
      });
    });
  },
});
