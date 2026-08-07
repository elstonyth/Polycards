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

const fakeService = (metadata: Record<string, unknown> | null = {}) => {
  const svc = Object.create(PacksModuleService.prototype) as PacksModuleService;
  // One shared ordered log across the SQL, the read and the write. An
  // `ops.indexOf(a) < ops.indexOf(b)` assertion is the only thing that can
  // catch a read that drifts back out in front of the lock.
  const ops: string[] = [];
  const em = {
    execute: jest.fn(async (_query: string, _params?: unknown[]) => {
      ops.push('sql');
      return [];
    }),
  };
  const retrieveCustomer = jest.fn(async () => {
    ops.push('read');
    return { metadata };
  });
  const updateCustomers = jest.fn(async () => {
    ops.push('write');
    return {};
  });
  return {
    svc,
    em,
    ops,
    retrieveCustomer,
    updateCustomers,
    customers: { retrieveCustomer, updateCustomers },
    ctx: { transactionManager: em } as never,
  };
};

describe('PacksModuleService.mutateCustomerMetadata', () => {
  it('takes the metadata advisory lock BEFORE reading, and writes after', async () => {
    const f = fakeService({ avatar_url: 'a' });
    await f.svc.mutateCustomerMetadata(
      {
        customerId: 'cus_1',
        customers: f.customers,
        mutate: (m) => ({ ...m, handle: 'x' }),
      },
      f.ctx,
    );

    expect(f.em.execute.mock.calls[0][0]).toContain('pg_advisory_xact_lock');
    // A DIFFERENT key namespace from `credit:` on purpose — the ledger's "at
    // most one credit: lock per transaction, ever" invariant must stay intact.
    expect(f.em.execute.mock.calls[0][1]).toEqual(['metadata:cus_1']);
    expect(f.ops).toEqual(['sql', 'read', 'write']);
  });

  it('hands mutate the blob read inside the lock, not one the caller carried in', async () => {
    const f = fakeService({ bank_accounts: ['from-the-locked-read'] });
    const seen: unknown[] = [];
    await f.svc.mutateCustomerMetadata(
      {
        customerId: 'cus_1',
        customers: f.customers,
        mutate: (m) => {
          seen.push(m.bank_accounts);
          return { ...m, avatar_url: 'new' };
        },
      },
      f.ctx,
    );
    expect(seen).toEqual([['from-the-locked-read']]);
    // Exactly ONE read exists, and it is the locked one. If a caller-side read
    // ever comes back, this count moves and the "decided from a stale blob"
    // regression is visible.
    expect(f.retrieveCustomer).toHaveBeenCalledTimes(1);
  });

  it('a mutate that refuses writes NOTHING (this is how a cap is enforced under the lock)', async () => {
    const f = fakeService({ bank_accounts: [1, 2, 3, 4, 5] });
    await expect(
      f.svc.mutateCustomerMetadata(
        {
          customerId: 'cus_1',
          customers: f.customers,
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
    expect(f.updateCustomers).not.toHaveBeenCalled();
    // The refusal came from the LOCKED read: the lock was already held when
    // mutate ran and saw five accounts.
    expect(f.ops).toEqual(['sql', 'read']);
  });

  it('null from mutate means "nothing changed" — no write, current blob returned', async () => {
    const f = fakeService({ bank_accounts: ['keep'] });
    const out = await f.svc.mutateCustomerMetadata(
      { customerId: 'cus_1', customers: f.customers, mutate: () => null },
      f.ctx,
    );
    expect(f.updateCustomers).not.toHaveBeenCalled();
    expect(out).toEqual({ bank_accounts: ['keep'] });
  });

  it('returns what was actually written, and treats a null blob as {}', async () => {
    const f = fakeService(null);
    const out = await f.svc.mutateCustomerMetadata(
      {
        customerId: 'cus_2',
        customers: f.customers,
        mutate: (m) => ({ ...m, handle: 'first' }),
      },
      f.ctx,
    );
    expect(f.updateCustomers).toHaveBeenCalledWith('cus_2', {
      metadata: { handle: 'first' },
    });
    expect(out).toEqual({ handle: 'first' });
  });
});
