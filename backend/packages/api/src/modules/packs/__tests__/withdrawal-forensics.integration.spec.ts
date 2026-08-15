import path from 'path';
import { moduleIntegrationTestRunner } from '@medusajs/test-utils';
import { PACKS_MODULE } from '../index';
import type PacksModuleService from '../service';
import GlobePayWithdrawal from '../models/globepay-withdrawal';

jest.setTimeout(300 * 1000);

// Plan 095, against a REAL database. The forensics columns are only worth
// having if the two writers cannot erase each other, and no mock can answer
// that: the unit specs assert on call arguments, while the risk lives in what
// the generated service's find-then-write actually flushes.
//
// The production sequence these reproduce, in order:
//   1. startGlobePayWithdrawal inserts the row and keeps the returned object
//   2. GlobePay POSTs Payout Verification to a DIFFERENT request, which stamps
//      verify_outcome on that same row
//   3. their SubmitWithdrawal response comes back a refusal, and the ORIGINAL
//      request closes the row from the object it captured in step 1
//
// If step 3 wrote back the entity as it looked in step 1, step 2's stamp would
// vanish — and a row whose verify_outcome is null is exactly how this code
// tells "their verification never reached us" from "we refused it". That
// misreading would send an operator hunting a reachability fault that does not
// exist, which is the whole diagnosis inverted.
moduleIntegrationTestRunner<PacksModuleService>({
  moduleName: PACKS_MODULE,
  resolve: path.resolve(__dirname, '../../..', 'modules/packs'),
  // The runner generates the schema from THIS list, never from the
  // migrations — a model missing here fails as `relation … does not exist`.
  moduleModels: [GlobePayWithdrawal],
  testSuite: ({ service }) => {
    const newRow = (merchantTransactionId: string) =>
      service.createGlobePayWithdrawals([
        {
          merchant_transaction_id: merchantTransactionId,
          customer_id: 'cus_forensics',
          amount: 400,
          bank_code: 'MYHLBB',
          account_number: '12345678901',
          account_holder_name: 'AHMAD BIN ALI',
          status: 'pending',
        },
      ]);

    const reread = async (id: string) => {
      const [row] = await service.listGlobePayWithdrawals({ id }, { take: 1 });
      return row;
    };

    describe('payout forensics columns', () => {
      it('keeps a verification stamp that lands between the insert and the close', async () => {
        const [inserted] = await newRow('PC-forensics-1');

        // Step 2, from the verification request.
        await service.updateGlobePayWithdrawals({
          id: inserted.id,
          verify_outcome: '2026-08-12T00:00:00.000Z rejected: amount 403.2 !=',
        });

        // Step 3, from the object step 1 captured — deliberately the STALE
        // one, which is what the refusal branch actually holds.
        await service.updateGlobePayWithdrawals({
          id: inserted.id,
          status: 'failed',
          failure_reason: 'submit refused: codes=PMT10013 httpStatus=200',
        });

        const row = await reread(inserted.id);
        expect(row.status).toBe('failed');
        expect(row.failure_reason).toMatch(/PMT10013/);
        // The assertion this file exists for.
        expect(row.verify_outcome).toMatch(/rejected: amount/);
      });

      it('keeps it through the selector-scoped close the sweep and deny use', async () => {
        const [inserted] = await newRow('PC-forensics-2');
        await service.updateGlobePayWithdrawals({
          id: inserted.id,
          verify_outcome: '2026-08-12T00:00:00.000Z success',
        });

        // refundGlobePayWithdrawal's terminal update — a different write shape
        // (selector + data), so it needs its own proof.
        await service.updateGlobePayWithdrawals({
          selector: { id: inserted.id, status: 'pending' },
          data: {
            status: 'failed',
            gateway_status: 5,
            failure_reason: 'sweep: requery statusId 5',
          },
        });

        const row = await reread(inserted.id);
        expect(row.status).toBe('failed');
        expect(row.gateway_status).toBe(5);
        expect(row.failure_reason).toBe('sweep: requery statusId 5');
        // A payout their verification APPROVED and that still failed is the
        // finding that points away from our code entirely — it must survive.
        expect(row.verify_outcome).toMatch(/success/);
      });

      it('leaves both columns null on a row nothing has explained', async () => {
        // NULL is load-bearing: it is how the admin page decides to warn that
        // no verification ever arrived. A default of '' would silence that.
        const [inserted] = await newRow('PC-forensics-3');
        const row = await reread(inserted.id);
        expect(row.verify_outcome).toBeNull();
        expect(row.failure_reason).toBeNull();
      });
    });
  },
});
