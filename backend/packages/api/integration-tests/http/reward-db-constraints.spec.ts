import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';

jest.setTimeout(240 * 1000);

// Reward-economy DB-constraint guards (CodeRabbit #4/#5).
//
// The MODULE test runner (moduleIntegrationTestRunner) rebuilds schema from
// MODELS, so the hand-written cross-column CHECK (pack_odds_kind_payout_check),
// the Pull.source NOT-NULL DEFAULT, and the partial-unique index
// (UQ_reward_draw_customer_day_ordinal) are ABSENT there — the module specs
// can't assert them. This HTTP runner runs the real MIGRATIONS against a real
// Postgres, so it is the only place these constraints exist. We drive the
// module service directly (no routes needed) to exercise them.

const PACK_SLUG = 'reward-db-constraints-box';

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ getContainer }) => {
    describe('reward-economy DB constraints (migrated DB)', () => {
      let packs: PacksModuleService;

      beforeEach(async () => {
        packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        // A reward_box Pack to hang reward PackOdds rows on (pack_id is plain
        // text = Pack.slug; seeding the Pack keeps the rows realistic).
        await packs.createPacks([
          {
            slug: PACK_SLUG,
            title: 'Reward DB Constraints Box',
            category: 'reward_box',
            price: 0,
            image: '/cdn/reward-db.webp',
            pool_enabled: true,
            draws_per_day: 3,
          } as Parameters<typeof packs.createPacks>[0][number],
        ]);
      });

      // (a) pack_odds_kind_payout_check — the cross-column CHECK.

      it('createPackOdds REJECTS a malformed reward row (kind=credit WITH product_handle)', async () => {
        await expect(
          packs.createPackOdds([
            {
              pack_id: PACK_SLUG,
              card_id: null,
              rarity: null,
              weight: 10,
              locked: false,
              kind: 'credit',
              // Violates the CHECK: a credit row must have product_handle NULL.
              product_handle: 'should-not-be-here',
              credit_amount: 5,
            } as Parameters<typeof packs.createPackOdds>[0][number],
          ]),
        ).rejects.toThrow();
      });

      it('createPackOdds ACCEPTS a valid kind=credit reward row', async () => {
        const [row] = await packs.createPackOdds([
          {
            pack_id: PACK_SLUG,
            card_id: null,
            rarity: null,
            weight: 10,
            locked: false,
            kind: 'credit',
            product_handle: null,
            credit_amount: 5,
          } as Parameters<typeof packs.createPackOdds>[0][number],
        ]);
        expect(row.id).toBeDefined();
        expect(row.kind).toBe('credit');
        expect(Number(row.credit_amount)).toBe(5);
      });

      // (b) Pull.source NOT-NULL DEFAULT 'pack'.

      it('a Pull created WITHOUT source defaults to pack', async () => {
        const [pull] = await packs.createPulls([
          {
            customer_id: 'cust_db_constraints',
            pack_id: PACK_SLUG,
            card_id: 'some-card-handle',
            order_id: null,
            rolled_at: new Date(),
            // source intentionally omitted — DB DEFAULT must fill it.
          } as Parameters<typeof packs.createPulls>[0][number],
        ]);
        expect(pull.source).toBe('pack');
      });

      // (c) UQ_reward_draw_customer_day_ordinal — partial-unique on
      //     (customer_id, draw_day, draw_ordinal) WHERE deleted_at IS NULL.

      it('a second reward_draw with the SAME (customer_id, draw_day, draw_ordinal) REJECTS', async () => {
        const base = {
          customer_id: 'cust_uniq_db',
          tier: 'c',
          draw_day: '2026-06-25',
          draw_ordinal: 1,
          prize_kind: 'nothing' as const,
          prize_snapshot: {},
          vault_pull_id: null,
          credit_txn_id: null,
          status: 'drawn' as const,
        };

        // First insert succeeds.
        const [first] = await packs.createRewardDraws([
          base as Parameters<typeof packs.createRewardDraws>[0][number],
        ]);
        expect(first.id).toBeDefined();

        // Second insert on the same tuple violates the partial-unique index.
        await expect(
          packs.createRewardDraws([
            base as Parameters<typeof packs.createRewardDraws>[0][number],
          ]),
        ).rejects.toThrow();
      });
    });
  },
});
