/**
 * releaseOldRewardHoldsForCustomer — integration:modules
 *
 * The one-shot release of the holds that reward and gift sales stamped before
 * ADR 0012 (scripts/release-old-reward-holds.ts). Today's code no longer
 * stamps those sales, so the old stamped rows are written directly.
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

jest.setTimeout(300 * 1000);

const ACTOR = 'script:release-old-reward-holds';

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
  ],
  testSuite: ({ service }) => {
    const topup = (customerId: string, amount: number, reference: string) =>
      service.mutateCreditAtomic({
        customerId,
        amount,
        reason: 'topup',
        reference,
      });

    // A sale written the old way: normal credit with its held share stamped.
    const stampedSale = async (
      customerId: string,
      source: 'reward' | 'gift' | 'free' | 'bonus',
      amount: number,
      stampSen: number,
    ) => {
      const [pull] = await service.createPulls([
        {
          customer_id: customerId,
          pack_id: source === 'reward' ? 'task-reward' : 'bronze',
          card_id: 'old-card',
          order_id: null,
          rolled_at: new Date(),
          status: 'bought_back' as const,
          source,
          bonus_bp: source === 'bonus' ? 5000 : 10000,
        },
      ]);
      const [row] = await service.createCreditTransactions([
        {
          customer_id: customerId,
          amount,
          reason: 'buyback' as const,
          pull_id: pull.id,
          reference: null,
          external_funded_cents: stampSen,
        } as Record<string, unknown>,
      ]);
      return row.id as string;
    };

    const open = (customerId: string, amount: number, extSen: number) =>
      service.createCreditTransactions([
        {
          customer_id: customerId,
          amount: -amount,
          reason: 'pack_open' as const,
          pull_id: null,
          reference: null,
          external_funded_cents: -extSen,
        } as Record<string, unknown>,
      ]);

    const stampOf = async (id: string) => {
      const [row] = await service.listCreditTransactions({ id });
      return Number(row.external_funded_cents ?? 0);
    };

    const audits = (customerId: string) =>
      service.listAdminActionAudits({
        entity_type: 'customer',
        entity_id: customerId,
        action: 'release_reward_holds',
      });

    it('releases reward and gift stamps once, and leaves welcome and bonus stamps', async () => {
      const cus = 'cus_rel_all';
      await topup(cus, 50, 'rel_all_topup');
      const reward = await stampedSale(cus, 'reward', 20, 2000);
      const gift = await stampedSale(cus, 'gift', 10, 1000);
      const welcome = await stampedSale(cus, 'free', 8, 800);
      const bonus = await stampedSale(cus, 'bonus', 6, 300);
      await open(cus, 45, 4500);

      const before = await service.walletSummary(cus);
      expect(before.playthrough.remaining).toBeCloseTo(46, 2);
      expect(await service.customersWithOldRewardHolds()).toContain(cus);

      // Dry run: reports, writes nothing.
      const dry = await service.releaseOldRewardHoldsForCustomer(cus, {
        apply: false,
        actor: ACTOR,
      });
      expect(dry).toEqual({
        alreadyReleased: false,
        remainingSen: 4600,
        releasedSen: 3000,
      });
      expect(await service.walletSummary(cus)).toEqual(before);
      expect(await audits(cus)).toHaveLength(0);

      // Apply: exactly the reward + gift stamps go; the balance does not move.
      const applied = await service.releaseOldRewardHoldsForCustomer(cus, {
        apply: true,
        actor: ACTOR,
      });
      expect(applied.releasedSen).toBe(3000);
      const after = await service.walletSummary(cus);
      expect(after.balance).toBeCloseTo(before.balance, 2);
      expect(after.playthrough.remaining).toBeCloseTo(16, 2);
      expect(after.withdrawable).toBeCloseTo(before.withdrawable + 30, 2);
      expect(await stampOf(reward)).toBe(0);
      expect(await stampOf(gift)).toBe(0);
      expect(await stampOf(welcome)).toBe(800);
      expect(await stampOf(bonus)).toBe(300);
      const [audit] = await audits(cus);
      expect(audit).toMatchObject({ admin_id: ACTOR });
      expect(audit.after).toMatchObject({ released_sen: 3000 });
      expect(await service.customersWithOldRewardHolds()).not.toContain(cus);

      // Second apply: a no-op.
      expect(
        await service.releaseOldRewardHoldsForCustomer(cus, {
          apply: true,
          actor: ACTOR,
        }),
      ).toMatchObject({ alreadyReleased: true, releasedSen: 0 });
      expect(await service.walletSummary(cus)).toEqual(after);
      expect(await audits(cus)).toHaveLength(1);
    });

    it('releases only what is still held, and never a later top-up', async () => {
      const cus = 'cus_rel_partial';
      const reward = await stampedSale(cus, 'reward', 30, 3000);
      await topup(cus, 20, 'rel_partial_topup');
      // Opens spent RM 45 of the RM 50 held: RM 5 is left to release.
      await open(cus, 45, 4500);

      const r = await service.releaseOldRewardHoldsForCustomer(cus, {
        apply: true,
        actor: ACTOR,
      });
      expect(r).toMatchObject({ remainingSen: 500, releasedSen: 500 });
      expect(await stampOf(reward)).toBe(2500);
      expect((await service.walletSummary(cus)).playthrough.remaining).toBe(0);

      // A top-up afterwards stays held; a re-run cannot touch it.
      await topup(cus, 100, 'rel_partial_topup_2');
      await service.releaseOldRewardHoldsForCustomer(cus, {
        apply: true,
        actor: ACTOR,
      });
      expect((await service.walletSummary(cus)).playthrough.remaining).toBe(
        100,
      );
      expect(await stampOf(reward)).toBe(2500);
    });

    it('marks a customer whose old stamps were all spent, so a re-run stays a no-op', async () => {
      const cus = 'cus_rel_spent';
      const reward = await stampedSale(cus, 'reward', 20, 2000);
      await open(cus, 20, 2000);

      const r = await service.releaseOldRewardHoldsForCustomer(cus, {
        apply: true,
        actor: ACTOR,
      });
      expect(r).toMatchObject({ remainingSen: 0, releasedSen: 0 });
      expect(await audits(cus)).toHaveLength(1);

      await topup(cus, 50, 'rel_spent_topup');
      await service.releaseOldRewardHoldsForCustomer(cus, {
        apply: true,
        actor: ACTOR,
      });
      expect((await service.walletSummary(cus)).playthrough.remaining).toBe(
        50,
      );
      expect(await stampOf(reward)).toBe(2000);
    });

    it('a never-topped-up account sees the release only after a top-up', async () => {
      const cus = 'cus_rel_notopup';
      await stampedSale(cus, 'reward', 15, 1500);

      await service.releaseOldRewardHoldsForCustomer(cus, {
        apply: true,
        actor: ACTOR,
      });
      let w = await service.walletSummary(cus);
      expect(w.playthrough.remaining).toBe(0);
      expect(w.withdrawable).toBe(0); // no top-up, no withdrawal

      await topup(cus, 10, 'rel_notopup_topup');
      w = await service.walletSummary(cus);
      // The RM 10 top-up is held; the released RM 15 sale is withdrawable.
      expect(w.playthrough.remaining).toBe(10);
      expect(w.withdrawable).toBeCloseTo(15, 2);
    });
  },
});
