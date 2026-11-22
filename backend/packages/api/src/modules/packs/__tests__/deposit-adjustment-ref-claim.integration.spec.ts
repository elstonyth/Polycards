/**
 * Settlement's Link gateway entry against a REAL Postgres — integration:modules
 *
 * WHY a DB-backed spec: the link is a compare-and-set, and "two operators link
 * one row, exactly one wins" is only true if the database says so. So is "one
 * entry backs one row" (a partial unique index, whose error text the module
 * matches) and the ledger filter that finds another customer's hand credit. A
 * fake packs answers whatever the test tells it to all three.
 */

import path from 'path';
import { moduleIntegrationTestRunner } from '@medusajs/test-utils';
import { PACKS_MODULE } from '../index';
import type PacksModuleService from '../service';
import AdminActionAudit from '../models/admin-action-audit';
import CreditTransaction from '../models/credit-transaction';
import GatewayDeposit from '../models/gateway-deposit';
import { quotedForAnotherCustomer } from '../deposit-adjustment-entry';

jest.setTimeout(300 * 1000);

moduleIntegrationTestRunner<PacksModuleService>({
  moduleName: PACKS_MODULE,
  resolve: path.resolve(__dirname, '../../..', 'modules/packs'),
  // A modules-type spec builds its schema from THIS array, never from the
  // migrations.
  moduleModels: [GatewayDeposit, CreditTransaction, AdminActionAudit],
  testSuite: ({ service }) => {
    const deposit = async (suffix: string) => {
      const [row] = await service.createGatewayDeposits([
        {
          merchant_transaction_id: `PC-ADJ-${suffix}`,
          customer_id: `cus_adj_${suffix}`,
          amount_requested: 64.56,
          payment_method_code: 'OB',
          gateway_transaction_id: `D-${suffix}`,
          gateway: 'tgpay',
          status: 'settled',
        },
      ]);
      return row;
    };
    const refOf = async (id: string) =>
      (await service.listGatewayDeposits({ id }, { take: 1 }))[0]
        .gateway_adjustment_ref;

    describe('claimDepositAdjustmentRef', () => {
      it('two links racing on one row: exactly one wins, and its reference stays', async () => {
        const row = await deposit('race');
        const [a, b] = await Promise.all(
          ['MD-A', 'MD-B'].map((to) =>
            service.claimDepositAdjustmentRef({
              id: row.id,
              from: null,
              to,
              entryId: null,
            }),
          ),
        );
        expect([a, b].filter(Boolean)).toHaveLength(1);
        expect(await refOf(row.id)).toBe(a ? 'MD-A' : 'MD-B');
      });

      it('moves only from the reference the caller read, and writes `set` with it', async () => {
        const row = await deposit('swap');
        expect(
          await service.claimDepositAdjustmentRef({
            id: row.id,
            from: null,
            to: 'MD-OLD',
            entryId: 'D-OLD',
            set: { audit_note: 'was flagged' },
          }),
        ).toBe(true);
        expect(
          await service.claimDepositAdjustmentRef({
            id: row.id,
            from: 'MD-STALE',
            to: 'MD-NEW',
            entryId: 'D-NEW',
          }),
        ).toBe(false);
        expect(await refOf(row.id)).toBe('MD-OLD');
        expect(
          await service.claimDepositAdjustmentRef({
            id: row.id,
            from: 'MD-OLD',
            to: 'MD-NEW',
            entryId: null,
            set: { audit_note: null },
          }),
        ).toBe(true);
        const [after] = await service.listGatewayDeposits(
          { id: row.id },
          { take: 1 },
        );
        expect(after).toMatchObject({
          gateway_adjustment_ref: 'MD-NEW',
          // A replace whose entry has no gateway id clears the old one.
          gateway_adjustment_entry_id: null,
          audit_note: null,
        });
      });

      it('one entry backs one row: the unique index refuses a second holder, in words the link recognises', async () => {
        const first = await deposit('one');
        const second = await deposit('two');
        await service.claimDepositAdjustmentRef({
          id: first.id,
          from: null,
          to: 'MD-ONE',
          entryId: null,
        });
        await expect(
          service.claimDepositAdjustmentRef({
            id: second.id,
            from: null,
            to: 'MD-ONE',
            entryId: null,
          }),
        ).rejects.toThrow(/unique|duplicate|already exists/i);
        expect(await refOf(second.id)).toBeNull();
      });
    });

    // A reference typed in another letter case is different text, so the
    // reference index lets it through; the gateway's own id for the entry is
    // the same however it was typed (review, 2026-11-21).
    describe('one gateway entry id, one row', () => {
      it('refuses a second row the same entry id under a differently typed reference, in words the link recognises', async () => {
        const first = await deposit('case1');
        const second = await deposit('case2');
        expect(
          await service.claimDepositAdjustmentRef({
            id: first.id,
            from: null,
            to: 'MD20261108102020',
            entryId: 'D2026110814697999',
          }),
        ).toBe(true);
        await expect(
          service.claimDepositAdjustmentRef({
            id: second.id,
            from: null,
            to: 'md20261108102020',
            entryId: 'D2026110814697999',
          }),
        ).rejects.toThrow(/unique|duplicate|already exists/i);
        expect(await refOf(second.id)).toBeNull();
      });
    });

    // The link and its log entry are one transaction (review, 2026-11-21).
    describe('the audit row rides the claim', () => {
      const audit = (entity_id: string) => ({
        admin_id: 'usr_admin_1',
        entity_type: 'gateway_deposit' as const,
        entity_id,
        action: 'edit' as const,
        before: { gateway_adjustment_ref: null },
        after: { gateway_adjustment_ref: 'MD-LOG' },
        reason: 'Checked back office',
      });
      const auditsOf = (entity_id: string) =>
        service.listAdminActionAudits({ entity_id });

      it('a won claim leaves exactly one audit row', async () => {
        const row = await deposit('logwon');
        expect(
          await service.claimDepositAdjustmentRef({
            id: row.id,
            from: null,
            to: 'MD-LOG',
            entryId: 'D-LOG',
            audit: audit(row.id),
          }),
        ).toBe(true);
        const rows = await auditsOf(row.id);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          admin_id: 'usr_admin_1',
          reason: 'Checked back office',
        });
      });

      it('a lost claim leaves none', async () => {
        const row = await deposit('loglost');
        expect(
          await service.claimDepositAdjustmentRef({
            id: row.id,
            from: 'MD-STALE',
            to: 'MD-LOG2',
            entryId: null,
            audit: audit(row.id),
          }),
        ).toBe(false);
        expect(await auditsOf(row.id)).toHaveLength(0);
      });

      it('an audit row that cannot be inserted rolls the link back', async () => {
        const row = await deposit('logfail');
        await service.claimDepositAdjustmentRef({
          id: row.id,
          from: null,
          to: 'MD-KEEP',
          entryId: 'D-KEEP',
          set: { audit_note: 'still flagged' },
        });
        await expect(
          service.claimDepositAdjustmentRef({
            id: row.id,
            from: 'MD-KEEP',
            to: 'MD-LOST',
            entryId: 'D-LOST',
            set: { audit_note: null },
            // NOT NULL admin_id and an action outside the enum: the insert
            // fails after the UPDATE has run.
            audit: {
              ...audit(row.id),
              admin_id: null,
              action: 'not_an_action',
            } as never,
          }),
        ).rejects.toThrow();
        const [after] = await service.listGatewayDeposits(
          { id: row.id },
          { take: 1 },
        );
        expect(after).toMatchObject({
          gateway_adjustment_ref: 'MD-KEEP',
          gateway_adjustment_entry_id: 'D-KEEP',
          audit_note: 'still flagged',
        });
        expect(await auditsOf(row.id)).toHaveLength(0);
      });
    });

    describe('quotedForAnotherCustomer', () => {
      const credit = (customer_id: string, reason: string, reference: string) =>
        service.createCreditTransactions([
          { customer_id, reason, amount: 56.49, reference } as never,
        ]);

      it('finds a hand credit to someone else that quotes the reference, and only that', async () => {
        await credit(
          'cus_me',
          'adjustment',
          'Short USDT top-up, entry MD_2026A',
        );
        expect(
          await quotedForAnotherCustomer(service, {
            customerId: 'cus_me',
            ref: 'MD_2026A',
          }),
        ).toBe(false);
        // A top-up row is not a hand credit, and "_" must not act as a wildcard.
        await credit('cus_other', 'topup', 'MD_2026A');
        await credit('cus_other', 'adjustment', 'entry MDX2026A');
        expect(
          await quotedForAnotherCustomer(service, {
            customerId: 'cus_me',
            ref: 'MD_2026A',
          }),
        ).toBe(false);
        await credit('cus_other', 'bonus_grant', 'for md_2026a, checked');
        expect(
          await quotedForAnotherCustomer(service, {
            customerId: 'cus_me',
            ref: 'MD_2026A',
          }),
        ).toBe(true);
      });

      // CodeQL #32: "%" and "\" in the reference match themselves too.
      it('treats % and \\ in the reference as plain characters', async () => {
        await credit('cus_other2', 'adjustment', 'entry MDY2026B');
        expect(
          await quotedForAnotherCustomer(service, {
            customerId: 'cus_me2',
            ref: 'MD%2026B',
          }),
        ).toBe(false);
        await credit('cus_other2', 'adjustment', 'entry MD\\2026C');
        expect(
          await quotedForAnotherCustomer(service, {
            customerId: 'cus_me2',
            ref: 'MD\\2026C',
          }),
        ).toBe(true);
      });
    });
  },
});
