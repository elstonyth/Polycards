/**
 * The ban report against the Payout Destination module — integration:modules
 *
 * GET /reports/support/ban lists every account on a player's numbers in its
 * own SQL (it needs their names, handles, ban state and payouts, which
 * numberStanding does not return). It builds that SQL from the module's pieces
 * (payout-destination.ts), and this pins the result to the module's rules on
 * real Postgres: for each of a player's bank numbers, `other_accounts` is
 * numberStanding's holders, and `banned_number` / `lifted_for_player` are its
 * ban flags. Padding and separators, a retired alias, the same digits at
 * another bank, payout statuses, deleted accounts and cut rows, both PayNow
 * spellings, and a lift for this player only.
 */

import path from 'path';
import { moduleIntegrationTestRunner } from '@medusajs/test-utils';
import { ContainerRegistrationKeys } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../index';
import PacksModuleService from '../service';
import CustomerAccountState from '../models/customer-account-state';
import GatewayWithdrawal from '../models/gateway-withdrawal';
import { numberStanding } from '../payout-destination';
import { savedBankAccountId } from '../saved-accounts';
import type { LedgerSqlManager } from '../claim';
import { GET } from '../../../api/reports/support/ban/route';

jest.setTimeout(300 * 1000);

// Made-up details only (the repo is public).
const NUMBER = '512345670001';
const LOCAL = '91234567';
const FULL = `65${LOCAL}`;

const entry = (bankCode: string, accountNumber: string, holder = 'TAN AH KOW') => ({
  id: savedBankAccountId(bankCode, accountNumber),
  bankCode,
  bankName: bankCode,
  accountNumber,
  accountHolderName: holder,
  savedAt: '2026-01-01T00:00:00.000Z',
});

type BankView = {
  bank: string;
  last4: string;
  banned_number: boolean;
  lifted_for_player: boolean;
  other_accounts: { username: string }[];
};

