/**
 * walletSummary integration test — integration:modules
 *
 * Verifies:
 *  1. locked = pending-unmatured + suspended; reversed commissions excluded.
 *  2. nextUnlock = earliest pending maturity date + the amount maturing then.
 *  3. Frozen account → available 0, but locked is the real value.
 *
 * Uses the real DB via moduleIntegrationTestRunner (lightweight; no full
 * medusa app boot).
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
    describe('walletSummary', () => {
      it(
        'walletSummary: locked excludes reversed/available; nextUnlock = earliest pending tranche',
        async () => {
          const cust = 'cus_ws_main';

          // --- topup: give the customer a base balance ---
          await service.mutateCreditAtomic({
            customerId: cust,
            amount: 200,
            reason: 'topup',
            reference: 'topup_ws_main',
          });

          // --- pending commission #1: matures at T1 (earliest), amount A = 10 ---
          const T1 = new Date(Date.now() + 2 * 86_400_000); // +2 days
          const [creditA] = await service.createCreditTransactions([
            {
              customer_id: cust,
              amount: 10,
              reason: 'direct_referral' as const,
              pull_id: null,
              reference: null,
              source_transaction_id: 'open_ws_a',
              generation: 1,
            } as Record<string, unknown>,
          ]);
          await service.createCommissions([
            {
              credit_transaction_id: creditA.id,
              beneficiary: cust,
              source_transaction_id: 'open_ws_a',
              generation: 1,
              kind: 'direct',
              status: 'pending',
              matures_at: T1,
              effective_pct: 5,
            } as Record<string, unknown>,
          ]);

          // --- pending commission #2: matures at T2 > T1, amount B = 20 ---
          const T2 = new Date(Date.now() + 4 * 86_400_000); // +4 days
          const [creditB] = await service.createCreditTransactions([
            {
              customer_id: cust,
              amount: 20,
              reason: 'direct_referral' as const,
              pull_id: null,
              reference: null,
              source_transaction_id: 'open_ws_b',
              generation: 1,
            } as Record<string, unknown>,
          ]);
          await service.createCommissions([
            {
              credit_transaction_id: creditB.id,
              beneficiary: cust,
              source_transaction_id: 'open_ws_b',
              generation: 1,
              kind: 'direct',
              status: 'pending',
              matures_at: T2,
              effective_pct: 5,
            } as Record<string, unknown>,
          ]);

          // --- suspended commission: amount S = 15 (always locked) ---
          const [creditS] = await service.createCreditTransactions([
            {
              customer_id: cust,
              amount: 15,
              reason: 'team_override' as const,
              pull_id: null,
              reference: null,
              source_transaction_id: 'open_ws_s',
              generation: 2,
            } as Record<string, unknown>,
          ]);
          await service.createCommissions([
            {
              credit_transaction_id: creditS.id,
              beneficiary: cust,
              source_transaction_id: 'open_ws_s',
              generation: 2,
              kind: 'override',
              status: 'suspended',
              matures_at: new Date(Date.now() + 86_400_000),
              effective_pct: 20,
            } as Record<string, unknown>,
          ]);

          // --- reversed commission: amount R = 30, its reversal row nets it out;
          //     the commission status='reversed' must NOT count as locked ---
          const [creditR] = await service.createCreditTransactions([
            {
              customer_id: cust,
              amount: 30,
              reason: 'direct_referral' as const,
              pull_id: null,
              reference: null,
              source_transaction_id: 'open_ws_r',
              generation: 1,
            } as Record<string, unknown>,
          ]);
          await service.createCommissions([
            {
              credit_transaction_id: creditR.id,
              beneficiary: cust,
              source_transaction_id: 'open_ws_r',
              generation: 1,
              kind: 'direct',
              status: 'reversed',
              matures_at: new Date(Date.now() + 86_400_000),
              effective_pct: 5,
            } as Record<string, unknown>,
          ]);
          // negative reversal row (balances the books — balance = 200 + 10 + 20 + 15 + 30 - 30 = 245)
          await service.createCreditTransactions([
            {
              customer_id: cust,
              amount: -30,
              reason: 'commission_reversal' as const,
              pull_id: null,
              reference: 'reversal:open_ws_r',
              source_transaction_id: null,
              generation: 0,
            } as Record<string, unknown>,
          ]);

          // Act
          const w = await service.walletSummary(cust);

          // Assert locked = A + B + S = 45; reversed R NOT locked
          expect(w.locked).toBeCloseTo(10 + 20 + 15, 2);

          // nextUnlock = earliest pending tranche = T1, amount = A = 10
          expect(w.nextUnlock).not.toBeNull();
          expect(w.nextUnlock!.amount).toBeCloseTo(10, 2);
          // date should match T1 within 1 second (ISO string round-trip)
          expect(
            Math.abs(new Date(w.nextUnlock!.date).getTime() - T1.getTime()),
          ).toBeLessThan(1000);

          // available = balance - locked (not frozen)
          expect(w.available).toBeCloseTo(w.balance - w.locked, 2);
          expect(w.isFrozen).toBe(false);
        },
      );

      it(
        'walletSummary: playthrough gate — buybacks never unlock unspent deposits',
        async () => {
          const cust = 'cus_ws_playthrough';

          // deposit RM100, open RM40, sell a card back for RM100.
          await service.mutateCreditAtomic({
            customerId: cust,
            amount: 100,
            reason: 'topup',
            reference: 'topup_ws_pt',
          });
          await service.createCreditTransactions([
            {
              customer_id: cust,
              amount: -40,
              reason: 'pack_open' as const,
              pull_id: null,
              reference: null,
              // deposit-funded open: the gate sums external basis, not amount
              external_funded_cents: -4000,
            } as Record<string, unknown>,
            {
              customer_id: cust,
              amount: 100,
              reason: 'buyback' as const,
              pull_id: null,
              reference: null,
            } as Record<string, unknown>,
          ]);

          // balance 160, but used(40) < deposited(100) -> nothing withdrawable.
          let w = await service.walletSummary(cust);
          expect(w.balance).toBeCloseTo(160, 2);
          expect(w.withdrawable).toBe(0);
          expect(w.playthrough).toEqual({
            deposited: 100,
            used: 40,
            remaining: 60,
          });

          // open the remaining RM60 -> gate opens, full available withdrawable.
          await service.createCreditTransactions([
            {
              customer_id: cust,
              amount: -60,
              reason: 'pack_open' as const,
              pull_id: null,
              reference: null,
              external_funded_cents: -6000,
            } as Record<string, unknown>,
          ]);
          w = await service.walletSummary(cust);
          expect(w.playthrough).toEqual({
            deposited: 100,
            used: 100,
            remaining: 0,
          });
          expect(w.withdrawable).toBeCloseTo(w.available, 2);
          expect(w.withdrawable).toBeCloseTo(100, 2);
        },
      );

      it(
        'walletSummary: playthrough gate — promo-funded play does not unlock a later deposit',
        async () => {
          const cust = 'cus_ws_promo_basis';

          // Earn no-deposit (commission) credit, then spend it on packs. A real
          // open funded entirely by non-deposit balance writes
          // external_funded_cents: 0 (consumeExternalSen returns 0 when the
          // external balance is 0), so it banks NO playthrough.
          await service.createCreditTransactions([
            {
              customer_id: cust,
              amount: 100,
              reason: 'direct_referral' as const,
              external_funded_cents: 0,
              pull_id: null,
              reference: null,
            } as Record<string, unknown>,
            {
              customer_id: cust,
              amount: -100,
              reason: 'pack_open' as const,
              external_funded_cents: 0,
              pull_id: null,
              reference: null,
            } as Record<string, unknown>,
          ]);

          // NOW deposit real money. The lifetime gate must NOT already be
          // satisfied by the earlier promo-funded play (timing can't save it —
          // the sums are lifetime aggregates).
          await service.mutateCreditAtomic({
            customerId: cust,
            amount: 100,
            reason: 'topup',
            reference: 'topup_ws_promo',
          });

          // Under the pre-plan `amount` basis this assertion fails: used would be
          // 100 and the untouched deposit instantly withdrawable — the
          // deposit-passthrough hole this plan closes. On the external basis the
          // promo-funded open contributes 0 used, so the deposit stays locked.
          let w = await service.walletSummary(cust);
          expect(w.playthrough).toEqual({
            deposited: 100,
            used: 0,
            remaining: 100,
          });
          expect(w.withdrawable).toBe(0);

          // Play the deposit through (a real deposit-funded open) -> gate opens.
          await service.createCreditTransactions([
            {
              customer_id: cust,
              amount: -100,
              reason: 'pack_open' as const,
              external_funded_cents: -10000,
              pull_id: null,
              reference: null,
            } as Record<string, unknown>,
          ]);
          w = await service.walletSummary(cust);
          expect(w.playthrough.remaining).toBe(0);
          expect(w.withdrawable).toBeCloseTo(w.available, 2);

          // Balance is 0 here, so withdrawable≈available alone is 0≈0 — it
          // would pass even with the gate stuck closed. Add a non-deposit
          // credit and prove a POSITIVE balance is actually withdrawable.
          await service.createCreditTransactions([
            {
              customer_id: cust,
              amount: 25,
              reason: 'buyback' as const,
              external_funded_cents: 0,
              pull_id: null,
              reference: null,
            } as Record<string, unknown>,
          ]);
          w = await service.walletSummary(cust);
          expect(w.playthrough.remaining).toBe(0); // buyback doesn't re-lock
          expect(w.withdrawable).toBeGreaterThan(0);
          expect(w.withdrawable).toBeCloseTo(w.available, 2);
          expect(w.withdrawable).toBeCloseTo(25, 2);
        },
      );

      it(
        'walletSummary: frozen account reports available 0 but real locked',
        async () => {
          const frozenId = 'cus_ws_frozen';

          // Topup so balance is non-zero
          await service.mutateCreditAtomic({
            customerId: frozenId,
            amount: 100,
            reason: 'topup',
            reference: 'topup_ws_frozen',
          });

          // Add a locked pending commission
          const [creditF] = await service.createCreditTransactions([
            {
              customer_id: frozenId,
              amount: 25,
              reason: 'direct_referral' as const,
              pull_id: null,
              reference: null,
              source_transaction_id: 'open_ws_frozen',
              generation: 1,
            } as Record<string, unknown>,
          ]);
          await service.createCommissions([
            {
              credit_transaction_id: creditF.id,
              beneficiary: frozenId,
              source_transaction_id: 'open_ws_frozen',
              generation: 1,
              kind: 'direct',
              status: 'pending',
              matures_at: new Date(Date.now() + 86_400_000),
              effective_pct: 5,
            } as Record<string, unknown>,
          ]);

          // Freeze via setManualFreeze (Phase 3a freeze API)
          await service.setManualFreeze({
            customerId: frozenId,
            adminId: 'admin_test',
            reason: 'wallet summary freeze test',
          });

          // Act
          const w = await service.walletSummary(frozenId);

          // available must be 0 when frozen
          expect(w.available).toBe(0);
          // locked should still reflect the real locked amount
          expect(w.locked).toBeGreaterThan(0);
          expect(w.isFrozen).toBe(true);
        },
      );

      it(
        'walletSummary: pre-1b topup does not count toward deposited',
        async () => {
          const cust = 'cus_ws_pre1b_mixed';

          // Pre-1b deposit: external_funded_cents omitted → NULL (the column is
          // nullable with no default). Simulates a deposit made before the 1b
          // basis column existed. It must NOT route through mutateCreditAtomic,
          // which stamps a non-NULL basis on every topup.
          await service.createCreditTransactions([
            {
              customer_id: cust,
              amount: 50,
              reason: 'topup' as const,
              pull_id: null,
              reference: 'pre1b_topup',
            } as Record<string, unknown>,
          ]);

          // Post-1b deposit RM80 (mutateCreditAtomic stamps +8000 basis), then
          // fully played through by a deposit-funded open.
          await service.mutateCreditAtomic({
            customerId: cust,
            amount: 80,
            reason: 'topup',
            reference: 'post1b_topup',
          });
          await service.createCreditTransactions([
            {
              customer_id: cust,
              amount: -80,
              reason: 'pack_open' as const,
              pull_id: null,
              reference: null,
              external_funded_cents: -8000,
            } as Record<string, unknown>,
          ]);

          const w = await service.walletSummary(cust);

          // deposited counts only the post-1b RM80; the pre-1b RM50 is
          // grandfathered out. used = 80 → gate open.
          expect(w.playthrough).toEqual({
            deposited: 80,
            used: 80,
            remaining: 0,
          });
          // Balance = 50 + 80 - 80 = 50; the grandfathered pre-1b deposit is
          // fully withdrawable now that the gate is open.
          expect(w.balance).toBeCloseTo(50, 2);
          expect(w.withdrawable).toBeGreaterThan(0);
          expect(w.withdrawable).toBeCloseTo(w.available, 2);
          expect(w.withdrawable).toBeCloseTo(50, 2);
        },
      );

      it(
        'walletSummary: legacy customer — pre-1b deposit alone is withdrawable-eligible',
        async () => {
          const cust = 'cus_ws_pre1b_only';

          // A legacy customer whose ONLY ledger row is a pre-1b topup (NULL
          // basis) and who never opened a pack. Grandfathered: deposited 0 →
          // remaining 0 → the whole balance is withdrawable.
          await service.createCreditTransactions([
            {
              customer_id: cust,
              amount: 50,
              reason: 'topup' as const,
              pull_id: null,
              reference: 'pre1b_only_topup',
            } as Record<string, unknown>,
          ]);

          const w = await service.walletSummary(cust);

          expect(w.playthrough.deposited).toBe(0);
          expect(w.playthrough.remaining).toBe(0);
          expect(w.balance).toBeCloseTo(50, 2);
          expect(w.withdrawable).toBeGreaterThan(0);
          expect(w.withdrawable).toBeCloseTo(w.available, 2);
          expect(w.withdrawable).toBeCloseTo(50, 2);
        },
      );
    });
  },
});
