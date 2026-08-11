/**
 * claimGlobePayWithdrawalStatus against a REAL Postgres — integration:modules
 *
 * WHY this exists on top of the unit spec (globepay-withdrawal.unit.spec.ts,
 * which pins the statement's shape against a fake `em`): the claim's whole
 * value is its return value, and that comes from what the MikroORM driver
 * hands back for an `UPDATE … RETURNING id`. A fake `em` returns whatever the
 * test says, so it cannot tell us that `rows.length` is a real number here.
 * Get that wrong and every claim answers false — approve silently becomes a
 * no-op and no held withdrawal can ever be released.
 *
 * The mutual exclusion itself is a Postgres property of a single conditional
 * UPDATE (the predicate is re-evaluated against committed state after the row
 * lock releases). These tests run sequentially, so what they prove is the
 * half that lives in our code: a claim on a row whose status no longer
 * matches touches nothing and answers false.
 */

import path from 'path';
import { moduleIntegrationTestRunner } from '@medusajs/test-utils';
import { PACKS_MODULE } from '../index';
import type PacksModuleService from '../service';
import GlobePayWithdrawal from '../models/globepay-withdrawal';

jest.setTimeout(300 * 1000);

moduleIntegrationTestRunner<PacksModuleService>({
  moduleName: PACKS_MODULE,
  resolve: path.resolve(__dirname, '../../..', 'modules/packs'),
  moduleModels: [GlobePayWithdrawal],
  testSuite: ({ service }) => {
    const seed = async (
      suffix: string,
      status: 'pending' | 'settled' | 'failed' | 'held',
    ) => {
      const [row] = await service.createGlobePayWithdrawals([
        {
          merchant_transaction_id: `PW-CLAIM-${suffix}`,
          customer_id: 'cus_claim',
          amount: 1500,
          bank_code: 'MBB',
          account_number: '1234567890',
          account_holder_name: 'AHMAD BIN ALI',
          status,
        },
      ]);
      return row;
    };
    const statusOf = async (id: string) =>
      (await service.listGlobePayWithdrawals({ id }, { take: 1 }))[0]?.status;

    describe('claimGlobePayWithdrawalStatus', () => {
      it('the FIRST claim wins and a repeat loses — the double-approve guard', async () => {
        const row = await seed('1', 'held');

        await expect(
          service.claimGlobePayWithdrawalStatus({
            id: row.id,
            from: ['held'],
            to: 'pending',
          }),
        ).resolves.toBe(true);
        expect(await statusOf(row.id)).toBe('pending');

        // The row is no longer 'held', so the second claim matches no row.
        // This is what a double-clicked Approve hits, and it is the only
        // thing between it and a duplicate payout.
        await expect(
          service.claimGlobePayWithdrawalStatus({
            id: row.id,
            from: ['held'],
            to: 'pending',
          }),
        ).resolves.toBe(false);
        expect(await statusOf(row.id)).toBe('pending');
      });

      it('leaves a settled row untouched — deny cannot reach one', async () => {
        const row = await seed('2', 'settled');
        await expect(
          service.claimGlobePayWithdrawalStatus({
            id: row.id,
            from: ['held', 'failed'],
            to: 'failed',
          }),
        ).resolves.toBe(false);
        expect(await statusOf(row.id)).toBe('settled');
      });

      it("deny's claim is re-runnable: held -> failed, then failed -> failed", async () => {
        const row = await seed('3', 'held');
        const claim = () =>
          service.claimGlobePayWithdrawalStatus({
            id: row.id,
            from: ['held', 'failed'],
            to: 'failed',
          });
        await expect(claim()).resolves.toBe(true);
        // The recovery path: an operator re-denying a row whose refund never
        // landed must get through, or that debit is stranded forever.
        await expect(claim()).resolves.toBe(true);
        expect(await statusOf(row.id)).toBe('failed');
      });

      it('never claims a soft-deleted row', async () => {
        const row = await seed('4', 'held');
        await service.softDeleteGlobePayWithdrawals([row.id]);
        await expect(
          service.claimGlobePayWithdrawalStatus({
            id: row.id,
            from: ['held'],
            to: 'pending',
          }),
        ).resolves.toBe(false);
      });

      it('a row that does not exist is a lost claim, not a crash', async () => {
        await expect(
          service.claimGlobePayWithdrawalStatus({
            id: 'gpw_does_not_exist',
            from: ['held'],
            to: 'pending',
          }),
        ).resolves.toBe(false);
      });
    });
  },
});