moduleIntegrationTestRunner<PacksModuleService>({
  moduleName: PACKS_MODULE,
  resolve: path.resolve(__dirname, '../../..', 'modules/packs'),
  moduleModels: [CustomerAccountState, GatewayWithdrawal],
  testSuite: ({ service, MikroOrmWrapper }) => {
    const em = () => MikroOrmWrapper.forkManager();
    let n = 0;
    // first_name is the shown name the report lists; the id here, to compare.
    const put = (
      id: string,
      metadata: Record<string, unknown>,
      deleted = false,
    ) =>
      em().execute(
        'insert into "customer" ("id", "first_name", "metadata", "deleted_at") values (?, ?, ?::jsonb, ?)',
        [id, id, JSON.stringify(metadata), deleted ? new Date() : null],
      );
    const payout = (
      customer_id: string,
      bank_code: string,
      account_number: string,
      status: 'pending' | 'held' | 'settled' | 'failed' = 'settled',
    ) =>
      service.createGatewayWithdrawals([
        {
          merchant_transaction_id: `PW-BANP-${String(++n).padStart(4, '0')}`,
          customer_id,
          amount: 100,
          bank_code,
          account_number,
          account_holder_name: 'TAN AH KOW',
          gateway: 'fake',
          status,
        },
      ]);
    const ban = (key: string) =>
      em().execute(
        'insert into "banned_payout_account" ("account_key") values (?)',
        [key],
      );

    /** The report's username lookup, on this database. */
    const report = async (username: string) => {
      const db = {
        raw: async (sql: string, bindings?: readonly unknown[]) => ({
          rows: await em().execute(sql, (bindings ?? []) as unknown[]),
        }),
      };
      const res = { json: jest.fn() };
      await GET(
        {
          query: { username },
          scope: {
            resolve: (key: string) =>
              key === ContainerRegistrationKeys.PG_CONNECTION ? db : service,
          },
        } as never,
        res as never,
      );
      return res.json.mock.calls[0][0] as { bank_accounts: BankView[] };
    };

    beforeEach(async () => {
      // The core customer table is not this module's: made by hand with the
      // columns the report and the player lookup read.
      await em().execute(
        'create table if not exists "customer" ("id" text primary key, "metadata" jsonb, "updated_at" timestamptz null, "deleted_at" timestamptz null)',
      );
      for (const col of [
        '"first_name" text null',
        '"email" text null',
        '"phone" text null',
        '"has_account" boolean not null default true',
        '"created_at" timestamptz not null default now()',
      ]) {
        await em().execute(
          `alter table "customer" add column if not exists ${col}`,
        );
      }
      await em().execute(
        'create table if not exists "banned_payout_account" ("account_key" text not null primary key, "bank_code" text null, "reason" text null, "created_at" timestamptz not null default now())',
      );
      await em().execute('delete from "customer"');
      await em().execute('delete from "banned_payout_account"');
      await em().execute('delete from "gateway_withdrawal"');
    });

    it("lists the module's holders and ban flags for each of a player's numbers", async () => {
      await put('player', {
        bank_accounts: [
          entry('MBBEMYKL', NUMBER),
          entry('PAYNOWSG', LOCAL),
          entry('USDTTRC20', 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'),
        ],
        // The bank number's ban is lifted for this player only.
        payout_ban_lifted: {
          [NUMBER]: { bank_code: 'MBBEMYKL', at: '2026-11-04T00:00:00.000Z' },
        },
      });
      await put('spaced', { bank_accounts: [entry('MBBEMYKL', '5123 4567-0001')] });
      await put('legacy', { bank_accounts: [entry('MYMB2U', NUMBER)] });
      await put('padded', {});
      await payout('padded', 'MBBEMYKL', `00${NUMBER}`);
      await put('other_bank', { bank_accounts: [entry('PBBEMYKL', NUMBER)] });
      await put('failed', {});
      await payout('failed', 'MBBEMYKL', NUMBER, 'failed');
      await put('pending', {});
      await payout('pending', 'MBBEMYKL', NUMBER, 'pending');
      await put('held', {});
      await payout('held', 'MBBEMYKL', NUMBER, 'held');
      // A deleted account's saved list is not read; its cut payout row keeps
      // the last 4 only.
      await put('deleted', { bank_accounts: [entry('MBBEMYKL', NUMBER)] }, true);
      await payout('deleted', 'MBBEMYKL', NUMBER.slice(-4));
      await put('pn_full', { bank_accounts: [entry('PAYNOWSG', FULL)] });
      await put('pn_paid', {});
      await payout('pn_paid', 'PAYNOWSG', LOCAL);
      await put('pn_other_bank', { bank_accounts: [entry('DBSSSGSG', LOCAL)] });
      await ban(NUMBER);
      await ban(FULL);

      const { bank_accounts: banks } = await report('player');
      // The wallet has no holder to share: not listed.
      expect(banks.map((b) => b.last4).sort()).toEqual(['0001', '4567']);
      for (const [bankCode, number] of [
        ['MBBEMYKL', NUMBER],
        ['PAYNOWSG', LOCAL],
      ]) {
        const s = await numberStanding(
          em() as unknown as LedgerSqlManager,
          'player',
          { bankCode, accountNumber: number },
        );
        const view = banks.find((b) => b.last4 === number.slice(-4))!;
        expect(view.other_accounts.map((o) => o.username).sort()).toEqual(
          s.holders.map((h) => h.customerId).sort(),
        );
        expect(view.banned_number).toBe(s.bannedForPlayer);
        expect(view.lifted_for_player).toBe(s.banned && !s.bannedForPlayer);
      }
      // What those are, so a parity of two empty lists cannot pass.
      const bank = banks.find((b) => b.last4 === '0001')!;
      expect(bank.other_accounts.map((o) => o.username).sort()).toEqual([
        'held',
        'legacy',
        'padded',
        'pending',
        'spaced',
      ]);
      expect(bank).toMatchObject({ banned_number: false, lifted_for_player: true });
      const paynow = banks.find((b) => b.last4 === '4567')!;
      expect(paynow.other_accounts.map((o) => o.username).sort()).toEqual([
        'pn_full',
        'pn_paid',
      ]);
      expect(paynow).toMatchObject({ banned_number: true, lifted_for_player: false });
    });
  },
});
