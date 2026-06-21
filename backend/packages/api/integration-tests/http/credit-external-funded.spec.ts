import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { topUpCreditsWorkflow } from '../../src/workflows/topup-credits';

jest.setTimeout(240 * 1000);

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ getContainer }) => {
    describe('credit_transaction.external_funded_cents column', () => {
      it('persists and reads back the signed external-funded sen', async () => {
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        const [row] = await packs.createCreditTransactions([
          {
            customer_id: 'cus_extfund_test',
            amount: 100,
            reason: 'topup' as const,
            pull_id: null,
            reference: 'mock_ext',
            external_funded_cents: 10000,
          } as Record<string, unknown>,
        ]);
        const [fetched] = await packs.listCreditTransactions(
          { id: row.id },
          { take: 1 },
        );
        expect(
          Number(
            (fetched as { external_funded_cents?: number | null })
              .external_funded_cents,
          ),
        ).toBe(10000);
      });

      it('defaults to null (treated as 0) when not supplied', async () => {
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        const [row] = await packs.createCreditTransactions([
          {
            customer_id: 'cus_extfund_null',
            amount: 5,
            reason: 'buyback' as const,
            pull_id: 'pull_extfund_null',
            reference: null,
          },
        ]);
        const [fetched] = await packs.listCreditTransactions(
          { id: row.id },
          { take: 1 },
        );
        const ext = (fetched as { external_funded_cents?: number | null })
          .external_funded_cents;
        expect(ext == null ? 0 : Number(ext)).toBe(0);
      });
    });

    describe('topUpCreditsStep external-funded wiring', () => {
      it('a real top-up workflow run stamps external_funded_cents', async () => {
        const cust = 'cus_topup_wf';
        const { result } = await topUpCreditsWorkflow(getContainer()).run({
          input: { customer_id: cust, amount: 80 },
        });
        expect(result.balance).toBe(80);

        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        const summary = await packs.creditSummary(cust);
        expect(summary.topupTotal).toBe(80);
        const [row] = await packs.listCreditTransactions(
          { customer_id: cust },
          { take: 1, order: { created_at: 'DESC' } },
        );
        expect(
          Number(
            (row as { external_funded_cents?: number | null })
              .external_funded_cents,
          ),
        ).toBe(8000);
      });
    });

    describe('mutateCreditAtomic external-funded stamping', () => {
      it('stamps a top-up with the full external sen', async () => {
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        const cust = 'cus_mca_topup';
        await packs.mutateCreditAtomic({
          customerId: cust,
          amount: 100,
          reason: 'topup',
          reference: 'mock_a',
        });
        const summary = await packs.creditSummary(cust);
        expect(summary.externalFundedSpendTotal).toBe(0); // nothing consumed yet
        const [row] = await packs.listCreditTransactions(
          { customer_id: cust },
          { take: 1, order: { created_at: 'DESC' } },
        );
        expect(
          Number(
            (row as { external_funded_cents?: number | null })
              .external_funded_cents,
          ),
        ).toBe(10000);
      });

      it('a pack_open consumes min(price, external balance) and snapshots −consumed', async () => {
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        const cust = 'cus_mca_open';
        await packs.mutateCreditAtomic({
          customerId: cust,
          amount: 100,
          reason: 'topup',
          reference: 'mock_b',
        });
        // Add internal (buyback) credit OUTSIDE the external counter.
        await packs.createCreditTransactions([
          {
            customer_id: cust,
            amount: 100,
            reason: 'buyback' as const,
            pull_id: 'pull_mca_open',
            reference: null,
          },
        ]);
        // Open RM150: 100 external available, so consume 10000 sen, leaving 0.
        await packs.mutateCreditAtomic({
          customerId: cust,
          amount: -150,
          reason: 'pack_open',
          floor: 0,
        });
        const summary = await packs.creditSummary(cust);
        expect(summary.externalFundedSpendTotal).toBe(100); // only the 100 external
        // Second open RM40 funded purely by leftover buyback credit → 0 external.
        await packs.mutateCreditAtomic({
          customerId: cust,
          amount: -40,
          reason: 'pack_open',
          floor: 0,
        });
        const after = await packs.creditSummary(cust);
        expect(after.externalFundedSpendTotal).toBe(100); // still capped at top-ups
      });

      it('an adjustment stamps 0 external (internal grant never raises VIP basis)', async () => {
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        const cust = 'cus_mca_adjust';
        await packs.mutateCreditAtomic({
          customerId: cust,
          amount: 500,
          reason: 'adjustment',
          reference: 'comp',
        });
        const summary = await packs.creditSummary(cust);
        expect(summary.externalFundedSpendTotal).toBe(0);
        const [row] = await packs.listCreditTransactions(
          { customer_id: cust },
          { take: 1, order: { created_at: 'DESC' } },
        );
        const ext = (row as { external_funded_cents?: number | null })
          .external_funded_cents;
        expect(ext == null ? 0 : Number(ext)).toBe(0);
      });
    });

    describe('mutateCreditAtomic sign invariants', () => {
      it('rejects a non-positive top-up', async () => {
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        await expect(
          packs.mutateCreditAtomic({
            customerId: 'cus_sign_topup',
            amount: -5,
            reason: 'topup',
            reference: 'bad',
          }),
        ).rejects.toThrow(/topup amount must be greater than 0/);
      });

      it('rejects a non-negative pack_open', async () => {
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        await expect(
          packs.mutateCreditAtomic({
            customerId: 'cus_sign_open',
            amount: 5,
            reason: 'pack_open',
            floor: 0,
          }),
        ).rejects.toThrow(/pack_open amount must be less than 0/);
      });
    });
  },
});
