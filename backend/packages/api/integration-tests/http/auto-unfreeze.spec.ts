import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import payReferralWeekJob from '../../src/jobs/pay-referral-week';
import { VIP_LEVELS } from '../../src/scripts/vip-levels.data';

jest.setTimeout(180 * 1000);

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ getContainer }) => {
    async function seedLadder(packs: PacksModuleService) {
      const existing = await packs.listVipLevels({}, { take: 1 });
      if (existing.length === 0) {
        await packs.createVipLevels(
          VIP_LEVELS.map((r) => ({
            level: r.level,
            spend_threshold: r.spend_threshold,
            voucher_amount: r.voucher_amount,
            frame_unlock: r.frame_unlock,
            prizes: r.prizes ?? null,
          })),
        );
      }
    }

    describe('auto-unfreeze on repayment', () => {
      // Scenario A: AUTO-frozen account with negative balance; a topup that brings
      // balance >= 0 should lift the freeze and stamp unfreeze_cause='repaid'.
      it(
        '(A) AUTO freeze clears when a topup via mutateCreditAtomic repays the debt',
        async () => {
          const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
          const cid = 'cust_au_auto_a';

          // Seed a negative ledger row directly — mutateCreditAtomic's floor=0
          // would block an outright negative, so we bypass it to arrange the
          // "already in debt" state. This is the same pattern used in other specs
          // (delete-guard, closed-wash-ring) to set up unusual ledger states.
          await packs.createCreditTransactions([
            {
              customer_id: cid,
              amount: -5,
              reason: 'adjustment' as const,
              pull_id: null,
              reference: 'seed-debt',
              external_funded_cents: 0,
              source_transaction_id: null,
            } as Record<string, unknown>,
          ]);

          // Create the frozen state row (cause='auto').
          await packs.createCustomerAccountStates([
            {
              customer_id: cid,
              frozen: true,
              cause: 'auto',
              frozen_reason: 'clawback:open_x',
            },
          ]);

          // Precondition: account is frozen before repayment.
          const [beforeState] = await packs.listCustomerAccountStates(
            { customer_id: cid, frozen: true },
            { take: 1 },
          );
          expect(beforeState).toBeTruthy();
          expect(beforeState.cause).toBe('auto');

          // Act: topup that brings balance from -5 to +15 (>= 0).
          await packs.mutateCreditAtomic({
            customerId: cid,
            amount: 20,
            reason: 'topup',
          });

          // Assert: freeze lifted.
          const [afterState] = await packs.listCustomerAccountStates(
            { customer_id: cid },
            { take: 1 },
          );
          expect(afterState.frozen).toBe(false);
          expect(afterState.unfreeze_cause).toBe('repaid');
          expect(afterState.unfrozen_at).toBeTruthy();
        },
      );

      // Scenario A2: A topup that only partially repays (balance still negative)
      // must NOT lift the freeze.
      it(
        '(A2) AUTO freeze stays when topup leaves balance still negative',
        async () => {
          const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
          const cid = 'cust_au_partial';

          await packs.createCreditTransactions([
            {
              customer_id: cid,
              amount: -10,
              reason: 'adjustment' as const,
              pull_id: null,
              reference: 'seed-debt-2',
              external_funded_cents: 0,
              source_transaction_id: null,
            } as Record<string, unknown>,
          ]);

          await packs.createCustomerAccountStates([
            {
              customer_id: cid,
              frozen: true,
              cause: 'auto',
              frozen_reason: 'clawback:open_partial',
            },
          ]);

          // Act: only partially repay — balance goes from -10 to -5 (still < 0).
          await packs.mutateCreditAtomic({
            customerId: cid,
            amount: 5,
            reason: 'topup',
          });

          const [state] = await packs.listCustomerAccountStates(
            { customer_id: cid },
            { take: 1 },
          );
          expect(state.frozen).toBe(true);
          expect(state.unfreeze_cause).toBeNull();
        },
      );

      // Scenario B: MANUAL freeze must NEVER be auto-lifted, regardless of balance.
      it(
        '(B) MANUAL freeze stays frozen even when a topup brings balance positive',
        async () => {
          const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
          const cid = 'cust_au_manual_b';

          await packs.createCustomerAccountStates([
            {
              customer_id: cid,
              frozen: true,
              cause: 'manual',
              frozen_by: 'admin_x',
              frozen_reason: 'fraud',
            },
          ]);

          // Act: healthy topup — balance goes positive.
          await packs.mutateCreditAtomic({
            customerId: cid,
            amount: 20,
            reason: 'topup',
          });

          const [state] = await packs.listCustomerAccountStates(
            { customer_id: cid },
            { take: 1 },
          );
          // MANUAL freeze is sticky — must not be lifted by maybeAutoUnfreeze.
          expect(state.frozen).toBe(true);
          expect(state.cause).toBe('manual');
          expect(state.unfreeze_cause).toBeNull();
        },
      );

      // Scenario C: the weekly commission payout. Its credit is a direct insert,
      // NOT a mutateCreditAtomic call, so it never gets the inline unfreeze —
      // the pay callers run maybeAutoUnfreezeForCustomer post-commit instead.
      // Exercised through the cron job (the caller that owns the sweep), not
      // through payWeeklySettlement, because the sweep is what is under test.
      //
      // week_start is UNIQUE on weekly_settlement and this runner does NOT reset
      // between tests, so each scenario seeds its own week and its own ids.
      async function seedApprovedRun(
        packs: PacksModuleService,
        customerId: string,
        weekStart: Date,
        amountCents: number,
      ): Promise<void> {
        const [run] = await packs.createWeeklySettlements([
          {
            week_start: weekStart,
            status: 'approved' as const,
            total_commission_cents: amountCents,
          },
        ]);
        await packs.createWeeklySettlementLines([
          {
            settlement_id: run.id,
            customer_id: customerId,
            basis_cents: amountCents * 200,
            rate_bp: 50,
            amount_cents: amountCents,
            status: 'pending' as const,
          },
        ]);
      }

      it(
        '(C) AUTO freeze clears when a weekly commission payout repays the debt',
        async () => {
          const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
          const cid = 'cust_au_settlement_c';

          // In debt by RM5 (seeded directly — mutateCreditAtomic's floor=0
          // refuses an outright negative), and AUTO-frozen for it.
          await packs.createCreditTransactions([
            {
              customer_id: cid,
              amount: -5,
              reason: 'adjustment' as const,
              pull_id: null,
              reference: 'seed-debt-settlement',
              external_funded_cents: 0,
              source_transaction_id: null,
            } as Record<string, unknown>,
          ]);
          await packs.createCustomerAccountStates([
            {
              customer_id: cid,
              frozen: true,
              cause: 'auto',
              frozen_reason: 'clawback:open_settlement',
            },
          ]);

          // RM20 of commission owed on an APPROVED run — more than covers it.
          await seedApprovedRun(packs, cid, new Date('2031-03-04T16:00:00Z'), 2000);

          // Act: the hourly pay cron.
          await payReferralWeekJob(getContainer());

          // The money moved...
          const txns = await packs.listCreditTransactions({
            customer_id: cid,
            reason: 'referral_commission',
          });
          expect(txns).toHaveLength(1);
          expect(Number(txns[0].amount)).toBe(20);

          // ...and the freeze went with it. Without the callers' post-commit
          // sweep the referrer is paid but still locked out.
          const [state] = await packs.listCustomerAccountStates(
            { customer_id: cid },
            { take: 1 },
          );
          expect(state.frozen).toBe(false);
          expect(state.unfreeze_cause).toBe('repaid');
          expect(state.unfrozen_at).toBeTruthy();
        },
      );

      // Scenario C2: the sweep must not become a back door around a manual hold.
      // maybeAutoUnfreeze is scoped to cause='auto', so this already holds —
      // the test pins it.
      it(
        '(C2) MANUAL freeze survives a weekly commission payout',
        async () => {
          const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
          const cid = 'cust_au_settlement_manual_c2';

          await packs.createCustomerAccountStates([
            {
              customer_id: cid,
              frozen: true,
              cause: 'manual',
              frozen_by: 'admin_y',
              frozen_reason: 'fraud',
            },
          ]);

          await seedApprovedRun(packs, cid, new Date('2031-03-11T16:00:00Z'), 2000);

          await payReferralWeekJob(getContainer());

          // Paid — a manual freeze does not block money coming IN...
          const txns = await packs.listCreditTransactions({
            customer_id: cid,
            reason: 'referral_commission',
          });
          expect(txns).toHaveLength(1);
          // ...but the hold is the admin's to lift, not the payout's.
          const [state] = await packs.listCustomerAccountStates(
            { customer_id: cid },
            { take: 1 },
          );
          expect(state.frozen).toBe(true);
          expect(state.cause).toBe('manual');
          expect(state.unfreeze_cause).toBeNull();
        },
      );
    });
  },
});
