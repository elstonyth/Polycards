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
import LedgerEntry from '../models/ledger-entry';
import LedgerSequence from '../models/ledger-sequence';

jest.setTimeout(300 * 1000);

moduleIntegrationTestRunner<PacksModuleService>({
  moduleName: PACKS_MODULE,
  resolve: path.resolve(__dirname, '../../..', 'modules/packs'),
  moduleModels: [
    Pack, Card, PackOdds, Pull, CreditTransaction, DeliveryOrder,
    DeliveryOrderItem, VipLevel, RewardsSettings, CustomerAccountState, AdminActionAudit, VipMemberState,
    // adminAdjustCredit writes a ledger row (Epic 4 AD writer); this runner
    // generates schema from THIS list ONLY — not from migrations — so a spec that
    // reaches any recordLedgerEntry call site must list these two models.
    // Canonical example: ledger-service.integration.spec.ts.
    LedgerEntry, LedgerSequence,
  ],
  testSuite: ({ service }) => {
    describe('auditForCustomer', () => {
      it('2-way union surfaces customer + credit audit rows', async () => {
        // customer-keyed audit: freeze S
        await service.setManualFreeze({ customerId: 'au_S', adminId: 'adm_1', reason: 'test freeze' });
        // credit-keyed audit: adjust S's credit
        await service.adminAdjustCredit({ customerId: 'au_S', amount: 5, note: 'test adjust', adminId: 'adm_1' });

        const res = await service.auditForCustomer('au_S', { limit: 50, offset: 0 });
        const actions = res.actions.map((a) => a.action).sort();
        expect(actions).toContain('freeze');             // customer-keyed
        expect(actions).toContain('adjust_credit');      // credit-keyed (the silently-dropped one)
        expect(res.account_state?.frozen).toBe(true);
      });
    });
  },
});
