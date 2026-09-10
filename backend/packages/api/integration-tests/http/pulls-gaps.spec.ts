import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { Modules } from '@medusajs/framework/utils';
import type Redis from 'ioredis';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { clearPullGapsCache } from '../../src/api/store/pulls/gaps/route';
import { clearRecentPullsCache } from '../../src/api/store/pulls/recent/route';
import { STORE_READ_DEFAULTS } from '../../src/api/utils/rate-limit';
import {
  connectTestRedisOrFail,
  TEST_REDIS_URL,
  unwrapResponse,
} from './utils';

jest.setTimeout(240 * 1000);

// The route is public, so the limiter keys on the request IP — every call in
// this harness shares one. These restore the PRODUCTION store-read numbers
// over the effectively-unlimited ones in .env.test (which exist so the other
// suites' reads never trip it). Deliberately the shipped values, not tighter
// ones: the runner never restores env, so this leaks into later suites in the
// shard (see auth-rate-limit.spec.ts) and a leak of production behaviour is
// the only harmless kind. The burst rule is what's under test; the sustained
// one is left as .env.test has it.
const RATE_ENV = {
  STORE_READ_RATE_BURST_LIMIT: String(STORE_READ_DEFAULTS.burstLimit),
  STORE_READ_RATE_BURST_WINDOW_MS: String(STORE_READ_DEFAULTS.burstWindowMs),
  // The app's limiter must write to the SAME redis beforeEach clears below, or
  // it silently fails over to its in-memory store and a previous suite's
  // store-read events stay on the budget. See auth-rate-limit.spec.ts.
  REDIS_URL: TEST_REDIS_URL,
};

// GET /store/pulls/gaps — the stats chart behind the pull-history panel. The
// gap arithmetic is a window function over the scope's whole ledger, so it is
// pinned end to end: numbered in roll order, each hit's gap counts from the
// previous hit (the first from the ledger's start), `current` is the pulls
// since the newest hit, and the header rate comes from the pack's PUBLISHED
// odds (null on the global feed).
const PACK = 'gaps-pack';
const COMMON = 'gaps-common';
const IMMORTAL = 'gaps-immortal';

