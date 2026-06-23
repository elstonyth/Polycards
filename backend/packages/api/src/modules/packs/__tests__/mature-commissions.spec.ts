/**
 * Commission maturity job integration test — integration:modules (Task 7 / Phase 3b)
 *
 * Verifies the four required cases from task-7-brief:
 *  1. A PAST-matures_at pending commission → matureDueCommissions(spy) flips it
 *     to 'available'; spy called once with its id.
 *  2. A 2nd run flips 0 (idempotent).
 *  3. A 'reversed' commission with past matures_at is NEVER flipped.
 *  4. A FUTURE-matures_at pending commission is NOT flipped.
 */

import path from 'path';
import { moduleIntegrationTestRunner } from '@medusajs/test-utils';
import { PACKS_MODULE } from '../index';
import type PacksModuleService from '../service';
import Pack from '../models/pack';
import Card from '../models/card';
import PackOdds from '../models/pack-odds';
import Pull from '../models/pull';
import CreditTransaction from '../models/credit-transaction';
import DeliveryOrder from '../models/delivery-order';
import DeliveryOrderItem from '../models/delivery-order-item';
import VipLevel from '../models/vip-level';
import RewardsSettings from '../models/rewards-settings';
import ReferralRelationship from '../models/referral-relationship';
import Commission from '../models/commission';
import CustomerAccountState from '../models/customer-account-state';
import AdminActionAudit from '../models/admin-action-audit';
import VipMemberState from '../models/vip-member-state';
import VipRewardGrant from '../models/vip-reward-grant';

jest.setTimeout(300 * 1000);

// Helper: create a commission row with arbitrary status + matures_at via the
// credit-transaction + commission ORM (same path as production).
async function seedCommission(
  service: PacksModuleService,
  opts: {
    beneficiary: string;
    status: 'pending' | 'available' | 'reversed' | 'suspended';
    maturesAt: Date;
    sourceTransactionId: string;
    creditTxnId?: string;
  },
) {
  // We need a credit_transaction row as the backing row (commission FK).
  const ct = await service.createCreditTransactions({
    customer_id: opts.beneficiary,
    amount: 1.0,
    reason: 'direct_referral',
    source_transaction_id: opts.sourceTransactionId,
    reference: null,
    pull_id: null,
    external_funded_cents: 0,
  });

  const commission = await service.createCommissions({
    credit_transaction_id: ct.id,
    beneficiary: opts.beneficiary,
    source_transaction_id: opts.sourceTransactionId,
    generation: 1,
    kind: 'direct',
    status: opts.status,
    matures_at: opts.maturesAt,
    effective_pct: 0.01,
    reversal_transaction_id: null,
  });

  return commission;
}

