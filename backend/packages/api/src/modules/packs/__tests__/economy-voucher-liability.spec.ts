/**
 * Economy voucher-liability aggregate — integration:modules (RED → GREEN)
 *
 * Seeds vip_reward_grant rows directly via raw INSERT (no ladder / open required)
 * and asserts the service's outstandingVoucherLiabilityMyr aggregate:
 *
 *   - 2 GRANTED voucher grants (amount_myr 10 and 25) → liability == 35
 *   - 1 FULFILLED voucher grant (amount_myr 50) → excluded (status filter) → still 35
 *   - 1 GRANTED non-voucher (box) grant with no amount_myr → excluded (no amount) → still 35
 *   - 1 GRANTED non-voucher (frame) grant (amount_myr 99) → excluded (kind filter) → still 35
 *
 * Implementation target: PacksModuleService.outstandingVoucherLiabilityMyr()
 * SQL: SELECT COALESCE(SUM((payload->>'amount_myr')::numeric), 0)
 *        FROM vip_reward_grant
 *       WHERE kind='voucher' AND status='granted' AND deleted_at IS NULL
 *
 * If kind='voucher' filter is removed: 10 + 25 + 99 = 134 (FAILS)
 * If status='granted' filter is removed: 10 + 25 + 50 + 99 = 184 (FAILS)
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
    describe('outstandingVoucherLiabilityMyr', () => {
      it('sums GRANTED voucher grants and excludes FULFILLED + non-voucher rows (35)', async () => {
        // Arrange: insert rows directly via service create* to avoid ladder setup
        // We use unique customer IDs to isolate from other tests in this suite.
        const base = 'voucher-liability-test';

        // 2 GRANTED vouchers: 10 + 25 = 35 MYR
        await (service as unknown as { createVipRewardGrants: (rows: unknown[]) => Promise<unknown> })
          .createVipRewardGrants([
            {
              id: `${base}-granted-10`,
              customer_id: `cust_${base}_a`,
              level: 2,
              kind: 'voucher',
              payload: { amount_myr: 10 },
              status: 'granted',
              source_open_id: null,
            },
            {
              id: `${base}-granted-25`,
              customer_id: `cust_${base}_b`,
              level: 3,
              kind: 'voucher',
              payload: { amount_myr: 25 },
              status: 'granted',
              source_open_id: null,
            },
          ]);

        // 1 FULFILLED voucher: 50 MYR — must be excluded
        await (service as unknown as { createVipRewardGrants: (rows: unknown[]) => Promise<unknown> })
          .createVipRewardGrants([
            {
              id: `${base}-fulfilled-50`,
              customer_id: `cust_${base}_c`,
              level: 4,
              kind: 'voucher',
              payload: { amount_myr: 50 },
              status: 'fulfilled',
              source_open_id: null,
            },
          ]);

        // 1 GRANTED non-voucher (box) — must be excluded regardless of status
        await (service as unknown as { createVipRewardGrants: (rows: unknown[]) => Promise<unknown> })
          .createVipRewardGrants([
            {
              id: `${base}-granted-box`,
              customer_id: `cust_${base}_d`,
              level: 2,
              kind: 'box',
              payload: { tier: 'standard' },
              status: 'granted',
              source_open_id: null,
            },
          ]);

        // 1 GRANTED non-voucher (frame) with amount_myr: 99 — must be excluded by kind filter
        // This row makes the kind='voucher' filter load-bearing (removes it → total becomes 134)
        await (service as unknown as { createVipRewardGrants: (rows: unknown[]) => Promise<unknown> })
          .createVipRewardGrants([
            {
              id: `${base}-granted-frame-99`,
              customer_id: `cust_${base}_e`,
              level: 5,
              kind: 'frame',
              payload: { amount_myr: 99 },
              status: 'granted',
              source_open_id: null,
            },
          ]);

        // Act
        const liability = await service.outstandingVoucherLiabilityMyr();

        // Assert: 10 + 25 = 35; fulfilled (50) and box excluded
        expect(liability).toBe(35);
      });
    });
  },
});
