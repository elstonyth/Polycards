import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { Modules } from '@medusajs/framework/utils';
import type PacksModuleService from '../../src/modules/packs/service';

jest.setTimeout(240 * 1000);

// PacksModuleService.payoutNumberStanding is raw SQL over two tables the
// route spec can only fake: customer.metadata.bank_accounts (JSONB, owned by
// the customer module) and gateway_withdrawal. This pins it against the real
// schema: who counts as "another holder", and who does not.
medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ getContainer }) => {
    describe('payoutNumberStanding holders', () => {
      const NUMBER = '123456789012';

      it('finds saved and paid holders, and skips self, failed payouts and deleted savers', async () => {
        const customers = getContainer().resolve(Modules.CUSTOMER);
        const packs = getContainer().resolve<PacksModuleService>('packs');
        const saved = (bankCode: string, pad = '') => ({
          bank_accounts: [
            {
              id: `${bankCode}-${NUMBER}`,
              bankCode,
              bankName: 'Maybank',
              accountNumber: pad + NUMBER,
              accountHolderName: 'TAN AH KOW',
            },
          ],
        });
        const [me, saver, legacySaver, gone, payee, failedPayee, odd, padded, spaced] =
          await customers.createCustomers([
            { email: 'me@shared.test', metadata: saved('MBBEMYKL') },
            { email: 'saver@shared.test', metadata: saved('MBBEMYKL') },
            { email: 'legacy@shared.test', metadata: saved('MYMB2U') },
            { email: 'gone@shared.test', metadata: saved('MBBEMYKL') },
            { email: 'payee@shared.test' },
            { email: 'failed@shared.test' },
            // A non-array bank_accounts must not break the scan.
            { email: 'odd@shared.test', metadata: { bank_accounts: 'x' } },
            // The same number padded with a leading zero.
            { email: 'padded@shared.test', metadata: saved('MBBEMYKL', '0') },
            // An older entry saved with spaces, before digits-only validation.
            {
              email: 'spaced@shared.test',
              metadata: { bank_accounts: [{ ...saved('MBBEMYKL').bank_accounts[0], accountNumber: '1234 5678 9012' }] },
            },
          ]);
        await customers.softDeleteCustomers([gone.id]);
        const row = (
          customerId: string,
          ref: string,
          status: 'settled' | 'failed',
        ) => ({
          merchant_transaction_id: ref,
          customer_id: customerId,
          amount: 100,
          bank_code: 'MBBEMYKL',
          account_number: NUMBER,
          account_holder_name: 'TAN AH KOW',
          status,
        });
        await packs.createGatewayWithdrawals([
          row(payee.id, 'PC-shared-paid', 'settled'),
          row(failedPayee.id, 'PC-shared-failed', 'failed'),
          row(me.id, 'PC-shared-mine', 'settled'),
        ]);

        const { holders } = await packs.payoutNumberStanding(me.id, {
          bankCode: 'MBBEMYKL',
          accountNumber: NUMBER,
        });
        const ids = holders.map((h) => h.customerId).sort();
        // The retired-gateway code (MYMB2U) is the same bank.
        expect(ids).toEqual(
          [legacySaver.id, padded.id, payee.id, saver.id, spaced.id].sort(),
        );
        // A saver holds it unpaid; a payee was paid to it.
        expect(holders.find((h) => h.customerId === saver.id)?.paid).toBe(false);
        expect(holders.find((h) => h.customerId === payee.id)?.paid).toBe(true);
        expect(ids).not.toContain(odd.id);

        expect(
          (
            await packs.payoutNumberStanding(me.id, {
              bankCode: 'MBBEMYKL',
              accountNumber: '999',
            })
          ).holders,
        ).toEqual([]);
      });
    });
  },
});
