import sharp from 'sharp';
import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils';
import type { ICustomerModuleService } from '@medusajs/framework/types';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { clearChallengeCache } from '../../src/api/store/challenge/route';
import { topChaseCards } from '../../src/api/reports/growth/brand-poster/route';
import { assetOrigin } from '../../src/api/utils/image-fetch';
import { unzipSync, strFromU8 } from 'fflate';
import { DEFAULT_USD_MYR } from '../../src/modules/packs/pricing';
import { findBank } from '../../src/modules/packs/banks';
import { ensureDefaultPlayerGroup } from '../../src/modules/packs/player-groups';
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

    describe('the report keys', () => {
      it("open growth reports with any desk's key, never without one", async () => {
        expect((await report('challenge')).status).toBe(200);
        expect((await report('challenge', FINANCE_KEY)).status).toBe(200);
        expect((await report('challenge', 'x'.repeat(48))).status).toBe(401);
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
        expect([meta.width, meta.height]).toEqual([1080, 1350]);
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

      it('reads the next challenge waiting in the queue, and draws its poster', async () => {
        expect((await report('challenge?week=next')).status).toBe(404);
        const startsAt = new Date(Date.now() + 3 * DAY_MS);
        await packs().createChallengeSchedules([
          {
            starts_at: startsAt,
            label: 'Next week',
            // A json column: the model types it as a record.
            stages: [
              {
                stage_number: 1,
                threshold_myr: 5000,
                rank_rewards: [
                  { rank: 2, card_id: null, credits: 300 },
                  { rank: 1, card_id: cyId, credits: 0 },
                ],
              },
            ] as unknown as Record<string, unknown>,
          },
        ]);
        const res = await report('challenge?week=next');
        expect(res.status).toBe(200);
        expect(res.data).toMatchObject({
          queued: true,
          starts_at: startsAt.toISOString(),
          label: 'Next week',
          stages: [
            {
              stage: 1,
              threshold_myr: 5000,
              prizes: [
                { rank: 1, card: 'Y Card', card_image: '/x.webp', credits: 0 },
                { rank: 2, card: null, card_image: null, credits: 300 },
              ],
            },
          ],
        });
        const poster = await unwrapResponse(
          api.get('/reports/growth/challenge-poster?week=next', {
            headers: { 'x-report-key': GROWTH_KEY },
            responseType: 'arraybuffer',
          }),
        );
        expect(poster.status).toBe(200);
        expect((await sharp(Buffer.from(poster.data)).metadata()).format).toBe(
          'jpeg',
        );
        expect((await report('challenge-poster?week=last')).status).toBe(400);
      });

      it('draws every stage of the running or the queued challenge on one poster', async () => {
        const poster = (query = '') =>
          unwrapResponse(
            api.get(`/reports/growth/challenge-stages-poster${query}`, {
              headers: { 'x-report-key': GROWTH_KEY },
              responseType: 'arraybuffer',
            }),
          );
        const res = await poster();
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toMatch(/^image\/jpeg/);
        const meta = await sharp(Buffer.from(res.data)).metadata();
        expect([meta.format, meta.width, meta.height]).toEqual([
          'jpeg',
          1080,
          1350,
        ]);
        // Both stages' #1 card; the seeded art is served by nobody here.
        expect(res.headers['x-poster-missing-art']).toBe('1:1,2:1');

        expect((await report('challenge-stages-poster?week=next')).status).toBe(
          404,
        );
        await packs().createChallengeSchedules([
          {
            starts_at: new Date(Date.now() + 3 * DAY_MS),
            label: null,
            stages: [
              {
                stage_number: 1,
                threshold_myr: 5000,
                rank_rewards: [{ rank: 1, card_id: cyId, credits: 0 }],
              },
            ] as unknown as Record<string, unknown>,
          },
        ]);
        const next = await poster('?week=next');
        expect(next.status).toBe(200);
        expect(next.headers['x-poster-missing-art']).toBe('1:1');
        expect((await report('challenge-stages-poster?week=last')).status).toBe(
          400,
        );
      });

      it("reports last week's results as settlement paid them, public names only", async () => {
        expect((await report('challenge-results')).status).toBe(404);
        expect((await report('challenge-results-poster')).status).toBe(404);

        const s = await packs().challengeSettings();
        const last = await packs().challengeWeekBounds({
          timezone: s.timezone,
          resetDay: s.reset_day,
          resetHour: s.reset_hour,
          weeksBack: 1,
        });
        const [real] = await customers().listCustomers(
          { email: 'gp-real@test.dev' },
          { take: 1 },
        );
        const lastWeek = new Date(last.startUtc.getTime() + DAY_MS);
        await packs().createPulls([
          ...[1, 2].map(() => ({
            customer_id: real.id,
            pack_id: GP_PACK,
            card_id: GX,
            rolled_at: lastWeek,
            source: 'pack' as const,
          })),
          {
            customer_id: 'cus_gp_w2',
            pack_id: GP_PACK,
            card_id: GY,
            rolled_at: lastWeek,
            source: 'pack' as const,
          },
        ]);
        const snap = { pool_myr: 5000, unlocked_stages: [1, 2] };
        const payout = (
          customer_id: string,
          rank: number,
          kind: 'card' | 'credits',
          card_id: string,
          credits: number,
          extra: Record<string, unknown> = {},
        ) => ({
          week_start: last.startUtc,
          customer_id,
          rank,
          kind,
          card_id,
          credits,
          snapshot: { ...snap, ...extra } as unknown as Record<string, unknown>,
        });
        await packs().createChallengePayouts([
          payout(real.id, 1, 'card', cxId, 0, { qty: 2 }),
          payout(real.id, 1, 'credits', '', 150),
          payout('cus_gp_w2', 2, 'credits', '', 300),
          payout('cus_gp_1', 3, 'credits', '', 100),
        ]);
        await packs().setAccountDisabled({
          customerId: 'cus_gp_1',
          adminId: 'user_gp_admin',
          disabled: true,
          reason: 'test disable',
        });

        const res = await report('challenge-results');
        expect(res.status).toBe(200);
        const r = res.data;
        expect(r).toMatchObject({
          currency: 'MYR',
          week: {
            start: last.startUtc.toISOString(),
            end: last.endUtc.toISOString(),
          },
          pool_myr: 5000,
          unlocked_stages: [1, 2],
          hidden_winners: 1,
        });
        expect(r.winners).toEqual([
          {
            rank: 1,
            name: 'Real_Puller',
            handle: 'Real_Handle',
            pulled_value_myr: MYR(100),
            credits: 150,
            cards: [
              {
                name: 'X Card · PSA 10',
                image: `${assetOrigin()}/x.webp`,
                qty: 2,
                value_myr: expect.any(Number),
              },
            ],
            prize_value_myr: expect.any(Number),
          },
          {
            rank: 2,
            name: expect.stringMatching(/^Collector \d+$/),
            handle: null,
            pulled_value_myr: MYR(30),
            credits: 300,
            cards: [],
            prize_value_myr: 300,
          },
        ]);
        // The prize is the credits plus both cards at today's value.
        const card = r.winners[0].cards[0];
        expect(card.value_myr).toBeGreaterThan(0);
        expect(r.winners[0].prize_value_myr).toBe(
          Math.round((150 + 2 * card.value_myr) * 100) / 100,
        );
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

        const poster = await unwrapResponse(
          api.get('/reports/growth/challenge-results-poster', {
            headers: { 'x-report-key': GROWTH_KEY },
            responseType: 'arraybuffer',
          }),
        );
        expect(poster.status).toBe(200);
        expect(poster.headers['content-type']).toMatch(/^image\/jpeg/);
        const meta = await sharp(Buffer.from(poster.data)).metadata();
        // The 4:5 size Facebook and Instagram feeds show whole.
        expect([meta.format, meta.width, meta.height]).toEqual([
          'jpeg',
          1080,
          1350,
        ]);
        expect(poster.headers['x-poster-part']).toBe('top');
        expect(poster.headers['x-poster-week']).toBe(
          last.startUtc.toISOString(),
        );
        expect(poster.headers['x-poster-missing-art']).toBe('1');
        expect(poster.headers['x-poster-note']).toMatch(
          /^1 winner is left off/,
        );
        // Ranks 4-10 are the week's second image.
        const rest = await unwrapResponse(
          api.get('/reports/growth/challenge-results-poster?part=rest', {
            headers: { 'x-report-key': GROWTH_KEY },
            responseType: 'arraybuffer',
          }),
        );
        expect(rest.status).toBe(200);
        expect(rest.headers['x-poster-part']).toBe('rest');
        const restMeta = await sharp(Buffer.from(rest.data)).metadata();
        expect([restMeta.width, restMeta.height]).toEqual([1080, 1350]);
        expect((await report('challenge-results-poster?part=all')).status).toBe(
          400,
        );
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
            checkin_days: null,
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
            checkin_days: null,
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
            checkin_days: null,
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
            checkin_days: null,
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
            checkin_days: 5,
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

      it("draws the week's tasks as a poster: check-ins as one strip, a tile per other task", async () => {
        await packs().createTaskDefinitions([
          {
            kind: 'weekly' as const,
            title: 'Rip 10 Bronze',
            requirement: { type: 'rip_count', count: 10, pack_id: 'tk-bronze' },
            reward: { type: 'pack', pack_id: 'tk-bronze' },
            ends_at: weeklyEnds,
          },
          {
            kind: 'weekly' as const,
            title: 'Rip for a gone pack',
            requirement: { type: 'rip_count', count: 1 },
            reward: { type: 'pack', pack_id: 'tk-gone' },
            ends_at: weeklyEnds,
          },
        ]);
        const res = await unwrapResponse(
          api.get('/reports/growth/tasks-poster', {
            headers: { 'x-report-key': GROWTH_KEY },
            responseType: 'arraybuffer',
          }),
        );
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toMatch(/^image\/jpeg/);
        const meta = await sharp(Buffer.from(res.data)).metadata();
        expect([meta.format, meta.width, meta.height]).toEqual([
          'jpeg',
          1080,
          1350,
        ]);
        // Nobody serves the seeded art here: the check-in tier and the tile.
        expect(res.headers['x-poster-missing-art']).toBe('checkin:5,task:0');
        // A prize nobody can claim is left off, and staff are told.
        expect(res.headers['x-poster-note']).toMatch(
          /Rip for a gone pack.*admin Tasks console/,
        );
        expect((await report('tasks-poster', null)).status).toBe(401);
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

    describe('the daily top pulls and their report', () => {
      // One Malaysia day: 2026-09-20 00:00 MYT = 2026-09-19T16:00Z.
      const DAY = '2026-09-20';
      const inDay = (hourUtc: number) =>
        new Date(Date.UTC(2026, 8, 19, 16 + hourUtc));
      const fx = (usd: number) => Math.round(usd * DEFAULT_USD_MYR * 100) / 100;
      const ids: Record<string, string> = {};

      beforeEach(async () => {
        await packs().createPacks([
          {
            slug: 'dh-pack',
            title: 'DH Pack',
            category: 'pokemon',
            price: 100,
            image: '/images/dh-pack.webp',
          },
        ]);
        const card = (handle: string, name: string, mv: number) => ({
          handle,
          name,
          set: 'DH Set',
          grader: 'PSA',
          grade: '10',
          market_value: mv,
          image: '/x.webp',
          slab_image: `https://cdn.test/${handle}.webp`,
        });
        await packs().createCards([
          card('dh-a', 'Latias & Latios GX #105', 100),
          card('dh-b', 'DH B', 50),
          card('dh-c', 'DH C', 10),
          card('dh-d', 'DH D', 500),
        ]);
        await packs().createPackOdds(
          [
            ['dh-a', 'Legendary'],
            ['dh-b', 'Rare'],
            ['dh-c', 'Common'],
            ['dh-d', 'Immortal'],
          ].map(([card_id, rarity]) => ({
            pack_id: 'dh-pack',
            card_id,
            weight: 100,
            locked: false,
            rarity: rarity as 'Legendary',
          })),
        );
        const made = await customers().createCustomers([
          {
            email: 'ace@test.dev',
            first_name: 'Ace_Puller',
            last_name: 'Private',
            phone: '+60111111111',
            has_account: true,
          },
          {
            email: 'bee@test.dev',
            first_name: 'Bee',
            phone: '+60122222222',
            has_account: true,
          },
          {
            email: 'hidden@test.dev',
            first_name: 'Hidden',
            phone: '+60133333333',
            has_account: true,
          },
        ]);
        const [ace, bee, hidden] = made.map((c) => c.id);
        Object.assign(ids, { ace, bee, hidden });
        await packs().setAccountDisabled({
          customerId: hidden,
          adminId: 'user_dh_admin',
          disabled: true,
          reason: 'test disable',
        });
        const pull = (
          customer_id: string,
          card_id: string,
          usd: number,
          rolled_at: Date,
          source: 'pack' | 'reward' = 'pack',
        ) => ({
          customer_id,
          pack_id: 'dh-pack',
          card_id,
          rolled_at,
          source,
          recorded_value_usd: usd,
        });
        const pulls = await packs().createPulls([
          pull(ace, 'dh-a', 100, inDay(2)),
          pull(bee, 'dh-b', 50, inDay(3)),
          pull(ace, 'dh-c', 10, inDay(4)),
          // Not on the board: a disabled player, a prize draw, the next day.
          pull(hidden, 'dh-d', 500, inDay(5)),
          pull(bee, 'dh-d', 500, inDay(6), 'reward'),
          pull(ace, 'dh-d', 500, inDay(24)),
        ]);
        ids.top = pulls[0].id;
        ids.hiddenPull = pulls[3].id;
        ids.rewardPull = pulls[4].id;
        const withdrawal = (
          customer_id: string,
          n: string,
          status: 'held' | 'settled',
          amount: number,
        ) => ({
          merchant_transaction_id: `dh-wd-${n}`,
          customer_id,
          amount,
          bank_code: 'MBBEMYKL',
          account_number: `55667788${n}`,
          account_holder_name: `Holder ${n}`,
          status,
        });
        const wds = await packs().createGatewayWithdrawals([
          withdrawal(bee, '1', 'held', 30),
          withdrawal(ace, '2', 'settled', 70),
          withdrawal(ace, '3', 'settled', 999),
        ]);
        await pg().raw(
          'UPDATE gateway_withdrawal SET created_at = ? WHERE id IN (?, ?)',
          [inDay(7), wds[0].id, wds[1].id],
        );
        await pg().raw(
          'UPDATE gateway_withdrawal SET created_at = ? WHERE id = ?',
          [inDay(30), wds[2].id],
        );
      });

      it('ranks the paid pulls of one Malaysia day by pulled value, public data only', async () => {
        const res = await report(`top-pulls?day=${DAY}`);
        expect(res.status).toBe(200);
        expect(res.data.day).toBe(DAY);
        expect(
          res.data.pulls.map(
            (p: {
              rank: number;
              card: { name: string; rarity: string };
              value_myr: number;
              player: { name: string };
            }) => [
              p.rank,
              p.card.name,
              p.card.rarity,
              p.value_myr,
              p.player.name,
            ],
          ),
        ).toEqual([
          [1, 'Latias & Latios GX #105', 'Legendary', fx(100), 'Ace_Puller'],
          [2, 'DH B', 'Rare', fx(50), 'Bee'],
          [3, 'DH C', 'Common', fx(10), 'Ace_Puller'],
        ]);
        expect(res.data.pulls[0]).toMatchObject({
          pull_id: ids.top,
          card: {
            grade: 'PSA 10',
            slab_image: 'https://cdn.test/dh-a.webp',
          },
          pack: { slug: 'dh-pack', title: 'DH Pack' },
        });
        const body = JSON.stringify(res.data);
        for (const secret of [
          '@',
          '+60',
          'Private',
          'customer',
          ids.ace,
          'Hidden',
        ]) {
          expect(body).not.toContain(secret);
        }
        const two = await report(`top-pulls?day=${DAY}&limit=2`);
        expect(two.data.pulls).toHaveLength(2);
        for (const bad of [
          'day=2026-13-01',
          'day=yesterday',
          'limit=0',
          'limit=21',
        ]) {
          expect((await report(`top-pulls?${bad}`)).status).toBe(400);
        }
      });

      it('draws the Telegram pull card for one paid pull, nothing else', async () => {
        // Nobody serves the seeded art here, so the card cannot be drawn; the
        // route says so instead of sending a broken picture (pull-card's
        // unit spec covers the drawing itself).
        const res = await report(`pull-card?pull=${ids.top}`);
        expect(res.status).toBe(502);
        expect(JSON.stringify(res.data)).toMatch(/art could not be loaded/);
        for (const pull of [ids.rewardPull, ids.hiddenPull, 'pull_nope']) {
          expect((await report(`pull-card?pull=${pull}`)).status).toBe(404);
        }
        expect((await report('pull-card')).status).toBe(400);
      });

      it('renders the top pulls as a posting poster', async () => {
        const res = await unwrapResponse(
          api.get(`/reports/growth/top-pulls-poster?day=${DAY}`, {
            headers: { 'x-report-key': GROWTH_KEY },
            responseType: 'arraybuffer',
          }),
        );
        expect(res.status).toBe(200);
        const meta = await sharp(Buffer.from(res.data)).metadata();
        expect([meta.format, meta.width, meta.height]).toEqual([
          'jpeg',
          1080,
          1350,
        ]);
        expect(res.headers['x-poster-ranks']).toBe('1,2,3');
        // Nobody serves the seeded slab art here.
        expect(res.headers['x-poster-missing-art']).toBe('1,2,3');
        expect((await report('top-pulls-poster?day=2026-01-01')).status).toBe(
          404,
        );
      });

      it('puts the full customer details in the Excel, for the Growth key only', async () => {
        // The pulls sheet keeps Legendary and Immortal pulls by DEFAULT-group
        // players only: a partner's Legendary and a Mythical hit stay out, a
        // player filed in DEFAULT itself stays in.
        await packs().createCards([
          {
            handle: 'dh-m',
            name: 'DH Mythic',
            set: 'DH Set',
            grader: 'PSA',
            grade: '10',
            market_value: 300,
            image: '/x.webp',
          },
        ]);
        await packs().createPackOdds([
          {
            pack_id: 'dh-pack',
            card_id: 'dh-m',
            weight: 100,
            locked: false,
            rarity: 'Mythical',
          },
        ]);
        const [member, partner] = await customers().createCustomers([
          {
            email: 'member@test.dev',
            first_name: 'Member',
            phone: '+60144444444',
            has_account: true,
          },
          {
            email: 'partner@test.dev',
            first_name: 'Partner',
            phone: '+60155555555',
            has_account: true,
          },
        ]);
        const def = await ensureDefaultPlayerGroup(getContainer());
        const partners = await customers().createCustomerGroups({
          name: 'Partners',
        });
        await customers().addCustomerToGroup([
          { customer_id: member.id, customer_group_id: def.id },
          { customer_id: partner.id, customer_group_id: partners.id },
        ]);
        await packs().createPulls(
          [
            [member.id, 'dh-d', 500],
            [partner.id, 'dh-a', 100],
            [ids.ace, 'dh-m', 300],
          ].map(([customer_id, card_id, usd]) => ({
            customer_id: customer_id as string,
            pack_id: 'dh-pack',
            card_id: card_id as string,
            rolled_at: inDay(8),
            source: 'pack' as const,
            recorded_value_usd: usd as number,
          })),
        );

        const res = await unwrapResponse(
          api.get(`/reports/growth/daily-report?day=${DAY}`, {
            headers: { 'x-report-key': GROWTH_KEY },
            responseType: 'arraybuffer',
          }),
        );
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toBe(
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        );
        expect(res.headers['content-disposition']).toBe(
          `attachment; filename="polycards-daily-${DAY}.xlsx"`,
        );
        const files = unzipSync(new Uint8Array(Buffer.from(res.data)));
        const strings = strFromU8(files['xl/sharedStrings.xml']);
        const workbook = strFromU8(files['xl/workbook.xml']);
        expect(workbook).toContain('name="Legendary &amp; Immortal"');
        expect(workbook).toContain('name="Withdrawals"');
        for (const detail of [
          'Ace_Puller',
          '+60111111111',
          'ace@test.dev',
          'Latias &amp; Latios GX #105',
          'DH D',
          'member@test.dev',
          '556677881',
          'Holder 1',
          findBank('MBBEMYKL')!.name,
        ]) {
          expect(strings).toContain(detail);
        }
        for (const absent of [
          // Below Legendary: Rare, Common and Mythical pulls.
          'DH B',
          'DH C',
          'DH Mythic',
          // A partner-group player, though their pull is Legendary.
          'partner@test.dev',
          '+60155555555',
          // Other days' withdrawals and the hidden player's pull.
          '556677883',
          '+60133333333',
        ]) {
          expect(strings).not.toContain(absent);
        }

        expect(
          (await report(`daily-report?day=${DAY}`, FINANCE_KEY)).status,
        ).toBe(403);
        expect((await report(`daily-report?day=${DAY}`, null)).status).toBe(
          401,
        );
      });
    });
  },
});
