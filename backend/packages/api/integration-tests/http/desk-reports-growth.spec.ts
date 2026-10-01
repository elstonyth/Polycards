import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils';
import type { ICustomerModuleService } from '@medusajs/framework/types';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { clearChallengeCache } from '../../src/api/store/challenge/route';
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
        await packs().createPulls([
          ...pull('cus_gp_1', GX, 3), // 150 USD
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
        expect(r.pool_myr).toBe(MYR(180));
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
          remaining_myr: Math.round((1_000_000 - MYR(180)) * 100) / 100,
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
        expect(r.week.which).toBe('current');
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
        expect(r.standings).toHaveLength(1);
        expect(r.standings[0]).toMatchObject({ rank: 1, pulls: 1 });
        const body = JSON.stringify(r);
        expect(body).not.toContain('cus_gp_');
        expect(body).not.toContain('@');
      });

      it('reports last week, and refuses an unknown week', async () => {
        const current = (await report('challenge')).data;
        const last = await report('challenge?week=last');
        expect(last.status).toBe(200);
        expect(last.data.week.which).toBe('last');
        expect(last.data.week.end).toBe(current.week.start);
        expect(last.data.pool_myr).toBe(0);
        expect((await report('challenge?week=next')).status).toBe(400);
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
  },
});
