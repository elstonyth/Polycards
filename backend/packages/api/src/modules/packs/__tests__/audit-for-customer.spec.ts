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
import LedgerEntry from '../models/ledger-entry';
import LedgerSequence from '../models/ledger-sequence';

jest.setTimeout(300 * 1000);

moduleIntegrationTestRunner<PacksModuleService>({
  moduleName: PACKS_MODULE,
  resolve: path.resolve(__dirname, '../../..', 'modules/packs'),
  moduleModels: [
    Pack, Card, PackOdds, Pull, CreditTransaction, DeliveryOrder,
    DeliveryOrderItem, VipLevel, RewardsSettings, ReferralRelationship,
    Commission, CustomerAccountState, AdminActionAudit, VipMemberState,
    // adminAdjustCredit / reverseCommission write ledger rows (Epic 4); this
    // runner generates schema from THIS list, so the tables must be listed here.
    LedgerEntry, LedgerSequence,
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

    describe('auditForCustomer', () => {
      it('3-way union surfaces customer + commission + credit audit rows', async () => {
        await seedLadder(); // REQUIRED — else settleOpen rolls back and no commission row exists to reverse

        // commission: link + open so a commission exists, then reverse it (writes commission-keyed audit)
        await service.linkSponsor({ recruitId: 'au_R', sponsorId: 'au_S' });
        await service.mutateCreditAtomic({ customerId: 'au_R', amount: 30, reason: 'topup' });
        await service.settleOpen({ customerId: 'au_R', amount: -20, sourceTransactionId: 'au_open' });
        const [comm] = await service.listCommissions({ beneficiary: 'au_S' }, { take: 1 });
        await service.reverseCommission({ commissionId: comm.id, adminId: 'adm_1', reason: 'test reverse' });
        // customer-keyed audit: freeze S
        await service.setManualFreeze({ customerId: 'au_S', adminId: 'adm_1', reason: 'test freeze' });
        // credit-keyed audit: adjust S's credit
        await service.adminAdjustCredit({ customerId: 'au_S', amount: 5, note: 'test adjust', adminId: 'adm_1' });

        const res = await service.auditForCustomer('au_S', { limit: 50, offset: 0 });
        const actions = res.actions.map((a) => a.action).sort();
        expect(actions).toContain('reverse_commission'); // commission-keyed
        expect(actions).toContain('freeze');             // customer-keyed
        expect(actions).toContain('adjust_credit');      // credit-keyed (the silently-dropped one)
        expect(res.account_state?.frozen).toBe(true);
      });
    });
  },
});
