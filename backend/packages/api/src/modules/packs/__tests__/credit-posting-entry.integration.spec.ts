/**
 * mutateCreditAtomic, the one credit posting entry point (integration:modules):
 * what a posting with a ledger part writes, what a replay and a refusal
 * write (nothing), and when an inflow lifts a freeze. Row-level goldens for
 * every site live in credit-posting.integration.spec.ts.
 */

import path from 'path';
import { moduleIntegrationTestRunner } from '@medusajs/test-utils';
import { PACKS_MODULE } from '../index';
import type PacksModuleService from '../service';
import CreditTransaction from '../models/credit-transaction';
import CustomerAccountState from '../models/customer-account-state';
import LedgerEntry from '../models/ledger-entry';
import LedgerSequence from '../models/ledger-sequence';

jest.setTimeout(120 * 1000);

moduleIntegrationTestRunner<PacksModuleService>({
  moduleName: PACKS_MODULE,
  resolve: path.resolve(__dirname, '../../..', 'modules/packs'),
  moduleModels: [CreditTransaction, CustomerAccountState, LedgerEntry, LedgerSequence],
  testSuite: ({ service }) => {
    const credits = (customer_id: string) => service.listCreditTransactions({ customer_id });
    const ledger = (customer_id: string) => service.listLedgerEntries({ customer_id });
    const wp = { type: 'WP' as const, period: 'p', stage: 0, rank: 0, sku: null, value: 0 };

    it('writes the ledger part with the credit: ref_id and wallet_delta default to the row', async () => {
      const c = 'cus_entry_ledger';
      const res = await service.mutateCreditAtomic({
        customerId: c, amount: 2.004, reason: 'reward_credit', idempotencyReference: 'task:x',
        ledger: { type: 'WP', payload: wp },
      });
      expect(res).toMatchObject({ amount: 2, balance: 2, rowBonusCents: 200, replayed: false });
      const [row] = await ledger(c);
      expect(res.ledger).toEqual({ id: row.id, display_id: row.display_id });
      expect(row).toMatchObject({ type: 'WP', ref_id: res.id, vault_delta: null });
      expect(Number(row.wallet_delta)).toBe(2);
    });

    it('an explicit ref_id and deltas win', async () => {
      const c = 'cus_entry_explicit';
      await service.createCreditTransactions([{ customer_id: c, amount: 50, reason: 'topup', external_funded_cents: 5000 }]);
      const res = await service.mutateCreditAtomic({
        customerId: c, amount: -15, reason: 'delivery_fee', reference: 'order_1',
        ledger: { type: 'OD', refId: 'order_1', walletDelta: -15, vaultDelta: -48,
          payload: { type: 'OD', handles: [], status: 'requested' } },
      });
      const [row] = await ledger(c);
      expect(row).toMatchObject({ ref_id: 'order_1' });
      expect([Number(row.wallet_delta), Number(row.vault_delta)]).toEqual([-15, -48]);
      // No bonus held, so the fee took none (rowBonusCents is the row's sen).
      expect((await credits(c)).find((r) => r.id === res.id)!.bonus_cents).toBe(0);
    });

    it('a replay writes one credit and one ledger row in total', async () => {
      const c = 'cus_entry_replay';
      const post = () => service.mutateCreditAtomic({
        customerId: c, amount: 5, reason: 'reward_credit', idempotencyReference: 'luckydraw:p1',
        ledger: { type: 'WP', payload: wp },
      });
      const first = await post();
      const again = await post();
      expect(again).toMatchObject({ id: first.id, replayed: true });
      expect(again.ledger).toBeUndefined();
      expect(await credits(c)).toHaveLength(1);
      expect(await ledger(c)).toHaveLength(1);
    });

    it('a floor refusal writes neither row', async () => {
      const c = 'cus_entry_floor';
      await expect(service.mutateCreditAtomic({
        customerId: c, amount: -1, reason: 'adjustment', floor: 0,
        ledger: { type: 'AD', payload: { type: 'AD', admin_id: 'a', reason: 'r', detail: null, card_handle: null } },
      })).rejects.toThrow(/Deduction exceeds/);
      expect(await credits(c)).toHaveLength(0);
      expect(await ledger(c)).toHaveLength(0);
    });

    it('an inflow that repays the debt lifts an AUTO freeze, never a manual one', async () => {
      for (const cause of ['auto', 'manual'] as const) {
        const c = `cus_entry_freeze_${cause}`;
        await service.createCreditTransactions([{ customer_id: c, amount: -10, reason: 'pack_open' }]);
        await service.createCustomerAccountStates([{ customer_id: c, frozen: true, cause, frozen_at: new Date() }]);
        await service.mutateCreditAtomic({ customerId: c, amount: 4, reason: 'adjustment' });
        expect((await service.listCustomerAccountStates({ customer_id: c }))[0].frozen).toBe(true);
        await service.mutateCreditAtomic({ customerId: c, amount: 6, reason: 'adjustment' });
        expect((await service.listCustomerAccountStates({ customer_id: c }))[0].frozen).toBe(cause === 'manual');
      }
    });

    it('a commission replay with the same RF ref writes nothing (RF first, unlocked)', async () => {
      const c = 'cus_entry_rf';
      const post = () => service.mutateCreditAtomic({
        customerId: c, amount: 5, reason: 'referral_commission', unlocked: true,
        ledger: { type: 'RF', refId: 'wsl_1', walletDelta: 5, vaultDelta: null,
          payload: { type: 'RF', week_start: '2026-11-09', basis_cents: 100000, rate_bp: 50 } },
      });
      const first = await post();
      const again = await post();
      expect(first).toMatchObject({ replayed: false, rowBonusCents: null });
      expect(again).toMatchObject({ replayed: true, id: '', ledger: first.ledger });
      const [row] = await credits(c);
      expect(await credits(c)).toHaveLength(1);
      expect(await ledger(c)).toHaveLength(1);
      expect([row.external_funded_cents, row.bonus_cents, row.source_transaction_id]).toEqual([null, null, null]);
    });

    // Folded from credit-idempotency.spec.ts (security audit 2026-06-23): the
    // anchor's dedupe is scoped to the customer whose credit lock it holds.
    it('the idempotency anchor is customer-scoped: two customers with one anchor are each credited', async () => {
      const ref = 'topup-idem:SHARED-KEY';
      const a = await service.mutateCreditAtomic({ customerId: 'cus_idem_A', amount: 10, reason: 'topup', idempotencyReference: ref });
      const b = await service.mutateCreditAtomic({ customerId: 'cus_idem_B', amount: 10, reason: 'topup', idempotencyReference: ref });
      expect(a.replayed).toBe(false);
      expect(b).toMatchObject({ replayed: false, balance: 10 });
      expect(b.id).not.toBe(a.id);
      expect(await credits('cus_idem_A')).toHaveLength(1);
      expect(await credits('cus_idem_B')).toHaveLength(1);
    });

    it('a same-customer replay returns the original row and amount', async () => {
      const ref = 'topup-idem:cus_idem_C:k1';
      const first = await service.mutateCreditAtomic({ customerId: 'cus_idem_C', amount: 25, reason: 'topup', idempotencyReference: ref });
      const replay = await service.mutateCreditAtomic({ customerId: 'cus_idem_C', amount: 25, reason: 'topup', idempotencyReference: ref });
      expect(replay).toMatchObject({ replayed: true, id: first.id, amount: 25 });
      expect(await credits('cus_idem_C')).toHaveLength(1);
    });

    it('re-credits after the original row is deleted (the dedupe ignores deleted rows)', async () => {
      const ref = 'topup-idem:cus_idem_D:k1';
      const first = await service.mutateCreditAtomic({ customerId: 'cus_idem_D', amount: 40, reason: 'topup', idempotencyReference: ref });
      await service.deleteCreditTransactionsGuarded([first.id]);
      const after = await service.mutateCreditAtomic({ customerId: 'cus_idem_D', amount: 40, reason: 'topup', idempotencyReference: ref });
      expect(after).toMatchObject({ replayed: false, balance: 40 });
      expect(after.id).not.toBe(first.id);
      expect(await credits('cus_idem_D')).toHaveLength(1);
    });
  },
});
