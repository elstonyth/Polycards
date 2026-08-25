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

    it('a deleted account is voided as account_deleted, not paid', async () => {
      const id = await seedClosedWeek();
      // How the pay step detects deletion: the delete_account audit row —
      // the same source deletedCustomerIds reads everywhere else.
      await service.createAdminActionAudits([
        {
          admin_id: 'cus_a',
          entity_type: 'customer',
          entity_id: 'cus_a',
          action: 'delete_account',
          before: null,
          after: null,
          reason: 'self-service deletion',
        },
      ]);
      await service.approveWeeklySettlement({
        settlementId: id,
        adminId: 'admin_1',
      });
      const res = await service.payWeeklySettlement({ settlementId: id });
      expect(res.paid).toBe(1);
      expect(res.skipped).toBe(1);
      const [aLine] = await service.listWeeklySettlementLines({
        settlement_id: id,
        customer_id: 'cus_a',
      });
      expect(aLine.status).toBe('voided');
      expect(aLine.void_reason).toBe('account_deleted');
      // The skip deducted A's rebate from the run's stored totals.
      const [run] = await service.listWeeklySettlements({ id });
      expect(run.total_rebate_cents).toBe(0);
      // Run still flips to paid — nothing pending remains.
      expect(run.status).toBe('paid');
    });

    it('voiding a line keeps the run totals the approve dialog quotes true', async () => {
      const id = await seedClosedWeek();
      const lines = await service.listWeeklySettlementLines({
        settlement_id: id,
      });
      const rebate = lines.find((l) => l.kind === 'vip_rebate')!;
      await service.voidSettlementLine({
        lineId: rebate.id,
        adminId: 'admin_1',
        reason: 'test',
      });
      const [run] = await service.listWeeklySettlements({ id });
      expect(run.total_rebate_cents).toBe(0);
      expect(run.total_commission_cents).toBe(500); // untouched
    });

    it('pay writes a pay_settlement audit row (cron identity when no admin)', async () => {
      const id = await seedClosedWeek();
      await service.approveWeeklySettlement({
        settlementId: id,
        adminId: 'admin_1',
      });
      await service.payWeeklySettlement({ settlementId: id });
      const audits = await service.listAdminActionAudits({
        action: 'pay_settlement',
        entity_id: id,
      });
      expect(audits).toHaveLength(1);
      expect(audits[0].admin_id).toBe('system:pay-referral-week');
      // An idempotent re-run pays nothing and must not add a second row.
      await service.payWeeklySettlement({ settlementId: id });
      expect(
        await service.listAdminActionAudits({
          action: 'pay_settlement',
          entity_id: id,
        }),
      ).toHaveLength(1);
    });

    it('voidWeeklySettlement voids a whole draft run', async () => {
      const id = await seedClosedWeek();
      await service.voidWeeklySettlement({
        settlementId: id,
        adminId: 'admin_1',
        reason: 'recompute later',
      });
      const [run] = await service.listWeeklySettlements({ id });
      expect(run.status).toBe('void');
      expect(run.total_commission_cents).toBe(0);
      const lines = await service.listWeeklySettlementLines({
        settlement_id: id,
      });
      expect(lines.every((l) => l.status === 'voided')).toBe(true);
      // Not approvable or payable afterwards.
      await expect(
        service.approveWeeklySettlement({ settlementId: id, adminId: 'a' }),
      ).rejects.toThrow(/draft/i);
      await expect(
        service.payWeeklySettlement({ settlementId: id }),
      ).rejects.toThrow(/approved/i);
    });

    it('a stranded pending line whose RF row already exists is NOT paid twice', async () => {
      const id = await seedClosedWeek();
      await service.approveWeeklySettlement({
        settlementId: id,
        adminId: 'admin_1',
      });
      await service.payWeeklySettlement({ settlementId: id });
      const lines = await service.listWeeklySettlementLines({
        settlement_id: id,
      });
      const line = lines[0];
      // Simulate the crash window the ledger guard exists for: the money
      // moved (RF row + credit written) but the line update was lost.
      await service.updateWeeklySettlementLines({
        selector: { id: line.id },
        data: { status: 'pending' as const, paid_transaction_id: null },
      });
      await service.updateWeeklySettlements({
        selector: { id },
        data: { status: 'approved' as const },
      });
      const before = await service.listCreditTransactions({
        customer_id: line.customer_id,
        reason: line.kind,
      });
      const res = await service.payWeeklySettlement({ settlementId: id });
      expect(res.paid).toBe(0); // replayed, not re-paid
      const after = await service.listCreditTransactions({
        customer_id: line.customer_id,
        reason: line.kind,
      });
      expect(after).toHaveLength(before.length); // NO second credit
      const [repaired] = await service.listWeeklySettlementLines({
        id: line.id,
      });
      expect(repaired.status).toBe('paid'); // and the line is repaired
    });

    it('bindReferral refuses an established spender (signup-scoped)', async () => {
      await service.createCreditTransactions([
        { customer_id: 'cus_old', amount: -50, reason: 'pack_open' },
      ]);
      expect(
        await service.bindReferral({
          customerId: 'cus_old',
          referrerId: 'cus_r9',
        }),
      ).toEqual({ bound: false, reason: 'not_a_new_account' });
      expect(
        await service.listReferralAttributions({ customer_id: 'cus_old' }),
      ).toHaveLength(0);
      // A brand-new account still binds.
      expect(
        await service.bindReferral({
          customerId: 'cus_new',
          referrerId: 'cus_r9',
        }),
      ).toEqual({ bound: true });
    });

    it('adminSetReferral rejects a referrer that does not resolve', async () => {
      await expect(
        service.adminSetReferral({
          customerId: 'cus_z',
          referrerId: 'cus_ghost',
          adminId: 'admin_1',
          reason: 'typo',
          referrerExists: async () => false,
        }),
      ).rejects.toThrow(/not an existing customer/i);
      // With a resolver that says yes, it lands.
      await service.adminSetReferral({
        customerId: 'cus_z',
        referrerId: 'cus_real',
        adminId: 'admin_1',
        reason: 'support',
        referrerExists: async () => true,
      });
      const [row] = await service.listReferralAttributions({
        customer_id: 'cus_z',
      });
      expect(row.referrer_id).toBe('cus_real');
    });

    it('adminSetReferral overrides, clears and audits attribution', async () => {
      await service.bindReferral({
        customerId: 'cus_x',
        referrerId: 'cus_r1',
      });
      // Customer path is permanent…
      expect(
        await service.bindReferral({ customerId: 'cus_x', referrerId: 'cus_r2' }),
      ).toEqual({ bound: false, reason: 'already_bound' });
      // …the admin path can fix it.
      await service.adminSetReferral({
        customerId: 'cus_x',
        referrerId: 'cus_r2',
        adminId: 'admin_1',
        reason: 'support ticket',
      });
      let [row] = await service.listReferralAttributions({
        customer_id: 'cus_x',
      });
      expect(row.referrer_id).toBe('cus_r2');
      await expect(
        service.adminSetReferral({
          customerId: 'cus_x',
          referrerId: 'cus_x',
          adminId: 'admin_1',
          reason: 'bad',
        }),
      ).rejects.toThrow(/themself/i);
      await service.adminSetReferral({
        customerId: 'cus_x',
        referrerId: null,
        adminId: 'admin_1',
        reason: 'clear',
      });
      [row] = await service.listReferralAttributions({ customer_id: 'cus_x' });
      expect(row).toBeUndefined();
    });
  },
});
