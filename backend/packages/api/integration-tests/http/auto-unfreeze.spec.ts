import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { VIP_LEVELS } from '../../src/scripts/vip-levels.data';

jest.setTimeout(180 * 1000);

medusaIntegrationTestRunner({
  inApp: true,
  env: { COMMISSION_COOLDOWN_DAYS: '0' }, // immediate maturity for scenario C
  testSuite: ({ getContainer }) => {
    async function seedLadder(packs: PacksModuleService) {
      const existing = await packs.listVipLevels({}, { take: 1 });
      if (existing.length === 0) {
        await packs.createVipLevels(
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

      // Scenario C: AUTO-frozen SPONSOR whose balance went negative via a clawback.
      // A downline pack open pays the sponsor a commission via settleOpen. Because
      // settleOpen only holds the recruit's advisory lock (not the sponsor's), it
      // does NOT auto-unfreeze the sponsor — doing so would be a TOCTOU race and
      // risks deadlock with the sorted-lock reversal paths. The sponsor STAYS frozen
      // after the commission. A subsequent direct mutateCreditAtomic inflow (which
      // DOES hold the sponsor's lock) triggers the auto-unfreeze when balance >= 0.
      it(
        '(C) AUTO-frozen sponsor stays frozen after settleOpen commission; unfreezes on direct mutateCreditAtomic inflow',
        async () => {
          const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
          await seedLadder(packs);

          const sponsor = 'cust_au_sponsor_c';
          const recruit = 'cust_au_recruit_c';

          // Seed the sponsor with a small negative balance (simulating a prior clawback).
          // Keep the debt small ($0.10) so a 1% commission on a $50 open ($0.50)
          // would be enough to repay it — but we assert the freeze does NOT lift here.
          await packs.createCreditTransactions([
            {
              customer_id: sponsor,
              amount: -0.1,
              reason: 'adjustment' as const,
              pull_id: null,
              reference: 'seed-debt-c',
              external_funded_cents: 0,
              source_transaction_id: null,
            } as Record<string, unknown>,
          ]);

          // Freeze the sponsor AUTO.
          await packs.createCustomerAccountStates([
            {
              customer_id: sponsor,
              frozen: true,
              cause: 'auto',
              frozen_reason: 'clawback:open_c_prior',
            },
          ]);

          // Link recruit to sponsor.
          // Referral writes were retired with linkSponsor; the model is kept, so the
        // edge is seeded directly for setup.
        await packs.createReferralRelationships([
          { customer_id: recruit, sponsor_id: sponsor },
        ]);

          // Fund the recruit with enough to open a pack.
          await packs.mutateCreditAtomic({
            customerId: recruit,
            amount: 100,
            reason: 'topup',
          });

          // Act: recruit opens a pack; the commission credit is paid to sponsor.
          const settled = await packs.settleOpen({
            customerId: recruit,
            amount: -50,
            sourceTransactionId: 'open_au_c_1',
          });

          // There must have been at least one commission (sponsor had level-1 pct > 0).
          expect(settled.commissions.length).toBeGreaterThan(0);

          // Assert: sponsor is STILL frozen after settleOpen — the commission repaid
          // the debt in the ledger but settleOpen does NOT auto-unfreeze (TOCTOU risk).
          const [midState] = await packs.listCustomerAccountStates(
            { customer_id: sponsor },
            { take: 1 },
          );
          expect(midState.frozen).toBe(true);
          expect(midState.unfreeze_cause).toBeNull();

          // Now a direct mutateCreditAtomic inflow (which holds the sponsor's lock)
          // triggers the auto-unfreeze because the sponsor's balance is now >= 0
          // (commission already repaid the debt; the +1 is a tiny surplus to ensure
          // the projected balance is non-negative even if balance is exactly 0).
          await packs.mutateCreditAtomic({
            customerId: sponsor,
            amount: 0.01,
            reason: 'topup',
          });

          // Assert: freeze now lifted via mutateCreditAtomic.
          const [afterState] = await packs.listCustomerAccountStates(
            { customer_id: sponsor },
            { take: 1 },
          );
          expect(afterState.frozen).toBe(false);
          expect(afterState.unfreeze_cause).toBe('repaid');
        },
      );
    });
  },
});
