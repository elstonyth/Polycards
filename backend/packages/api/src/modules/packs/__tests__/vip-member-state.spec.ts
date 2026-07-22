/**
 * vip_member_state integration test — integration:modules
 *
 * Verifies:
 *  1. rebuildVipMemberState after two opens: lifetime == Σ consumed and
 *     highest_level_ever == levelForSpend(fromSen(lifetime)).
 *  2. After reverseOpen + rebuild: lifetime UNCHANGED (monotonic) and
 *     current_level STRICTLY DROPS (net basis crosses a lower threshold).
 *
 * Uses the real DB via moduleIntegrationTestRunner (lightweight; no full
 * medusa app boot).
 *
 * Threshold anchors from vip-levels.data.ts:
 *   L2 = 3 MYR (300 sen)
 *   L3 = 25 MYR (2 500 sen)
 *
 * Open 1: 20 MYR (2 000 sen) — net basis lands on L2 (3 ≤ 20 < 25)
 * Open 2:  6 MYR (  600 sen) — net basis 26 MYR crosses L3 (≥ 25)
 * After reverseOpen(open 2): net basis drops back to 20 MYR → L2.
 * ⟹ current_level 3 → 2 (strict drop), highest_level_ever stays 3.
 */

import path from 'path';
import { moduleIntegrationTestRunner } from '@medusajs/test-utils';
import { PACKS_MODULE } from '../index';
import type PacksModuleService from '../service';
import { levelForSpend } from '../vip-ladder';
import { fromSen } from '../money';
import { VIP_LEVELS } from '../../../scripts/vip-levels.data';
import VipMemberState from '../models/vip-member-state';
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

    describe('vip_member_state projection', () => {
      it('rebuild: lifetime == Σ consumed; highest_level_ever == levelForSpend(fromSen(lifetime)); monotonic after reverse', async () => {
        await seedLadder();

        const customerId = 'cust_vms_1';

        // Fund the customer with enough credit to cover both opens (26 MYR total)
        await service.mutateCreditAtomic({
          customerId,
          amount: 30,
          reason: 'topup',
        });

        // Open 1: 20 MYR spend (2 000 sen external) — net basis 20 MYR ∈ [L2=3, L3=25)
        await service.settleOpen({
          customerId,
          amount: -20,
          sourceTransactionId: 'open_vms_1',
        });

        // Open 2: 6 MYR spend (600 sen external) — cumulative 26 MYR ≥ L3 threshold (25 MYR)
        await service.settleOpen({
          customerId,
          amount: -6,
          sourceTransactionId: 'open_vms_2',
        });

        // Rebuild the projection
        await service.rebuildVipMemberState(customerId);

        // Read back the projection row
        const [row] = await service.listVipMemberStates(
          { customer_id: customerId },
          { take: 1 },
        );
        expect(row).toBeDefined();

        const lifetime = Number(row.lifetime_external_spend_sen);
        // Σ consumed: both opens are external-funded (topup = external); 2000 + 600 = 2600 sen
        expect(lifetime).toBe(2600);

        // highest_level_ever == levelForSpend(fromSen(2600 sen = 26 MYR), ladder)
        const ladderRows = await service.listVipLevels(
          {},
          { select: ['level', 'spend_threshold'], take: 1000 },
        );
        const ladder = ladderRows.map((r) => ({
          level: r.level,
          spend_threshold: Number(r.spend_threshold),
        }));
        const expectedHighest = levelForSpend(fromSen(lifetime), ladder);
        expect(row.highest_level_ever).toBe(expectedHighest);
        expect(row.highest_level_ever).toBe(3); // 26 MYR ≥ L3 (25 MYR) and < L4 (83 MYR)

        // current_level uses the net basis (same as highest since no reversal yet)
        expect(row.current_level).toBe(expectedHighest);

        // ── Phase 2: reverseOpen open_vms_2 + rebuild ────────────────────────
        // Reversing the 6 MYR open drops net basis to 20 MYR, which is below the
        // L3 threshold (25 MYR) → current_level must drop from 3 to 2.
        await service.reverseOpen('open_vms_2');
        await service.rebuildVipMemberState(customerId);

        const [rowAfter] = await service.listVipMemberStates(
          { customer_id: customerId },
          { take: 1 },
        );
        expect(rowAfter).toBeDefined();

        const lifetimeAfter = Number(rowAfter.lifetime_external_spend_sen);

        // MONOTONIC: lifetime must not decrease after the reversal
        // (reversal rows have amount>0 and are excluded from the counter)
        expect(lifetimeAfter).toBe(lifetime); // 2 600 sen — unchanged

        // highest_level_ever must not regress (GREATEST in upsert)
        expect(rowAfter.highest_level_ever).toBe(expectedHighest); // still 3

        // current_level must STRICTLY DROP: net basis = open_vms_1 only = 20 MYR
        // 20 MYR < L3 threshold (25 MYR) → current_level == 2
        const netBasis = (await service.creditSummary(customerId))
          .vipSpendTotal;
        const expectedCurrentAfter = levelForSpend(netBasis, ladder);
        expect(rowAfter.current_level).toBe(expectedCurrentAfter);
        // Exact drop: 3 → 2
        expect(rowAfter.current_level).toBe(2);
        // Strict inequality: current_level < highest_level_ever
        expect(rowAfter.current_level).toBeLessThan(rowAfter.highest_level_ever);
      });
    });
  },
});
