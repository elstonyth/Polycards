import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { mintSuperAdmin, unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

// Economy report: GET /admin/economy returns lifetime ledger totals, the
// outstanding vault liability, and a per-active-pack theoretical RTP table —
// all from directly-seeded rows so every number is exactly predictable.

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('admin economy report', () => {
      let adminToken: string;

      beforeEach(async () => {
        adminToken = await mintSuperAdmin(
          getContainer(),
          api,
          'economy-admin@test.dev',
          'economy-test-password-1',
        );
      });

      const economy = (headers: Record<string, string>) =>
        unwrapResponse(api.get('/admin/economy', { headers }));

      it('rejects an unauthenticated read with 401', async () => {
        expect((await economy({})).status).toBe(401);
      });

      it('reports exact totals, liability, and per-pack RTP', async () => {
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);

        // Ledger: $100 topup, two opens (-$25, -$25), one buyback (+$11.61),
        // one adjustment (+$5) → revenue 50, payouts 11.61, net 38.39.
        await packs.createCreditTransactions([
          {
            customer_id: 'cus_a',
            amount: 100,
            reason: 'topup' as const,
            pull_id: null,
            reference: 'ref',
          },
          {
            customer_id: 'cus_a',
            amount: -25,
            reason: 'pack_open' as const,
            pull_id: null,
            reference: null,
          },
          {
            customer_id: 'cus_a',
            amount: -25,
            reason: 'pack_open' as const,
            pull_id: null,
            reference: null,
          },
          {
            customer_id: 'cus_a',
            amount: 11.61,
            reason: 'buyback' as const,
            pull_id: null,
            reference: null,
          },
          {
            customer_id: 'cus_a',
            amount: 5,
            reason: 'adjustment' as const,
            pull_id: null,
            reference: 'grant',
          },
        ]);

        // Cards: $10 and $30 USD FMV. The report converts FMV to MYR at the live
        // rate (no FxRate row seeded → default 4.7), so $10→RM47, $30→RM141;
        // EV/RTP additionally apply each card's display multiplier.
        // Vault: TWO vaulted pulls of the $10 card (liability RM94) + one
        // bought-back (excluded).
        await packs.createCards([
          {
            handle: 'eco-low',
            name: 'Eco Low',
            set: 'QA',
            grader: 'PSA',
            grade: '9',
            market_value: 10,
            image: '/qa.png',
          },
          {
            handle: 'eco-high',
            name: 'Eco High',
            set: 'QA',
            grader: 'PSA',
            grade: '10',
            market_value: 30,
            // Custom multiplier: proves EV resolves PER CARD (a flat-1.2
            // regression would pass if both cards rode the DB default).
            market_multiplier: 2,
            image: '/qa.png',
          },
        ]);
        await packs.createPulls([
          {
            customer_id: 'cus_a',
            pack_id: 'eco-pack',
            card_id: 'eco-low',
            status: 'vaulted' as const,
            rolled_at: new Date(),
          },
          {
            customer_id: 'cus_a',
            pack_id: 'eco-pack',
            card_id: 'eco-low',
            status: 'vaulted' as const,
            rolled_at: new Date(),
          },
          {
            customer_id: 'cus_a',
            pack_id: 'eco-pack',
            card_id: 'eco-high',
            status: 'bought_back' as const,
            buyback_amount: 27,
            rolled_at: new Date(),
          },
        ]);

        // Pack: price 25 (MYR credits), 50/50 odds over the two cards. EV uses
        // DISPLAY values (FMV × the card's own multiplier): eco-low rides the
        // 1.2 default (RM56.40), eco-high carries a custom 2 (RM282) →
        // EV RM169.20 (0.5×56.4 + 0.5×282), RTP 676.8% (169.2/25). A draft
        // pack must NOT appear in the table.
        await packs.createPacks([
          {
            slug: 'eco-pack',
            title: 'Eco Pack',
            category: 'pokemon',
            price: 25,
            image: '/qa.png',
            status: 'active' as const,
            rank: 0,
          },
          {
            slug: 'eco-draft',
            title: 'Eco Draft',
            category: 'pokemon',
            price: 25,
            image: '/qa.png',
            status: 'draft' as const,
            rank: 1,
          },
        ]);
        await packs.createPackOdds([
          {
            pack_id: 'eco-pack',
            card_id: 'eco-low',
            rarity: 'Common' as const,
            weight: 5000,
            locked: false,
          },
          {
            pack_id: 'eco-pack',
            card_id: 'eco-high',
            rarity: 'Rare' as const,
            weight: 5000,
            locked: false,
          },
        ]);

        const res = await economy({ authorization: `Bearer ${adminToken}` });
        expect(res.status).toBe(200);

        expect(res.data.totals).toEqual({
          revenue: 50,
          payouts: 11.61,
          topups: 100,
          adjustments: 5,
          directReferral: 0,
          teamOverride: 0,
          commissionReversal: 0,
          cashout: 0,
          // Task A5 (audit #59) added the non-revenue rewardPromo bucket to the
          // report; no reward credits are seeded here, so it must be 0.
          rewardPromo: 0,
          net: 38.39,
        });

        expect(res.data.liability).toEqual({ count: 2, market_value: 94 });

        expect(res.data.packs).toHaveLength(1);
        expect(res.data.packs[0]).toMatchObject({
          slug: 'eco-pack',
          price: 25,
          ev: 169.2,
          rtp_pct: 676.8,
        });
      });
    });
  },
});
