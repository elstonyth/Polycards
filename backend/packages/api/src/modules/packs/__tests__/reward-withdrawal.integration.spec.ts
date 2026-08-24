/**
 * recordRewardWithdrawal (B7) — integration:modules
 *
 * Ship a vaulted reward-prize Pull as a physical delivery, under the per-customer
 * `credit:` advisory lock (mirrors settleOpen / settleRewardDraw — NOT the
 * lockless requestDeliveryStep). One transaction: validate the Pull is
 * source='reward', owned, status='vaulted' (else 'invalid'); COUNT today's
 * is_reward delivery_order rows; >= withdrawals_per_day → 'capped'; else create a
 * DeliveryOrder(is_reward:true) + DeliveryOrderItem and flip the Pull
 * vaulted → delivering under the lock (that flip — not the per-(order,pull)
 * unique — is the one-active-shipment enforcer).
 *
 * Asserted contracts:
 *  - Withdraw a vaulted reward Pull → 'requested'; a DeliveryOrder(is_reward:true)
 *    exists; the Pull is flipped to 'delivering'; a DeliveryOrderItem joins them.
 *  - A second same-day withdrawal (default withdrawals_per_day=1) → 'capped',
 *    with the second Pull left untouched (still 'vaulted') and no second order.
 *  - Withdrawing a source='pack' Pull via this path → 'invalid' (no order, Pull
 *    untouched).
 *
 * Test-runner caveat: moduleIntegrationTestRunner rebuilds schema from MODELS, so
 * hand-written CHECK/partial-unique constraints are ABSENT here. The cap is proven
 * via the advisory-lock + COUNT runtime path (the daily-cap invariant), and the
 * one-active-shipment guard via the status flip — exactly what runs in prod.
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
import CustomerAccountState from '../models/customer-account-state';
import AdminActionAudit from '../models/admin-action-audit';
import VipMemberState from '../models/vip-member-state';
import VipRewardGrant from '../models/vip-reward-grant';
import NotificationRead from '../models/notification-read';
import RewardDraw from '../models/reward-draw';

jest.setTimeout(300 * 1000);

// A complete, snapshot-able shipping address (matches snapshotAddress' required
// fields). Passed straight to recordRewardWithdrawal; the route resolves the real
// one upstream — the service just snapshots whatever it is handed.
const ADDRESS = {
  first_name: 'Ada',
  last_name: 'Lovelace',
  address_1: '1 Analytical Engine Way',
  city: 'Kuala Lumpur',
  postal_code: '50000',
  country_code: 'my',
};

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
    CustomerAccountState,
    AdminActionAudit,
    VipMemberState,
    VipRewardGrant,
    NotificationRead,
    RewardDraw,
  ],
  testSuite: ({ service }) => {
    // Seed one Pull directly (no draw round-trip needed — B7 only cares about the
    // Pull's source/owner/status, not how it was created).
    const seedPull = async (opts: {
      customerId: string;
      source: 'pack' | 'reward';
    }) => {
      const [pull] = await service.createPulls([
        {
          customer_id: opts.customerId,
          pack_id: 'reward-box-c',
          card_id: 'prize-handle',
          order_id: null,
          rolled_at: new Date(),
          source: opts.source,
        },
      ]);
      return pull.id;
    };

    describe('recordRewardWithdrawal', () => {
      // recordRewardWithdrawal fails closed (returns 'invalid') when the global
      // redemption gate is off — so these tests need it ON. Previously this suite
      // set NOTHING and silently relied on another suite leaking the flag; that
      // surfaced when payout-freeze-guard.spec.ts (correctly) restored the env.
      // Own the flag here and restore it, so the suite is order-independent.
      const prevGate = process.env.REWARDS_REDEMPTION_ENABLED;
      beforeAll(() => {
        process.env.REWARDS_REDEMPTION_ENABLED = 'true';
      });
      afterAll(() => {
        if (prevGate === undefined)
          delete process.env.REWARDS_REDEMPTION_ENABLED;
        else process.env.REWARDS_REDEMPTION_ENABLED = prevGate;
      });

      it('ships a vaulted reward Pull: requested + is_reward order + Pull flipped', async () => {
        const customerId = 'cus_wd_ok';
        const pullId = await seedPull({ customerId, source: 'reward' });

        const res = await service.recordRewardWithdrawal(
          customerId,
          pullId,
          ADDRESS,
        );
        expect(res.status).toBe('requested');

        const orders = await service.listDeliveryOrders(
          { customer_id: customerId },
          { take: 10 },
        );
        expect(orders).toHaveLength(1);
        expect(orders[0].is_reward).toBe(true);

        const items = await service.listDeliveryOrderItems(
          { delivery_order_id: orders[0].id },
          { take: 10 },
        );
        expect(items).toHaveLength(1);
        expect(items[0].pull_id).toBe(pullId);

        const [pull] = await service.listPulls({ id: pullId }, { take: 1 });
        expect(pull.status).toBe('delivering');
      });

      it('caps a second same-day withdrawal (default withdrawals_per_day=1)', async () => {
        const customerId = 'cus_wd_cap';
        const first = await seedPull({ customerId, source: 'reward' });
        const second = await seedPull({ customerId, source: 'reward' });

        const r1 = await service.recordRewardWithdrawal(
          customerId,
          first,
          ADDRESS,
        );
        expect(r1.status).toBe('requested');

        const r2 = await service.recordRewardWithdrawal(
          customerId,
          second,
          ADDRESS,
        );
        expect(r2.status).toBe('capped');

        // Only one order; the second Pull is left untouched (still vaulted).
        const orders = await service.listDeliveryOrders(
          { customer_id: customerId },
          { take: 10 },
        );
        expect(orders).toHaveLength(1);
        const [pull2] = await service.listPulls({ id: second }, { take: 1 });
        expect(pull2.status).toBe('vaulted');
      });

      it('rejects a source=pack Pull as invalid (no order, Pull untouched)', async () => {
        const customerId = 'cus_wd_pack';
        const pullId = await seedPull({ customerId, source: 'pack' });

        const res = await service.recordRewardWithdrawal(
          customerId,
          pullId,
          ADDRESS,
        );
        expect(res.status).toBe('invalid');

        const orders = await service.listDeliveryOrders(
          { customer_id: customerId },
          { take: 10 },
        );
        expect(orders).toHaveLength(0);
        const [pull] = await service.listPulls({ id: pullId }, { take: 1 });
        expect(pull.status).toBe('vaulted');
      });
    });
  },
});
