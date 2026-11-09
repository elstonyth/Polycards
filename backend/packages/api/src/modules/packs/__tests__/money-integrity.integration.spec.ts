/**
 * moneyIntegrityFindings — integration:modules
 *
 * Real Postgres, because the whole of it is a query: what a process dying
 * between two money writes leaves behind.
 */

import path from 'path';
import { moduleIntegrationTestRunner } from '@medusajs/test-utils';
import { PACKS_MODULE } from '../index';
import type PacksModuleService from '../service';
import AdminActionAudit from '../models/admin-action-audit';
import CreditTransaction from '../models/credit-transaction';
import CustomerAccountState from '../models/customer-account-state';
import GatewayWithdrawal from '../models/gateway-withdrawal';
import LedgerEntry from '../models/ledger-entry';
import LedgerSequence from '../models/ledger-sequence';
import Pull from '../models/pull';
import TicketSpin from '../models/ticket-spin';
import {
  withdrawalIdempotencyReference,
  withdrawalRefundReference,
} from '../gateway-withdrawal';
import { moneyIntegrityFindings } from '../money-integrity';

jest.setTimeout(300 * 1000);

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

moduleIntegrationTestRunner<PacksModuleService>({
  moduleName: PACKS_MODULE,
  resolve: path.resolve(__dirname, '../../..', 'modules/packs'),
  moduleModels: [
    AdminActionAudit,
    CreditTransaction,
    CustomerAccountState,
    GatewayWithdrawal,
    LedgerEntry,
    LedgerSequence,
    Pull,
    TicketSpin,
  ],
  testSuite: ({ service, MikroOrmWrapper }) => {
    const ago = (ms: number) => new Date(Date.now() - ms);

    let n = 0;
    const credit = async (row: {
      customer: string;
      amount: number;
      reason: string;
      at?: Date;
      open?: string;
      pull?: string;
      reference?: string;
      anchor?: string;
    }) => {
      const id = `ct_${++n}`;
      await MikroOrmWrapper.getManager().execute(
        'INSERT INTO credit_transaction ' +
          '(id, customer_id, amount, raw_amount, reason, source_transaction_id, pull_id, reference, created_at, updated_at) ' +
          'VALUES (?, ?, ?, ?::jsonb, ?, ?, ?, ?, ?, ?)',
        [
          id,
          row.customer,
          row.amount,
          JSON.stringify({ value: String(row.amount), precision: 20 }),
          row.reason,
          row.anchor ?? row.open ?? null,
          row.pull ?? null,
          row.reference ?? null,
          (row.at ?? ago(DAY)).toISOString(),
          (row.at ?? ago(DAY)).toISOString(),
        ],
      );
      return id;
    };
    const charge = (open: string, customer: string, at = ago(DAY)) =>
      credit({ customer, amount: -45, reason: 'pack_open', open, at });

    const pull = async (
      customer: string,
      over: { open_id?: string; status?: 'vaulted' | 'bought_back' } = {},
    ) => {
      const [row] = await service.createPulls([
        {
          customer_id: customer,
          pack_id: 'p',
          card_id: 'c',
          order_id: null,
          rolled_at: ago(DAY),
          source: 'pack',
          ...over,
        },
      ]);
      return row;
    };

    describe('a charge for an open', () => {
      it('with no card, no spin and no reversal is flagged', async () => {
        await charge('open_lost', 'cus_lost');
        await expect(moneyIntegrityFindings(service)).resolves.toEqual([
          expect.objectContaining({
            kind: 'open_without_prize',
            customer_id: 'cus_lost',
            amount: 45,
          }),
        ]);
      });

      it('with its card is not', async () => {
        await charge('open_card', 'cus_card');
        await pull('cus_card', { open_id: 'open_card' });
        await expect(moneyIntegrityFindings(service)).resolves.toEqual([]);
      });

      it('with its ticket spin is not', async () => {
        await charge('open_spin', 'cus_spin');
        await service.createTicketSpins([
          {
            customer_id: 'cus_spin',
            pack_id: 'lucky',
            tickets: 1,
            source: 'pack',
            open_id: 'open_spin',
            rolled_at: ago(DAY),
          },
        ]);
        await expect(moneyIntegrityFindings(service)).resolves.toEqual([]);
      });

      it('that was reversed is not', async () => {
        const id = await charge('open_rev', 'cus_rev');
        await credit({
          customer: 'cus_rev',
          amount: 45,
          reason: 'pack_open',
          reference: `reversal:${id}`,
        });
        await expect(moneyIntegrityFindings(service)).resolves.toEqual([]);
      });

      // Still inside its own workflow: the card lands a moment later.
      it('from the last few minutes is not, yet', async () => {
        await charge('open_new', 'cus_new', ago(5 * MINUTE));
        await expect(moneyIntegrityFindings(service)).resolves.toEqual([]);
      });

      it('older than the window is not', async () => {
        await charge('open_old', 'cus_old', ago(8 * DAY));
        await expect(moneyIntegrityFindings(service)).resolves.toEqual([]);
      });
    });

    describe('a sell-back', () => {
      it('paid while the card stays vaulted is flagged', async () => {
        const row = await pull('cus_sold');
        await credit({
          customer: 'cus_sold',
          amount: 12.5,
          reason: 'buyback',
          pull: row.id,
        });
        await expect(moneyIntegrityFindings(service)).resolves.toEqual([
          expect.objectContaining({
            kind: 'sold_without_flip',
            id: row.id,
            customer_id: 'cus_sold',
            amount: 12.5,
          }),
        ]);
      });

      it('that flipped the card is not', async () => {
        const row = await pull('cus_flip', { status: 'bought_back' });
        await credit({
          customer: 'cus_flip',
          amount: 12.5,
          reason: 'buyback',
          pull: row.id,
        });
        await expect(moneyIntegrityFindings(service)).resolves.toEqual([]);
      });
    });

    describe('a denied payout', () => {
      const denied = async (customer: string) => {
        const [row] = await service.createGatewayWithdrawals([
          {
            merchant_transaction_id: `PW-${customer}`,
            customer_id: customer,
            amount: 1500,
            bank_code: 'MBBEMYKL',
            account_number: '123456789012',
            account_holder_name: 'AHMAD BIN ALI',
            gateway: 'fake',
            status: 'held',
          },
        ]);
        const debitReference = withdrawalIdempotencyReference(
          customer,
          row.merchant_transaction_id,
        );
        await credit({
          customer,
          amount: -1500,
          reason: 'cashout',
          anchor: debitReference,
        });
        await service.claimWithdrawalAgainstDebit({
          id: row.id,
          customerId: customer,
          debitReference,
          from: ['held'],
          to: 'failed',
          audit: {
            admin_id: 'usr_1',
            action: 'deny_withdrawal',
            before: { status: 'held' },
            after: { status: 'failed', amount: 1500 },
            reason: 'the process died after this',
          },
        });
        return row;
      };
      // The audit row was written just now, inside the settle time.
      const later = () => new Date(Date.now() + 20 * MINUTE);

      it('with no refund is flagged', async () => {
        const row = await denied('cus_deny');
        await expect(moneyIntegrityFindings(service, later())).resolves.toEqual(
          [
            expect.objectContaining({
              kind: 'denied_without_refund',
              id: row.id,
              customer_id: 'cus_deny',
              amount: 1500,
            }),
          ],
        );
      });

      it('in the last few minutes is not, yet', async () => {
        await denied('cus_deny_new');
        await expect(moneyIntegrityFindings(service)).resolves.toEqual([]);
      });

      it('with its refund is not', async () => {
        const row = await denied('cus_deny_ok');
        await credit({
          customer: 'cus_deny_ok',
          amount: 1500,
          reason: 'cashout',
          anchor: withdrawalRefundReference(
            'cus_deny_ok',
            row.merchant_transaction_id,
          ),
        });
        await expect(moneyIntegrityFindings(service, later())).resolves.toEqual(
          [],
        );
      });
    });

    describe('refundUnfinishedOpen', () => {
      const pullsFor = (open: string) =>
        service.listPulls({ open_id: open }, { take: 5 });
      const record = (open: string, customer: string) =>
        service.recordPullsWithLedger({
          pulls: [
            {
              customer_id: customer,
              pack_id: 'p',
              card_id: 'c',
              order_id: null,
              rolled_at: new Date(),
              source: 'pack',
              open_id: open,
            },
          ],
          ledger: {
            customerId: customer,
            openId: open,
            price: 45,
            packId: 'p',
            channel: 'single',
            fx: 4.5,
          },
        });

      it('refunds a charge with no card or spin, once', async () => {
        const id = await charge('open_refund', 'cus_refund');
        await expect(service.refundUnfinishedOpen(id)).resolves.toBe(
          'refunded',
        );
        await expect(service.creditBalance('cus_refund')).resolves.toBe(0);
        await expect(moneyIntegrityFindings(service)).resolves.toEqual([]);
        await expect(service.refundUnfinishedOpen(id)).resolves.toBe('already');
        await expect(service.creditBalance('cus_refund')).resolves.toBe(0);
      });

      it('leaves a charge whose card or spin landed', async () => {
        const card = await charge('open_kept', 'cus_kept');
        await pull('cus_kept', { open_id: 'open_kept' });
        const spin = await charge('open_kept_spin', 'cus_kept');
        await service.createTicketSpins([
          {
            customer_id: 'cus_kept',
            pack_id: 'lucky',
            tickets: 1,
            source: 'pack',
            open_id: 'open_kept_spin',
            rolled_at: ago(DAY),
          },
        ]);
        await expect(service.refundUnfinishedOpen(card)).resolves.toBe(
          'has_prize',
        );
        await expect(service.refundUnfinishedOpen(spin)).resolves.toBe(
          'has_prize',
        );
        await expect(service.creditBalance('cus_kept')).resolves.toBe(-90);
      });

      it('refunds nothing but an open charge', async () => {
        const topup = await credit({
          customer: 'cus_other',
          amount: 45,
          reason: 'topup',
        });
        await expect(service.refundUnfinishedOpen(topup)).resolves.toBe(
          'not_found',
        );
        await expect(service.creditBalance('cus_other')).resolves.toBe(45);
      });

      it('refuses a card for an open already refunded, and records nothing', async () => {
        const id = await charge('open_late', 'cus_late');
        await service.refundUnfinishedOpen(id);
        await expect(record('open_late', 'cus_late')).rejects.toThrow(
          /refunded/i,
        );
        await expect(pullsFor('open_late')).resolves.toHaveLength(0);
      });

      it('records a card for an open still charged, as before', async () => {
        await charge('open_live', 'cus_live');
        await record('open_live', 'cus_live');
        await expect(pullsFor('open_live')).resolves.toHaveLength(1);
      });
    });
  },
});
