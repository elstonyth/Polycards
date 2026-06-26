/**
 * maybeAutoUnfreezeForCustomer (F1) — integration:modules
 *
 * The buyback step writes its credit OUTSIDE mutateCreditAtomic, so it skipped
 * the inline auto-unfreeze: a customer auto-frozen by a clawback could repay via
 * buyback yet stay frozen with a $0 spendable balance. This helper — called after
 * the buyback credit commits — lifts an AUTO freeze whose debt is now repaid,
 * under the same per-customer `credit:` advisory lock and re-reading the committed
 * balance. Asserted contracts:
 *  - AUTO-frozen + balance >= 0  -> unfrozen, unfreeze_cause 'repaid'
 *  - AUTO-frozen + balance < 0   -> stays frozen (debt not cleared)
 *  - MANUAL-frozen + balance >= 0 -> stays frozen (admin freeze is sticky)
 *  - not frozen                   -> no-op
 *
 * Test-runner caveat: moduleIntegrationTestRunner rebuilds schema from MODELS, so
 * every seeded field is set explicitly (no reliance on prod-only DB defaults).
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
import NotificationRead from '../models/notification-read';
import RewardDraw from '../models/reward-draw';

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
    NotificationRead,
    RewardDraw,
  ],
  testSuite: ({ service }) => {
    const freeze = (customerId: string, cause: 'auto' | 'manual') =>
      service.createCustomerAccountStates([
        { customer_id: customerId, frozen: true, cause, frozen_at: new Date() },
      ]);
    // A signed credit row (credit +, debit −). reason is set explicitly.
    const ledger = (customerId: string, amount: number, reason: string) =>
      service.createCreditTransactions([
        { customer_id: customerId, amount, reason: reason as 'adjustment' },
      ]);
    const stateOf = async (customerId: string) => {
      const [s] = await service.listCustomerAccountStates(
        { customer_id: customerId },
        { take: 1 },
      );
      return s;
    };

    describe('maybeAutoUnfreezeForCustomer', () => {
      it('lifts an AUTO freeze once a buyback repays the balance to >= 0', async () => {
        const c = 'cus_unfreeze_ok';
        await ledger(c, -10, 'adjustment'); // clawback debt
        await freeze(c, 'auto');
        await ledger(c, 10, 'buyback'); // sell a card -> balance 0

        await service.maybeAutoUnfreezeForCustomer(c);

        const s = await stateOf(c);
        expect(s.frozen).toBe(false);
        expect(s.unfreeze_cause).toBe('repaid');
      });

      it('keeps an AUTO freeze while the balance is still negative', async () => {
        const c = 'cus_unfreeze_neg';
        await ledger(c, -10, 'adjustment');
        await freeze(c, 'auto');
        await ledger(c, 5, 'buyback'); // partial -> balance −5

        await service.maybeAutoUnfreezeForCustomer(c);

        const s = await stateOf(c);
        expect(s.frozen).toBe(true);
      });

      it('never auto-clears a MANUAL (admin) freeze even when repaid', async () => {
        const c = 'cus_unfreeze_manual';
        await freeze(c, 'manual');
        await ledger(c, 100, 'buyback');

        await service.maybeAutoUnfreezeForCustomer(c);

        const s = await stateOf(c);
        expect(s.frozen).toBe(true);
      });

      it('is a no-op for a customer that was never frozen', async () => {
        const c = 'cus_unfreeze_none';
        await ledger(c, 50, 'buyback');

        await expect(
          service.maybeAutoUnfreezeForCustomer(c),
        ).resolves.toBeUndefined();
      });
    });
  },
});
