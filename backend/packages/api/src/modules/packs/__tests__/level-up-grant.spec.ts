/**
 * VIP level-up reward grant integration test — integration:modules
 *
 * Verifies the three required cases from the task-6-brief:
 *  1. First open crossing to L5 grants exactly L2..L5 rewards; L1 never granted.
 *  2. Redelivery of the same (customerId, openId) is a no-op (idempotent).
 *  3. CRITICAL: clawback-then-respend does NOT re-grant and does NOT block the
 *     respend open. vip_member_state.current_level may drop but highest_level_ever
 *     stays at the peak.
 *
 * Ladder anchors (vip-levels.data.ts):
 *   L1 = 0 MYR, L2 = 3 MYR, L3 = 25 MYR, L4 = 83 MYR, L5 = 198 MYR
 * Open 200 MYR → lifetime 200 sen×100=20000 sen → L5.
 * L2 has voucher_amount=2 → voucher only; box tier derives live at draw time (B3/B6).
 * L3 has voucher_amount=2 → voucher only. L4 same. L5 same.
 */

import path from 'path';
import { moduleIntegrationTestRunner } from '@medusajs/test-utils';
import { PACKS_MODULE } from '../index';
import type PacksModuleService from '../service';
import { VIP_LEVELS } from '../../../scripts/vip-levels.data';
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
    async function seedLadder() {
      const existing = await service.listVipLevels({}, { take: 1 });
      if (existing.length === 0) {
        await service.createVipLevels(
          VIP_LEVELS.map((r) => ({
            level: r.level,
            spend_threshold: r.spend_threshold,
            voucher_amount: r.voucher_amount,
            box_tier: r.box_tier,
            frame_unlock: r.frame_unlock,
            direct_referral_pct: r.direct_referral_pct,
            prizes: r.prizes ?? null,
          })),
        );
      }
    }

    describe('level-up reward grant (monotonic, post-commit)', () => {
      it('first open crossing to L5 grants exactly L2..L5 rewards; L1 never granted', async () => {
        await seedLadder();

        // Arrange: unique customer to avoid cross-test contamination
        const customerId = 'cust_grant_l5_1';

        // Fund enough credit: 210 MYR to cover the open + spare
        await service.mutateCreditAtomic({
          customerId,
          amount: 210,
          reason: 'topup',
        });

        // Settle an open for 200 MYR → lifetime = 20000 sen = 200 MYR → L5
        // (L5 threshold = 198 MYR; L6 threshold = 386 MYR)
        await service.settleOpen({
          customerId,
          amount: -200,
          sourceTransactionId: 'open_l5_a1',
        });

        // Act
        const { gained } = await service.grantLevelUpRewards(
          customerId,
          'open_l5_a1',
        );

        // Assert: gained levels are exactly L2..L5
        expect(gained).toEqual([2, 3, 4, 5]);

        // Assert: L1 is never granted
        expect(gained).not.toContain(1);

        // Assert: exactly the right vip_reward_grant rows exist
        const grants = await service.listVipRewardGrants(
          { customer_id: customerId },
          { take: 100 },
        );

        // Each level grants voucher only (box no longer per-rung — tier derives live via settleRewardDraw).
        // frame_unlock is false for all L2-L5 in the seed data.
        const grantedLevels = [...new Set(grants.map((g) => g.level))].sort(
          (a, b) => a - b,
        );
        expect(grantedLevels).toEqual([2, 3, 4, 5]);

        // No L1 row at all
        expect(grants.some((g) => g.level === 1)).toBe(false);

        // Each of L2..L5 has voucher only (voucher_amount=2 > 0, frame_unlock=false).
        // Box is no longer granted per-rung; tier derives live at draw time (B3/B6).
        for (const lvl of [2, 3, 4, 5]) {
          const lvlGrants = grants.filter((g) => g.level === lvl);
          const kinds = lvlGrants.map((g) => g.kind).sort();
          expect(kinds).not.toContain('box');
          expect(kinds).toContain('voucher');
          expect(kinds).not.toContain('frame');
          expect(kinds).not.toContain('prize');
        }

        // vip_member_state: highest_level_ever == 5
        const [state] = await service.listVipMemberStates(
          { customer_id: customerId },
          { take: 1 },
        );
        expect(state).toBeDefined();
        expect(Number(state!.highest_level_ever)).toBe(5);
        expect(Number(state!.current_level)).toBe(5);
      });

      it('redelivery of the same open is a no-op (idempotent, no dup grants)', async () => {
        await seedLadder();

        const customerId = 'cust_grant_idem_1';

        await service.mutateCreditAtomic({
          customerId,
          amount: 210,
          reason: 'topup',
        });

        await service.settleOpen({
          customerId,
          amount: -200,
          sourceTransactionId: 'open_idem_a1',
        });

        // First call
        const { gained: gained1 } = await service.grantLevelUpRewards(
          customerId,
          'open_idem_a1',
        );
        expect(gained1.length).toBeGreaterThan(0);

        const grantsBefore = await service.listVipRewardGrants(
          { customer_id: customerId },
          { take: 100 },
        );
        const countBefore = grantsBefore.length;

        // Second call — same (customerId, openId) — must be a no-op
        const { gained: gained2 } = await service.grantLevelUpRewards(
          customerId,
          'open_idem_a1',
        );

        const grantsAfter = await service.listVipRewardGrants(
          { customer_id: customerId },
          { take: 100 },
        );
        const countAfter = grantsAfter.length;

        // No new grants
        expect(countAfter).toBe(countBefore);
        // Second call returns empty gained (highest_level_ever already at new level)
        expect(gained2).toEqual([]);
      });

      it('CRITICAL: clawback-then-respend does NOT re-grant and does NOT block the open', async () => {
        await seedLadder();

        const customerId = 'cust_grant_clawback_1';

        // Fund enough for two opens
        await service.mutateCreditAtomic({
          customerId,
          amount: 500,
          reason: 'topup',
        });

        // Step 1: Open to L5 (200 MYR). Grants L2..L5.
        await service.settleOpen({
          customerId,
          amount: -200,
          sourceTransactionId: 'open_cb_a1',
        });

        const { gained: gained1 } = await service.grantLevelUpRewards(
          customerId,
          'open_cb_a1',
        );
        expect(gained1).toEqual([2, 3, 4, 5]);

        const grantsAfterFirst = await service.listVipRewardGrants(
          { customer_id: customerId },
          { take: 100 },
        );
        const countAfterFirst = grantsAfterFirst.length;

        // Step 2: reverseOpen the first spend → net basis drops, lifetime STAYS
        await service.reverseOpen('open_cb_a1');

        // Verify: lifetime still counts the original open (monotonic; reversal excluded)
        const lifetimeSenAfterClawback =
          await service.lifetimeExternalSenFor(customerId);
        // Original open was 200 MYR = 20000 sen. Reversal rows are excluded.
        expect(lifetimeSenAfterClawback).toBe(20000);

        // Step 3: Settle a FRESH open_id (respend) — this must NOT throw
        // Use a smaller amount (e.g. 10 MYR) that keeps net basis below L5
        // to make current_level < highest_level_ever observable.
        let respendError: unknown = null;
        try {
          await service.settleOpen({
            customerId,
            amount: -10,
            sourceTransactionId: 'open_cb_a2',
          });
        } catch (e) {
          respendError = e;
        }
        // The respend must NOT throw
        expect(respendError).toBeNull();

        // Step 4: Grant for the respend open_id — must not add new grants
        const { gained: gained2 } = await service.grantLevelUpRewards(
          customerId,
          'open_cb_a2',
        );

        // No new grants: highest_level_ever is already 5, lifetime still 20000 sen (L5)
        // so newLevel === highestEver → levelsToGrant returns []
        expect(gained2).toEqual([]);

        // Grant count must not have grown
        const grantsAfterRespend = await service.listVipRewardGrants(
          { customer_id: customerId },
          { take: 100 },
        );
        expect(grantsAfterRespend.length).toBe(countAfterFirst);

        // vip_member_state: highest_level_ever still 5
        const [state] = await service.listVipMemberStates(
          { customer_id: customerId },
          { take: 1 },
        );
        expect(state).toBeDefined();
        expect(Number(state!.highest_level_ever)).toBe(5);

        // current_level may be < 5 (net basis after clawback+10 MYR respend is 10 MYR < L3)
        // but must be strictly < highest_level_ever
        expect(Number(state!.current_level)).toBeLessThan(
          Number(state!.highest_level_ever),
        );
      });
    });
  },
});
