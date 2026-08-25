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
  ],
  testSuite: ({ service }) => {
    // The week CONTAINING now — the test closes it explicitly by iso key, so
    // freshly inserted (created_at = now) rows land inside the window.
    const week = referralWeekFor(new Date());

    // The runner resets the DB between tests — seed per test, guarded by an
    // existence check (sibling vip-member-state.spec convention).
    async function seed() {
      const existing = await service.listReferralAttributions({}, { take: 1 });
      if (existing.length > 0) return;
      // Ladder: L1 pays no rebate, L2 pays 1%.
      await service.createVipLevels([
        {
          level: 1,
          spend_threshold: 0,
          voucher_amount: 0,
          box_tier: 'a',
          rebate_bp: 0,
        },
        {
          level: 2,
          spend_threshold: 100,
          voucher_amount: 0,
          box_tier: 'b',
          rebate_bp: 100,
        },
      ]);
      // Attribution: A and B referred by R; D referred by partner R2; C loose.
      await service.createReferralAttributions([
        { customer_id: 'cus_a', referrer_id: 'cus_r' },
        { customer_id: 'cus_b', referrer_id: 'cus_r' },
        { customer_id: 'cus_d', referrer_id: 'cus_r2' },
      ]);
      // R2 is a partner at 4%.
      await service.setPartnerRate({
        customerId: 'cus_r2',
        rateBp: 400,
        adminId: 'admin_1',
      });
      // A is VIP L2 (gets the 1% rebate); everyone else has no state row.
      await service.createVipMemberStates([
        {
          customer_id: 'cus_a',
          lifetime_external_spend_sen: 10_000,
          highest_level_ever: 2,
          current_level: 2,
        },
      ]);
      // This week's turnover: A RM100, B RM50, C RM30 (unreferred), D RM80.
      await service.createCreditTransactions([
        { customer_id: 'cus_a', amount: -100, reason: 'pack_open' },
        { customer_id: 'cus_b', amount: -50, reason: 'pack_open' },
        { customer_id: 'cus_c', amount: -30, reason: 'pack_open' },
        { customer_id: 'cus_d', amount: -80, reason: 'pack_open' },
        // A top-up must never count as turnover.
        { customer_id: 'cus_a', amount: 500, reason: 'topup' },
      ]);
      // A pack_open from LAST week — outside the window, must not count.
      const [old] = await service.createCreditTransactions([
        { customer_id: 'cus_a', amount: -999, reason: 'pack_open' },
      ]);
      // created_at is a framework column the generated update type doesn't
      // expose — assign it anyway (the entity has the field) and VERIFY it
      // stuck, so a silently-ignored assign can't fake an in-window row.
      const lastWeekAt = new Date(week.startUtc.getTime() - 24 * 3600 * 1000);
      await service.updateCreditTransactions({
        selector: { id: old.id },
        data: { created_at: lastWeekAt } as never,
      });
      const [oldRow] = await service.listCreditTransactions({ id: old.id });
      expect(new Date(oldRow.created_at).toISOString()).toBe(
        lastWeekAt.toISOString(),
      );
    }

    it('closes the week into a draft run with the right lines', async () => {
      await seed();
      const r = await service.closeReferralWeek({
        weekStartIso: week.weekStartIso,
      });
      expect(r.created).toBe(true);

      const [run] = await service.listWeeklySettlements({ id: r.settlementId });
      expect(run.status).toBe('draft');
      expect(new Date(run.week_start).toISOString()).toBe(
        week.startUtc.toISOString(),
      );

      const lines = await service.listWeeklySettlementLines({
        settlement_id: r.settlementId,
      });

      // R: downline A+B = RM150 = 15,000c → tier 1 (0.5%) → 75c.
      const rLine = lines.find(
        (l) => l.customer_id === 'cus_r' && l.kind === 'referral_commission',
      );
      expect(rLine).toBeDefined();
      expect(rLine!.basis_cents).toBe(15_000);
      expect(rLine!.rate_bp).toBe(50);
      expect(rLine!.amount_cents).toBe(75);
      expect(rLine!.status).toBe('pending');

      // R2 (partner 4%): downline D = RM80 = 8,000c → 320c.
      const r2Line = lines.find(
        (l) => l.customer_id === 'cus_r2' && l.kind === 'referral_commission',
      );
      expect(r2Line).toBeDefined();
      expect(r2Line!.basis_cents).toBe(8_000);
      expect(r2Line!.rate_bp).toBe(400);
      expect(r2Line!.amount_cents).toBe(320);

      // A (VIP L2, 1%): own RM100 = 10,000c → 100c rebate.
      const aRebate = lines.find(
        (l) => l.customer_id === 'cus_a' && l.kind === 'vip_rebate',
      );
      expect(aRebate).toBeDefined();
      expect(aRebate!.basis_cents).toBe(10_000);
      expect(aRebate!.rate_bp).toBe(100);
      expect(aRebate!.amount_cents).toBe(100);

      // B and C are L1 (0 bp) — no rebate lines; C is unreferred — nobody
      // earns commission on C's spend; zero-amount lines are skipped.
      expect(
        lines.filter((l) => l.kind === 'vip_rebate').map((l) => l.customer_id),
      ).toEqual(['cus_a']);
      expect(lines).toHaveLength(3);

      expect(run.total_commission_cents).toBe(75 + 320);
      expect(run.total_rebate_cents).toBe(100);
    });

    it('is idempotent — a re-run creates nothing new', async () => {
      await seed();
      const first = await service.closeReferralWeek({
        weekStartIso: week.weekStartIso,
      });
      expect(first.created).toBe(true);
      const again = await service.closeReferralWeek({
        weekStartIso: week.weekStartIso,
      });
      expect(again.created).toBe(false);
      expect(again.settlementId).toBe(first.settlementId);
      const runs = await service.listWeeklySettlements({});
      expect(runs).toHaveLength(1);
      const lines = await service.listWeeklySettlementLines({});
      expect(lines).toHaveLength(3);
    });

    it('refuses to close a week whose line breaches the per-line ceiling', async () => {
      // A misconfigured 100% partner rate on RM 60,000 of downline turnover
      // computes RM 60,000 — over the RM 50,000 per-line ceiling.
      await service.createReferralAttributions([
        { customer_id: 'cus_whale', referrer_id: 'cus_bigpartner' },
      ]);
      await service.setPartnerRate({
        customerId: 'cus_bigpartner',
        rateBp: 500,
        adminId: 'admin_1',
      });
      await service.editReferralSettings({
        partner_min_bp: 100,
        partner_max_bp: 10_000,
        adminId: 'admin_1',
        reason: 'test widening',
      });
      await service.setPartnerRate({
        customerId: 'cus_bigpartner',
        rateBp: 10_000, // 100%
        adminId: 'admin_1',
      });
      await service.createCreditTransactions([
        { customer_id: 'cus_whale', amount: -60_000, reason: 'pack_open' },
      ]);
      await expect(
        service.closeReferralWeek({ weekStartIso: week.weekStartIso }),
      ).rejects.toThrow(/ceiling/i);
      // Nothing was written — the operator fixes the config and re-runs.
      expect(await service.listWeeklySettlements({})).toHaveLength(0);
    });

    it('rejects a week key that is not an MYT Tuesday', async () => {
      await expect(
        service.closeReferralWeek({ weekStartIso: '2026-08-19' }), // a Wednesday
      ).rejects.toThrow(/Tuesday/i);
    });
  },
});
