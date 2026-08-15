import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { Modules } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { clearRecentPullsCache } from '../../src/api/store/pulls/recent/route';
import { unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

// GET /store/pulls/recent used to be global-only, so every pack page rendered
// the SAME history. `?pack_id=<Pack.slug>` scopes it. Two traps guarded here:
//  - the filter itself (Pull.pack_id IS the slug), and
//  - the 5s per-process response cache, which was keyed by a single literal:
//    unkeyed, the first pack requested in a window is served to every other
//    pack — the original bug, back as an intermittent one.
const PACK_A = 'recent-filter-pack-a';
const PACK_B = 'recent-filter-pack-b';
const CARD_A = 'recent-filter-card-a';
const CARD_B = 'recent-filter-card-b';

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('store recent pulls — per-pack filter', () => {
      let storeHeaders: Record<string, string>;

      beforeEach(async () => {
        const container = getContainer();
        clearRecentPullsCache();

        const apiKeyModule = container.resolve(Modules.API_KEY);
        const key = await apiKeyModule.createApiKeys({
          title: 'recent-filter-test',
          type: 'publishable',
          created_by: 'recent-filter-test',
        });
        storeHeaders = { 'x-publishable-api-key': key.token };

        const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
        await packs.createPacks([
          {
            slug: PACK_A,
            title: 'Recent Filter Pack A',
            category: 'pokemon',
            price: 10,
            image: '/cdn/test-pack-a.webp',
          },
          {
            slug: PACK_B,
            title: 'Recent Filter Pack B',
            category: 'pokemon',
            price: 10,
            image: '/cdn/test-pack-b.webp',
          },
        ]);
        await packs.createCards([
          {
            handle: CARD_A,
            name: 'Card A',
            set: 'Base',
            grader: 'PSA',
            grade: '10',
            market_value: 20,
            image: 'card-a.png',
          },
          {
            handle: CARD_B,
            name: 'Card B',
            set: 'Base',
            grader: 'PSA',
            grade: '10',
            market_value: 30,
            image: 'card-b.png',
          },
        ]);
        await packs.createPackOdds([
          { pack_id: PACK_A, card_id: CARD_A, rarity: 'Common', weight: 1 },
          { pack_id: PACK_B, card_id: CARD_B, rarity: 'Common', weight: 1 },
        ]);
        await packs.createPulls([
          {
            customer_id: 'cus_recent_filter',
            pack_id: PACK_A,
            card_id: CARD_A,
            order_id: null,
            rolled_at: new Date(),
            source: 'pack',
          },
          {
            customer_id: 'cus_recent_filter',
            pack_id: PACK_B,
            card_id: CARD_B,
            order_id: null,
            rolled_at: new Date(),
            source: 'pack',
          },
        ]);
      });

      // One test on purpose: the A-then-B calls must land inside the same 5s
      // cache window for the cache-key assertion to mean anything (and the
      // runner's per-test DB reset would otherwise wipe the seed between them).
      it('scopes the feed to ?pack_id, and one pack never serves another from cache', async () => {
        const a = await unwrapResponse(
          api.get(`/store/pulls/recent?pack_id=${PACK_A}`, {
            headers: storeHeaders,
          }),
        );
        expect(a.status).toBe(200);
        expect(a.data.pulls.map((p: { handle: string }) => p.handle)).toEqual([
          CARD_A,
        ]);

        // Immediately after A — a single-keyed cache would replay A's rows here.
        const b = await unwrapResponse(
          api.get(`/store/pulls/recent?pack_id=${PACK_B}`, {
            headers: storeHeaders,
          }),
        );
        expect(b.status).toBe(200);
        expect(b.data.pulls.map((p: { handle: string }) => p.handle)).toEqual([
          CARD_B,
        ]);

        // No param = the global feed (the home page) — still both packs. Also
        // proves a pack-keyed cache entry is never served for the global key.
        const all = await unwrapResponse(
          api.get('/store/pulls/recent', { headers: storeHeaders }),
        );
        expect(all.status).toBe(200);
        const handles = all.data.pulls.map((p: { handle: string }) => p.handle);
        expect(handles).toContain(CARD_A);
        expect(handles).toContain(CARD_B);

        // An unknown slug is an empty feed, not a 500 and not the global one.
        const unknown = await unwrapResponse(
          api.get('/store/pulls/recent?pack_id=no-such-pack', {
            headers: storeHeaders,
          }),
        );
        expect(unknown.status).toBe(200);
        expect(unknown.data.pulls).toEqual([]);

        // Operator injection: qs parses `pack_id[$ne]=…` into an OBJECT, and an
        // object in a listPulls filter is a query operator, not a value. The
        // typeof-string guard degrades it to the global feed — without the
        // guard this returns pack B only, which is what makes this assertion
        // discriminating rather than decorative.
        const injected = await unwrapResponse(
          api.get(`/store/pulls/recent?pack_id[$ne]=${PACK_A}`, {
            headers: storeHeaders,
          }),
        );
        expect(injected.status).toBe(200);
        const injectedHandles = injected.data.pulls.map(
          (p: { handle: string }) => p.handle,
        );
        expect(injectedHandles).toContain(CARD_A);
        expect(injectedHandles).toContain(CARD_B);
      });

      // b88a6027 hid administratively disabled players from the leaderboard,
      // challenge and public profile; this feed was the fourth public surface
      // and was missed. Same helper, same verdict as the boards: DROP the row.
      it('drops an administratively disabled player from the feed', async () => {
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        // A second, LATER pull on pack A from a player who is then disabled.
        // Later on purpose: it heads the DESC window, so a missing filter shows
        // up as an extra row rather than as something the limit hid.
        await packs.createPulls([
          {
            customer_id: 'cus_recent_disabled',
            pack_id: PACK_A,
            card_id: CARD_A,
            order_id: null,
            rolled_at: new Date(Date.now() + 1000),
            source: 'pack',
          },
        ]);
        await packs.createCustomerAccountStates([
          { customer_id: 'cus_recent_disabled', disabled: true },
        ]);

        // Pack A has two pulls; only the enabled player's survives.
        const scoped = await unwrapResponse(
          api.get(`/store/pulls/recent?pack_id=${PACK_A}`, {
            headers: storeHeaders,
          }),
        );
        expect(scoped.status).toBe(200);
        expect(scoped.data.pulls).toHaveLength(1);

        // Same on the global feed — three pulls seeded, two publishable.
        const all = await unwrapResponse(
          api.get('/store/pulls/recent', { headers: storeHeaders }),
        );
        expect(all.status).toBe(200);
        expect(all.data.pulls).toHaveLength(2);
      });
    });
  },
});
