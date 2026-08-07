import { MedusaError } from '@medusajs/framework/utils';
import PacksModuleService from '../service';

/**
 * mutateCustomerMetadata — the serialized read-modify-write of the shared
 * `customer.metadata` JSONB blob (avatar_url, avatar_file_id,
 * equipped_frame_level, bank_accounts, handle).
 *
 * The bug it exists to kill: every writer spread-merges the WHOLE blob, so an
 * avatar upload landing between a saved bank account's read and its write
 * republishes the pre-save blob and the account is silently gone.
 *
 * HONESTY NOTE ON COVERAGE: a jest unit test with no database cannot execute
 * two real transactions against one Postgres advisory lock, so nothing below
 * proves the race is closed. What is pinned here is the ORDERING that makes
 * closing it possible — the lock statement is issued first and the metadata
 * read happens after it, never before — plus the write/no-write contract. The
 * same fake-`this` technique as delivery-transition-atomic.unit.spec.ts:
 * @InjectTransactionManager reuses a provided `sharedContext.transactionManager`
 * and calls the original method.
 */

/**
 * The lock, the read and the write are all raw SQL on ONE `em`, so the ordered
 * log below is built by classifying the SQL itself. That is what makes a read
 * drifting back out in front of the lock visible.
 */
const fakeService = (
  metadata: Record<string, unknown> | null = {},
  exists = true,
) => {
  const svc = Object.create(PacksModuleService.prototype) as PacksModuleService;
  const ops: string[] = [];
  const em = {
    execute: jest.fn(async (query: string, _params?: unknown[]) => {
      if (query.includes('pg_advisory_xact_lock')) {
        ops.push('lock');
        return [];
      }
      if (query.startsWith('SELECT metadata')) {
        ops.push('read');
        // pg returns a jsonb column already parsed; a missing (or soft-deleted)
        // customer is zero rows, which is how the NOT_FOUND arm is reached.
        return exists ? [{ metadata }] : [];
      }
      ops.push('write');
      return [];
    }),
  };
  return { svc, em, ops, ctx: { transactionManager: em } as never };
};

/** The `?`-params of the nth em.execute call. */
const paramsOf = (em: { execute: jest.Mock }, n: number) =>
  em.execute.mock.calls[n][1] as unknown[];

describe('PacksModuleService.mutateCustomerMetadata', () => {
  it('takes the metadata advisory lock BEFORE reading, and writes after', async () => {
    const f = fakeService({ avatar_url: 'a' });
    await f.svc.mutateCustomerMetadata(
      { customerId: 'cus_1', mutate: (m) => ({ ...m, handle: 'x' }) },
      f.ctx,
    );

    expect(f.em.execute.mock.calls[0][0]).toContain('pg_advisory_xact_lock');
    // A DIFFERENT key namespace from `credit:` on purpose — the ledger's "at
    // most one credit: lock per transaction, ever" invariant must stay intact.
    expect(paramsOf(f.em, 0)).toEqual(['metadata:cus_1']);
    expect(f.ops).toEqual(['lock', 'read', 'write']);
  });

  // The reason all three statements go through the same `em`: a second pooled
  // connection here would deadlock the 5-slot per-process pool under five
  // concurrent mutations, and under lesser contention the 30s
  // idle_in_transaction kill would drop this session — releasing the advisory
  // lock — while the write landed anyway. See utils/db-driver-options.ts.
  it('runs the lock, the read and the write on ONE connection', async () => {
    const f = fakeService({});
    await f.svc.mutateCustomerMetadata(
      { customerId: 'cus_1', mutate: (m) => ({ ...m, handle: 'x' }) },
      f.ctx,
    );
    expect(f.em.execute).toHaveBeenCalledTimes(3);
  });

  it('hands mutate the blob read inside the lock, not one the caller carried in', async () => {
    const f = fakeService({ bank_accounts: ['from-the-locked-read'] });
    const seen: unknown[] = [];
    await f.svc.mutateCustomerMetadata(
      {
        customerId: 'cus_1',
        mutate: (m) => {
          seen.push(m.bank_accounts);
          return { ...m, avatar_url: 'new' };
        },
      },
      f.ctx,
    );
    // Called EXACTLY once, from exactly one read — the contract the avatar
    // route's captured `previousFileId` relies on.
    expect(seen).toEqual([['from-the-locked-read']]);
    expect(f.ops.filter((o) => o === 'read')).toHaveLength(1);
  });

  it('a mutate that refuses writes NOTHING (this is how a cap is enforced under the lock)', async () => {
    const f = fakeService({ bank_accounts: [1, 2, 3, 4, 5] });
    await expect(
      f.svc.mutateCustomerMetadata(
        {
          customerId: 'cus_1',
          mutate: (m) => {
            const accounts = m.bank_accounts as unknown[];
            if (accounts.length >= 5) {
              throw new MedusaError(
                MedusaError.Types.NOT_ALLOWED,
                'remove one first',
              );
            }
            return { ...m, bank_accounts: [...accounts, 6] };
          },
        },
        f.ctx,
      ),
    ).rejects.toMatchObject({ type: MedusaError.Types.NOT_ALLOWED });
    // The refusal came from the LOCKED read: the lock was already held when
    // mutate ran and saw five accounts. No write was issued, and because the
    // write would have been on this same transaction, the rollback covers it.
    expect(f.ops).toEqual(['lock', 'read']);
  });

  it('null from mutate means "nothing changed" — no write, current blob returned', async () => {
    const f = fakeService({ bank_accounts: ['keep'] });
    const out = await f.svc.mutateCustomerMetadata(
      { customerId: 'cus_1', mutate: () => null },
      f.ctx,
    );
    expect(f.ops).toEqual(['lock', 'read']);
    expect(out).toEqual({ bank_accounts: ['keep'] });
  });

  it('writes the blob as JSON text for the ::jsonb cast, and treats NULL metadata as {}', async () => {
    const f = fakeService(null);
    const out = await f.svc.mutateCustomerMetadata(
      { customerId: 'cus_2', mutate: (m) => ({ ...m, handle: 'first' }) },
      f.ctx,
    );
    expect(f.em.execute.mock.calls[2][0]).toContain('UPDATE customer SET');
    expect(paramsOf(f.em, 2)).toEqual(['{"handle":"first"}', 'cus_2']);
    expect(out).toEqual({ handle: 'first' });
  });

  it('a missing (or soft-deleted) customer is NOT_FOUND, and nothing is written', async () => {
    const f = fakeService({}, false);
    await expect(
      f.svc.mutateCustomerMetadata(
        { customerId: 'cus_gone', mutate: (m) => m },
        f.ctx,
      ),
    ).rejects.toMatchObject({ type: MedusaError.Types.NOT_FOUND });
    expect(f.ops).toEqual(['lock', 'read']);
  });
});
