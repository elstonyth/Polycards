/**
 * claimReward (B5) — integration:modules
 *
 * Read-then-write under the per-customer `credit:` advisory lock, mirroring the
 * reverseCommission idempotency discipline (service.ts ~742). One transaction:
 * re-read the grant; reject if not owned / not `granted`; voucher → credit
 * (+amount_myr, reason 'voucher_claim', external_funded_cents=0, idempotent on
 * `voucher:<grantId>`) + flip status='fulfilled'; frame → flip status only.
 *
 * Asserted contracts:
 *  - A granted VOUCHER claim raises the balance by amount_myr, flips the grant to
 *    'fulfilled', writes exactly one `voucher_claim` row with external_funded_cents=0,
 *    and leaves the VIP basis (externalFundedSpendTotal) UNCHANGED (basis-neutral).
 *  - A second claim of the same grant returns {claimed:false}, balance unchanged,
 *    still exactly one voucher_claim row (idempotent).
 *  - A granted FRAME claim flips status='fulfilled' with NO credit row.
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
    const voucherRows = (customerId: string) =>
      service.listCreditTransactions(
        { customer_id: customerId, reason: 'voucher_claim' },
        { take: 100 },
      );

    describe('claimReward', () => {
      // claimReward fails closed when the redemption gate is off (defense in depth
      // at the mint site). These tests exercise the claim logic, so the gate must
      // be ON; restored afterwards so test order can't leak the flag.
      const prevGate = process.env.REWARDS_REDEMPTION_ENABLED;
      beforeAll(() => {
        process.env.REWARDS_REDEMPTION_ENABLED = 'true';
      });
      afterAll(() => {
        if (prevGate === undefined) delete process.env.REWARDS_REDEMPTION_ENABLED;
        else process.env.REWARDS_REDEMPTION_ENABLED = prevGate;
      });

      it('credits a granted voucher once, flips it fulfilled, and stays basis-neutral', async () => {
        const customerId = 'cus_claim_voucher';
        const [grant] = await service.createVipRewardGrants([
          {
            id: 'vrg_cus_claim_voucher_2_voucher',
            customer_id: customerId,
            level: 2,
            kind: 'voucher',
            payload: { amount_myr: 5 },
            status: 'granted',
            source_open_id: 'open_seed',
          },
        ]);

        const basisBefore = (await service.creditSummary(customerId))
          .externalFundedSpendTotal;

        const res = await service.claimReward(customerId, grant.id);
        // D2: claimReward now includes amount_myr + level for notification routing.
        expect(res).toEqual({ claimed: true, kind: 'voucher', amount_myr: 5, level: 2 });

        expect(await service.creditBalance(customerId)).toBe(5);

        const [claimed] = await service.listVipRewardGrants(
          { id: grant.id },
          { take: 1 },
        );
        expect(claimed.status).toBe('fulfilled');

        const rows = await voucherRows(customerId);
        expect(rows).toHaveLength(1);
        expect(Number(rows[0].amount)).toBe(5);
        expect(Number(rows[0].external_funded_cents)).toBe(0);

        // Basis-neutral: a voucher credit must NOT bump the VIP spend basis.
        const basisAfter = (await service.creditSummary(customerId))
          .externalFundedSpendTotal;
        expect(basisAfter).toBe(basisBefore);

        // Idempotent: a second claim is a clean no-op, balance unchanged.
        const replay = await service.claimReward(customerId, grant.id);
        expect(replay.claimed).toBe(false);
        expect(await service.creditBalance(customerId)).toBe(5);
        expect(await voucherRows(customerId)).toHaveLength(1);
      });

      it('rejects a claim whose customer does not own the grant', async () => {
        const [grant] = await service.createVipRewardGrants([
          {
            id: 'vrg_cus_owner_2_voucher',
            customer_id: 'cus_owner',
            level: 2,
            kind: 'voucher',
            payload: { amount_myr: 7 },
            status: 'granted',
            source_open_id: 'open_seed',
          },
        ]);

        const res = await service.claimReward('cus_intruder', grant.id);
        expect(res.claimed).toBe(false);
        expect(await voucherRows('cus_intruder')).toHaveLength(0);

        const [untouched] = await service.listVipRewardGrants(
          { id: grant.id },
          { take: 1 },
        );
        expect(untouched.status).toBe('granted');
      });

      it('flips a granted frame to fulfilled with no credit row', async () => {
        const customerId = 'cus_claim_frame';
        const [grant] = await service.createVipRewardGrants([
          {
            id: 'vrg_cus_claim_frame_2_frame',
            customer_id: customerId,
            level: 2,
            kind: 'frame',
            payload: { level: 2 },
            status: 'granted',
            source_open_id: 'open_seed',
          },
        ]);

        const res = await service.claimReward(customerId, grant.id);
        // D2: claimReward now includes level in the result for notification routing.
        expect(res).toEqual({ claimed: true, kind: 'frame', level: 2 });

        const [claimed] = await service.listVipRewardGrants(
          { id: grant.id },
          { take: 1 },
        );
        expect(claimed.status).toBe('fulfilled');
        expect(await service.creditBalance(customerId)).toBe(0);
        expect(await voucherRows(customerId)).toHaveLength(0);
      });
    });
  },
});
