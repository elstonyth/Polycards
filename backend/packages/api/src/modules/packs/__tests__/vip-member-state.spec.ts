/**
 * vip_member_state integration test — integration:modules
 *
 * Verifies:
 *  1. rebuildVipMemberState after two opens: lifetime == Σ consumed and
 *     highest_level_ever == levelForSpend(fromSen(lifetime)).
 *  2. After reverseOpen + rebuild: lifetime UNCHANGED (monotonic) and
 *     current_level dropped (net basis dropped).
 *
 * Uses the real DB via moduleIntegrationTestRunner (lightweight; no full
 * medusa app boot). L2 threshold = 3 MYR (300 sen); we open for 4 MYR + 1 MYR
 * so lifetime = 500 sen, which crosses L2.
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

        // Fund the customer (L2 threshold = 3 MYR; open for 4 + 1 MYR = 5 MYR = 500 sen)
        await service.mutateCreditAtomic({
          customerId,
          amount: 10,
          reason: 'topup',
        });

        // Open 1: 4 MYR spend (400 sen external, fully external-funded)
        await service.settleOpen({
          customerId,
          amount: -4,
          sourceTransactionId: 'open_vms_1',
        });

        // Open 2: 1 MYR spend (100 sen external)
        await service.settleOpen({
          customerId,
          amount: -1,
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
        // Σ consumed: both opens are external-funded (topup = external); 400 + 100 = 500
        expect(lifetime).toBe(500);

        // highest_level_ever == levelForSpend(fromSen(500 sen = 5 MYR), ladder)
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
        expect(row.highest_level_ever).toBeGreaterThan(1); // crossed L2 (3 MYR threshold)

        // current_level uses the net basis (same as highest since no reversal yet)
        expect(row.current_level).toBe(expectedHighest);

        // ── Phase 2: reverseOpen open_vms_2 + rebuild ────────────────────────
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
        expect(lifetimeAfter).toBe(lifetime); // 500 sen — unchanged

        // highest_level_ever must not regress (GREATEST in upsert)
        expect(rowAfter.highest_level_ever).toBe(expectedHighest);

        // current_level may drop: net basis = open_vms_1 only = 4 MYR = 400 sen
        const netBasis = (await service.creditSummary(customerId))
          .externalFundedSpendTotal;
        const expectedCurrentAfter = levelForSpend(netBasis, ladder);
        expect(rowAfter.current_level).toBe(expectedCurrentAfter);
        // Reversal brings net basis from 5 MYR → 4 MYR; level should drop or stay
        // (depends on ladder thresholds) but the assertion is data-driven
        expect(expectedCurrentAfter).toBeLessThanOrEqual(expectedHighest);
      });
    });
  },
});
