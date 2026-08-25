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
    CustomerAccountState,
    AdminActionAudit,
    VipMemberState,
    VipRewardGrant,
  ],
  testSuite: ({ service }) => {
    describe('walletSummary', () => {
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

          // Earn no-deposit (internal) credit, then spend it on packs. A real
          // open funded entirely by non-deposit balance writes
          // external_funded_cents: 0 (consumeExternalSen returns 0 when the
          // external balance is 0), so it banks NO playthrough.
          await service.createCreditTransactions([
            {
              customer_id: cust,
              amount: 100,
              reason: 'buyback' as const,
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
        'walletSummary: frozen account reports available 0 on a real balance',
        async () => {
          const frozenId = 'cus_ws_frozen';

          // Topup so balance is non-zero
          await service.mutateCreditAtomic({
            customerId: frozenId,
            amount: 100,
            reason: 'topup',
            reference: 'topup_ws_frozen',
          });

          // Freeze via setManualFreeze (Phase 3a freeze API)
          await service.setManualFreeze({
            customerId: frozenId,
            adminId: 'admin_test',
            reason: 'wallet summary freeze test',
          });

          const w = await service.walletSummary(frozenId);

          // available must be 0 when frozen, even though the balance is real
          expect(w.balance).toBe(100);
          expect(w.available).toBe(0);
          expect(w.withdrawable).toBe(0);
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

      it(
        'walletSummary: precomputed inputs agree with the self-scan path',
        async () => {
          const cust = 'cus_ws_bothpaths';

          // Mixed ledger: a pre-1b topup (NULL basis, grandfathered out of
          // deposited), a post-1b topup (RM120 → +12000 basis), and a partial
          // deposit-funded open (RM50). Exercises non-trivial balance /
          // deposited / used so an agreement between paths is meaningful.
          await service.createCreditTransactions([
            {
              customer_id: cust,
              amount: 30,
              reason: 'topup' as const,
              pull_id: null,
              reference: 'bothpaths_pre1b',
            } as Record<string, unknown>,
          ]);
          await service.mutateCreditAtomic({
            customerId: cust,
            amount: 120,
            reason: 'topup',
            reference: 'bothpaths_post1b',
          });
          await service.createCreditTransactions([
            {
              customer_id: cust,
              amount: -50,
              reason: 'pack_open' as const,
              pull_id: null,
              reference: null,
              external_funded_cents: -5000,
            } as Record<string, unknown>,
          ]);

          const s = await service.creditSummary(cust);
          const scanned = await service.walletSummary(cust);
          const threaded = await service.walletSummary(cust, {
            balance: s.balance,
            depositedCents: Math.round(s.depositedPlaythroughTotal * 100),
            usedCents: Math.round(s.externalFundedSpendTotal * 100),
          });

          // The two paths must return an identical wallet summary — proving the
          // threaded scalars reproduce the self-scan exactly (the single-scan
          // refactor is behavior-preserving) and that the optional-arg path
          // still receives its injected context at the shifted parameter index.
          expect(threaded).toEqual(scanned);
          // Sanity: the shared basis is actually non-trivial here.
          expect(scanned.playthrough.deposited).toBeCloseTo(120, 2);
          expect(scanned.playthrough.used).toBeCloseTo(50, 2);
        },
      );
    });
  },
});
