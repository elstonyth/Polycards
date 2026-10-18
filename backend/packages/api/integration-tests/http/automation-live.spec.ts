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
    it('runs an actual paid draw and buyback once, preserving sandbox isolation and both balances', async () => {
      const container = getContainer();
      const token = await mintSuperAdmin(
        container,
        api,
        'live-admin@example.test',
        'live-test-password',
      );
      const headers = { authorization: `Bearer ${token}` };
      const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
      const customers = container.resolve(Modules.CUSTOMER);
      const [customer] = await customers.createCustomers([
        { email: 'live-account@example.test', has_account: true },
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
        maxCyclesPerAccount: 1,
        maxSpendMyr: 10,
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
      await api.post('/admin/automation/live', { action: 'stop' }, { headers });
      expect(await tickLive(container)).toBe(false);
      expect(
        (await packs.listAndCountPulls({ customer_id: customer.id }))[1],
      ).toBe(1);
      // Simulate a disable arriving after the next draw, at the separate sell boundary.
      const disabled = jest
        .spyOn(packs, 'isAccountDisabled')
        .mockImplementation(
          async (id) =>
            (await packs.listAndCountPulls({ customer_id: id }))[1] > 1,
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
