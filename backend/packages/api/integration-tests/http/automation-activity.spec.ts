import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { Modules } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { mintSuperAdmin, unwrapResponse } from './utils';

jest.setTimeout(240_000);

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('GET /admin/automation/activity', () => {
      it('reports only Automation accounts: totals, tiers, per account and Legendary+ hits', async () => {
        const container = getContainer();
        const token = await mintSuperAdmin(
          container,
          api,
          'activity-admin@example.test',
          'activity-test-password',
        );
        const headers = { authorization: `Bearer ${token}` };
        const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
        const [house, player] = await container
          .resolve(Modules.CUSTOMER)
          .createCustomers([
            {
              email: 'house@example.test',
              first_name: 'House',
              has_account: true,
            },
            { email: 'player@example.test', has_account: true },
          ]);
        await packs.createPacks([
          {
            slug: 'act-pack',
            title: 'Act Pack',
            category: 'pokemon',
            price: 45,
            image: '/x.webp',
          },
        ]);
        await packs.createCards(
          ['act-common', 'act-legend'].map((handle) => ({
            handle,
            name: handle,
            set: 'S',
            grader: 'PSA',
            grade: '10',
            market_value: 10,
            image: 'https://cdn.example.test/card.webp',
          })),
        );
        await packs.createPackOdds([
          {
            pack_id: 'act-pack',
            card_id: 'act-common',
            rarity: 'Common',
            weight: 1,
          },
          {
            pack_id: 'act-pack',
            card_id: 'act-legend',
            rarity: 'Legendary',
            weight: 1,
          },
        ]);
        const pull = (customer_id: string, card_id: string, ago: number) => ({
          customer_id,
          pack_id: 'act-pack',
          card_id,
          order_id: null,
          rolled_at: new Date(Date.now() - ago),
          source: 'pack' as const,
          recorded_value_usd: 10,
        });
        await packs.createPulls([
          pull(house.id, 'act-common', 60_000),
          pull(house.id, 'act-legend', 30_000),
          pull(house.id, 'act-legend', 9 * 86_400_000), // outside 7 days
          pull(player.id, 'act-legend', 1000), // not an Automation account
        ]);
        await packs.createAutomationMonitors([
          {
            id: 'global',
            accounts: { customer_ids: [house.id] },
            updated_by: 'test',
          },
        ]);

        expect(
          (await unwrapResponse(api.get('/admin/automation/activity'))).status,
        ).toBe(401);
        expect(
          (
            await unwrapResponse(
              api.get('/admin/automation/activity?days=3', { headers }),
            )
          ).status,
        ).toBe(400);

        const { data } = await api.get('/admin/automation/activity?days=7', {
          headers,
        });
        expect(data.windowDays).toBe(7);
        expect(data.hitTiers).toEqual(['Immortal', 'Legendary']);
        expect(data.names).toEqual({ [house.id]: 'House' });
        const sum = (key: 'draws' | 'costMyr') =>
          data.days.reduce(
            (total: number, row: Record<string, number>) => total + row[key],
            0,
          );
        expect(sum('draws')).toBe(2);
        expect(sum('costMyr')).toBe(90);
        expect(
          Object.fromEntries(
            data.tiers.map((row: { rarity: string; draws: number }) => [
              row.rarity,
              row.draws,
            ]),
          ),
        ).toEqual({ Common: 1, Legendary: 1 });
        expect(data.accounts).toEqual([
          expect.objectContaining({ customerId: house.id, draws: 2, hits: 1 }),
        ]);
        expect(data.hits).toEqual([
          expect.objectContaining({
            customerId: house.id,
            rarity: 'Legendary',
            cardName: 'act-legend',
            packTitle: 'Act Pack',
            sold: false,
          }),
        ]);
      });
    });
  },
});
