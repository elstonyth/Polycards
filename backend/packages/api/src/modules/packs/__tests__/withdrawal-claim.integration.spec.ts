/**
 * claimGlobePayWithdrawalStatus against a REAL Postgres — integration:modules
 *
 * WHY this exists on top of the unit spec (globepay-withdrawal.unit.spec.ts,
 * which pins the statement's shape against a fake `em`): the claim's whole
 * value is its return value, and that comes from what the MikroORM driver
 * hands back for an `UPDATE … RETURNING id`. A fake `em` returns whatever the
 * test says, so it cannot tell us that `rows.length` is a real number here.
 * Get that wrong and every claim answers false — approve silently becomes a
 * no-op and no held withdrawal can ever be released.
 *
 * The mutual exclusion itself is a Postgres property of a single conditional
 * UPDATE (the predicate is re-evaluated against committed state after the row
 * lock releases). These tests run sequentially, so what they prove is the
 * half that lives in our code: a claim on a row whose status no longer
 * matches touches nothing and answers false.
 */

import path from 'path';
import { moduleIntegrationTestRunner } from '@medusajs/test-utils';
import { PACKS_MODULE } from '../index';
import type PacksModuleService from '../service';
import GlobePayWithdrawal from '../models/globepay-withdrawal';
import CreditTransaction from '../models/credit-transaction';
import { withdrawalIdempotencyReference } from '../globepay-withdrawal';

jest.setTimeout(300 * 1000);

