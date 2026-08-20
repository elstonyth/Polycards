import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import {
  GLOBEPAY_MAX_RECENT_PENDING_PER_CUSTOMER,
  GLOBEPAY_PENDING_WINDOW_MS,
} from '../../src/modules/packs/globepay-deposit';

/**
 * createGlobePayDepositCapped against a REAL database (#429).
 *
 * The unit specs pin the ordering (lock, then count, then insert) and the
 * policy the module hands down, but neither executes a line of SQL: the
 * advisory lock and the windowed count run against jest mocks there. This suite
 * exists to prove the statements actually run — `pg_advisory_xact_lock` is a
 * real call inside a real transaction, and `created_at: { $gte }` is a real
 * query whose scoping the cap depends on.
 *
 * What it does NOT prove: that the burst race is closed. Two transactions
 * racing one advisory lock is not something this harness can stage; the lock is
 * what makes closing it possible, and the ordering that makes the lock
 * meaningful is pinned in globepay-deposit-cap-lock.unit.spec.ts.
 *
 * One customer per test — the suite shares a database across its cases, so a
 * shared id would carry the previous test's backlog into the next one.
 */

jest.setTimeout(240 * 1000);
const CAP = GLOBEPAY_MAX_RECENT_PENDING_PER_CUSTOMER;

const pending = (customerId: string, n: number) => ({
  merchant_transaction_id: `PC-cap-seed-${customerId}-${n}`,
  customer_id: customerId,
  amount_requested: 50,
  payment_method_code: 'BQR',
  status: 'pending' as const,
});

const capped = (customerId: string) => ({
  data: {
    merchant_transaction_id: `PC-cap-new-${customerId}`,
    customer_id: customerId,
    amount_requested: 50,
    payment_method_code: 'BQR',
    status: 'pending' as const,
  },
  maxRecentPending: CAP,
  windowMs: GLOBEPAY_PENDING_WINDOW_MS,
});

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ getContainer }) => {
    const packs = () =>
      getContainer().resolve<PacksModuleService>(PACKS_MODULE);

    const seed = async (customerId: string, count: number) =>
      packs().createGlobePayDeposits(
        Array.from({ length: count }, (_, i) => pending(customerId, i)),
      );

    const pendingCount = async (customerId: string): Promise<number> => {
      const [, total] = await packs().listAndCountGlobePayDeposits({
        customer_id: customerId,
        status: 'pending',
      });
      return total;
    };

    it('inserts while the customer is below the cap', async () => {
      const customer = 'cus_cap_under';
      await seed(customer, CAP - 1);

      expect(
        await packs().createGlobePayDepositCapped(capped(customer)),
      ).not.toBeNull();
      expect(await pendingCount(customer)).toBe(CAP);
    });

    it('refuses and writes nothing once the cap is reached', async () => {
      const customer = 'cus_cap_at';
      await seed(customer, CAP);

      expect(
        await packs().createGlobePayDepositCapped(capped(customer)),
      ).toBeNull();
      expect(await pendingCount(customer)).toBe(CAP); // no row added
    });

    it('does not count a settled row against the cap', async () => {
      // Only 'pending' occupies the reconcile sweep's queue, which is the whole
      // thing the cap bounds.
      const customer = 'cus_cap_settled';
      const rows = await seed(customer, CAP);
      await packs().updateGlobePayDeposits(
        rows.map((r) => ({ id: r.id, status: 'settled' as const })),
      );

      expect(
        await packs().createGlobePayDepositCapped(capped(customer)),
      ).not.toBeNull();
    });

    it('does not count another customer against this one', async () => {
      const customer = 'cus_cap_mine';
      await seed('cus_cap_theirs', CAP);

      expect(
        await packs().createGlobePayDepositCapped(capped(customer)),
      ).not.toBeNull();
    });
  },
});
