import path from 'path';
import { moduleIntegrationTestRunner } from '@medusajs/test-utils';
import { PACKS_MODULE } from '../index';
import type PacksModuleService from '../service';
import ReferralAttribution from '../models/referral-attribution';
import ReferralSettings from '../models/referral-settings';
import WeeklySettlement from '../models/weekly-settlement';
import WeeklySettlementLine from '../models/weekly-settlement-line';
import CreditTransaction from '../models/credit-transaction';
import CustomerAccountState from '../models/customer-account-state';
import VipLevel from '../models/vip-level';
import VipMemberState from '../models/vip-member-state';
import AdminActionAudit from '../models/admin-action-audit';
import LedgerEntry from '../models/ledger-entry';
import LedgerSequence from '../models/ledger-sequence';
import { referralWeekFor } from '../referral';

jest.setTimeout(300 * 1000);

moduleIntegrationTestRunner<PacksModuleService>({
  moduleName: PACKS_MODULE,
  resolve: path.resolve(__dirname, '../../..', 'modules/packs'),
  moduleModels: [
    ReferralAttribution,
    ReferralSettings,
    WeeklySettlement,
    WeeklySettlementLine,
    CreditTransaction,
    CustomerAccountState,
    VipLevel,
    VipMemberState,
    AdminActionAudit,
    LedgerEntry,
    LedgerSequence,
  ],
  testSuite: ({ service }) => {
    const week = referralWeekFor(new Date());

    // Seed one closed draft: R earns commission on A's spend; A earns a
    // rebate. Returns the run id. DB resets between tests, so each test
    // builds its own world through this.
    async function seedClosedWeek(): Promise<string> {
      await service.createVipLevels([
        {
          level: 1,
          spend_threshold: 0,
          voucher_amount: 0,
          box_tier: 'a',
          rebate_bp: 100, // 1% rebate at L1 so A gets a line without state
        },
      ]);
      await service.createReferralAttributions([
        { customer_id: 'cus_a', referrer_id: 'cus_r' },
      ]);
      await service.createCreditTransactions([
        { customer_id: 'cus_a', amount: -1000, reason: 'pack_open' }, // RM1000
      ]);
      const r = await service.closeReferralWeek({
        weekStartIso: week.weekStartIso,
      });
      expect(r.created).toBe(true);
      expect(r.lines).toBe(2); // R commission 50bp x 100000c = 500c; A rebate 1000c
      return r.settlementId;
    }

    it('approve flips draft→approved and audits; re-approve is rejected', async () => {
      const id = await seedClosedWeek();
      await service.approveWeeklySettlement({
        settlementId: id,
        adminId: 'admin_1',
      });
      const [run] = await service.listWeeklySettlements({ id });
      expect(run.status).toBe('approved');
      expect(run.approved_by).toBe('admin_1');
      expect(run.approved_at).not.toBeNull();
      const audits = await service.listAdminActionAudits({
        action: 'approve_settlement',
        entity_id: id,
      });
      expect(audits).toHaveLength(1);
      await expect(
        service.approveWeeklySettlement({
          settlementId: id,
          adminId: 'admin_1',
        }),
      ).rejects.toThrow(/draft/i);
    });

    it('void marks a pending line and audits; paying skips it', async () => {
      const id = await seedClosedWeek();
      const lines = await service.listWeeklySettlementLines({
        settlement_id: id,
      });
      const rebate = lines.find((l) => l.kind === 'vip_rebate')!;
      await service.voidSettlementLine({
        lineId: rebate.id,
        adminId: 'admin_1',
        reason: 'suspicious volume',
      });
      const [voided] = await service.listWeeklySettlementLines({
        id: rebate.id,
      });
      expect(voided.status).toBe('voided');
      expect(voided.void_reason).toBe('suspicious volume');

      await service.approveWeeklySettlement({
        settlementId: id,
        adminId: 'admin_1',
      });
      const res = await service.payWeeklySettlement({ settlementId: id });
      expect(res.paid).toBe(1); // only the commission line

      // The voided customer got no money.
      const aTxns = await service.listCreditTransactions({
        customer_id: 'cus_a',
        reason: 'vip_rebate',
      });
      expect(aTxns).toHaveLength(0);
    });

    it('rejects voiding a paid line', async () => {
      const id = await seedClosedWeek();
      await service.approveWeeklySettlement({
        settlementId: id,
        adminId: 'admin_1',
      });
      await service.payWeeklySettlement({ settlementId: id });
      const [line] = await service.listWeeklySettlementLines({
        settlement_id: id,
        kind: 'referral_commission',
      });
      expect(line.status).toBe('paid');
      await expect(
        service.voidSettlementLine({
          lineId: line.id,
          adminId: 'admin_1',
          reason: 'too late',
        }),
      ).rejects.toThrow(/paid/i);
    });

    it('pay refuses a draft run', async () => {
      const id = await seedClosedWeek();
      await expect(
        service.payWeeklySettlement({ settlementId: id }),
      ).rejects.toThrow(/approved/i);
    });

    it('pay writes credit + RF ledger per line, flips the run, and re-runs are no-ops', async () => {
      const id = await seedClosedWeek();
      await service.approveWeeklySettlement({
        settlementId: id,
        adminId: 'admin_1',
      });
      const res = await service.payWeeklySettlement({ settlementId: id });
      expect(res.paid).toBe(2);

      // R: 0.5% of RM1000 = RM5 credit, reason referral_commission.
      const rTxns = await service.listCreditTransactions({
        customer_id: 'cus_r',
        reason: 'referral_commission',
      });
      expect(rTxns).toHaveLength(1);
      expect(Number(rTxns[0].amount)).toBe(5);

      // A: 1% of RM1000 = RM10, reason vip_rebate.
      const aTxns = await service.listCreditTransactions({
        customer_id: 'cus_a',
        reason: 'vip_rebate',
      });
      expect(aTxns).toHaveLength(1);
      expect(Number(aTxns[0].amount)).toBe(10);

      // Each line carries its transaction and an RF ledger row keyed on it.
      const lines = await service.listWeeklySettlementLines({
        settlement_id: id,
      });
      for (const l of lines) {
        expect(l.status).toBe('paid');
        expect(l.paid_transaction_id).not.toBeNull();
        const entries = await service.listLedgerEntries({
          type: 'RF',
          ref_id: l.id,
        });
        expect(entries).toHaveLength(1);
        expect(Number(entries[0].wallet_delta)).toBe(l.amount_cents / 100);
      }

      const [run] = await service.listWeeklySettlements({ id });
      expect(run.status).toBe('paid');
      expect(run.paid_at).not.toBeNull();

      // Re-running pay must not double-credit.
      const again = await service.payWeeklySettlement({ settlementId: id });
      expect(again.paid).toBe(0);
      expect(
        await service.listCreditTransactions({
          reason: ['referral_commission', 'vip_rebate'],
        }),
      ).toHaveLength(2);
    });

    it('skipCustomerIds voids those lines as account_deleted', async () => {
      const id = await seedClosedWeek();
      await service.approveWeeklySettlement({
        settlementId: id,
        adminId: 'admin_1',
      });
      const res = await service.payWeeklySettlement({
        settlementId: id,
        skipCustomerIds: ['cus_a'],
      });
      expect(res.paid).toBe(1);
      expect(res.skipped).toBe(1);
      const [aLine] = await service.listWeeklySettlementLines({
        settlement_id: id,
        customer_id: 'cus_a',
      });
      expect(aLine.status).toBe('voided');
      expect(aLine.void_reason).toBe('account_deleted');
      // Run still flips to paid — nothing pending remains.
      const [run] = await service.listWeeklySettlements({ id });
      expect(run.status).toBe('paid');
    });
  },
});