medusaIntegrationTestRunner({
  inApp: true,
  env: RATE_ENV,
  testSuite: ({ api, getContainer }) => {
    describe('store pull gaps — hit history for the stats chart', () => {
      let storeHeaders: Record<string, string>;
      let redis: Redis;

      beforeAll(async () => {
        redis = await connectTestRedisOrFail(
          'the gaps suite must observe the real rl:store-read:* budget',
        );
      });

      afterAll(() => {
        redis?.disconnect();
        // The runner never restores env, so the next suite in the shard would
        // otherwise boot its app on THIS budget. Dropping the two keys puts it
        // back on whatever the test env sets (or, failing that, the same
        // production defaults) — never on something tighter.
        delete process.env.STORE_READ_RATE_BURST_LIMIT;
        delete process.env.STORE_READ_RATE_BURST_WINDOW_MS;
      });

      beforeEach(async () => {
        const container = getContainer();
        clearPullGapsCache();
        // Events another suite (or the previous case) left inside the burst
        // window would shift this one's budget.
        const spent = await redis.keys('rl:store-read:*');
        if (spent.length) await redis.del(...spent);

        const apiKeyModule = container.resolve(Modules.API_KEY);
        const key = await apiKeyModule.createApiKeys({
          title: 'gaps-test',
          type: 'publishable',
          created_by: 'gaps-test',
        });
        storeHeaders = { 'x-publishable-api-key': key.token };

        const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
        await packs.createPacks([
          {
            slug: PACK,
            title: 'Gaps Pack',
            category: 'pokemon',
            price: 10,
            image: '/cdn/gaps-pack.webp',
            published_odds: { tiers: { Immortal: 1.1, Common: 98.9 } },
          } as Parameters<typeof packs.createPacks>[0][number],
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
        // Roll order: C C I C C C I C  → hits at #3 (gap 3) and #7 (gap 4),
        // then one pull since → current 1.
        const order = [
          COMMON,
          COMMON,
          IMMORTAL,
          COMMON,
          COMMON,
          COMMON,
          IMMORTAL,
          COMMON,
        ];
        const t0 = Date.now() - 60_000;
        await packs.createPulls(
          order.map((card, i) => ({
            customer_id: 'cus_gaps',
            pack_id: PACK,
            card_id: card,
            order_id: null,
            rolled_at: new Date(t0 + i * 1_000),
            source: 'pack' as const,
          })),
        );
      });

      it('numbers the ledger, gaps each hit from the previous one, and reads the published rate', async () => {
        const r = await unwrapResponse(
          api.get(`/store/pulls/gaps?pack_id=${PACK}&rarity=Immortal`, {
            headers: storeHeaders,
          }),
        );
        expect(r.status).toBe(200);
        expect(r.data.rarity).toBe('Immortal');
        // Newest hit first.
        expect(r.data.hits.map((h: { gap: number }) => h.gap)).toEqual([4, 3]);
        expect(r.data.current).toBe(1);
        expect(r.data.avg).toBeCloseTo(3.5);
        expect(r.data.last20).toBeCloseTo(3.5);
        // 1.1% published → one hit every 91 draws.
        expect(r.data.pct).toBeCloseTo(1.1);
        expect(r.data.expected).toBe(91);
        // Display fields ride each hit (no customer record → anonymous, seeded).
        expect(r.data.hits[0]).toMatchObject({
          who: 'Anonymous',
          profile_handle: null,
          avatar_url: null,
          frame_url: null,
        });
        expect(typeof r.data.hits[0].seed).toBe('number');

        // A tier with no hits: no gaps, the whole ledger is the drought.
        const legendary = await unwrapResponse(
          api.get(`/store/pulls/gaps?pack_id=${PACK}&rarity=Legendary`, {
            headers: storeHeaders,
          }),
        );
        expect(legendary.status).toBe(200);
        expect(legendary.data.hits).toEqual([]);
        expect(legendary.data.current).toBe(8);
        expect(legendary.data.avg).toBeNull();
        expect(legendary.data.pct).toBeNull();
        expect(legendary.data.expected).toBeNull();

        // Global scope: same gaps, but no pack means no published rate.
        const globalImmortal = await unwrapResponse(
          api.get('/store/pulls/gaps?rarity=Immortal', {
            headers: storeHeaders,
          }),
        );
        expect(globalImmortal.status).toBe(200);
        expect(
          globalImmortal.data.hits.map((h: { gap: number }) => h.gap),
        ).toEqual([4, 3]);
        expect(globalImmortal.data.pct).toBeNull();
        expect(globalImmortal.data.expected).toBeNull();

        // A draft / unknown pack answers the empty chart before any ledger
        // scan — and never leaks its published rate.
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        await packs.createPacks([
          {
            slug: `${PACK}-draft`,
            title: 'Draft Gaps Pack',
            category: 'pokemon',
            price: 10,
            image: '/cdn/draft.webp',
            status: 'draft',
            published_odds: { tiers: { Immortal: 5 } },
          } as Parameters<typeof packs.createPacks>[0][number],
        ]);
        for (const slug of [`${PACK}-draft`, 'no-such-pack']) {
          const r = await unwrapResponse(
            api.get(`/store/pulls/gaps?pack_id=${slug}&rarity=Immortal`, {
              headers: storeHeaders,
            }),
          );
          expect(r.status).toBe(200);
          expect(r.data).toEqual({
            rarity: 'Immortal',
            pct: null,
            expected: null,
            avg: null,
            last20: null,
            current: 0,
            hits: [],
          });
        }

        // A batch open stamps its cards with ONE rolled_at. The chart's drought
        // bar and the feed's drought counter must still agree on "pulls since
        // the last hit" — both count in (rolled_at, id) order.
        const tBatch = new Date();
        await packs.createPulls(
          [IMMORTAL, COMMON, COMMON].map((card) => ({
            customer_id: 'cus_gaps',
            pack_id: PACK,
            card_id: card,
            order_id: null,
            rolled_at: tBatch,
            source: 'pack' as const,
          })),
        );
        clearPullGapsCache();
        clearRecentPullsCache();
        const [afterBatch, feed] = await Promise.all([
          unwrapResponse(
            api.get(`/store/pulls/gaps?pack_id=${PACK}&rarity=Immortal`, {
              headers: storeHeaders,
            }),
          ),
          unwrapResponse(
            api.get(`/store/pulls/recent?pack_id=${PACK}`, {
              headers: storeHeaders,
            }),
          ),
        ]);
        expect(afterBatch.data.hits).toHaveLength(3);
        expect(afterBatch.data.current).toBe(feed.data.drought.Immortal);
        // Whatever the id order inside the batch, the three new rows land as
        // one hit plus its trailing drought: gap + current = 3 + the one pull
        // (#8) that followed the previous hit.
        expect(afterBatch.data.hits[0].gap + afterBatch.data.current).toBe(4);

        // A disabled player's hits STAY (dropping one would corrupt the
        // neighbouring gaps) but are anonymised — no name, face or handle.
        await packs.setAccountDisabled({
          customerId: 'cus_gaps',
          adminId: 'user_gaps_admin',
          disabled: true,
          reason: 'test disable',
        });
        clearPullGapsCache();
        const anon = await unwrapResponse(
          api.get(`/store/pulls/gaps?pack_id=${PACK}&rarity=Immortal`, {
            headers: storeHeaders,
          }),
        );
        expect(anon.data.hits).toHaveLength(3);
        for (const hit of anon.data.hits) {
          expect(hit).toMatchObject({
            who: 'Anonymous',
            seed: null,
            profile_handle: null,
            avatar_url: null,
            frame_url: null,
          });
        }
      });

      // The scalars ride the hit rows now (one scan), so a tier with NO hits
      // is the one path that still needs the scalar-only statement. Its
      // drought must stay the scope's whole pull count — CONTEXT.md §Drought,
      // "a tier never hit counts every pull on record".
      it('a tier that has never hit falls back to the scalar-only scan', async () => {
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        const seeded = await packs.listPulls(
          { pack_id: PACK, source: 'pack' },
          { take: 1000 },
        );
        // Guards the assertion below from passing on an empty ledger.
        expect(seeded.length).toBeGreaterThan(0);

        const r = await unwrapResponse(
          api.get(`/store/pulls/gaps?pack_id=${PACK}&rarity=Mythical`, {
            headers: storeHeaders,
          }),
        );
        expect(r.status).toBe(200);
        expect(r.data.hits).toEqual([]);
        expect(r.data.current).toBe(seeded.length);
        expect(r.data.avg).toBeNull();
        expect(r.data.last20).toBeNull();
      });

      // Last in the file: it spends the whole burst budget, and the sliding
      // window drains on wall-clock time.
      it('429s past the store read burst budget', async () => {
        // One warm request populates the route's 5s cache, so the burst below
        // is a limiter test and not 120 concurrent ledger scans.
        const warm = await unwrapResponse(
          api.get(`/store/pulls/gaps?pack_id=${PACK}&rarity=Immortal`, {
            headers: storeHeaders,
          }),
        );
        expect(warm.status).toBe(200);

        // In parallel, not sequentially: 121 round trips one after another can
        // outlast the burst window on a loaded box and never trip.
        const rest = await Promise.all(
          Array.from({ length: STORE_READ_DEFAULTS.burstLimit }, () =>
            unwrapResponse(
              api.get(`/store/pulls/gaps?pack_id=${PACK}&rarity=Immortal`, {
                headers: storeHeaders,
              }),
            ),
          ),
        );

        // burstLimit + 1 events against a burstLimit budget: the overflow is
        // denied, and nothing above the budget was ever served.
        const denied = rest.filter((res) => res.status === 429);
        expect(denied.length).toBeGreaterThanOrEqual(1);
        expect(
          rest.filter((res) => res.status === 200).length,
        ).toBeLessThanOrEqual(STORE_READ_DEFAULTS.burstLimit);
        expect(denied[0].data).toMatchObject({ type: 'rate_limit_exceeded' });
        expect(Number(denied[0].headers['retry-after'])).toBeGreaterThanOrEqual(
          1,
        );
      });
    });
  },
});
