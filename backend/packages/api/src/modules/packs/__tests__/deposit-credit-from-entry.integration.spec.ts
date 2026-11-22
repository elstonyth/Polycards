/**
 * Deposits' Credit from gateway entry against a REAL Postgres —
 * integration:modules
 *
 * WHY a DB-backed spec: the credit and the link must land together, once. That
 * the entry is reserved before money moves (a compare-and-set under a partial
 * unique index), that the credit lands exactly once on the top-up anchor, and
 * that a refused credit gives the reservation back are only true if the
 * database says so. The unit spec's fake packs answers whatever it is told.
 * The gateway is the fake one, answering in USDT, so the row's FX lock does the
 * real conversion.
 */

import path from 'path';
import { moduleIntegrationTestRunner } from '@medusajs/test-utils';
import { Modules } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../index';
import type PacksModuleService from '../service';
import AdminActionAudit from '../models/admin-action-audit';
import CreditTransaction from '../models/credit-transaction';
import CustomerAccountState from '../models/customer-account-state';
import GatewayDeposit from '../models/gateway-deposit';
import LedgerEntry from '../models/ledger-entry';
import LedgerSequence from '../models/ledger-sequence';
import { creditFromAdjustmentEntry } from '../deposit-adjustment-entry';
import { fakeGateway } from '../fake-gateway';
import { setActiveGateway } from '../gateway';
import { topupIdempotencyReference } from '../topup';

jest.setTimeout(300 * 1000);

const ORIGINAL = { ...process.env };

