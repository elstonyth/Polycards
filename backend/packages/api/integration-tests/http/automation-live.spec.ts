import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { Modules } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { tickLive } from '../../src/api/utils/automation-live-store';
import { clearRecentPullsCache } from '../../src/api/store/pulls/recent/route';
import automationLiveJob from '../../src/jobs/automation-live';
import { mintSuperAdmin, unwrapResponse } from './utils';
import type { IEventBusModuleService } from '@medusajs/framework/types';

// Never send to Telegram from an integration run, even if local env has a token.
jest.mock('../../src/modules/packs/telegram', () => ({
  postApexPull: jest.fn(async () => null),
}));

// The app's own scheduled job calls tickLive every 2 s. This suite drives
// every tick itself (often with a fake clock) and counts which call claimed a
// cycle, so a job tick landing in between made it flaky. Keep the schedule,
// drop the work.
jest.mock('../../src/jobs/automation-live', () => ({
  __esModule: true,
  default: jest.fn(async () => undefined),
  config: { name: 'automation-live', schedule: '*/2 * * * * *' },
}));

jest.setTimeout(240_000);

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    it('settles every selected draw without a spend cap and publishes each pull to the storefront feed', async () => {
      const container = getContainer();
      const eventBus = container.resolve<IEventBusModuleService>(Modules.EVENT_BUS);
      const emit = eventBus.emit.bind(eventBus);
      const announcements: string[] = [];
      jest.spyOn(eventBus, 'emit').mockImplementation(async (events, options) => {
        for (const event of Array.isArray(events) ? events : [events]) {
          if (event.name !== 'pull.revealed') continue;
          announcements.push((event.data as { pull_id: string }).pull_id);
          // A dropped announcement must not interrupt the paid draw or sell.
          if (announcements.length === 1) throw new Error('Test event bus outage');
        }
        await emit(events, options);
      });
      const token = await mintSuperAdmin(
        container,
        api,
        'live-admin@example.test',
        'live-test-password',
      );
      const headers = { authorization: `Bearer ${token}` };
      const key = await container.resolve(Modules.API_KEY).createApiKeys({
        title: 'live-feed-test',
        type: 'publishable',
        created_by: 'live-feed-test',
      });
      const storeHeaders = { 'x-publishable-api-key': key.token };
      const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
      const customers = container.resolve(Modules.CUSTOMER);
      const [customer] = await customers.createCustomers([
        {
          email: 'live-account@example.test',
          first_name: 'Live Player',
          has_account: true,
        },
      ]);
      await packs.createCreditTransactions([
        {
          customer_id: customer.id,
          amount: 30,
          bonus_cents: 500,
          reason: 'topup',
        },
      ]);
      await packs.createPacks([
        {
          slug: 'live-pack',
          title: 'Live pack',
          category: 'pokemon',
          price: 10,
          image: '/test.webp',
          buyback_percent: 90,
        },
      ]);
      await packs.createCards([
        {
          handle: 'live-card',
          name: 'Live card',
          set: 'Test',
          grader: 'PSA',
          grade: '10',
          market_value: 2,
          market_multiplier: 1,
          image: '/test.webp',
        },
      ]);
      await packs.createPackOdds([
        {
          pack_id: 'live-pack',
          card_id: 'live-card',
          rarity: 'Rare',
          weight: 100,
          locked: false,
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
      await api.post(
        '/admin/automation/accounts',
        { emails: [customer.email] },
        { headers },
      );
      expect(
        (await unwrapResponse(api.get('/admin/automation/live'))).status,
      ).toBe(401);
      const initial = (await api.get('/admin/automation/live', { headers }))
        .data;
      expect(initial).toMatchObject({
        mode: 'live',
        status: 'idle',
        cycles: [],
      });
      expect(await tickLive(container)).toBe(false);
      const config = {
        packSlug: 'live-pack',
        customerIds: [customer.id],
        intervalSeconds: 2,
        maxCyclesPerAccount: 3,
      };
      await api.post(
        '/admin/automation/live',
        { action: 'save', config },
        { headers },
      );
      expect(
        (await api.get('/admin/automation/live', { headers })).data.config,
      ).toMatchObject({ timingMode: 'fixed', intervalSeconds: 2 });
      expect(
        (
          await unwrapResponse(
            api.post(
              '/admin/automation/live',
              {
                action: 'save',
                config: {
                  ...config,
                  timingMode: 'humanized',
                  humanizedTestClock: true,
                },
              },
              { headers },
            ),
          )
        ).status,
      ).toBe(400);
      expect(await tickLive(container)).toBe(false);
      expect(
        (await packs.listAndCountPulls({ customer_id: customer.id }))[1],
      ).toBe(0);
      expect(
        (
          await unwrapResponse(
            api.post(
              '/admin/automation/live',
              {
                action: 'run',
                config: { ...config, customerIds: ['sandbox_001'] },
              },
              { headers },
            ),
          )
        ).status,
      ).toBe(400);
      await api.post(
        '/admin/automation/live',
        {
          action: 'run',
          config: {
            ...config,
            timingMode: 'random',
            randomMinSeconds: 2,
            randomMaxSeconds: 2,
          },
        },
        { headers },
      );
      const firstDrawAt = Date.now() + 60000;
      const ticks = await Promise.all([
        tickLive(container, () => firstDrawAt),
        tickLive(container, () => firstDrawAt),
        tickLive(container, () => firstDrawAt),
      ]);
      expect(ticks.filter(Boolean)).toHaveLength(1);
      const view = (await api.get('/admin/automation/live', { headers })).data;
      expect(view.cycles).toHaveLength(1);
      expect(view.cycles[0]).toMatchObject({
        customerId: customer.id,
        costCents: 1000,
        saleCents: 720,
        startingCents: 3000,
        endingCents: 2720,
        startingBonusCents: 500,
        endingBonusCents: 0,
        differenceCents: 0,
        bonusDifferenceCents: 0,
        error: null,
      });
      const [pull] = await packs.listPulls({ customer_id: customer.id });
      expect(pull.id).toBe(view.cycles[0].pullId);
      expect(pull.open_id).toBe(view.cycles[0].id);
      expect(pull.status).toBe('bought_back');
      expect(pull.source).toBe('bonus');
      expect(pull.revealed_at).not.toBeNull();
      expect(announcements).toEqual([pull.id]);
      const transactions = await packs.listCreditTransactions({
        customer_id: customer.id,
      });
      expect(
        transactions.filter((row) => row.reason === 'pack_open'),
      ).toHaveLength(1);
      expect(
        transactions.filter((row) => row.pull_id === pull.id),
      ).toHaveLength(1);
      expect(
        (await api.get('/admin/automation/sandbox', { headers })).data.profiles,
      ).toEqual([]);
      // Warm the public feed before later draws, then verify cache expiry includes them too.
      expect(
        (await api.get('/store/pulls/recent', { headers: storeHeaders })).data
          .pulls,
      ).toEqual([
        expect.objectContaining({
          id: pull.id,
          name: 'Live card',
          pack_id: 'live-pack',
        }),
      ]);
      for (let index = 0; index < 2; index++) {
        const scheduled = (await api.get('/admin/automation/live', { headers }))
          .data;
        const dueAt = scheduled.nextRunAt;
        expect(dueAt).toBeGreaterThan(firstDrawAt);
        expect(await tickLive(container, () => dueAt - 1)).toBe(false);
        const attempts = await Promise.all([
          tickLive(container, () => dueAt),
          tickLive(container, () => dueAt),
        ]);
        expect(attempts.filter(Boolean)).toHaveLength(1);
      }
      const completed = (await api.get('/admin/automation/live', { headers }))
        .data;
      expect(completed.status).toBe('completed');
      expect(completed.spentCents).toBe(3000);
      expect(completed.cycles).toHaveLength(3);
      expect(
        completed.cycles.every(
          (cycle: {
            differenceCents: number;
            bonusDifferenceCents: number;
            error: string | null;
          }) =>
            cycle.differenceCents === 0 &&
            cycle.bonusDifferenceCents === 0 &&
            cycle.error === null,
        ),
      ).toBe(true);
      expect(await packs.creditSummary(customer.id)).toMatchObject({
        balance: 21.6,
        bonusBalance: 0,
      });
      const settledPulls = await packs.listPulls({ customer_id: customer.id });
      expect(settledPulls).toHaveLength(3);
      // Later ticks publish only their new pulls, never backfill the missed first post.
      expect(announcements.slice().sort()).toEqual(
        settledPulls.map((row) => row.id).sort(),
      );
      expect(settledPulls.every((row) => row.revealed_at !== null)).toBe(true);
      expect(settledPulls.map((row) => row.source).sort()).toEqual([
        'bonus',
        'pack',
        'pack',
      ]);
      expect(settledPulls.every((row) => row.status === 'bought_back')).toBe(
        true,
      );
      const settledTransactions = await packs.listCreditTransactions({
        customer_id: customer.id,
      });
      expect(
        await packs.pullDrought({ packId: 'live-pack', rarity: 'Immortal' }),
      ).toBe(3);
      expect(
        await packs.pullGaps({
          packId: 'live-pack',
          rarity: 'Rare',
          limit: 20,
        }),
      ).toMatchObject({
        current: 0,
        avg: 1,
        hits: expect.arrayContaining(
          settledPulls.map((row) =>
            expect.objectContaining({ id: row.id, gap: 1 }),
          ),
        ),
      });
      expect(
        settledTransactions.filter((row) => row.reason === 'pack_open'),
      ).toHaveLength(3);
      for (const row of settledPulls) {
        expect(
          settledTransactions.filter(
            (transaction) => transaction.pull_id === row.id,
          ),
        ).toHaveLength(1);
      }
      // The feed serves a stale body while it rebuilds (#835); read it fresh.
      clearRecentPullsCache();
      for (const path of [
        '/store/pulls/recent',
        '/store/pulls/recent?pack_id=live-pack',
      ]) {
        const publicBody = (await api.get(path, { headers: storeHeaders }))
          .data;
        expect(publicBody.drought).toMatchObject({ Immortal: 3, Legendary: 3 });
        const feed = publicBody.pulls;
        expect(feed).toHaveLength(3);
        expect(feed.map((row: { id: string }) => row.id).sort()).toEqual(
          settledPulls.map((row) => row.id).sort(),
        );
        for (const row of feed) {
          expect(row).toMatchObject({
            name: 'Live card',
            pack_id: 'live-pack',
            pack_title: 'Live pack',
            rarity: 'Rare',
            marketPriceMyr: 8,
            who: 'Live Player',
          });
          expect(row).not.toHaveProperty('customer_id');
          expect(row).not.toHaveProperty('email');
        }
      }
      await api.post('/admin/automation/live', { action: 'stop' }, { headers });
      expect(await tickLive(container)).toBe(false);
      expect(
        (await packs.listAndCountPulls({ customer_id: customer.id }))[1],
      ).toBe(3);
      await api.post(
        '/admin/automation/live',
        {
          action: 'run',
          config: {
            ...config,
            maxCyclesPerAccount: 1,
            timingMode: 'humanized',
            humanizedRegion: 'mysg',
          },
        },
        { headers },
      );
      const tomorrow = new Date(Date.now() + 86400000)
        .toISOString()
        .slice(0, 10);
      let clock = Date.parse(`${tomorrow}T00:00:00Z`);
      expect(await tickLive(container, () => clock)).toBe(false);
      const sleeping = (await api.get('/admin/automation/live', { headers }))
        .data;
      expect(sleeping).toMatchObject({
        status: 'running',
        cycles: [],
      });
      // Desktop routines shift sleep by ±75 minutes, daily jitter by ±20,
      // then add up to ten minutes of stable wake lag.
      expect(sleeping.nextRunAt).toBeGreaterThanOrEqual(
        clock + (240 - 95) * 60000,
      );
      expect(sleeping.nextRunAt).toBeLessThanOrEqual(
        clock + (240 + 95 + 10) * 60000,
      );
      expect(sleeping.schedules[0].humanized.timerKind).toBe('OFFLINE_END');
      expect(sleeping.schedules[0].waitReason).toContain('Sleeping');
      expect(await tickLive(container, () => clock + 1000)).toBe(false);
      expect(
        (await packs.listAndCountPulls({ customer_id: customer.id }))[1],
      ).toBe(3);
      let humanized = sleeping;
      for (
        let attempt = 0;
        attempt < 100 && humanized.cycles.length === 0;
        attempt++
      ) {
        clock = humanized.nextRunAt;
        await tickLive(container, () => clock);
        humanized = (await api.get('/admin/automation/live', { headers })).data;
      }
      expect(humanized.status).toBe('completed');
      expect(humanized.cycles).toHaveLength(1);
      expect(humanized.cycles[0]).toMatchObject({
        differenceCents: 0,
        bonusDifferenceCents: 0,
        costCents: 1000,
        saleCents: 720,
        error: null,
      });
      const [humanizedPull] = await packs.listPulls({
        id: humanized.cycles[0].pullId,
      });
      expect(humanizedPull.status).toBe('bought_back');
      expect(
        (
          await api.get('/store/pulls/recent?pack_id=live-pack&rarity=Rare', {
            headers: storeHeaders,
          })
        ).data.pulls,
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: humanizedPull.id }),
        ]),
      );
      const [competitor] = await customers.createCustomers([
        {
          email: 'rank-competitor@example.test',
          first_name: 'Rank Competitor',
          has_account: true,
        },
      ]);
      await packs.createCreditTransactions([
        { customer_id: competitor.id, amount: -10, reason: 'pack_open' },
      ]);
      await packs.createPulls([
        {
          customer_id: competitor.id,
          pack_id: 'live-pack',
          card_id: 'live-card',
          rolled_at: new Date(),
          source: 'pack',
          recorded_value_usd: 1000,
        },
      ]);
      const ownRows = await packs.leaderboardTop({
        sinceMs: null,
        limit: 1,
        customerIds: [customer.id],
      });
      expect(ownRows).toEqual([
        expect.objectContaining({
          customer_id: customer.id,
          pulls: 4,
          volume: 32,
        }),
      ]);
      await api.post(
        '/admin/automation/live',
        {
          action: 'run',
          config: {
            ...config,
            maxCyclesPerAccount: 1,
            rankTargets: [
              { customerId: customer.id, period: 'alltime', targetRank: 1 },
            ],
          },
        },
        { headers },
      );
      expect(await tickLive(container)).toBe(true);
      const rankedDraw = (await api.get('/admin/automation/live', { headers }))
        .data;
      expect(rankedDraw.status).toBe('running');
      expect(rankedDraw.cycles).toEqual([
        expect.objectContaining({
          differenceCents: 0,
          bonusDifferenceCents: 0,
          error: null,
        }),
      ]);
      expect(
        (await packs.listPulls({ id: rankedDraw.cycles[0].pullId }))[0].status,
      ).toBe('bought_back');
      let rankClock = rankedDraw.nextRunAt;
      // Still below its rank: the goal account keeps drawing past the
      // per-account cap (1) until the goal is done.
      expect(await tickLive(container, () => rankClock)).toBe(true);
      const pushing = (await api.get('/admin/automation/live', { headers }))
        .data;
      expect(pushing.status).toBe('running');
      expect(pushing.rankGoals[0]).toMatchObject({
        done: false,
        status: { currentRank: 2, mode: 'live' },
      });
      expect(pushing.cycles).toHaveLength(2);
      await api.post('/admin/automation/live', { action: 'stop' }, { headers });
      // The feed serves a stale body while it rebuilds (#835); read it fresh.
      clearRecentPullsCache();
      const feed = (
        await api.get('/store/pulls/recent?pack_id=live-pack', {
          headers: storeHeaders,
        })
      ).data.pulls as Record<string, unknown>[];
      const botRow = feed.find((row) => row.id === rankedDraw.cycles[0].pullId);
      const playerRow = feed.find((row) => row.who === 'Rank Competitor');
      // A live bot draw reads exactly like any other player's pull in the
      // public feed: its own name, the same fields, no automation marker.
      expect(botRow).toMatchObject({ who: 'Live Player' });
      expect(Object.keys(botRow!).sort()).toEqual(
        Object.keys(playerRow!).sort(),
      );
      await api.post(
        '/admin/automation/live',
        {
          action: 'run',
          config: {
            ...config,
            maxCyclesPerAccount: 1,
            rankTargets: [
              { customerId: customer.id, period: 'alltime', targetRank: 2 },
            ],
          },
        },
        { headers },
      );
      rankClock = Date.now();
      expect(await tickLive(container, () => rankClock)).toBe(false);
      expect(await tickLive(container, () => rankClock + 2000)).toBe(false);
      const secured = (await api.get('/admin/automation/live', { headers }))
        .data;
      expect(secured.status).toBe('completed');
      expect(secured.cycles).toEqual([]);
      expect(secured.rankGoals[0]).toMatchObject({
        done: true,
        status: { state: 'secured', currentRank: 2 },
      });
      // Repeat: a finished round starts the next one on its own, archived in
      // history, at the pack prices of the moment.
      await api.post(
        '/admin/automation/live',
        {
          action: 'run',
          config: { ...config, maxCyclesPerAccount: 1, repeat: true },
        },
        { headers },
      );
      expect(await tickLive(container)).toBe(true);
      const firstRound = (await api.get('/admin/automation/live', { headers }))
        .data;
      expect(firstRound).toMatchObject({ status: 'running' });
      expect(firstRound.cycles).toHaveLength(1);
      await packs.updatePacks({
        selector: { slug: 'live-pack' },
        data: { price: 10.5 },
      });
      expect(await tickLive(container, () => firstRound.nextRunAt)).toBe(false);
      const nextRound = (await api.get('/admin/automation/live', { headers }))
        .data;
      expect(nextRound).toMatchObject({
        status: 'running',
        cycles: [],
        packPricesCents: { 'live-pack': 1050 },
      });
      expect(nextRound.runId).not.toBe(firstRound.runId);
      expect(nextRound.history[0]).toMatchObject({
        runId: firstRound.runId,
        draws: 1,
        settled: 1,
      });
      await api.post('/admin/automation/live', { action: 'stop' }, { headers });
      await packs.updatePacks({
        selector: { slug: 'live-pack' },
        data: { price: 10 },
      });
      // Simulate a disable arriving after the next draw, at the separate sell boundary.
      const pullsBeforeDisable = (
        await packs.listAndCountPulls({ customer_id: customer.id })
      )[1];
      const disabled = jest
        .spyOn(packs, 'isAccountDisabled')
        .mockImplementation(
          async (id) =>
            (await packs.listAndCountPulls({ customer_id: id }))[1] >
            pullsBeforeDisable,
        );
      try {
        await api.post(
          '/admin/automation/live',
          { action: 'run', config },
          { headers },
        );
        expect(await tickLive(container)).toBe(true);
        const refused = (await api.get('/admin/automation/live', { headers }))
          .data;
        expect(refused.status).toBe('failed');
        expect(refused.cycles[0].error).toContain('disabled');
        const [unsold] = await packs.listPulls({
          id: refused.cycles[0].pullId,
        });
        expect(unsold.status).toBe('vaulted');
        expect(
          await packs.listCreditTransactions({ pull_id: unsold.id }),
        ).toHaveLength(0);
      } finally {
        disabled.mockRestore();
      }
      // The scheduler ran the stub, so the real job never raced the ticks above.
      expect(automationLiveJob).toHaveBeenCalled();
    });
  },
});
