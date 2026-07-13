import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { deleteCardWorkflow } from '../../src/workflows/delete-card';
import {
  foldLedgerRow,
  EMPTY_TOTALS,
  totalsToUsd,
} from '../../src/modules/packs/credit-summary';

jest.setTimeout(240 * 1000);

const PACK_SLUG = 'pst-pack';
const CARD_HANDLE = 'pst-card';

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ getContainer }) => {
    describe('transitionPullStatus — guarded, atomic pull-status flips', () => {
      let packs: PacksModuleService;

      beforeEach(async () => {
        packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        await packs.createPacks([
          {
            slug: PACK_SLUG,
            title: 'PST Pack',
            category: 'pokemon',
            price: 10,
            image: '/cdn/test-pack.webp',
          },
        ]);
        await packs.createCards([
          {
            handle: CARD_HANDLE,
            name: 'PST Card',
            set: 'Test Set',
            grader: 'PSA',
            grade: '10',
            market_value: 50,
            image: '/cdn/test-card.webp',
          },
        ]);
      });

      const mkPull = async (
        status: 'vaulted' | 'delivering' | 'bought_back',
      ) => {
        const [pull] = await packs.createPulls([
          {
            customer_id: 'cus_pst_test',
            pack_id: PACK_SLUG,
            card_id: CARD_HANDLE,
            order_id: null,
            rolled_at: new Date(),
            status,
          },
        ]);
        return pull;
      };

      it('flips vaulted → bought_back and stamps buyback fields', async () => {
        const pull = await mkPull('vaulted');
        await packs.transitionPullStatus({
          ids: [pull.id],
          from: 'vaulted',
          to: 'bought_back',
          set: { buyback_amount: 216, buyback_at: new Date() },
        });
        const [fresh] = await packs.listPulls({ id: pull.id }, { take: 1 });
        expect(fresh.status).toBe('bought_back');
        expect(Number(fresh.buyback_amount)).toBe(216);
        expect(fresh.buyback_at).toBeTruthy();
      });

      it('throws when the pull is not in `from` (stale read simulation)', async () => {
        const pull = await mkPull('delivering');
        await expect(
          packs.transitionPullStatus({
            ids: [pull.id],
            from: 'vaulted',
            to: 'bought_back',
          }),
        ).rejects.toThrow(/changed state/i);
        const [fresh] = await packs.listPulls({ id: pull.id }, { take: 1 });
        expect(fresh.status).toBe('delivering'); // untouched
      });

      it('is all-or-nothing on a mixed batch (rollback proof)', async () => {
        const good = await mkPull('vaulted');
        const bad = await mkPull('delivering');
        await expect(
          packs.transitionPullStatus({
            ids: [good.id, bad.id],
            from: 'vaulted',
            to: 'delivering',
          }),
        ).rejects.toThrow(/changed state/i);
        // The matching row must have been rolled back too.
        const [freshGood] = await packs.listPulls({ id: good.id }, { take: 1 });
        expect(freshGood.status).toBe('vaulted');
      });

      describe('deleteCardStep — vault guard', () => {
        it('refuses to delete a card customers still hold', async () => {
          const pull = await mkPull('vaulted');
          void pull;
          // Workflow engine errors surface as deserialized plain objects (not
          // real Error instances) by the time .run() rethrows them, so
          // .rejects.toThrow() (which requires isError()) can't see them —
          // match on the message shape instead.
          await expect(
            deleteCardWorkflow(getContainer()).run({
              input: { handle: CARD_HANDLE },
            }),
          ).rejects.toMatchObject({
            message: expect.stringMatching(/still hold/i),
          });
          const [card] = await packs.listCards(
            { handle: CARD_HANDLE },
            { take: 1 },
          );
          expect(card).toBeTruthy(); // not deleted
        });

        it('refuses to delete while a copy is out for delivery', async () => {
          await mkPull('delivering');
          await expect(
            deleteCardWorkflow(getContainer()).run({
              input: { handle: CARD_HANDLE },
            }),
          ).rejects.toMatchObject({
            message: expect.stringMatching(/still hold/i),
          });
          const [card] = await packs.listCards(
            { handle: CARD_HANDLE },
            { take: 1 },
          );
          expect(card).toBeTruthy(); // not deleted
        });

        it('history (bought_back) does NOT block deletion', async () => {
          await mkPull('bought_back');
          await deleteCardWorkflow(getContainer()).run({
            input: { handle: CARD_HANDLE },
          });
          const cards = await packs.listCards(
            { handle: CARD_HANDLE },
            { take: 1 },
          );
          expect(cards).toHaveLength(0); // deleted
        });
      });

      describe('creditSummary — SQL matches the unit-tested fold', () => {
        it('agrees with foldLedgerRow on a mixed ledger', async () => {
          const CUS = 'cus_summary_oracle';
          await packs.createCreditTransactions([
            { customer_id: CUS, amount: 100, reason: 'topup', external_funded_cents: 10000 },
            { customer_id: CUS, amount: -30, reason: 'pack_open', external_funded_cents: -3000 },
            { customer_id: CUS, amount: 21.6, reason: 'buyback', external_funded_cents: 0 },
            { customer_id: CUS, amount: -5.55, reason: 'adjustment', external_funded_cents: 0 },
            { customer_id: CUS, amount: 30, reason: 'pack_open', external_funded_cents: 3000 }, // reversal mirror
          ]);
          const sql = await packs.creditSummary(CUS);
          const rows = await packs.listCreditTransactions(
            { customer_id: CUS },
            { take: 100 },
          );
          let acc = EMPTY_TOTALS;
          for (const t of rows) {
            acc = foldLedgerRow(acc, {
              amount: Number(t.amount),
              reason: t.reason,
              // Preserve null: coercing NULL→0 would lose the grandfathering
              // distinction the deposited-playthrough basis relies on (the SQL
              // gates on external_funded_cents IS NOT NULL). Coerce only non-null.
              externalFundedCents: (() => {
                const v = (t as { external_funded_cents?: number | null })
                  .external_funded_cents;
                return v == null ? null : Number(v);
              })(),
            });
          }
          expect(sql).toEqual(totalsToUsd(acc));
        });
      });
    });
  },
});
