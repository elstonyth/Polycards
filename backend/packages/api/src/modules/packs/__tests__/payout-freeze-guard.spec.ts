/**
 * assertNotFrozen on payout outflows (security audit 2026-06-30, Batch A item 5)
 * — integration:modules
 *
 * Before this change a freeze (auto clawback-debt OR a sticky manual/AMLA/fraud
 * hold) gated NOTHING — it was a projective flag only. A frozen account could
 * still drain value via sell-back / reward draw / voucher claim / prize
 * withdrawal. assertNotFrozen now blocks each payout at its locked service site
 * (and the buyback step), while inflows (top-up repay → auto-unfreeze) and admin
 * adjustments stay allowed — those go through mutateCreditAtomic, which is
 * intentionally NOT gated.
 *
 * The guard runs immediately after the per-customer lock, BEFORE any grant /
 * pool / pull lookup, so a frozen account is rejected with minimal fixture.
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
    const freeze = (customerId: string, cause: 'auto' | 'manual' = 'manual') =>
      service.createCustomerAccountStates([
        { customer_id: customerId, frozen: true, cause, frozen_at: new Date() },
      ]);

    describe('assertNotFrozen', () => {
      it('throws for a MANUALLY frozen account (admin/AMLA/fraud hold)', async () => {
        await freeze('cus_frozen_direct', 'manual');
        await expect(
          service.assertNotFrozen('cus_frozen_direct'),
        ).rejects.toThrow(/frozen/i);
      });

      it('resolves for an AUTO-frozen account — clawback debt stays repayable (buyback/top-up auto-unfreeze)', async () => {
        await freeze('cus_auto_frozen', 'auto');
        await expect(
          service.assertNotFrozen('cus_auto_frozen'),
        ).resolves.toBeUndefined();
      });

      it('resolves for a never-frozen account', async () => {
        await expect(
          service.assertNotFrozen('cus_never_frozen'),
        ).resolves.toBeUndefined();
      });

      it('resolves once an account is unfrozen (frozen:false row)', async () => {
        await service.createCustomerAccountStates([
          { customer_id: 'cus_was_frozen', frozen: false, cause: 'auto' },
        ]);
        await expect(
          service.assertNotFrozen('cus_was_frozen'),
        ).resolves.toBeUndefined();
      });
    });

    describe('payout methods block a MANUALLY frozen account', () => {
      // These payouts are themselves gated by REWARDS_REDEMPTION_ENABLED (which
      // short-circuits BEFORE the freeze check), so the gate must be ON to reach
      // the guard. Restored afterwards so test order can't leak the flag.
      const prevGate = process.env.REWARDS_REDEMPTION_ENABLED;
      beforeAll(() => {
        process.env.REWARDS_REDEMPTION_ENABLED = 'true';
      });
      afterAll(() => {
        if (prevGate === undefined)
          delete process.env.REWARDS_REDEMPTION_ENABLED;
        else process.env.REWARDS_REDEMPTION_ENABLED = prevGate;
      });

      it('claimReward throws — no credit minted, grant left granted', async () => {
        const c = 'cus_frozen_claim';
        const [grant] = await service.createVipRewardGrants([
          {
            id: 'vrg_frozen_claim',
            customer_id: c,
            level: 2,
            kind: 'voucher',
            payload: { amount_myr: 5 },
            status: 'granted',
            source_open_id: 'open_seed',
          },
        ]);
        await freeze(c);

        await expect(service.claimReward(c, grant.id)).rejects.toThrow(
          /frozen/i,
        );

        // The payout must NOT have happened: no credit, grant still claimable.
        expect(await service.creditBalance(c)).toBe(0);
        const [after] = await service.listVipRewardGrants(
          { id: grant.id },
          { take: 1 },
        );
        expect(after.status).toBe('granted');
      });

      it('recordRewardWithdrawal throws (before the pull re-read)', async () => {
        const c = 'cus_frozen_withdraw';
        await freeze(c);
        await expect(
          service.recordRewardWithdrawal(c, 'pull_irrelevant', {
            first_name: 'A',
            last_name: 'B',
            address_1: 'C',
            city: 'D',
            postal_code: 'E',
            country_code: 'MY',
          }),
        ).rejects.toThrow(/frozen/i);
      });
    });
  },
});
