import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { Modules } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { clearRecentPullsCache } from '../../src/api/store/pulls/recent/route';
import { unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

// GET /store/pulls/recent grew a tier filter (?rarity) and the `drought`
// counters ("N packs without Immortal") for the pull-history panel. Rarity is
// PER-PACK (pack_odds), so both are joins — guarded here end to end rather
// than through the ORM filter shape:
//  - ?rarity keeps only pulls whose (pack, card) odds row carries that tier,
//  - drought counts the pulls SINCE the last hit of a tier (every pull on
//    record for a tier that has never hit),
//  - the cache key carries the tier, so a filtered window never serves the
//    unfiltered feed (or vice versa).
const PACK = 'recent-rarity-pack';
const COMMON = 'recent-rarity-common';
const IMMORTAL = 'recent-rarity-immortal';

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('store recent pulls — tier filter + drought counters', () => {
      let storeHeaders: Record<string, string>;

      beforeEach(async () => {
        const container = getContainer();
        clearRecentPullsCache();

        const apiKeyModule = container.resolve(Modules.API_KEY);
        const key = await apiKeyModule.createApiKeys({
          title: 'recent-rarity-test',
          type: 'publishable',
          created_by: 'recent-rarity-test',
        });
        storeHeaders = { 'x-publishable-api-key': key.token };

        const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
        await packs.createPacks([
          {
            slug: PACK,
            title: 'Recent Rarity Pack',
            category: 'pokemon',
            price: 10,
            image: '/cdn/test-pack.webp',
          },
        ]);
        await packs.createCards([
          {
            handle: COMMON,
            name: 'Common Card',
            set: 'Base',
            grader: 'PSA',
            grade: '10',
            market_value: 5,
            image: 'common.png',
          },
          {
            handle: IMMORTAL,
            name: 'Immortal Card',
            set: 'Base',
            grader: 'PSA',
            grade: '10',
            market_value: 500,
            image: 'immortal.png',
          },
        ]);
        await packs.createPackOdds([
          { pack_id: PACK, card_id: COMMON, rarity: 'Common', weight: 99 },
          { pack_id: PACK, card_id: IMMORTAL, rarity: 'Immortal', weight: 1 },
        ]);
        // Oldest first: the Immortal hit, then two Common pulls after it.
        const t0 = Date.now() - 30_000;
        await packs.createPulls([
          {
            customer_id: 'cus_recent_rarity',
            pack_id: PACK,
            card_id: IMMORTAL,
            order_id: null,
            rolled_at: new Date(t0),
            source: 'pack',
          },
          {
            customer_id: 'cus_recent_rarity',
            pack_id: PACK,
            card_id: COMMON,
            order_id: null,
            rolled_at: new Date(t0 + 10_000),
            source: 'pack',
          },
          {
            customer_id: 'cus_recent_rarity',
            pack_id: PACK,
            card_id: COMMON,
            order_id: null,
            rolled_at: new Date(t0 + 20_000),
            source: 'pack',
          },
        ]);
      });

      // One test on purpose: the calls must land inside the same 5s cache
      // window for the cache-key assertion to mean anything (and the runner's
      // per-test DB reset would otherwise wipe the seed between them).
      it('filters by ?rarity, counts the drought per tier, and keys the cache on the tier', async () => {
        const all = await unwrapResponse(
          api.get(`/store/pulls/recent?pack_id=${PACK}`, {
            headers: storeHeaders,
          }),
        );
        expect(all.status).toBe(200);
        expect(all.data.pulls.map((p: { handle: string }) => p.handle)).toEqual(
          [COMMON, COMMON, IMMORTAL],
        );
        // Two packs opened since the Immortal; Legendary has never hit, so
        // every pull on record counts.
        expect(all.data.drought).toEqual({ Immortal: 2, Legendary: 3 });
        // The new public display fields ride every row (no customer record
        // here → anonymous, seed-derived).
        const row = all.data.pulls[0];
        expect(typeof row.id).toBe('string');
        expect(typeof row.seed).toBe('number');
        expect(row).toMatchObject({
          profile_handle: null,
          avatar_url: null,
          frame_url: null,
        });

        // Immediately after the unfiltered call — a tier-blind cache key would
        // replay all three rows here.
        const immortal = await unwrapResponse(
          api.get(`/store/pulls/recent?pack_id=${PACK}&rarity=Immortal`, {
            headers: storeHeaders,
          }),
        );
        expect(immortal.status).toBe(200);
        expect(
          immortal.data.pulls.map((p: { handle: string }) => p.handle),
        ).toEqual([IMMORTAL]);
        // The counters describe the pack, not the tab.
        expect(immortal.data.drought).toEqual({ Immortal: 2, Legendary: 3 });

        // A tier with no pulls is an honest empty feed, not an error.
        const legendary = await unwrapResponse(
          api.get(`/store/pulls/recent?pack_id=${PACK}&rarity=Legendary`, {
            headers: storeHeaders,
          }),
        );
        expect(legendary.status).toBe(200);
        expect(legendary.data.pulls).toEqual([]);

        // Garbage tier = the unfiltered feed (the proxy gates the value; a
        // hand-typed URL must not 400 a public route).
        const garbage = await unwrapResponse(
          api.get(`/store/pulls/recent?pack_id=${PACK}&rarity=Shiny`, {
            headers: storeHeaders,
          }),
        );
        expect(garbage.status).toBe(200);
        expect(garbage.data.pulls).toHaveLength(3);

        // The global feed (no pack) filters and counts the same way.
        const globalImmortal = await unwrapResponse(
          api.get('/store/pulls/recent?rarity=Immortal', {
            headers: storeHeaders,
          }),
        );
        expect(globalImmortal.status).toBe(200);
        expect(
          globalImmortal.data.pulls.map((p: { handle: string }) => p.handle),
        ).toEqual([IMMORTAL]);
        expect(globalImmortal.data.drought.Immortal).toBe(2);

        // A draft pack's ledger is not public: it answers the empty feed (no
        // counters either) — and so does a slug that does not exist — BEFORE
        // any ledger query, so a garbage-slug loop costs one pack lookup each.
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        await packs.createPacks([
          {
            slug: `${PACK}-draft`,
            title: 'Draft Pack',
            category: 'pokemon',
            price: 10,
            image: '/cdn/draft.webp',
            status: 'draft',
          } as Parameters<typeof packs.createPacks>[0][number],
        ]);
        await packs.createPackOdds([
          {
            pack_id: `${PACK}-draft`,
            card_id: COMMON,
            rarity: 'Common',
            weight: 1,
          },
        ]);
        await packs.createPulls([
          {
            customer_id: 'cus_recent_rarity',
            pack_id: `${PACK}-draft`,
            card_id: COMMON,
            order_id: null,
            rolled_at: new Date(),
            source: 'pack',
          },
        ]);
        for (const slug of [`${PACK}-draft`, 'no-such-pack']) {
          const r = await unwrapResponse(
            api.get(`/store/pulls/recent?pack_id=${slug}`, {
              headers: storeHeaders,
            }),
          );
          expect(r.status).toBe(200);
          expect(r.data).toEqual({ pulls: [], drought: {} });
        }

        // An administratively disabled player is DROPPED from the feed (not
        // anonymised — the boards' rule), before the response is cached; the
        // drought counters still count their pulls, which did happen.
        await packs.setAccountDisabled({
          customerId: 'cus_recent_rarity',
          adminId: 'user_recent_admin',
          disabled: true,
          reason: 'test disable',
        });
        clearRecentPullsCache();
        const hidden = await unwrapResponse(
          api.get(`/store/pulls/recent?pack_id=${PACK}`, {
            headers: storeHeaders,
          }),
        );
        expect(hidden.status).toBe(200);
        expect(hidden.data.pulls).toEqual([]);
        expect(hidden.data.drought).toEqual({ Immortal: 2, Legendary: 3 });
      });
    });
  },
});
