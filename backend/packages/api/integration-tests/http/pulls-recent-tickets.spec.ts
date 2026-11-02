import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { Modules } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { clearPullGapsCache } from '../../src/api/store/pulls/gaps/route';
import { clearRecentPullsCache } from '../../src/api/store/pulls/recent/route';
import { unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

// A ticket pack writes a ticket_spin per spin and no pull, so a feed reading
// `pull` showed nothing for it, and "0 capsules without Immortal" besides. Its
// own feed and stats chart read the spins; the global feed stays cards only.
const CAPSULE = 'tickets-feed-capsule';
const SECOND_CAPSULE = 'tickets-feed-capsule-2';
const DRAFT = 'tickets-feed-draft';
const CARD_PACK = 'tickets-feed-cards';
const CARD = 'tickets-feed-card';

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('store pull history — a ticket pack', () => {
      let storeHeaders: Record<string, string>;
      const get = (path: string) =>
        unwrapResponse(api.get(path, { headers: storeHeaders }));

      beforeEach(async () => {
        const container = getContainer();
        clearRecentPullsCache();
        clearPullGapsCache();

        const apiKeyModule = container.resolve(Modules.API_KEY);
        const key = await apiKeyModule.createApiKeys({
          title: 'tickets-feed-test',
          type: 'publishable',
          created_by: 'tickets-feed-test',
        });
        storeHeaders = { 'x-publishable-api-key': key.token };

        const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
        await packs.createPacks([
          {
            slug: CAPSULE,
            title: 'Feed Capsule',
            category: 'poly',
            price: 10,
            image: '/cdn/capsule.webp',
            prize_type: 'tickets',
            published_odds: { tiers: { Immortal: 25 } },
          },
          {
            slug: SECOND_CAPSULE,
            title: 'Second Capsule',
            category: 'poly',
            price: 20,
            image: '/cdn/capsule-2.webp',
            prize_type: 'tickets',
          },
          {
            slug: DRAFT,
            title: 'Draft Capsule',
            category: 'poly',
            price: 10,
            image: '/cdn/draft.webp',
            prize_type: 'tickets',
            status: 'draft',
          },
          {
            slug: CARD_PACK,
            title: 'Feed Cards',
            category: 'pokemon',
            price: 10,
            image: '/cdn/cards.webp',
          },
        ]);
        await packs.createTicketPrizes(
          [
            { tickets: 4, rarity: 'Common' as const },
            { tickets: 75, rarity: 'Legendary' as const },
            { tickets: 300, rarity: 'Immortal' as const },
          ].flatMap((p) => [
            { ...p, pack_id: CAPSULE, weight: 1 },
            { ...p, pack_id: DRAFT, weight: 1 },
          ]),
        );
        // The same amounts on another tier: each capsule's table is scaled by
        // its price, so 75 is Legendary on one and Common on the next.
        await packs.createTicketPrizes(
          [
            { tickets: 75, rarity: 'Common' as const },
            { tickets: 600, rarity: 'Immortal' as const },
          ].map((p) => ({ ...p, pack_id: SECOND_CAPSULE, weight: 1 })),
        );

        // Oldest first, one a minute: 4, 300, 4, 75, 4, then what must not show
        // as a row: a gift, and a disabled player's spin (which still counts
        // towards the drought, as a disabled player's pull does).
        const start = Date.now() - 60 * 60_000;
        const spin = (
          i: number,
          tickets: number,
          over: Partial<{ customer_id: string; source: 'bonus' | 'gift' }> = {},
        ) => ({
          customer_id: 'cus_tickets_feed',
          pack_id: CAPSULE,
          tickets,
          source: 'pack' as const,
          open_id: `open_${i}`,
          rolled_at: new Date(start + i * 60_000),
          ...over,
        });
        await packs.createTicketSpins([
          spin(0, 4),
          spin(1, 300),
          spin(2, 4, { source: 'bonus' }),
          spin(3, 75),
          spin(4, 4),
          spin(5, 300, { source: 'gift' }),
          spin(6, 4, { customer_id: 'cus_tickets_disabled' }),
          { ...spin(7, 300), pack_id: DRAFT },
          // Between the first capsule's spins 4 and 6, then its newest.
          { ...spin(5, 75), open_id: 'open_second_0', pack_id: SECOND_CAPSULE },
          { ...spin(8, 75), open_id: 'open_second_1', pack_id: SECOND_CAPSULE },
        ]);
        await packs.createCustomerAccountStates([
          { customer_id: 'cus_tickets_disabled', disabled: true },
        ]);

        await packs.createCards([
          {
            handle: CARD,
            name: 'Feed Card',
            set: 'Base',
            grader: 'PSA',
            grade: '10',
            market_value: 20,
            image: 'card.png',
          },
        ]);
        await packs.createPackOdds([
          { pack_id: CARD_PACK, card_id: CARD, rarity: 'Common', weight: 1 },
        ]);
        await packs.createPulls([
          {
            customer_id: 'cus_tickets_feed',
            pack_id: CARD_PACK,
            card_id: CARD,
            order_id: null,
            rolled_at: new Date(),
            source: 'pack',
          },
        ]);
      });

      it('lists the spins, newest first, each with its amount and tier', async () => {
        const { status, data } = await get(
          `/store/pulls/recent?pack_id=${CAPSULE}`,
        );
        expect(status).toBe(200);
        expect(
          data.pulls.map((p: { tickets: number; rarity: string }) => [
            p.tickets,
            p.rarity,
          ]),
        ).toEqual([
          [4, 'Common'],
          [75, 'Legendary'],
          [4, 'Common'],
          [300, 'Immortal'],
          [4, 'Common'],
        ]);
        expect(data.pulls[0]).toMatchObject({
          pack_id: CAPSULE,
          pack_title: 'Feed Capsule',
          who: 'Anonymous',
        });
        expect(typeof data.pulls[0].id).toBe('string');
        // A public row names no account.
        expect(data.pulls[0]).not.toHaveProperty('customer_id');
      });

      it('counts the capsules since each chase tier last hit', async () => {
        const { data } = await get(`/store/pulls/recent?pack_id=${CAPSULE}`);
        // After the 300: 4, 75, 4 and the disabled player's 4.
        expect(data.drought).toEqual({ Immortal: 4, Legendary: 2 });
      });

      it('filters by tier off the pack table', async () => {
        const { data } = await get(
          `/store/pulls/recent?pack_id=${CAPSULE}&rarity=Immortal`,
        );
        expect(data.pulls.map((p: { tickets: number }) => p.tickets)).toEqual([
          300,
        ]);
      });

      it('an amount since removed from the table reads Common', async () => {
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        const [gone] = await packs.listTicketPrizes({
          pack_id: CAPSULE,
          tickets: 75,
        });
        await packs.softDeleteTicketPrizes([gone!.id]);

        const { data } = await get(`/store/pulls/recent?pack_id=${CAPSULE}`);
        expect(data.pulls[1]).toMatchObject({ tickets: 75, rarity: 'Common' });
      });

      it('the global feed stays cards only', async () => {
        const { data } = await get('/store/pulls/recent');
        expect(data.pulls.map((p: { handle: string }) => p.handle)).toEqual([
          CARD,
        ]);
      });

      it('a Draft ledger is not public', async () => {
        const { data } = await get(`/store/pulls/recent?pack_id=${DRAFT}`);
        expect(data).toEqual({ pulls: [], drought: {} });
      });

      it('the stats chart reads the spins, with the published rate', async () => {
        const { status, data } = await get(
          `/store/pulls/gaps?rarity=Immortal&pack_id=${CAPSULE}`,
        );
        expect(status).toBe(200);
        expect(data).toMatchObject({
          pct: 25,
          expected: 4,
          avg: 2,
          last20: 2,
          current: 4,
        });
        expect(data.hits.map((h: { gap: number }) => h.gap)).toEqual([2]);
      });

      it('a card pack still reads its pulls', async () => {
        const { data } = await get(`/store/pulls/recent?pack_id=${CARD_PACK}`);
        expect(data.pulls.map((p: { handle: string }) => p.handle)).toEqual([
          CARD,
        ]);
      });

      describe('?category — the home Poly tab', () => {
        it('merges its live capsules newest first, each row on its own table', async () => {
          const { status, data } = await get(
            '/store/pulls/recent?category=poly',
          );
          expect(status).toBe(200);
          expect(
            data.pulls.map(
              (p: { tickets: number; rarity: string; pack_id: string }) => [
                p.pack_id,
                p.tickets,
                p.rarity,
              ],
            ),
          ).toEqual([
            [SECOND_CAPSULE, 75, 'Common'],
            [SECOND_CAPSULE, 75, 'Common'],
            [CAPSULE, 4, 'Common'],
            [CAPSULE, 75, 'Legendary'],
            [CAPSULE, 4, 'Common'],
            [CAPSULE, 300, 'Immortal'],
            [CAPSULE, 4, 'Common'],
          ]);
          expect(data.pulls[0]).toMatchObject({
            pack_title: 'Second Capsule',
            pack_image: '/cdn/capsule-2.webp',
          });
          expect(data.pulls[3]).toMatchObject({
            pack_title: 'Feed Capsule',
            pack_image: '/cdn/capsule.webp',
          });
        });

        it('counts the drought across the capsules', async () => {
          const { data } = await get('/store/pulls/recent?category=poly');
          // After the 300: 4, 75, 4, the second capsule's two 75s (Common on
          // its table) and the disabled player's 4.
          expect(data.drought).toEqual({ Immortal: 6, Legendary: 4 });
        });

        it('filters by tier off each capsule’s own table', async () => {
          const { data } = await get(
            '/store/pulls/recent?category=poly&rarity=Legendary',
          );
          expect(
            data.pulls.map((p: { pack_id: string; tickets: number }) => [
              p.pack_id,
              p.tickets,
            ]),
          ).toEqual([[CAPSULE, 75]]);
        });

        it('a key with no feed of its own reads as the global feed', async () => {
          for (const category of ['pokemon', 'no-such-category']) {
            const { data } = await get(
              `/store/pulls/recent?category=${category}`,
            );
            expect(
              data.pulls.map((p: { handle: string }) => p.handle),
            ).toEqual([CARD]);
          }
        });

        it('with no live capsule, both reads answer empty', async () => {
          const packs =
            getContainer().resolve<PacksModuleService>(PACKS_MODULE);
          await packs.updatePacks({
            selector: { slug: [CAPSULE, SECOND_CAPSULE] },
            data: { status: 'draft' },
          });

          const feed = await get('/store/pulls/recent?category=poly');
          expect(feed.data).toEqual({ pulls: [], drought: {} });
          const gaps = await get(
            '/store/pulls/gaps?rarity=Immortal&category=poly',
          );
          expect(gaps.data).toMatchObject({ current: 0, hits: [] });
        });

        it('pack_id wins over category', async () => {
          const { data } = await get(
            `/store/pulls/recent?category=poly&pack_id=${SECOND_CAPSULE}`,
          );
          expect(
            new Set(data.pulls.map((p: { pack_id: string }) => p.pack_id)),
          ).toEqual(new Set([SECOND_CAPSULE]));
        });

        it('leaves the global feed under its own cache key', async () => {
          await get('/store/pulls/recent?category=poly');
          const { data } = await get('/store/pulls/recent');
          expect(data.pulls.map((p: { handle: string }) => p.handle)).toEqual([
            CARD,
          ]);
        });

        it('the stats chart reads the same spins, with no one published rate', async () => {
          const { status, data } = await get(
            '/store/pulls/gaps?rarity=Immortal&category=poly',
          );
          expect(status).toBe(200);
          expect(data).toMatchObject({
            pct: null,
            expected: null,
            avg: 2,
            current: 6,
          });
          expect(data.hits.map((h: { gap: number }) => h.gap)).toEqual([2]);
        });
      });
    });
  },
});