moduleIntegrationTestRunner<PacksModuleService>({
  moduleName: PACKS_MODULE,
  resolve: path.resolve(__dirname, '../../..', 'modules/packs'),
  moduleModels: [
    Pack,
    Card,
    PackOdds,
    Pull,
    CreditTransaction,
    DeliveryOrder,
    DeliveryOrderItem,
    VipLevel,
    RewardsSettings,
    ReferralRelationship,
    Commission,
    CustomerAccountState,
    AdminActionAudit,
    VipMemberState,
    VipRewardGrant,
  ],
  testSuite: ({ service }) => {
    describe('matureDueCommissions (maturity job)', () => {
      it('flips a past-matures_at pending commission to available; spy called once', async () => {
        // Arrange: commission that already matured (matures_at in the past)
        const beneficiary = 'cust_mature_1';
        const pastDate = new Date(Date.now() - 1000 * 60 * 60 * 24); // 1 day ago
        const commission = await seedCommission(service, {
          beneficiary,
          status: 'pending',
          maturesAt: pastDate,
          sourceTransactionId: 'open_mature_1',
        });

        const spy = jest.fn<Promise<void>, [string, string, boolean]>().mockResolvedValue(undefined);

        // Act
        const { flipped } = await service.matureDueCommissions(spy);

        // Assert: row flipped to 'available'
        expect(flipped).toBeGreaterThanOrEqual(1);

        const [updated] = await service.listCommissions(
          { id: commission.id },
          { take: 1 },
        );
        expect(updated!.status).toBe('available');

        // spy called exactly once with (beneficiary, commissionId, frozen=false)
        const calls = spy.mock.calls.filter(([, id]) => id === commission.id);
        expect(calls).toHaveLength(1);
        expect(calls[0]![0]).toBe(beneficiary);
        expect(calls[0]![2]).toBe(false); // not frozen
      });

      it('second run flips 0 rows (idempotent)', async () => {
        // Arrange: a commission already flipped to 'available' by the first run
        const beneficiary = 'cust_mature_idem_1';
        const pastDate = new Date(Date.now() - 1000 * 60 * 60 * 24);
        const commission = await seedCommission(service, {
          beneficiary,
          status: 'pending',
          maturesAt: pastDate,
          sourceTransactionId: 'open_mature_idem_1',
        });

        const spy1 = jest.fn<Promise<void>, [string, string, boolean]>().mockResolvedValue(undefined);
        const result1 = await service.matureDueCommissions(spy1);
        // First run should flip this one (and potentially others from previous tests)
        const commissionsFlippedFirst = spy1.mock.calls.filter(
          ([, id]) => id === commission.id,
        );
        expect(commissionsFlippedFirst).toHaveLength(1);

        // Second run: should flip 0 for THIS commission
        const spy2 = jest.fn<Promise<void>, [string, string, boolean]>().mockResolvedValue(undefined);
        await service.matureDueCommissions(spy2);

        const callsSecond = spy2.mock.calls.filter(
          ([, id]) => id === commission.id,
        );
        expect(callsSecond).toHaveLength(0);

        // Row is still 'available' (not re-flipped or regressed)
        const [row] = await service.listCommissions({ id: commission.id }, { take: 1 });
        expect(row!.status).toBe('available');
      });

      it('NEVER flips a reversed commission even if matures_at is in the past', async () => {
        // Arrange: a 'reversed' commission with a past matures_at
        const beneficiary = 'cust_mature_reversed_1';
        const pastDate = new Date(Date.now() - 1000 * 60 * 60 * 24);
        const commission = await seedCommission(service, {
          beneficiary,
          status: 'reversed',
          maturesAt: pastDate,
          sourceTransactionId: 'open_mature_reversed_1',
        });

        const spy = jest.fn<Promise<void>, [string, string, boolean]>().mockResolvedValue(undefined);
        await service.matureDueCommissions(spy);

        // Row must still be 'reversed'
        const [row] = await service.listCommissions({ id: commission.id }, { take: 1 });
        expect(row!.status).toBe('reversed');

        // spy never called for this commission id
        const calls = spy.mock.calls.filter(([, id]) => id === commission.id);
        expect(calls).toHaveLength(0);
      });

      it('does NOT flip a pending commission whose matures_at is in the future', async () => {
        // Arrange: commission with future matures_at
        const beneficiary = 'cust_mature_future_1';
        const futureDate = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30); // 30 days ahead
        const commission = await seedCommission(service, {
          beneficiary,
          status: 'pending',
          maturesAt: futureDate,
          sourceTransactionId: 'open_mature_future_1',
        });

        const spy = jest.fn<Promise<void>, [string, string, boolean]>().mockResolvedValue(undefined);
        await service.matureDueCommissions(spy);

        // Row must still be 'pending'
        const [row] = await service.listCommissions({ id: commission.id }, { take: 1 });
        expect(row!.status).toBe('pending');

        // spy never called
        const calls = spy.mock.calls.filter(([, id]) => id === commission.id);
        expect(calls).toHaveLength(0);
      });
    });
  },
});
