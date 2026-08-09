import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { Modules } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { mintSuperAdmin, postStoreCustomer, unwrapResponse } from './utils';

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
        return login.data.token;
      };

      const openOne = async (token: string, topupKey: string) => {
        await api.post(
          '/store/credits/topup',
          { amount: PACK_PRICE },
          { headers: { ...authed(token), 'idempotency-key': topupKey } },
        );
        return unwrapResponse(
          api.post(
            `/store/packs/${PACK_SLUG}/open`,
            {},
            { headers: authed(token) },
          ),
        );
      };

      // The player tab: ?customer_id= scopes the ledger and drops the GLOBAL
      // rollups (showing site-wide top cards next to one player's pulls would
      // read as that player's). Per-ROW rarity must survive the rollup skip —
      // it is derived from the same odds lookup the skipped window fed.
      it('scopes the ledger to ?customer_id=, empties the rollups, keeps row rarity', async () => {
        const tokenA = await registerCustomer('admin-pulls-a@test.dev');
        const tokenB = await registerCustomer('admin-pulls-b@test.dev');
        expect((await openOne(tokenA, 'admin-pulls-topup-a')).status).toBe(200);
        expect((await openOne(tokenB, 'admin-pulls-topup-b')).status).toBe(200);

        const adminToken = await mintSuperAdmin(
          getContainer(),
          api,
          ADMIN_EMAIL,
          PASSWORD,
        );
        const adminHeaders = { authorization: `Bearer ${adminToken}` };

        const all = await unwrapResponse(
          api.get('/admin/pulls', { headers: adminHeaders }),
        );
        expect(all.data.total).toBe(2);
        // Unscoped keeps its global rollups.
        expect(all.data.topCards.length).toBeGreaterThan(0);
        expect(all.data.topRarities.length).toBeGreaterThan(0);
        const rowA = all.data.pulls.find(
          (p: { customer_email: string | null }) =>
            p.customer_email === 'admin-pulls-a@test.dev',
        );
        expect(rowA).toBeDefined();

        const scoped = await unwrapResponse(
          api.get(`/admin/pulls?customer_id=${rowA.customer_id}`, {
            headers: adminHeaders,
          }),
        );
        expect(scoped.status).toBe(200);
        expect(scoped.data.total).toBe(1);
        expect(
          scoped.data.pulls.map(
            (p: { customer_email: string | null }) => p.customer_email,
          ),
        ).toEqual(['admin-pulls-a@test.dev']);
        // Per-row rarity still resolves from the (pack, card) odds row.
        expect(scoped.data.pulls[0].card.rarity).toBe('Rare');
        expect(scoped.data.topCards).toEqual([]);
        expect(scoped.data.topRarities).toEqual([]);

        // Empty value 400s rather than silently listing every customer.
        const empty = await unwrapResponse(
          api.get('/admin/pulls?customer_id=', { headers: adminHeaders }),
        );
        expect(empty.status).toBe(400);
      });

      // Regression guard for the missing `id` tiebreaker: a batch open
      // (open-batch) stamps every pull in the batch with the same `rolled_at`
      // millisecond (record-pulls-batch.ts calls `new Date()` once per card
      // inside one `.map()`), so ties on the sort key are the norm for this
      // route — not an edge case. Without a unique secondary sort key,
      // Postgres gives no guarantee that OFFSET pagination returns the same
      // tie order across different offsets, so a row can be shown on two
      // pages or on neither.
      it('pages /admin/pulls with limit=1 through a same-`rolled_at` batch without duplicates or gaps', async () => {
        const token = await registerCustomer('admin-pulls-batch@test.dev');
        await api.post(
          '/store/credits/topup',
          { amount: PACK_PRICE * 3 },
          {
            headers: {
              ...authed(token),
              'idempotency-key': 'admin-pulls-batch-topup',
            },
          },
        );
        const open = await unwrapResponse(
          api.post(
            `/store/packs/${PACK_SLUG}/open-batch`,
            { count: 3 },
            { headers: authed(token) },
          ),
        );
        expect(open.status).toBe(200);
        expect(open.data.rolls.length).toBe(3);

        const adminToken = await mintSuperAdmin(
          getContainer(),
          api,
          ADMIN_EMAIL,
          PASSWORD,
        );
        const adminHeaders = { authorization: `Bearer ${adminToken}` };

        const unpaged = await unwrapResponse(
          api.get('/admin/pulls', { headers: adminHeaders }),
        );
        expect(unpaged.status).toBe(200);
        expect(unpaged.data.total).toBe(3);
        const expectedIds = new Set(
          unpaged.data.pulls.map((p: { id: string }) => p.id),
        );
        expect(expectedIds.size).toBe(3);

        // Page through one row at a time. With a stable total order (the `id`
        // tiebreaker), the union of every page is exactly the 3 pull ids —
        // no row repeated, none skipped.
        const seenIds: string[] = [];
        for (let offset = 0; offset < 3; offset++) {
          const page = await unwrapResponse(
            api.get(`/admin/pulls?limit=1&offset=${offset}`, {
              headers: adminHeaders,
            }),
          );
          expect(page.status).toBe(200);
          expect(page.data.pulls.length).toBe(1);
          seenIds.push(page.data.pulls[0].id);
        }
        expect(new Set(seenIds)).toEqual(expectedIds);
        expect(seenIds.length).toBe(new Set(seenIds).size);
      });

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
