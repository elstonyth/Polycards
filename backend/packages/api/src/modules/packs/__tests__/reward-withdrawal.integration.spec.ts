/**
 * recordRewardWithdrawal (B7) — integration:modules
 *
 * Ship a vaulted reward-prize Pull as a physical delivery, under the per-customer
 * `credit:` advisory lock (mirrors settleOpen / settleRewardDraw — NOT the
 * lockless requestDeliveryStep). One transaction: validate the Pull is
 * source='reward', owned, status='vaulted' (else 'invalid'); COUNT the
 * prize cards in today's shipments; >= withdrawals_per_day → 'capped'; else create a
 * DeliveryOrder(is_reward:true) + DeliveryOrderItem and flip the Pull
 * vaulted → delivering under the lock (that flip — not the per-(order,pull)
 * unique — is the one-active-shipment enforcer).
 *
 * Asserted contracts:
 *  - Withdraw a vaulted reward Pull → 'requested'; a DeliveryOrder(is_reward:true)
 *    exists; the Pull is flipped to 'delivering'; a DeliveryOrderItem joins them.
 *  - A second same-day withdrawal (default withdrawals_per_day=1) → 'capped',
 *    with the second Pull left untouched (still 'vaulted') and no second order.
 *  - A canceled reward order does not count toward that cap.
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
import TicketSpin from '../models/ticket-spin';
// lockedPullIds reads a reward pull's task claim (daily-task lock).
import TaskDefinition from '../models/task-definition';
import TaskClaim from '../models/task-claim';
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
import LedgerEntry from '../models/ledger-entry';
import LedgerSequence from '../models/ledger-sequence';
import { snapshotAddress } from '../delivery';
import { DEFAULT_MARKET_MULTIPLIER, displayMarketPrice } from '../pricing';

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
const SG_ADDRESS = {
  first_name: 'Tan',
  last_name: 'Ah Kow',
  address_1: '10 Marina Boulevard',
  city: 'Singapore',
  postal_code: '018983',
  country_code: 'sg',
};

moduleIntegrationTestRunner<PacksModuleService>({
  moduleName: PACKS_MODULE,
  resolve: path.resolve(__dirname, '../../..', 'modules/packs'),
  moduleModels: [
    TaskDefinition,
    TaskClaim,
    Pack,
    Card,
    PackOdds,
    Pull,
    TicketSpin,
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
    LedgerEntry,
    LedgerSequence,
  ],
  testSuite: ({ service }) => {
    // Seed one Pull directly (no draw round-trip needed — B7 only cares about the
    // Pull's source/owner/status, not how it was created).
    const seedPull = async (opts: {
      customerId: string;
      source: 'pack' | 'reward';
      /** Deliveries need one top-up ever (2026-10-11); idempotent per customer. */
      topup?: boolean;
    }) => {
      if (opts.topup !== false) {
        await service.mutateCreditAtomic({
          customerId: opts.customerId,
          amount: 50,
          reason: 'topup',
          idempotencyReference: `seed-topup:${opts.customerId}`,
        });
      }
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
      // Run with the global redemption gate OFF — prod's setting. Withdrawal is
      // not behind it (2026-10-08): /task claims mint live reward pulls, and
      // while recordRewardWithdrawal failed closed every one was unshippable.
      // Own the flag here and restore it, so the suite is order-independent.
      const prevGate = process.env.REWARDS_REDEMPTION_ENABLED;
      beforeAll(() => {
        delete process.env.REWARDS_REDEMPTION_ENABLED;
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

      // Every delivery pays its zone's shipping (2026-10-14): prizes too.
      it('charges a prize its zone fee: RM15 West, with the OD row a cancel refunds', async () => {
        const customerId = 'cus_wd_fee_my';
        const pullId = await seedPull({ customerId, source: 'reward' });
        expect(await service.creditBalance(customerId)).toBe(50);
        const res = await service.recordRewardWithdrawal(
          customerId,
          pullId,
          ADDRESS,
        );
        expect(res.status).toBe('requested');
        expect(await service.creditBalance(customerId)).toBe(35);
        const [order] = await service.listDeliveryOrders(
          { customer_id: customerId },
          { take: 1 },
        );
        expect(Number(order.shipping_fee)).toBe(15);
        expect(Number(order.insurance_fee)).toBe(0);

        // The customer cancels: the fee comes back through the OD reversal.
        await service.transitionDeliveryOrderStatus({
          orderId: order.id,
          to: 'canceled',
          trackingNumber: null,
          pullIds: [pullId],
        });
        expect(await service.creditBalance(customerId)).toBe(50);
      });

      it('insures a prize worth over RM200, like a vault card', async () => {
        const customerId = 'cus_wd_fee_insured';
        await service.createCards([
          {
            handle: 'big-prize',
            name: 'Big Prize',
            set: 'Base',
            grader: 'PSA',
            grade: '10',
            market_value: 100,
            image: 'x.webp',
          },
        ]);
        await service.mutateCreditAtomic({
          customerId,
          amount: 100,
          reason: 'topup',
          idempotencyReference: `seed-topup:${customerId}`,
        });
        const [pull] = await service.createPulls([
          {
            customer_id: customerId,
            pack_id: 'reward-box-c',
            card_id: 'big-prize',
            order_id: null,
            rolled_at: new Date(),
            source: 'reward',
          },
        ]);
        // USD 100 at RM 4 per USD: well over the RM200 protection line.
        const res = await service.recordRewardWithdrawal(
          customerId,
          pull.id,
          ADDRESS,
          4,
        );
        expect(res.status).toBe('requested');
        const [order] = await service.listDeliveryOrders(
          { customer_id: customerId },
          { take: 1 },
        );
        const insurance = Number(order.insurance_fee);
        expect(insurance).toBeGreaterThan(0);
        expect(await service.creditBalance(customerId)).toBeCloseTo(
          100 - 15 - insurance,
          2,
        );
      });

      it('reports how many prizes can still ship today', async () => {
        const customerId = 'cus_wd_allowance';
        const pullId = await seedPull({ customerId, source: 'reward' });
        expect(await service.rewardShippingAllowance(customerId)).toEqual({
          perDay: 1,
          usedToday: 0,
          remaining: 1,
        });
        await service.recordRewardWithdrawal(customerId, pullId, ADDRESS);
        expect(await service.rewardShippingAllowance(customerId)).toEqual({
          perDay: 1,
          usedToday: 1,
          remaining: 0,
        });
      });

      it('charges a Singapore prize RM50', async () => {
        const customerId = 'cus_wd_fee_sg';
        const pullId = await seedPull({ customerId, source: 'reward' });
        const res = await service.recordRewardWithdrawal(
          customerId,
          pullId,
          SG_ADDRESS,
        );
        expect(res.status).toBe('requested');
        expect(await service.creditBalance(customerId)).toBe(0);
        const [order] = await service.listDeliveryOrders(
          { customer_id: customerId },
          { take: 1 },
        );
        expect(Number(order.shipping_fee)).toBe(50);
      });

      it('refuses a prize the balance cannot ship (no order, Pull untouched)', async () => {
        const customerId = 'cus_wd_fee_short';
        const pullId = await seedPull({ customerId, source: 'reward' });
        // RM50 topped up, RM45 already spent: RM5 cannot cover Singapore's RM50.
        await service.mutateCreditAtomic({
          customerId,
          amount: -45,
          reason: 'delivery_fee',
          reference: 'earlier-order',
        });
        await expect(
          service.recordRewardWithdrawal(customerId, pullId, SG_ADDRESS),
        ).rejects.toThrow(/exceeds the customer's balance/);
        expect(
          await service.listDeliveryOrders({ customer_id: customerId }),
        ).toHaveLength(0);
        const [pull] = await service.listPulls({ id: pullId });
        expect(pull.status).toBe('vaulted');
        expect(await service.creditBalance(customerId)).toBe(5);
      });

      it('rejects a country we do not ship to, or a Singapore 5-digit postcode', async () => {
        const customerId = 'cus_wd_fee_bad';
        const pullId = await seedPull({ customerId, source: 'reward' });
        for (const address of [
          { ...ADDRESS, country_code: 'th' },
          { ...SG_ADDRESS, postal_code: '18983' },
        ]) {
          const res = await service.recordRewardWithdrawal(
            customerId,
            pullId,
            address,
          );
          expect(res.status).toBe('invalid');
        }
        expect(await service.creditBalance(customerId)).toBe(50);
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

      it('a canceled reward order does not use up the daily cap', async () => {
        const customerId = 'cus_wd_cancel';
        const first = await seedPull({ customerId, source: 'reward' });
        const second = await seedPull({ customerId, source: 'reward' });

        const r1 = await service.recordRewardWithdrawal(
          customerId,
          first,
          ADDRESS,
        );
        expect(r1.status).toBe('requested');
        const [order] = await service.listDeliveryOrders(
          { customer_id: customerId },
          { take: 1 },
        );
        await service.updateDeliveryOrders([
          { id: order.id, status: 'canceled' as const },
        ]);

        const r2 = await service.recordRewardWithdrawal(
          customerId,
          second,
          ADDRESS,
        );
        expect(r2.status).toBe('requested');
      });

      it('refuses an account that never topped up (no order, Pull untouched)', async () => {
        const customerId = 'cus_wd_notopup';
        const pullId = await seedPull({ customerId, source: 'reward', topup: false });
        await expect(
          service.recordRewardWithdrawal(customerId, pullId, ADDRESS),
        ).rejects.toThrow(/Top up at least once/);
        expect(
          await service.listDeliveryOrders({ customer_id: customerId }),
        ).toHaveLength(0);
        const [pull] = await service.listPulls({ id: pullId });
        expect(pull.status).toBe('vaulted');
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

    // One parcel, one shipping fee (2026-10-23): prize cards sent with vault
    // cards ride in the vault order instead of a second RM15 order.
    describe('createDeliveryOrderWithLedger — prize cards in the vault parcel', () => {
      const SNAPSHOT = snapshotAddress(ADDRESS)!;
      const FX = 4;
      const seedCard = (handle: string, usd: number) =>
        service.createCards([
          {
            handle,
            name: handle,
            set: 'Base',
            grader: 'PSA',
            grade: '10',
            market_value: usd,
            image: 'x.webp',
          },
        ]);
      const seedOwned = async (
        customerId: string,
        cardId: string,
        source: 'pack' | 'reward',
      ) => {
        const [pull] = await service.createPulls([
          {
            customer_id: customerId,
            pack_id: 'reward-box-c',
            card_id: cardId,
            order_id: null,
            rolled_at: new Date(),
            source,
          },
        ]);
        return pull.id;
      };

      it('ships vault + prize as ONE order with ONE fee; the prize stays out of vault_delta', async () => {
        const customerId = 'cus_parcel_mixed';
        await seedCard('parcel-vault', 10);
        await seedCard('parcel-prize', 20);
        await service.mutateCreditAtomic({
          customerId,
          amount: 50,
          reason: 'topup',
          idempotencyReference: `seed-topup:${customerId}`,
        });
        const vaultId = await seedOwned(customerId, 'parcel-vault', 'pack');
        const prizeId = await seedOwned(customerId, 'parcel-prize', 'reward');

        const { orderId } = await service.createDeliveryOrderWithLedger({
          customerId,
          snapshot: SNAPSHOT,
          pullIds: [vaultId, prizeId],
          fx: FX,
        });

        const orders = await service.listDeliveryOrders(
          { customer_id: customerId },
          { take: 10 },
        );
        expect(orders).toHaveLength(1);
        expect(orders[0].is_reward).toBe(true);
        expect(Number(orders[0].shipping_fee)).toBe(15);
        expect(Number(orders[0].insurance_fee)).toBe(0);
        expect(await service.creditBalance(customerId)).toBe(35);
        // Prize pulls stay outside value tracking: only the vault card debits.
        const [od] = await service.listLedgerEntries(
          { ref_id: orderId, type: 'OD' },
          { take: 1 },
        );
        expect(Number(od.vault_delta)).toBeCloseTo(
          -displayMarketPrice(10, FX, DEFAULT_MARKET_MULTIPLIER),
          2,
        );
        expect(await service.rewardShippingAllowance(customerId)).toMatchObject(
          { usedToday: 1, remaining: 0 },
        );

        // Cancel: the whole fee back, both cards back in the vault, and the
        // prize allowance freed.
        await service.transitionDeliveryOrderStatus({
          orderId,
          to: 'canceled',
          trackingNumber: null,
          pullIds: [vaultId, prizeId],
        });
        expect(await service.creditBalance(customerId)).toBe(50);
        const pulls = await service.listPulls(
          { id: [vaultId, prizeId] },
          { take: 2 },
        );
        expect(pulls.map((p) => p.status)).toEqual(['vaulted', 'vaulted']);
        expect(await service.rewardShippingAllowance(customerId)).toMatchObject(
          { usedToday: 0, remaining: 1 },
        );
      });

      it('counts a prize in a vault order against the daily cap, on both paths', async () => {
        const customerId = 'cus_parcel_cap';
        const first = await seedPull({ customerId, source: 'reward' });
        const second = await seedPull({ customerId, source: 'reward' });
        const third = await seedPull({ customerId, source: 'reward' });
        const vaultId = await seedPull({ customerId, source: 'pack' });

        // Two prizes in one parcel exceed withdrawals_per_day=1: nothing ships.
        await expect(
          service.createDeliveryOrderWithLedger({
            customerId,
            snapshot: SNAPSHOT,
            pullIds: [vaultId, first, second],
            fx: FX,
          }),
        ).rejects.toThrow(/Prize cards ship 1 per day/);
        expect(
          await service.listDeliveryOrders({ customer_id: customerId }),
        ).toHaveLength(0);
        expect(await service.creditBalance(customerId)).toBe(50);

        // One prize rides along; the reward route is then capped for the day.
        await service.createDeliveryOrderWithLedger({
          customerId,
          snapshot: SNAPSHOT,
          pullIds: [vaultId, first],
          fx: FX,
        });
        expect(await service.creditBalance(customerId)).toBe(35);
        expect(
          (await service.recordRewardWithdrawal(customerId, third, ADDRESS))
            .status,
        ).toBe('capped');
      });
    });
  },
});
