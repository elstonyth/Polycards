/**
 * claimRows / claimOne against a REAL Postgres — integration:modules
 *
 * WHY a real database. `claim.ts` is the one place the storefront's
 * conditional row-claims are built, and every guarantee it sells is a
 * Postgres property, not a TypeScript one: the predicate is re-evaluated
 * against committed state AFTER the row lock releases, so of two concurrent
 * claims exactly one matches a row. A fake `em` returns whatever the test
 * says and can prove none of that — it cannot tell us the statement parses,
 * that the driver hands `RETURNING` rows back as a real array, or that a
 * loser really blocks and then matches nothing.
 *
 * No-query cases — empty lists, unsafe identifiers and undefined predicates —
 * use a hand-made `{ execute: jest.fn() }`, because the claim is precisely
 * that `execute` was never reached.
 *
 * `customer_account_state` is the fixture table: it carries a nullable
 * timestamp pair (`free_pack_available_at` / `free_pack_claimed_at`) for the
 * IS NULL / IS NOT NULL predicates, a nullable enum (`cause`) for the IN
 * predicate, and a unique non-`id` key (`customer_id`) for the `idColumn`
 * case — the real shape claimFreePack claims on.
 */

import path from 'path';
import { moduleIntegrationTestRunner } from '@medusajs/test-utils';
import { PACKS_MODULE } from '../index';
import type PacksModuleService from '../service';
import CustomerAccountState from '../models/customer-account-state';
import {
  claimOne,
  claimRows,
  NOT_NULL,
  NOW,
  type LedgerSqlManager,
} from '../claim';

jest.setTimeout(300 * 1000);

const TABLE = 'customer_account_state';

/** An `em` that records every call and never reaches a database — the only
 *  honest witness for "no query was issued". */
const fakeEm = () => {
  const execute = jest.fn(async () => [] as unknown[]);
  return { em: { execute } as unknown as LedgerSqlManager, execute };
};

