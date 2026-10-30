import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { Modules } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { postStoreCustomer, unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

const PASSWORD = 'ph-test-password-1';

// One-card pool (the roll always wins it). FMV $50 × multiplier 1.2 × FX 4.0
// = RM 240 — the draw-time value every pull here records.
const PACK_SLUG = 'ph-pack';
const PACK_TITLE = 'PH Test Pack';
const CARD_HANDLE = 'ph-card';
const CARD_NAME = 'PH Test Card PSA 10';
const PACK_PRICE = 10;
const VALUE_MYR = 240;

// The customer's pull history (GET /store/pulls/history) and the card names
// on their ledger rows (GET /store/credits), against the real open, batch-open
// and buyback routes: what each card cost, what it sold for, and that nobody
// else's pulls leak in.
medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('pull history', () => {
      let storeHeaders: Record<string, string>;

      beforeEach(async () => {
        const container = getContainer();
        const key = await container.resolve(Modules.API_KEY).createApiKeys({
          title: 'pull-history-test',
          type: 'publishable',
          created_by: 'pull-history-test',
        });
        storeHeaders = { 'x-publishable-api-key': key.token };

        const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
        await packs.createPacks([
          {
            slug: PACK_SLUG,
            title: PACK_TITLE,
            category: 'pokemon',
            price: PACK_PRICE,
            image: '/cdn/test-pack.webp',
            buyback_percent: 90,
          },
        ]);
        await packs.createCards([
          {
            handle: CARD_HANDLE,
            name: CARD_NAME,
            set: 'Test Set',
            grader: 'PSA',
            grade: '10',
            market_value: 50,
            market_multiplier: 1.2,
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
        await packs.createFxRates([
          {
            pair: 'USD_MYR',
            rate: 4,
            source: 'test',
            manual_override: true,
            manual_rate: 4,
          },
        ]);
      });

      const authed = (token: string): Record<string, string> => ({
        ...storeHeaders,
        authorization: `Bearer ${token}`,
      });

      const customer = async (email: string): Promise<string> => {
        const reg = await api.post('/auth/customer/emailpass/register', {
          email,
          password: PASSWORD,
        });
        await postStoreCustomer(
          api,
          getContainer(),
          { email },
          { headers: authed(reg.data.token) },
        );
        const login = await api.post('/auth/customer/emailpass', {
          email,
          password: PASSWORD,
        });
        const token = login.data.token as string;
        await api.post(
          '/store/credits/topup',
          { amount: 100 },
          { headers: { ...authed(token), 'idempotency-key': `ph-${email}` } },
        );
        return token;
      };

      const history = (token: string, query = '') =>
        unwrapResponse(
          api.get(`/store/pulls/history${query}`, { headers: authed(token) }),
        );

      it('refuses a caller with no token', async () => {
        const res = await history('');
        expect(res.status).toBe(401);
      });

      it('lists every pull with its price and sale; pages; never shows another customer', async () => {
        const tokenA = await customer('ph-a@test.dev');
        const tokenB = await customer('ph-b@test.dev');

        const single = await unwrapResponse(
          api.post(
            `/store/packs/${PACK_SLUG}/open`,
            {},
            { headers: authed(tokenA) },
          ),
        );
        expect(single.status).toBe(200);
        const soldId = single.data.pull.id as string;
        const sale = await unwrapResponse(
          api.post(
            `/store/vault/${soldId}/buyback`,
            {},
            { headers: authed(tokenA) },
          ),
        );
        expect(sale.status).toBe(200);

        const batch = await unwrapResponse(
          api.post(
            `/store/packs/${PACK_SLUG}/open-batch`,
            { count: 3 },
            { headers: authed(tokenA) },
          ),
        );
        expect(batch.status).toBe(200);
        await unwrapResponse(
          api.post(
            `/store/packs/${PACK_SLUG}/open`,
            {},
            { headers: authed(tokenB) },
          ),
        );

        const all = await history(tokenA);
        expect(all.status).toBe(200);
        expect(all.data.has_more).toBe(false);
        const items = all.data.items as Array<Record<string, unknown>>;
        // Customer B's pull is not here; the batch (newest) comes first.
        expect(items).toHaveLength(4);
        expect(items[3].pull_id).toBe(soldId);
        for (const item of items) {
          expect(item).toMatchObject({
            pack_title: PACK_TITLE,
            // The batch's one RM 30 charge split over its three cards.
            paid: PACK_PRICE,
            value: VALUE_MYR,
            card: { handle: CARD_HANDLE, name: CARD_NAME, rarity: 'Rare' },
          });
        }
        expect(items.slice(0, 3).map((i) => i.status)).toEqual([
          'vaulted',
          'vaulted',
          'vaulted',
        ]);
        expect(items[3]).toMatchObject({
          status: 'bought_back',
          sold_for: sale.data.amount,
        });
        expect(items[3].sold_at).toEqual(expect.any(String));

        const first = await history(tokenA, '?limit=2');
        const second = await history(tokenA, '?limit=2&offset=2');
        expect(first.data.has_more).toBe(true);
        expect(second.data.has_more).toBe(false);
        expect(
          [...first.data.items, ...second.data.items].map(
            (i: { pull_id: string }) => i.pull_id,
          ),
        ).toEqual(items.map((i) => i.pull_id));
      });

      it('names the cards on pack-open and sell-back ledger rows', async () => {
        const token = await customer('ph-ledger@test.dev');
        const single = await unwrapResponse(
          api.post(
            `/store/packs/${PACK_SLUG}/open`,
            {},
            { headers: authed(token) },
          ),
        );
        await unwrapResponse(
          api.post(
            `/store/vault/${single.data.pull.id}/buyback`,
            {},
            { headers: authed(token) },
          ),
        );
        await unwrapResponse(
          api.post(
            `/store/packs/${PACK_SLUG}/open-batch`,
            { count: 2 },
            { headers: authed(token) },
          ),
        );

        const credits = await unwrapResponse(
          api.get('/store/credits', { headers: authed(token) }),
        );
        expect(credits.status).toBe(200);
        const rows = credits.data.transactions as Array<{
          reason: string;
          amount: number;
          pack_title: string | null;
          card_names: string[];
        }>;
        const named = (reason: string, amount?: number) =>
          rows
            .filter(
              (r) =>
                r.reason === reason && (amount == null || r.amount === amount),
            )
            .map((r) => [r.pack_title, r.card_names]);
        expect(named('pack_open', -PACK_PRICE)).toEqual([
          [PACK_TITLE, [CARD_NAME]],
        ]);
        expect(named('pack_open', -2 * PACK_PRICE)).toEqual([
          [PACK_TITLE, [CARD_NAME, CARD_NAME]],
        ]);
        expect(named('buyback')).toEqual([[PACK_TITLE, [CARD_NAME]]]);
        expect(named('topup')).toEqual([[null, []]]);
      });
    });
  },
});