moduleIntegrationTestRunner<PacksModuleService>({
  moduleName: PACKS_MODULE,
  resolve: path.resolve(__dirname, '../../..', 'modules/packs'),
  // CreditTransaction is here for claimWithdrawalAgainstDebit's debit read.
  // A modules-type spec builds its schema from THIS array, never from the
  // migrations, so omitting it is an unfixable `relation "credit_transaction"
  // does not exist`.
  moduleModels: [GlobePayWithdrawal, CreditTransaction],
  testSuite: ({ service, MikroOrmWrapper }) => {
    const seed = async (
      suffix: string,
      status: 'pending' | 'settled' | 'failed' | 'held',
      customerId = 'cus_claim',
    ) => {
      const [row] = await service.createGlobePayWithdrawals([
        {
          merchant_transaction_id: `PW-CLAIM-${suffix}`,
          customer_id: customerId,
          amount: 1500,
          bank_code: 'MBB',
          account_number: '1234567890',
          account_holder_name: 'AHMAD BIN ALI',
          status,
        },
      ]);
      return row;
    };
    const statusOf = async (id: string) =>
      (await service.listGlobePayWithdrawals({ id }, { take: 1 }))[0]?.status;

    describe('claimGlobePayWithdrawalStatus', () => {
      it('the FIRST claim wins and a repeat loses — the double-approve guard', async () => {
        const row = await seed('1', 'held');

        await expect(
          service.claimGlobePayWithdrawalStatus({
            id: row.id,
            from: ['held'],
            to: 'pending',
          }),
        ).resolves.toBe(true);
        expect(await statusOf(row.id)).toBe('pending');

        // The row is no longer 'held', so the second claim matches no row.
        // This is what a double-clicked Approve hits, and it is the only
        // thing between it and a duplicate payout.
        await expect(
          service.claimGlobePayWithdrawalStatus({
            id: row.id,
            from: ['held'],
            to: 'pending',
          }),
        ).resolves.toBe(false);
        expect(await statusOf(row.id)).toBe('pending');
      });

      it('leaves a settled row untouched — deny cannot reach one', async () => {
        const row = await seed('2', 'settled');
        await expect(
          service.claimGlobePayWithdrawalStatus({
            id: row.id,
            from: ['held', 'failed'],
            to: 'failed',
          }),
        ).resolves.toBe(false);
        expect(await statusOf(row.id)).toBe('settled');
      });

      it("deny's claim is re-runnable: held -> failed, then failed -> failed", async () => {
        const row = await seed('3', 'held');
        const claim = () =>
          service.claimGlobePayWithdrawalStatus({
            id: row.id,
            from: ['held', 'failed'],
            to: 'failed',
          });
        await expect(claim()).resolves.toBe(true);
        // The recovery path: an operator re-denying a row whose refund never
        // landed must get through, or that debit is stranded forever.
        await expect(claim()).resolves.toBe(true);
        expect(await statusOf(row.id)).toBe('failed');
      });

      it('never claims a soft-deleted row', async () => {
        const row = await seed('4', 'held');
        await service.softDeleteGlobePayWithdrawals([row.id]);
        await expect(
          service.claimGlobePayWithdrawalStatus({
            id: row.id,
            from: ['held'],
            to: 'pending',
          }),
        ).resolves.toBe(false);
      });

      // The sweep reads its staleness clock off `updated_at` from exactly this
      // list call (jobs/globepay-withdrawal-reconcile.ts, plan 094). If the
      // field were not selected onto the entity, `new Date(undefined)` is an
      // Invalid Date, every age comparison is false, and a debit that never
      // reached the bank waits pending forever — with tsc and every mocked
      // test still green. That is the one part of the "updated_at is the
      // submit clock" argument no writer audit can establish, so it is checked
      // here against a real row.
      //
      // Backdated by a raw statement BEFORE the claim, on MikroOrmWrapper's
      // manager (same real database, a separate connection from the module
      // service) — two hours, then a STRICT `>`. Neither is decorative:
      // `before === after` (the claim's SQL never touching the column at all)
      // still satisfies `>=`, so the previous version of this assertion passed
      // whether or not `updated_at = now()` was even present in
      // claimGlobePayWithdrawalStatus's raw SQL (service.ts) — see plan 094's
      // ledger. Comparing against created_at instead was considered and
      // rejected: JS `Date` truncates to milliseconds, so two statements a
      // fraction of a millisecond apart make that flaky too. This is the only
      // thing in the repo that proves the claim's write reaches the column at
      // all, since it goes through `em.execute` and MikroORM's onUpdate hook
      // never fires for raw SQL.
      it('lists updated_at, and the claim moves it forward from a backdated value — the submit clock', async () => {
        const row = await seed('5', 'held');
        // RETURNING id, checked below: without it a bind mismatch or a typo'd
        // table/column name matches zero rows and this backdate silently
        // no-ops. The assertions past that point would then compare
        // `before` (captured moments after row creation) against `after`
        // (captured moments after the claim) — a real but sub-second gap
        // that can still satisfy `toBeGreaterThan` most of the time, so the
        // failure this guards would flake red under timing jitter rather
        // than fail loudly every time. Same pattern this test's own header
        // comment already relies on for `>=` vs strict `>` — an unasserted
        // no-op is the same class of false pass.
        const backdated = await MikroOrmWrapper.getManager().execute<
          { id: string }[]
        >(
          "UPDATE globepay_withdrawal SET updated_at = now() - interval '2 hours' WHERE id = ? RETURNING id",
          [row.id],
        );
        expect(backdated).toHaveLength(1);
        const [before] = await service.listGlobePayWithdrawals(
          { id: row.id },
          { take: 1 },
        );
        expect(before.updated_at).toBeInstanceOf(Date);

        await service.claimGlobePayWithdrawalStatus({
          id: row.id,
          from: ['held'],
          to: 'pending',
        });
        const [after] = await service.listGlobePayWithdrawals(
          { id: row.id },
          { take: 1 },
        );
        expect(after.updated_at.getTime()).toBeGreaterThan(
          before.updated_at.getTime(),
        );
        expect(after.created_at.getTime()).toBe(before.created_at.getTime());
      });

      it('a row that does not exist is a lost claim, not a crash', async () => {
        await expect(
          service.claimGlobePayWithdrawalStatus({
            id: 'gpw_does_not_exist',
            from: ['held'],
            to: 'pending',
          }),
        ).resolves.toBe(false);
      });
    });

    /**
     * claimWithdrawalAgainstDebit — the ONLY test in the repo that observes a
     * real advisory-lock race, and the reason this method exists.
     *
     * THE BUG IT PINS. The admin approve/deny routes used to read the debit
     * unlocked and then close the row, deciding "no debit will ever land"
     * from the row's AGE (a 60s grace, GLOBEPAY_WD_HELD_DEBIT_GRACE_MS). The
     * justification was that idle_in_transaction_session_timeout would have
     * killed any transaction still running past it. It does not: that
     * timeout fires only on a session idle BETWEEN statements, and a debit
     * blocked inside `SELECT pg_advisory_xact_lock(...)` is executing a
     * statement — reported `active`, wait_event `advisory` — so it survives
     * indefinitely. Every row below is backdated TWO HOURS, far past that
     * grace, so the deleted code would have closed each of them.
     *
     * A mocked test cannot show this. There is no lock without a database,
     * so the interleaving has to be driven against real Postgres on two
     * connections: MikroOrmWrapper.forkManager() stands in for the
     * withdrawForCashout transaction (it takes the same `credit:` key and
     * writes the same `wd:`-anchored debit row), and the module service runs
     * the admin close on its own.
     */
    describe('claimWithdrawalAgainstDebit', () => {
      const CUSTOMER = 'cus_lockrace';
      // The real anchor, not a stand-in: the routes derive the debit
      // reference this way, so a divergence between them and this test would
      // otherwise pass here and find nothing in production.
      const debitAnchor = (mtid: string) =>
        withdrawalIdempotencyReference(CUSTOMER, mtid);

      /** Two hours old — past every grace this replaced. */
      const backdate = async (id: string) => {
        const rows = await MikroOrmWrapper.getManager().execute<
          { id: string }[]
        >(
          "UPDATE globepay_withdrawal SET created_at = now() - interval '2 hours' WHERE id = ? RETURNING id",
          [id],
        );
        // Asserted for the same reason the updated_at test above asserts its
        // own backdate: a silent zero-row UPDATE would leave these tests
        // passing against a FRESH row, which proves nothing about age.
        expect(rows).toHaveLength(1);
      };

      /** Resolved?-yet probe that cannot itself hang the suite. */
      const settledWithin = async (p: Promise<unknown>, ms: number) => {
        let timer: NodeJS.Timeout | undefined;
        const pending = Symbol('pending');
        const result = await Promise.race([
          p.then(() => 'settled' as const).catch(() => 'settled' as const),
          new Promise((resolve) => {
            timer = setTimeout(() => resolve(pending), ms);
          }),
        ]);
        clearTimeout(timer);
        return result !== pending;
      };

      // THE TEST CodeRabbit asked for: the debit delayed well past the old
      // grace period. The close must WAIT for it rather than assume it away.
      it('waits for an in-flight debit and then refuses to close the row', async () => {
        const row = await seed('LOCK-1', 'held', CUSTOMER);
        await backdate(row.id);

        // The withdrawForCashout half: same lock key, and the debit written
        // INSIDE the transaction that holds it — uncommitted, exactly the
        // state the admin close used to be unable to see.
        const debitTxn = MikroOrmWrapper.forkManager();
        await debitTxn.begin();
        let open = true;
        try {
          await debitTxn.execute(
            'SELECT pg_advisory_xact_lock(hashtextextended(?, 0))',
            [`credit:${CUSTOMER}`],
          );
          await debitTxn.execute(
            'INSERT INTO credit_transaction ' +
              '(id, customer_id, amount, raw_amount, reason, reference, source_transaction_id) ' +
              "VALUES (?, ?, ?, ?::jsonb, 'cashout', ?, ?)",
            [
              'ct_lockrace_1',
              CUSTOMER,
              -1500,
              JSON.stringify({ value: '-1500', precision: 20 }),
              row.merchant_transaction_id,
              debitAnchor(row.merchant_transaction_id),
            ],
          );

          const closing = service.claimWithdrawalAgainstDebit({
            id: row.id,
            customerId: CUSTOMER,
            debitReference: debitAnchor(row.merchant_transaction_id),
            from: ['held'],
            to: 'pending',
          });

          // BLOCKED on the lock — this is the assertion the whole fix rests
          // on. Under the deleted age gate the row was two hours old, so the
          // close would have run straight through and stamped it 'failed'.
          expect(await settledWithin(closing, 750)).toBe(false);
          expect(await statusOf(row.id)).toBe('held');

          await debitTxn.commit();
          open = false;

          // Now it proceeds — and sees the debit that was invisible a moment
          // ago, so it takes the DEBITED branch instead of the orphan close.
          await expect(closing).resolves.toEqual({
            debited: true,
            claimed: true,
          });
          expect(await statusOf(row.id)).toBe('pending');
        } finally {
          // Never leave the lock held: a failed assertion above would
          // otherwise wedge every later test on the same key.
          if (open) await debitTxn.rollback();
        }
      });

      // The mirror, and the reason the destructive close must stay
      // available: a row whose debit really never landed (a crash between
      // startGlobePayWithdrawal's step 1 and step 2) is still closable by an
      // operator, with no refund.
      it('closes a genuinely orphaned held row as failed', async () => {
        const row = await seed('LOCK-2', 'held', CUSTOMER);
        await backdate(row.id);
        await expect(
          service.claimWithdrawalAgainstDebit({
            id: row.id,
            customerId: CUSTOMER,
            debitReference: debitAnchor(row.merchant_transaction_id),
            from: ['held'],
            to: 'pending',
          }),
        ).resolves.toEqual({ debited: false, claimed: true });
        // 'failed', NOT the caller's `to` — an undebited payout has no other
        // honest destination, and approve reads this as "never debited, so it
        // cannot be paid out".
        expect(await statusOf(row.id)).toBe('failed');

        // AND the other half of the pact, as far as this harness can reach:
        // step 1a's statement, run verbatim against the same schema, sees
        // the close this test just made — so a debit arriving after it would
        // refuse.
        //
        // What this does and does not prove. It pins the identifiers and the
        // predicate against a REAL schema (a renamed column or a stale
        // `deleted_at` assumption fails here), and it shows the read returns
        // the closed status. It does NOT drive withdrawForCashout, which
        // needs the `customer` table, wallet state and saved accounts —
        // none of which exist in a modules-type spec — so the step-1a
        // BRANCH is pinned by the fake-`em` tests in
        // globepay-withdrawal.unit.spec.ts instead. The SQL is duplicated
        // here rather than exported: those unit tests already assert the
        // shipped text contains each clause below, so drift fails there.
        const [seen] = await MikroOrmWrapper.getManager().execute<
          { status: string }[]
        >(
          'SELECT status FROM globepay_withdrawal ' +
            'WHERE merchant_transaction_id = ? AND deleted_at IS NULL',
          [row.merchant_transaction_id],
        );
        expect(seen?.status).toBe('failed');
      });

      // The lock wait is BOUNDED (SET LOCAL lock_timeout = '5s'), because
      // nothing else bounds it — an admin click on a customer with a
      // long-running credit mutation would otherwise hang forever holding a
      // pooled connection. This test costs its own ~5s and earns it: it
      // proves the claimed "harmless" part rather than asserting it — the
      // statement error aborts the transaction, so the row is left exactly
      // as it was and the operator can simply click again.
      it('gives up after the lock timeout, leaving the row untouched', async () => {
        const row = await seed('LOCK-5', 'held', CUSTOMER);
        await backdate(row.id);

        const holder = MikroOrmWrapper.forkManager();
        await holder.begin();
        try {
          await holder.execute(
            'SELECT pg_advisory_xact_lock(hashtextextended(?, 0))',
            [`credit:${CUSTOMER}`],
          );
          await expect(
            service.claimWithdrawalAgainstDebit({
              id: row.id,
              customerId: CUSTOMER,
              debitReference: debitAnchor(row.merchant_transaction_id),
              from: ['held'],
              to: 'pending',
            }),
            // A translated 55P03, not a raw "canceling statement due to lock
            // timeout" — and not a fabricated {debited:false}, which would
            // close the row on a reading that was never taken.
          ).rejects.toMatchObject({ type: 'conflict' });
          expect(await statusOf(row.id)).toBe('held');
        } finally {
          await holder.rollback();
        }
      });

      // The ordinary approve: a debit committed long ago is found, and the
      // row is released to the gateway rather than closed.
      it('claims a debited row to the callers status, leaving the debit alone', async () => {
        const row = await seed('LOCK-3', 'held', CUSTOMER);
        await backdate(row.id);
        await MikroOrmWrapper.getManager().execute(
          'INSERT INTO credit_transaction ' +
            '(id, customer_id, amount, raw_amount, reason, reference, source_transaction_id) ' +
            "VALUES (?, ?, ?, ?::jsonb, 'cashout', ?, ?)",
          [
            'ct_lockrace_3',
            CUSTOMER,
            -1500,
            JSON.stringify({ value: '-1500', precision: 20 }),
            row.merchant_transaction_id,
            debitAnchor(row.merchant_transaction_id),
          ],
        );
        await expect(
          service.claimWithdrawalAgainstDebit({
            id: row.id,
            customerId: CUSTOMER,
            debitReference: debitAnchor(row.merchant_transaction_id),
            from: ['held'],
            to: 'pending',
          }),
        ).resolves.toEqual({ debited: true, claimed: true });
        expect(await statusOf(row.id)).toBe('pending');
      });

      // Deny's shape, and the double-action guard: the row is already
      // 'pending' from the approve above, so deny's from-list matches
      // nothing. `debited` is still reported — the read happens either way —
      // but nothing moves.
      it('reports the debit but loses the claim on a row it may not touch', async () => {
        const row = await seed('LOCK-4', 'settled', CUSTOMER);
        await backdate(row.id);
        await expect(
          service.claimWithdrawalAgainstDebit({
            id: row.id,
            customerId: CUSTOMER,
            debitReference: debitAnchor(row.merchant_transaction_id),
            from: ['held', 'failed'],
            to: 'failed',
          }),
        ).resolves.toEqual({ debited: false, claimed: false });
        expect(await statusOf(row.id)).toBe('settled');
      });
    });
  },
});
