/**
 * mutateCreditAtomic idempotency-reference contract — integration:modules
 *
 * Security audit 2026-06-23 hardening (top-up replay protection). The dedupe
 * MUST be scoped to the customer that owns the credit:lock the mutation holds,
 * not matched globally by `reference`:
 *
 *  A. Two DIFFERENT customers presenting the SAME literal idempotencyReference
 *     must EACH be credited (the dedupe is per-customer, matching the per-
 *     customer advisory lock). This is the defense-in-depth contract — the
 *     real top-up path namespaces the reference by customer, so a black-box
 *     HTTP test can't reach it; this exercises the primitive directly.
 *  B. The SAME customer replaying the SAME reference is credited exactly once
 *     (the core replay guard).
 *  C. After the original row is (soft-)deleted, a replay re-credits — the
 *     dedupe read must ignore soft-deleted rows.
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
    const rowsFor = (customerId: string) =>
      service.listCreditTransactions({ customer_id: customerId }, { take: 100 });

    describe('mutateCreditAtomic idempotencyReference', () => {
      it('A. is customer-scoped: two customers with the same reference are each credited', async () => {
        const ref = 'topup-idem:SHARED-KEY';
        const a = await service.mutateCreditAtomic({
          customerId: 'cus_idem_A',
          amount: 10,
          reason: 'topup',
          idempotencyReference: ref,
        });
        const b = await service.mutateCreditAtomic({
          customerId: 'cus_idem_B',
          amount: 10,
          reason: 'topup',
          idempotencyReference: ref,
        });

        expect(a.replayed).toBe(false);
        // B shares A's reference but is a different customer — must NOT be
        // treated as a replay of A's credit.
        expect(b.replayed).toBe(false);
        expect(b.id).not.toBe(a.id);
        expect(await rowsFor('cus_idem_A')).toHaveLength(1);
        expect(await rowsFor('cus_idem_B')).toHaveLength(1);
        expect(b.balance).toBe(10);
      });

      it('B. dedupes a same-customer replay to exactly one credit', async () => {
        const ref = 'topup-idem:cus_idem_C:k1';
        const first = await service.mutateCreditAtomic({
          customerId: 'cus_idem_C',
          amount: 25,
          reason: 'topup',
          idempotencyReference: ref,
        });
        const replay = await service.mutateCreditAtomic({
          customerId: 'cus_idem_C',
          amount: 25,
          reason: 'topup',
          idempotencyReference: ref,
        });

        expect(first.replayed).toBe(false);
        expect(replay.replayed).toBe(true);
        expect(replay.id).toBe(first.id);
        expect(replay.amount).toBe(25);
        expect(await rowsFor('cus_idem_C')).toHaveLength(1);
      });

      it('C. re-credits after the original row is soft-deleted (dedupe ignores deleted rows)', async () => {
        const ref = 'topup-idem:cus_idem_D:k1';
        const first = await service.mutateCreditAtomic({
          customerId: 'cus_idem_D',
          amount: 40,
          reason: 'topup',
          idempotencyReference: ref,
        });
        await service.deleteCreditTransactionsGuarded([first.id]);

        const after = await service.mutateCreditAtomic({
          customerId: 'cus_idem_D',
          amount: 40,
          reason: 'topup',
          idempotencyReference: ref,
        });

        expect(after.replayed).toBe(false);
        expect(after.id).not.toBe(first.id);
        const live = await rowsFor('cus_idem_D');
        expect(live).toHaveLength(1); // the deleted row is excluded
        expect(after.balance).toBe(40);
      });
    });
  },
});
