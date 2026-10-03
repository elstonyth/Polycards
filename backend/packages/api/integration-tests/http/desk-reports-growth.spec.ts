import sharp from 'sharp';
import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils';
import type { ICustomerModuleService } from '@medusajs/framework/types';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { clearChallengeCache } from '../../src/api/store/challenge/route';
import { topChaseCards } from '../../src/api/reports/growth/brand-poster/route';
import { assetOrigin } from '../../src/api/utils/image-fetch';
import { myrDisplay as MYR, unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

// Growth desk reports (spec 2026-09-29-desk-reports-design.md, Phase B):
// /reports/growth/* over directly seeded rows. Each report is locked to the
// code that already computes the same figure for the site or the dashboard.
const GROWTH_KEY = 'g'.repeat(48);
const FINANCE_KEY = 'f'.repeat(48);
process.env.REPORT_KEY_GROWTH = GROWTH_KEY;
process.env.REPORT_KEY_FINANCE = FINANCE_KEY;
// The specs make more report requests than one real desk would.
process.env.DESK_REPORTS_RATE_BURST_LIMIT = '1000';
process.env.DESK_REPORTS_RATE_LIMIT = '6000';

const DAY_MS = 24 * 60 * 60 * 1000;
const GP_PACK = 'gp-pack';
const GP_OTHER = 'gp-other';
const GX = 'gp-x'; // mv 50 USD
const GY = 'gp-y'; // mv 30 USD

type Pg = {
  raw: (
    sql: string,
    bindings?: unknown[],
  ) => Promise<{ rowCount: number; rows: unknown[] }>;
};

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    const packs = () =>
      getContainer().resolve<PacksModuleService>(PACKS_MODULE);
    const customers = () =>
      getContainer().resolve<ICustomerModuleService>(Modules.CUSTOMER);
    const pg = () =>
      getContainer().resolve(
        ContainerRegistrationKeys.PG_CONNECTION,
      ) as unknown as Pg;
    const report = (path: string, key: string | null = GROWTH_KEY) =>
      unwrapResponse(
        api.get(`/reports/growth/${path}`, {
          headers: key ? { 'x-report-key': key } : {},
        }),
      );

    describe('the growth key', () => {
      it('opens growth reports and nothing else opens them', async () => {
        expect((await report('challenge')).status).toBe(200);
        expect((await report('challenge', FINANCE_KEY)).status).toBe(401);
        expect((await report('challenge', null)).status).toBe(401);
      });
    });

    describe('GET /reports/growth/challenge', () => {
      let storeHeaders: Record<string, string>;
      let cxId: string;
      let cyId: string;

      beforeEach(async () => {
        clearChallengeCache();
        const key = await getContainer()
          .resolve(Modules.API_KEY)
          .createApiKeys({
            title: 'growth-challenge-test',
            type: 'publishable',
            created_by: 'growth-challenge-test',
          });
        storeHeaders = { 'x-publishable-api-key': key.token };
        await packs().createPacks([
          {
            slug: GP_PACK,
            title: 'GP Pack',
            category: 'pokemon',
            price: 20,
            image: '/x.webp',
          },
        ]);
        await packs().createCards([
          {
            handle: GX,
            name: 'X Card',
            set: 'S',
            grader: 'PSA',
            grade: '10',
            market_value: 50,
            image: '/x.webp',
          },
          {
            handle: GY,
            name: 'Y Card',
            set: 'S',
            grader: 'PSA',
            grade: '10',
            market_value: 30,
            image: '/x.webp',
          },
        ]);
        const cards = await packs().listCards(
          { handle: [GX, GY] },
          { select: ['id', 'handle'], take: 2 },
        );
        cxId = cards.find((c) => c.handle === GX)!.id;
        cyId = cards.find((c) => c.handle === GY)!.id;
        const now = new Date();
        const pull = (customer_id: string, card_id: string, n: number) =>
          Array.from({ length: n }, () => ({
            customer_id,
            pack_id: GP_PACK,
            card_id,
            rolled_at: now,
            source: 'pack' as const,
          }));
        // A real player carrying everything a report must never show.
        const [realPlayer] = await customers().createCustomers([
          {
            email: 'gp-real@test.dev',
            first_name: 'Real_Puller',
            last_name: 'Private',
            phone: '+60123450000',
            metadata: {
              handle: 'Real_Handle',
              bank_accounts: [{ account_number: '9988776655' }],
              partner_credential: { password: 'pw-secret-1' },
            },
          },
        ]);
        await packs().createPulls([
          ...pull('cus_gp_1', GX, 3), // 150 USD
          ...pull(realPlayer.id, GY, 2), // 60 USD
          ...pull('cus_gp_2', GY, 1), // 30 USD
        ]);
        await packs().saveChallengeStages({
          stages: [
            {
              stage_number: 1,
              threshold_myr: 100,
              rank_rewards: [
                { rank: 1, card_id: cxId, credits: 0 },
                { rank: 4, card_id: null, credits: 1000 },
              ],
            },
            {
              stage_number: 2,
              threshold_myr: 1_000_000,
              rank_rewards: [
                { rank: 1, card_id: cyId, credits: 0 },
                { rank: 4, card_id: null, credits: 5000 },
              ],
            },
          ],
          adminId: 'growth-challenge-test',
          reason: 'test seed',
        });
      });

      it('shows the same pool, stages and standings as the public Ranks page', async () => {
        const site = (
          await unwrapResponse(
            api.get('/store/challenge', { headers: storeHeaders }),
          )
        ).data;
        const res = await report('challenge');
        expect(res.status).toBe(200);
        const r = res.data;
        expect(r.pool_myr).toBe(site.progress.pooledMyr);
        expect(r.pool_myr).toBe(MYR(240));
        expect(
          r.stages.map((s: { stage: number; threshold_myr: number }) => [
            s.stage,
            s.threshold_myr,
          ]),
        ).toEqual(
          site.stages.map(
            (s: { stageNumber: number; thresholdMyr: number }) => [
              s.stageNumber,
              s.thresholdMyr,
            ],
          ),
        );
        expect(r.standings).toEqual(
          site.top.map(
            (t: {
              rank: number;
              name: string;
              handle: string;
              pulls: number;
              volumeMyr: number;
            }) => ({
              rank: t.rank,
              name: t.name,
              handle: t.handle,
              pulls: t.pulls,
              pulled_value_myr: t.volumeMyr,
            }),
          ),
        );
        expect(r.standings[0]).toMatchObject({
          rank: 1,
          pulls: 3,
          pulled_value_myr: MYR(150),
        });
      });

      it('says which stages are unlocked and pays only unlocked stages', async () => {
        const r = (await report('challenge')).data;
        expect(r.stages[0]).toMatchObject({
          stage: 1,
          unlocked: true,
          remaining_myr: 0,
          prizes: [
            { rank: 1, card: 'X Card', card_image: '/x.webp', credits: 0 },
            { rank: 4, card: null, card_image: null, credits: 1000 },
          ],
        });
        expect(r.stages[1]).toMatchObject({
          stage: 2,
          unlocked: false,
          remaining_myr: Math.round((1_000_000 - MYR(240)) * 100) / 100,
        });
        // Stage 2 is locked, so its Y card and 5000 credits are not paid.
        expect(r.prizes_if_week_ended_now).toEqual([
          {
            rank: 1,
            credits: 0,
            cards: [{ name: 'X Card', image: '/x.webp' }],
          },
          { rank: 4, credits: 1000, cards: [] },
        ]);
        expect(new Date(r.week.start).getTime()).toBeLessThan(
          new Date(r.week.end).getTime(),
        );
      });

      it('flags a hidden player above the cut and never exposes ids or contact details', async () => {
        await packs().setAccountDisabled({
          customerId: 'cus_gp_1',
          adminId: 'user_gp_admin',
          disabled: true,
          reason: 'test disable',
        });
        const r = (await report('challenge')).data;
        expect(r.hidden_players_above_cut).toBe(1);
        expect(r.standings).toHaveLength(2);
        expect(r.standings[0]).toMatchObject({
          rank: 1,
          name: 'Real_Puller',
          handle: 'Real_Handle',
          pulls: 2,
        });
        const body = JSON.stringify(r);
        for (const secret of [
          'cus_',
          '@',
          '60123450000',
          'Private',
          '9988776655',
          'pw-secret-1',
          'bank',
          'partner',
        ]) {
          expect(body).not.toContain(secret);
        }
      });

      it('renders the poster as a JPEG, placeholder tiles for unreachable art', async () => {
        const res = await unwrapResponse(
          api.get('/reports/growth/challenge-poster?leaders=1', {
            headers: { 'x-report-key': GROWTH_KEY },
            responseType: 'arraybuffer',
          }),
        );
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toMatch(/^image\/jpeg/);
        expect(res.headers['cache-control']).toBe('no-store');
        const meta = await sharp(Buffer.from(res.data)).metadata();
        expect(meta.format).toBe('jpeg');
        expect(meta.width).toBe(1080);
        // The seeded art is a storefront-relative path nobody serves here.
        expect(res.headers['x-poster-missing-art']).toBe('1');
      });

      it('refuses a bad poster request with a readable reason', async () => {
        expect((await report('challenge-poster?stage=9')).status).toBe(400);
        expect((await report('challenge-poster?stage=x')).status).toBe(400);
        expect((await report('challenge-poster?leaders=yes')).status).toBe(400);
        await packs().saveChallengeStages({
          stages: [],
          adminId: 'growth-challenge-test',
          reason: 'clear',
        });
        expect((await report('challenge-poster')).status).toBe(404);
      });

      // An ended week recomputed live could announce prizes nobody was paid,
      // so only the running week is served.
      it('serves the running week only', async () => {
        expect((await report('challenge?week=current')).status).toBe(200);
        expect((await report('challenge?week=last')).status).toBe(400);
      });
    });

    describe('GET /reports/growth/signups', () => {
      it('counts sign-ups per Malaysia day exactly like the admin Stats page', async () => {
        const made = await customers().createCustomers([
          { email: 'gs-a@test.dev', has_account: true },
          { email: 'gs-b@test.dev', has_account: true },
          { email: 'gs-c@test.dev', has_account: true },
          { email: 'gs-guest@test.dev', has_account: false },
          {
            email: 'gs-staff@test.dev',
            has_account: true,
            metadata: { partner_credential: { username: 'x' } },
          },
        ]);
        // Two on 2026-09-02 MYT (one just after midnight MYT, i.e. the UTC
        // previous day), one on 2026-09-03 MYT, and the excluded two.
        const at = [
          '2026-09-01T16:30:00.000Z',
          '2026-09-02T10:00:00.000Z',
          '2026-09-03T04:00:00.000Z',
          '2026-09-02T10:00:00.000Z',
          '2026-09-02T10:00:00.000Z',
        ];
        for (const [i, c] of made.entries()) {
          await pg().raw('UPDATE customer SET created_at = ? WHERE id = ?', [
            at[i],
            c.id,
          ]);
        }
        // A deleted account still counts, like the dashboard.
        await customers().softDeleteCustomers([made[2].id]);

        const from = '2026-09-01T16:00:00.000Z';
        const to = '2026-09-03T16:00:00.000Z';
        const res = await report(`signups?from=${from}&to=${to}`);
        expect(res.status).toBe(200);
        expect(res.data.days).toEqual([
          { day: '2026-09-02', signups: 2 },
          { day: '2026-09-03', signups: 1 },
        ]);
        const stats = await packs().signupTopupStats(
          new Date(from),
          new Date(to),
        );
        expect(res.data.signups).toBe(stats.signups);
        expect(res.data.signups).toBe(3);
        expect(JSON.stringify(res.data)).not.toContain('@');
      });

      it('needs both window bounds', async () => {
        expect((await report('signups')).status).toBe(400);
      });
    });

    describe('GET /reports/growth/packs', () => {
      it('counts packs opened per Malaysia day, with the most-opened packs', async () => {
        await packs().createPacks([
          {
            slug: GP_PACK,
            title: 'GP Pack',
            category: 'pokemon',
            price: 20,
            image: '/x.webp',
          },
          {
            slug: GP_OTHER,
            title: 'GP Other',
            category: 'pokemon',
            price: 10,
            image: '/x.webp',
          },
        ]);
        const day1 = new Date('2026-09-02T02:00:00.000Z');
        const day2 = new Date('2026-09-03T02:00:00.000Z');
        const p = (
          pack_id: string,
          rolled_at: Date,
          source: 'pack' | 'free' | 'reward',
          n: number,
        ) =>
          Array.from({ length: n }, () => ({
            customer_id: 'cus_gp_p',
            pack_id,
            card_id: GX,
            rolled_at,
            source,
          }));
        await packs().createPulls([
          ...p(GP_PACK, day1, 'pack', 3),
          ...p(GP_OTHER, day1, 'pack', 1),
          ...p(GP_PACK, day2, 'pack', 2),
          ...p(GP_PACK, day2, 'free', 1),
          ...p(GP_PACK, day2, 'reward', 4), // prize draws: not counted
        ]);
        const window =
          'from=2026-09-01T16:00:00.000Z&to=2026-09-03T16:00:00.000Z';
        const res = await report(`packs?${window}`);
        expect(res.status).toBe(200);
        expect(res.data).toMatchObject({
          packs_opened: 6,
          free_packs_opened: 1,
          days: [
            { day: '2026-09-02', packs_opened: 4, free_packs_opened: 0 },
            { day: '2026-09-03', packs_opened: 2, free_packs_opened: 1 },
          ],
          top_packs: [
            { pack: GP_PACK, title: 'GP Pack', packs_opened: 5 },
            { pack: GP_OTHER, title: 'GP Other', packs_opened: 1 },
          ],
        });
        // The same opens the Finance pack-sales report counts.
        const finance = await unwrapResponse(
          api.get(`/reports/finance/pack-sales?${window}`, {
            headers: { 'x-report-key': FINANCE_KEY },
          }),
        );
        expect(
          finance.data.packs.reduce(
            (n: number, x: { packs_opened: number }) => n + x.packs_opened,
            0,
          ),
        ).toBe(res.data.packs_opened);
        expect(JSON.stringify(res.data)).not.toContain('revenue');
      });

      it('needs both window bounds', async () => {
        expect((await report('packs')).status).toBe(400);
      });
    });

    describe('GET /reports/growth/brand-poster', () => {
      const poster = (query: Record<string, string>) =>
        unwrapResponse(
          api.get(
            `/reports/growth/brand-poster?${new URLSearchParams(query)}`,
            {
              headers: { 'x-report-key': GROWTH_KEY },
              responseType: 'arraybuffer',
            },
          ),
        );

      it('prints only the live figure, counted like the admin Stats page', async () => {
        await customers().createCustomers([
          { email: 'bp-a@test.dev', has_account: true },
          { email: 'bp-b@test.dev', has_account: true },
          { email: 'bp-guest@test.dev', has_account: false },
          {
            email: 'bp-staff@test.dev',
            has_account: true,
            metadata: { partner_credential: { username: 'x' } },
          },
        ]);
        const res = await poster({
          headline: 'Collectors and counting',
          metric: 'players',
          round: 'hundred',
          art: 'none',
        });
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toMatch(/^image\/jpeg/);
        expect(res.headers['cache-control']).toBe('no-store');
        const all = await packs().signupTopupStats(new Date(0), new Date());
        // The header carries the exact count, whatever the poster rounds to.
        expect(res.headers['x-poster-figure']).toBe(String(all.signups));
        expect(all.signups).toBeGreaterThanOrEqual(2);
        const meta = await sharp(Buffer.from(res.data)).metadata();
        expect(meta.format).toBe('jpeg');
        expect([meta.width, meta.height]).toEqual([1080, 1350]);
        expect(res.headers['x-poster-missing-art']).toBeUndefined();

        const recent = await poster({
          headline: 'New collectors',
          metric: 'new_players',
          days: '3',
          art: 'none',
        });
        const since = await packs().signupTopupStats(
          new Date(Date.now() - 3 * DAY_MS),
          new Date(),
        );
        expect(recent.headers['x-poster-figure']).toBe(String(since.signups));

        const words = await poster({ headline: 'Something new', art: 'none' });
        expect(words.status).toBe(200);
        expect(words.headers['x-poster-figure']).toBeUndefined();
      });

      it("takes the home page's top chase cards as the hero", async () => {
        await packs().createPacks([
          {
            slug: 'bp-listed',
            title: 'BP Listed',
            category: 'pokemon',
            price: 600,
            image: '/x.webp',
          },
          {
            slug: 'bp-premium',
            title: 'BP Premium',
            category: 'pokemon',
            price: 5000,
            image: '/x.webp',
          },
          {
            slug: 'bp-welcome',
            title: 'BP Welcome',
            category: 'free_welcome',
            price: 0,
            image: '/x.webp',
          },
          {
            slug: 'bp-draft',
            title: 'BP Draft',
            category: 'pokemon',
            price: 20,
            image: '/x.webp',
            status: 'draft',
          },
          {
            slug: 'bp-soldout',
            title: 'BP Sold Out',
            category: 'pokemon',
            price: 20,
            image: '/x.webp',
            in_stock: false,
          },
        ]);
        const card = (
          handle: string,
          name: string,
          mv: number,
          slab = true,
        ) => ({
          handle,
          name,
          set: 'S',
          grader: 'PSA',
          grade: '10',
          market_value: mv,
          image: `/${handle}.webp`,
          slab_image: slab ? `/slab-${handle}.webp` : null,
        });
        await packs().createCards([
          card('bp-a', 'BP A', 90),
          card('bp-b', 'BP B', 50),
          card('bp-c', 'BP C', 20),
          card('bp-d', 'BP D', 10),
          card('bp-no-slab', 'BP No Slab', 1000, false),
          card('bp-welcome-hit', 'BP Welcome Hit', 500),
          card('bp-draft-hit', 'BP Draft Hit', 400),
          card('bp-soldout-hit', 'BP Sold Out Hit', 300),
        ]);
        const odds = (
          pack_id: string,
          card_id: string,
          rarity: 'Immortal' | 'Legendary' | 'Rare' | 'Common',
        ) => ({ pack_id, card_id, weight: 100, locked: false, rarity });
        await packs().createPackOdds([
          odds('bp-listed', 'bp-a', 'Legendary'),
          odds('bp-premium', 'bp-a', 'Immortal'),
          odds('bp-listed', 'bp-b', 'Rare'),
          odds('bp-listed', 'bp-c', 'Rare'),
          odds('bp-listed', 'bp-d', 'Common'),
          odds('bp-listed', 'bp-no-slab', 'Immortal'),
          odds('bp-welcome', 'bp-welcome-hit', 'Immortal'),
          odds('bp-draft', 'bp-draft-hit', 'Immortal'),
          odds('bp-soldout', 'bp-soldout-hit', 'Immortal'),
        ]);
        const hero = await topChaseCards(packs());
        // Slabs only, from packs customers can open now, most valuable first;
        // each with its best tier there and its priciest pack.
        expect(
          hero.map(({ name, image, pack, rarity }) => ({
            name,
            image,
            pack,
            rarity,
          })),
        ).toEqual([
          {
            name: 'BP A',
            image: '/slab-bp-a.webp',
            pack: 'BP Premium',
            rarity: 'Immortal',
          },
          {
            name: 'BP B',
            image: '/slab-bp-b.webp',
            pack: 'BP Listed',
            rarity: 'Rare',
          },
          {
            name: 'BP C',
            image: '/slab-bp-c.webp',
            pack: 'BP Listed',
            rarity: 'Rare',
          },
        ]);
        expect(hero[0].priceMyr).toBeGreaterThan(hero[1].priceMyr);
        // The seeded art is a relative path nobody serves here: placeholders.
        const res = await poster({ headline: 'Chase the top hits.' });
        expect(res.status).toBe(200);
        expect(res.headers['x-poster-missing-art']).toBe('1,2,3');
      });

      it('counts packs opened and frames a goal the data has not reached', async () => {
        const at = new Date();
        const pulls = (source: 'pack' | 'free' | 'reward', n: number) =>
          Array.from({ length: n }, () => ({
            customer_id: 'cus_bp_goal',
            pack_id: GP_PACK,
            card_id: GX,
            rolled_at: at,
            source,
          }));
        await packs().createPulls([
          ...pulls('pack', 12),
          ...pulls('free', 2),
          ...pulls('reward', 3),
        ]);
        const { rows } = (await pg().raw(
          "SELECT count(*)::int AS n FROM pull WHERE deleted_at IS NULL AND source = 'pack'",
        )) as { rows: { n: number }[] };
        const opened = rows[0].n;
        expect(opened).toBeGreaterThanOrEqual(12);

        // Paid packs only, like the Growth packs report's packs_opened.
        const packsPoster = await poster({
          headline: 'Packs ripped since launch.',
          metric: 'packs_opened',
          art: 'none',
        });
        expect(packsPoster.status).toBe(200);
        expect(packsPoster.headers['x-poster-figure']).toBe(String(opened));

        // A goal above the live figure is drawn as the goal, with progress.
        const ahead = await poster({
          headline: 'Be one of the first.',
          metric: 'packs_opened',
          goal: String(opened + 1000),
          art: 'none',
        });
        expect(ahead.status).toBe(200);
        expect(ahead.headers['x-poster-figure']).toBe(String(opened));
        expect(ahead.headers['x-poster-goal-reached']).toBe('0');

        // Once the data reaches it, it is the milestone.
        const reached = await poster({
          headline: 'Packs ripped.',
          metric: 'packs_opened',
          goal: '10',
          art: 'none',
        });
        expect(reached.headers['x-poster-goal-reached']).toBe('1');

        // A goal needs a live figure to measure against.
        const badGoals: Record<string, string>[] = [
          {},
          { metric: 'players', goal: 'x' },
          { metric: 'players', goal: '5' },
        ];
        for (const goal of badGoals) {
          const bad = await report(
            `brand-poster?${new URLSearchParams({ headline: 'Hi', goal: '1000', ...goal })}`,
          );
          expect(bad.status).toBe(400);
        }
      });

      it('refuses typed numbers, other scripts and bad options', async () => {
        const text = (query: Record<string, string>) =>
          report(`brand-poster?${new URLSearchParams(query)}`);
        expect((await text({})).status).toBe(400);
        const typed = await text({ headline: '600+ registered players' });
        expect(typed.status).toBe(400);
        expect(JSON.stringify(typed.data)).toMatch(/metric/);
        const chinese = await text({ headline: '累计注册超过' });
        expect(chinese.status).toBe(400);
        expect(JSON.stringify(chinese.data)).toMatch(/English/);
        const bads: Record<string, string>[] = [
          { headline: 'Hi', kicker: 'K'.repeat(29) },
          { headline: 'Hi', metric: 'revenue' },
          { headline: 'Hi', metric: 'new_players', days: '0' },
          { headline: 'Hi', metric: 'new_players', days: '94' },
          { headline: 'Hi', round: 'up' },
          { headline: 'Hi', art: 'ai' },
        ];
        for (const bad of bads) {
          expect((await text(bad)).status).toBe(400);
        }
        expect((await report('brand-poster?headline=Hi', null)).status).toBe(
          401,
        );
      });
    });

    describe('GET /reports/growth/tasks and achievements-poster', () => {
      const origin = assetOrigin();
      const weeklyEnds = new Date(Date.now() + 3 * DAY_MS);

      beforeEach(async () => {
        await packs().createPacks([
          {
            slug: 'tk-bronze',
            title: 'TK Bronze',
            category: 'pokemon',
            price: 300,
            image: '/images/tk-bronze.webp',
            display_image: '/images/tk-bronze-factory.webp',
          },
          {
            slug: 'tk-weekly',
            title: 'TK Weekly',
            category: 'pokemon',
            price: 45,
            image: 'https://cdn.test/tk-weekly.png',
          },
        ]);
        await packs().createCards([
          {
            handle: 'tk-latias',
            name: 'Latias & Latios GX #105',
            set: 'S',
            grader: 'PSA',
            grade: '10',
            market_value: 100,
            image: '/x.webp',
            slab_image: 'https://cdn.test/slab-latias.webp',
          },
        ]);
        const achievement = (
          title: string,
          requirement: Record<string, unknown>,
          reward: Record<string, unknown>,
          extra: Record<string, unknown> = {},
        ) => ({
          kind: 'achievement' as const,
          title,
          requirement,
          reward,
          ...extra,
        });
        await packs().createTaskDefinitions([
          achievement(
            'Reach lvl 20',
            { type: 'reach_level', level: 20 },
            { type: 'pack', pack_id: 'tk-bronze' },
          ),
          achievement(
            'Reach lvl 10',
            { type: 'reach_level', level: 10 },
            { type: 'credit', amount_myr: 50 },
          ),
          achievement(
            'Reach lvl 90',
            { type: 'reach_level', level: 90 },
            { type: 'card', card_handle: 'tk-latias' },
          ),
          achievement(
            'Vault 5 cards',
            { type: 'vault_count', count: 5 },
            { type: 'credit', amount_myr: 5 },
          ),
          // Switched off, and past its window: the page shows neither.
          achievement(
            'Reach lvl 30',
            { type: 'reach_level', level: 30 },
            { type: 'credit', amount_myr: 30 },
            { active: false },
          ),
          achievement(
            'Reach lvl 40',
            { type: 'reach_level', level: 40 },
            { type: 'credit', amount_myr: 40 },
            { ends_at: new Date(Date.now() - DAY_MS) },
          ),
          {
            kind: 'weekly' as const,
            title: 'Check in 5 days',
            requirement: { type: 'checkin_days', days: 5 },
            reward: { type: 'pack', pack_id: 'tk-weekly' },
            ends_at: weeklyEnds,
          },
        ]);
      });

      it('lists the live tasks with the prizes and values the /task page shows', async () => {
        const res = await report('tasks');
        expect(res.status).toBe(200);
        const r = res.data;
        expect(r.achievements).toEqual([
          {
            title: 'Reach lvl 10',
            requirement: 'Reach VIP level 10',
            level: 10,
            prize: 'RM 50.00 credit',
            prize_type: 'credit',
            value_myr: 50,
            image: null,
            ends_at: null,
          },
          {
            title: 'Reach lvl 20',
            requirement: 'Reach VIP level 20',
            level: 20,
            prize: 'Free rip · TK Bronze',
            prize_type: 'pack',
            value_myr: 300,
            image: `${origin}/images/tk-bronze.webp`,
            ends_at: null,
          },
          {
            title: 'Reach lvl 90',
            requirement: 'Reach VIP level 90',
            level: 90,
            prize: 'Latias & Latios GX #105 · PSA 10',
            prize_type: 'card',
            value_myr: expect.any(Number),
            image: 'https://cdn.test/slab-latias.webp',
            ends_at: null,
          },
          {
            title: 'Vault 5 cards',
            requirement: 'Vault 5 cards',
            level: null,
            prize: 'RM 5.00 credit',
            prize_type: 'credit',
            value_myr: 5,
            image: null,
            ends_at: null,
          },
        ]);
        expect(r.weekly).toEqual([
          {
            title: 'Check in 5 days',
            requirement: 'Check in on 5 days this week',
            level: null,
            prize: 'Free rip · TK Weekly',
            prize_type: 'pack',
            value_myr: 45,
            image: 'https://cdn.test/tk-weekly.png',
            ends_at: weeklyEnds.toISOString(),
          },
        ]);

        // Every value is the one the player's own hub promises.
        const hub = await packs().taskHubFor({ customerId: 'cus_tk_player' });
        const worth = new Map(
          hub.tasks.map((t) => [
            t.title,
            t.reward.type === 'credit'
              ? t.reward.amount_myr
              : t.reward.type === 'pack'
                ? t.reward.pack_price_myr
                : t.reward.card_value_myr,
          ]),
        );
        for (const t of [...r.achievements, ...r.weekly]) {
          expect(t.value_myr).toBe(worth.get(t.title));
        }
        expect(worth.get('Reach lvl 90')).toBeGreaterThan(0);

        // The catalogue, never anyone's progress.
        const body = JSON.stringify(r);
        expect(body).not.toMatch(
          /"(progress|claimed|pending_spins|vip_level|id)":/,
        );
        expect(body).not.toContain('report:catalogue');
      });

      it('renders the VIP-level ladder as a JPEG, art misses named by level', async () => {
        const poster = (query = '') =>
          unwrapResponse(
            api.get(`/reports/growth/achievements-poster${query}`, {
              headers: { 'x-report-key': GROWTH_KEY },
              responseType: 'arraybuffer',
            }),
          );
        const res = await poster();
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toMatch(/^image\/jpeg/);
        expect(res.headers['cache-control']).toBe('no-store');
        const meta = await sharp(Buffer.from(res.data)).metadata();
        expect([meta.format, meta.width, meta.height]).toEqual([
          'jpeg',
          1080,
          1350,
        ]);
        // VIP-level achievements only; the vault one is not on the ladder.
        expect(res.headers['x-poster-levels']).toBe('10,20,90');
        // Nobody serves the seeded art here; the credit has none to miss.
        expect(res.headers['x-poster-missing-art']).toBe('20,90');

        expect(res.headers['x-poster-skipped']).toBeUndefined();

        const some = await poster('?min_level=20&max_level=90');
        expect(some.headers['x-poster-levels']).toBe('20,90');
        const top = await poster('?min_level=50');
        expect(top.headers['x-poster-levels']).toBe('90');
      });

      it('leaves a prize nobody can claim off the poster and names its level', async () => {
        await packs().createTaskDefinitions([
          {
            kind: 'achievement' as const,
            title: 'Reach lvl 50',
            requirement: { type: 'reach_level', level: 50 },
            reward: { type: 'pack', pack_id: 'tk-gone' },
          },
        ]);
        // Staff still see it in the report, marked missing.
        const list = (await report('tasks')).data;
        expect(
          list.achievements.find((t: { level: number }) => t.level === 50),
        ).toMatchObject({
          prize: 'Free rip · tk-gone (missing)',
          value_myr: null,
        });
        const res = await unwrapResponse(
          api.get('/reports/growth/achievements-poster', {
            headers: { 'x-report-key': GROWTH_KEY },
            responseType: 'arraybuffer',
          }),
        );
        expect(res.status).toBe(200);
        expect(res.headers['x-poster-levels']).toBe('10,20,90');
        expect(res.headers['x-poster-skipped']).toBe('50');
        const only = await report(
          'achievements-poster?min_level=50&max_level=50',
        );
        expect(only.status).toBe(404);
        expect(JSON.stringify(only.data)).toMatch(/no longer exists/);
      });

      it('refuses a bad range with a readable reason', async () => {
        for (const q of [
          'min_level=x',
          'max_level=0',
          'min_level=101',
          'min_level=60&max_level=20',
        ]) {
          expect((await report(`achievements-poster?${q}`)).status).toBe(400);
        }
        const none = await report('achievements-poster?min_level=95');
        expect(none.status).toBe(404);
        expect(JSON.stringify(none.data)).toMatch(/10, 20, 90/);
        await packs().createTaskDefinitions(
          [41, 42, 43, 44, 45, 46, 47, 48].map((level) => ({
            kind: 'achievement' as const,
            title: `Reach lvl ${level}`,
            requirement: { type: 'reach_level', level },
            reward: { type: 'credit', amount_myr: 1 },
          })),
        );
        const many = await report('achievements-poster');
        expect(many.status).toBe(400);
        expect(JSON.stringify(many.data)).toMatch(/fits 10/);
        expect((await report('achievements-poster', null)).status).toBe(401);
        expect((await report('tasks', null)).status).toBe(401);
      });
    });
  },
});
