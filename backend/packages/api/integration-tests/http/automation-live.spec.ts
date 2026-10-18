import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { Modules } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { tickLive } from '../../src/api/utils/automation-live-store';
import { mintSuperAdmin, unwrapResponse } from './utils';

jest.setTimeout(240_000);

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    it('settles every selected draw without a spend cap and publishes each pull to the storefront feed', async () => {
      const container = getContainer();
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
          amount: 20,
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
        { action: 'run', config },
        { headers },
      );
      const ticks = await Promise.all([
        tickLive(container),
        tickLive(container),
        tickLive(container),
      ]);
      expect(ticks.filter(Boolean)).toHaveLength(1);
      const view = (await api.get('/admin/automation/live', { headers })).data;
      expect(view.cycles).toHaveLength(1);
      expect(view.cycles[0]).toMatchObject({
        customerId: customer.id,
        costCents: 1000,
        saleCents: 720,
        startingCents: 2000,
        endingCents: 1720,
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
        await new Promise((resolve) => setTimeout(resolve, 2100));
        const attempts = await Promise.all([
          tickLive(container),
          tickLive(container),
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
        balance: 11.6,
        bonusBalance: 0,
      });
      const settledPulls = await packs.listPulls({ customer_id: customer.id });
      expect(settledPulls).toHaveLength(3);
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
      await new Promise((resolve) => setTimeout(resolve, 5100));
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
      // Simulate a disable arriving after the next draw, at the separate sell boundary.
      const disabled = jest
        .spyOn(packs, 'isAccountDisabled')
        .mockImplementation(
          async (id) =>
            (await packs.listAndCountPulls({ customer_id: id }))[1] > 3,
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
    });
  },
});
