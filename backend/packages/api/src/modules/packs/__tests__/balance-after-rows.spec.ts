import path from 'path';
import { moduleIntegrationTestRunner } from '@medusajs/test-utils';
import { PACKS_MODULE } from '../index';
import type PacksModuleService from '../service';
import CreditTransaction from '../models/credit-transaction';

jest.setTimeout(300 * 1000);

// The Wallet tab's "Balance after" column: the SQL itself, on a real database.
moduleIntegrationTestRunner<PacksModuleService>({
  moduleName: PACKS_MODULE,
  resolve: path.resolve(__dirname, '../../..', 'modules/packs'),
  moduleModels: [CreditTransaction],
  testSuite: ({ service }) => {
    const row = async (
      customer_id: string,
      amount: number,
      created_at: string,
    ) => {
      const [created] = await service.createCreditTransactions([
        {
          customer_id,
          amount,
          reason: 'adjustment' as const,
          created_at: new Date(created_at),
        },
      ] as unknown as Parameters<typeof service.createCreditTransactions>[0]);
      return created.id as string;
    };

    describe('balanceAfterRows', () => {
      it("runs this customer's live rows in ledger order, ties by id", async () => {
        const first = await row('A', 10, '2026-10-01T00:00:00Z');
        const tiedOne = await row('A', -2.5, '2026-10-02T00:00:00Z');
        const tiedTwo = await row('A', 100, '2026-10-02T00:00:00Z');
        const deleted = await row('A', 999, '2026-10-01T12:00:00Z');
        await service.softDeleteCreditTransactions([deleted]);
        const other = await row('B', 5000, '2026-09-01T00:00:00Z');

        const after = await service.balanceAfterRows('A', [
          first,
          tiedOne,
          tiedTwo,
          deleted,
          other,
        ]);

        expect(after.get(first)).toBe(10);
        // Whichever tied row the id order puts last holds the whole sum.
        const [, lastTied] = [tiedOne, tiedTwo].sort();
        expect(after.get(lastTied)).toBe(107.5);
        expect(after.has(deleted)).toBe(false);
        expect(after.has(other)).toBe(false);
      });

      it('rounds each row to sen, as every balance read does', async () => {
        const one = await row('C', 0.004, '2026-10-01T00:00:00Z');
        const two = await row('C', 0.004, '2026-10-02T00:00:00Z');
        const after = await service.balanceAfterRows('C', [one, two]);
        // Summing first then rounding would give 0.01 beside a wallet of 0.00.
        expect(after.get(two)).toBe(0);
      });

      it('asks nothing for no rows', async () => {
        expect((await service.balanceAfterRows('A', [])).size).toBe(0);
      });
    });
  },
});