moduleIntegrationTestRunner<PacksModuleService>({
  moduleName: PACKS_MODULE,
  resolve: path.resolve(__dirname, '../../..', 'modules/packs'),
  // A modules-type spec builds its schema from THIS array, never from the
  // migrations: the deposit, what topUpCreditsWithLedger writes and reads,
  // and the admin action log.
  moduleModels: [
    GatewayDeposit,
    CreditTransaction,
    LedgerEntry,
    LedgerSequence,
    CustomerAccountState,
    AdminActionAudit,
  ],
  testSuite: ({ service }) => {
    const resolveFake = (key: string): unknown => {
      if (key === Modules.CUSTOMER) {
        return {
          retrieveCustomer: async () => ({ email: 'payer@example.test' }),
        };
      }
      if (key === Modules.NOTIFICATION) {
        return { createNotifications: async () => {} };
      }
      if (key === 'logger') {
        return { info: () => {}, warn: () => {}, error: () => {} };
      }
      return service;
    };
    const scope = {
      resolve: resolveFake as unknown as <T>(key: string) => T,
    };

    beforeEach(() => {
      fakeGateway.reset();
      setActiveGateway('fake');
      process.env.GATEWAY_ENABLED = 'true';
      process.env.PAYMENT_GATEWAY = 'fake';
      // The row's own order (PC-…) is Verify Fail; any other reference is
      // the manual entry, paid 75.36 USDT, with the gateway's own id.
      fakeGateway.script({
        getDepositDetail: (() => {
          const asked = fakeGateway.calls.depositDetails.at(-1) ?? '';
          return asked.startsWith('PC-')
            ? { state: 'failed', amount: 0, transactionId: 'D-ORDER' }
            : {
                state: 'success',
                amount: 75.36,
                netAmount: 74.61,
                statusId: 6,
                transactionId: `D-${asked}`,
              };
        }) as never,
      });
    });

    afterAll(() => {
      process.env = ORIGINAL;
      setActiveGateway(null);
    });

    // A real top-up, 2026-11-21: 75 USDT at a locked RM 306.45.
    const seed = async (suffix: string) => {
      const [row] = await service.createGatewayDeposits([
        {
          merchant_transaction_id: `PC-CFE-${suffix}`,
          customer_id: `cus_cfe_${suffix}`,
          amount_requested: 306.45,
          gateway_amount: 75,
          currency: 'USDT',
          payment_method_code: 'UTRC',
          gateway_transaction_id: `D-ORDER-${suffix}`,
          gateway: 'fake',
          status: 'expired',
        },
      ]);
      return row;
    };
    const reread = async (id: string) =>
      (await service.listGatewayDeposits({ id }, { take: 1 }))[0];
    const creditsOf = (customer_id: string) =>
      service.listCreditTransactions({ customer_id }, { take: 10 });
    const run = (depositId: string, ref: string) =>
      creditFromAdjustmentEntry(scope, {
        depositId,
        ref,
        adminId: 'usr_admin_1',
        reason: 'GlobePay365 confirmed what arrived',
      });

    it('credits what arrived once, settles the row, links the entry and logs it', async () => {
      const row = await seed('one');
      await expect(run(row.id, 'MD-ONE')).resolves.toEqual({
        credited: true,
        replayed: false,
        amount: 307.92,
        ref: 'MD-ONE',
        entryId: 'D-MD-ONE',
      });

      const after = await reread(row.id);
      expect(after.status).toBe('settled');
      expect(Number(after.amount_settled)).toBe(307.92);
      expect(after.gateway_adjustment_ref).toBe('MD-ONE');
      expect(after.gateway_adjustment_entry_id).toBe('D-MD-ONE');

      const credits = await creditsOf(row.customer_id);
      expect(credits).toHaveLength(1);
      expect(Number(credits[0].amount)).toBe(307.92);
      expect(credits[0].source_transaction_id).toBe(
        topupIdempotencyReference(row.customer_id, row.merchant_transaction_id),
      );
      expect(
        await service.listLedgerEntries(
          { customer_id: row.customer_id },
          { take: 10 },
        ),
      ).toHaveLength(1);

      const audits = await service.listAdminActionAudits(
        { entity_id: row.id },
        { take: 10 },
      );
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        admin_id: 'usr_admin_1',
        after: expect.objectContaining({
          amount: 307.92,
          gateway_adjustment_ref: 'MD-ONE',
          entry_reported_amount: 75.36,
        }),
      });
    });

    it('a second click is refused and moves nothing', async () => {
      const row = await seed('twice');
      await run(row.id, 'MD-TWICE');
      await expect(run(row.id, 'MD-TWICE')).rejects.toThrow(/already settled/);
      expect(await creditsOf(row.customer_id)).toHaveLength(1);
    });

    it('a double click racing on one row credits once', async () => {
      const row = await seed('race');
      const results = await Promise.allSettled([
        run(row.id, 'MD-RACE'),
        run(row.id, 'MD-RACE'),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(await creditsOf(row.customer_id)).toHaveLength(1);
    });

    it('one entry raced onto two rows: exactly one row is credited', async () => {
      const a = await seed('two-a');
      const b = await seed('two-b');
      const results = await Promise.allSettled([
        run(a.id, 'MD-SHARED'),
        run(b.id, 'MD-SHARED'),
      ]);
      const won = results.filter((r) => r.status === 'fulfilled');
      expect(won).toHaveLength(1);
      const lost = results.find((r) => r.status === 'rejected');
      expect(lost && lost.status === 'rejected' && String(lost.reason)).toMatch(
        /belongs to another deposit/,
      );
      const total =
        (await creditsOf(a.customer_id)).length +
        (await creditsOf(b.customer_id)).length;
      expect(total).toBe(1);
    });

    // Code review 2026-11-21: the reservation must never be swapped on a row
    // whose credit is in flight or landed, or the paid entry is freed.
    it('two different entries racing on one row: one credit, the other refused', async () => {
      const row = await seed('two-refs');
      const results = await Promise.allSettled([
        run(row.id, 'MD-X'),
        run(row.id, 'MD-Y'),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(await creditsOf(row.customer_id)).toHaveLength(1);
      const after = await reread(row.id);
      expect(after.status).toBe('settled');
      const won = results.findIndex((r) => r.status === 'fulfilled');
      expect(after.gateway_adjustment_ref).toBe(won === 0 ? 'MD-X' : 'MD-Y');
    });

    it('after a crash left a landed credit on an unsettled row: another entry is refused, the same one replays', async () => {
      const row = await seed('crash');
      // What a crash between the ledger write and the row claim leaves: the
      // entry reserved, the credit on the anchor, the row still expired.
      expect(
        await service.claimDepositAdjustmentRef({
          id: row.id,
          from: null,
          to: 'MD-LANDED',
          entryId: 'D-MD-LANDED',
          status: ['failed', 'expired'],
        }),
      ).toBe(true);
      await service.topUpCreditsWithLedger({
        customerId: row.customer_id,
        amount: 307.92,
        reason: 'topup',
        ledgerPaymentMethod: 'UTRC',
        ledgerGatewayRef: row.gateway_transaction_id,
        reference: row.gateway_transaction_id,
        idempotencyReference: topupIdempotencyReference(
          row.customer_id,
          row.merchant_transaction_id,
        ),
      } as never);

      await expect(run(row.id, 'MD-OTHER')).rejects.toThrow(
        /already being credited from gateway entry MD-LANDED/,
      );
      expect((await reread(row.id)).gateway_adjustment_ref).toBe('MD-LANDED');

      await expect(run(row.id, 'MD-LANDED')).resolves.toMatchObject({
        credited: true,
        replayed: true,
        amount: 307.92,
      });
      const after = await reread(row.id);
      expect(after.status).toBe('settled');
      expect(after.gateway_adjustment_ref).toBe('MD-LANDED');
      expect(await creditsOf(row.customer_id)).toHaveLength(1);
    });

    it('the reservation claim never touches a settled row', async () => {
      const row = await seed('settled');
      await run(row.id, 'MD-DONE');
      expect(
        await service.claimDepositAdjustmentRef({
          id: row.id,
          from: 'MD-DONE',
          to: null,
          entryId: null,
          status: ['failed', 'expired'],
        }),
      ).toBe(false);
      expect((await reread(row.id)).gateway_adjustment_ref).toBe('MD-DONE');
    });

    it('gives the reservation back when the ledger refuses the credit', async () => {
      const row = await seed('hand');
      // Staff already paid the ORDER by hand adjustment.
      await service.createCreditTransactions([
        {
          customer_id: row.customer_id,
          reason: 'adjustment',
          amount: 306.45,
          reference: `paid ${row.merchant_transaction_id} by hand`,
        } as never,
      ]);
      await expect(run(row.id, 'MD-HAND')).rejects.toThrow(
        /pay the customer twice/,
      );
      const after = await reread(row.id);
      expect(after.status).toBe('expired');
      expect(after.gateway_adjustment_ref).toBeNull();
      expect(after.gateway_adjustment_entry_id).toBeNull();
      // Only the hand adjustment.
      expect(await creditsOf(row.customer_id)).toHaveLength(1);
      // The released entry can back another row now.
      const other = await seed('hand-2');
      await expect(run(other.id, 'MD-HAND')).resolves.toMatchObject({
        credited: true,
      });
    });
  },
});