moduleIntegrationTestRunner<PacksModuleService>({
  moduleName: PACKS_MODULE,
  resolve: path.resolve(__dirname, '../../..', 'modules/packs'),
  moduleModels: [CustomerAccountState],
  testSuite: ({ service, MikroOrmWrapper }) => {
    // The runner resets the database between `it`s and the service is not
    // usable in `beforeAll`, so every test seeds its own rows.
    const seed = async (
      customerId: string,
      patch: Record<string, unknown> = {},
    ) => {
      const [row] = await service.createCustomerAccountStates([
        { customer_id: customerId, ...patch },
      ]);
      return row;
    };
    const read = async (customerId: string) =>
      (
        await service.listCustomerAccountStates(
          { customer_id: customerId },
          { take: 1 },
        )
      )[0];
    const em = () =>
      MikroOrmWrapper.getManager() as unknown as LedgerSqlManager;

    /** Backdate `updated_at` two hours, asserted: a silent zero-row UPDATE
     *  would leave the "moved it forward" assertion comparing two timestamps
     *  a fraction of a second apart, which passes on luck. Same discipline as
     *  withdrawal-claim.integration.spec. */
    const backdate = async (id: string) => {
      const rows = await MikroOrmWrapper.getManager().execute<{ id: string }[]>(
        `UPDATE ${TABLE} SET updated_at = now() - interval '2 hours' WHERE id = ? RETURNING id`,
        [id],
      );
      expect(rows).toHaveLength(1);
    };

    describe('claimRows', () => {
      it('moves only the rows the predicate matches, and returns exactly those ids', async () => {
        const match = await seed('cus_match', { cause: 'auto' });
        const other = await seed('cus_other', { cause: 'manual' });
        await backdate(match.id);
        const before = await read('cus_match');

        const claimed = await claimRows(em(), {
          table: TABLE,
          ids: [match.id, other.id],
          where: { cause: 'auto' },
          set: { frozen: true, frozen_reason: 'claimed' },
        });

        expect(claimed).toEqual([match.id]);
        const after = await read('cus_match');
        expect(after.frozen).toBe(true);
        expect(after.frozen_reason).toBe('claimed');
        // The stamp reaches the column: MikroORM's onUpdate hook never fires
        // for raw SQL, so `updated_at = now()` has to be in the statement.
        expect(after.updated_at.getTime()).toBeGreaterThan(
          before.updated_at.getTime(),
        );

        // The row whose `cause` did not match is untouched and unreported —
        // this is the half every caller's result decision rests on.
        const untouched = await read('cus_other');
        expect(untouched.frozen).toBe(false);
        expect(untouched.frozen_reason).toBeNull();
      });

      it('never moves a soft-deleted row', async () => {
        const row = await seed('cus_deleted', { cause: 'auto' });
        await service.softDeleteCustomerAccountStates([row.id]);

        await expect(
          claimRows(em(), {
            table: TABLE,
            ids: [row.id],
            where: { cause: 'auto' },
            set: { frozen: true },
          }),
        ).resolves.toEqual([]);
      });

      it('renders IN for an array, IS NULL for null, IS NOT NULL for NOT_NULL', async () => {
        const auto = await seed('cus_in_1', { cause: 'auto' });
        const manual = await seed('cus_in_2', { cause: 'manual' });
        const none = await seed('cus_in_3');
        const ids = [auto.id, manual.id, none.id];

        // Array ⇒ IN (…): both enum rows, never the NULL one (SQL NULL is
        // not IN anything).
        await expect(
          claimRows(em(), {
            table: TABLE,
            ids,
            where: { cause: ['auto', 'manual'] },
            set: { disabled: true },
          }),
        ).resolves.toEqual([auto.id, manual.id]);

        // null ⇒ IS NULL, which is the only way to reach that third row.
        await expect(
          claimRows(em(), {
            table: TABLE,
            ids,
            where: { cause: null },
            set: { disabled: true },
          }),
        ).resolves.toEqual([none.id]);

        // NOT_NULL ⇒ IS NOT NULL — the free-pack claim's "was ever stamped"
        // gate. `disabled` is now true everywhere, so the predicate under
        // test is the only thing selecting.
        await expect(
          claimRows(em(), {
            table: TABLE,
            ids,
            where: { cause: NOT_NULL },
            set: { frozen: true },
          }),
        ).resolves.toEqual([auto.id, manual.id]);
      });

      it('claims on a non-id key and answers in that key, with NOW from the database clock', async () => {
        await seed('cus_key', { free_pack_available_at: new Date() });

        await expect(
          claimRows(em(), {
            table: TABLE,
            ids: ['cus_key'],
            idColumn: 'customer_id',
            where: {
              free_pack_available_at: NOT_NULL,
              free_pack_claimed_at: null,
            },
            set: { free_pack_claimed_at: NOW },
          }),
        ).resolves.toEqual(['cus_key']);

        const after = await read('cus_key');
        expect(after.free_pack_claimed_at).toBeInstanceOf(Date);
      });

      it('issues no query for an empty id list or an empty IN list', async () => {
        const a = fakeEm();
        await expect(
          claimRows(a.em, { table: TABLE, ids: [], set: { frozen: true } }),
        ).resolves.toEqual([]);
        expect(a.execute).not.toHaveBeenCalled();

        // `IN ()` is a syntax error, so an empty list has to short-circuit the
        // same way — it matches nothing by definition.
        const b = fakeEm();
        await expect(
          claimRows(b.em, {
            table: TABLE,
            ids: ['cas_1'],
            where: { cause: [] },
            set: { frozen: true },
          }),
        ).resolves.toEqual([]);
        expect(b.execute).not.toHaveBeenCalled();
      });

      it('rejects an undefined predicate before any SQL runs', async () => {
        const f = fakeEm();
        await expect(
          claimRows(f.em, {
            table: TABLE,
            ids: ['cas_undefined'],
            where: { cause: undefined },
            set: { frozen: true },
          }),
        ).rejects.toThrow(/undefined.*cause/i);
        expect(f.execute).not.toHaveBeenCalled();
      });

      it('throws on an unsafe identifier before any SQL runs', async () => {
        for (const claim of [
          { table: 'customer_account_state; DROP TABLE pull', ids: ['x'] },
          { table: TABLE, ids: ['x'], idColumn: 'id, frozen' },
          { table: TABLE, ids: ['x'], set: { 'frozen = true --': 1 } },
          { table: TABLE, ids: ['x'], where: { 'cause OR 1=1': 'auto' } },
        ]) {
          const f = fakeEm();
          await expect(
            claimRows(f.em, { set: { frozen: true }, ...claim }),
          ).rejects.toThrow(/identifier/i);
          expect(f.execute).not.toHaveBeenCalled();
        }
      });
    });

    describe('claimOne', () => {
      it('answers true for the caller that moved the row and false for every other', async () => {
        const row = await seed('cus_one', { cause: 'auto' });
        const claim = {
          table: TABLE,
          ids: [row.id] as [string],
          where: { cause: 'auto', frozen: false },
          set: { frozen: true },
        };

        await expect(claimOne(em(), claim)).resolves.toBe(true);
        // The row no longer satisfies `frozen = false`: this is the repeat a
        // double-tapped button sends, and the false is the whole mutex.
        await expect(claimOne(em(), claim)).resolves.toBe(false);
      });

      it('a row that does not exist is a lost claim, not a crash', async () => {
        await expect(
          claimOne(em(), {
            table: TABLE,
            ids: ['cas_nope'],
            where: { cause: 'auto' },
            set: { frozen: true },
          }),
        ).resolves.toBe(false);
      });
    });

    /**
     * The property the whole module exists for, observed rather than argued:
     * two transactions claiming the same row on two connections. The loser
     * BLOCKS on the row lock (it cannot simply read a stale value and win),
     * and once the winner commits the loser's predicate is re-evaluated
     * against committed state and matches nothing.
     */
    describe('two concurrent claims', () => {
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

      it('exactly one wins; the loser waits, then matches nothing', async () => {
        const row = await seed('cus_race', { cause: 'auto' });
        const claim = {
          table: TABLE,
          ids: [row.id] as [string],
          where: { cause: 'auto', frozen: false },
          set: { frozen: true },
        };

        const winner = MikroOrmWrapper.forkManager();
        const loser = MikroOrmWrapper.forkManager();
        await winner.begin();
        await loser.begin();
        let open = true;
        try {
          await expect(
            claimOne(winner as unknown as LedgerSqlManager, claim),
          ).resolves.toBe(true);

          // Uncommitted: the loser's UPDATE is stuck on the winner's row lock.
          // Without that block it would read `frozen = false`, match, and both
          // callers would believe they owned the row.
          const losing = claimOne(loser as unknown as LedgerSqlManager, claim);
          expect(await settledWithin(losing, 750)).toBe(false);

          await winner.commit();
          open = false;

          await expect(losing).resolves.toBe(false);
          await loser.commit();
        } finally {
          if (open) await winner.rollback();
        }

        expect((await read('cus_race')).frozen).toBe(true);
      });
    });
  },
});
