/**
 * Payout Destination identity against a REAL Postgres — integration:modules
 *
 * numberStanding and nameStanding are raw SQL over the core customer table
 * (customer.metadata.bank_accounts), gateway_withdrawal and
 * banned_payout_account. This pins who counts as another holder of a number
 * at a bank, who is banned for whom, and who holds a name: padding and
 * separators, both PayNow spellings, the bank scope, payout statuses, deleted
 * accounts and cut rows, wallets compared whole, lifts and name clearings.
 * And ADR 0016: a shared browser or network is never a holder or a block.
 */

import path from 'path';
import { moduleIntegrationTestRunner } from '@medusajs/test-utils';
import { PACKS_MODULE } from '../index';
import PacksModuleService from '../service';
import GatewayWithdrawal from '../models/gateway-withdrawal';
import VisitorSignal from '../models/visitor-signal';
import {
  nameStanding,
  numberStanding,
  saveVerdict,
} from '../payout-destination';
import { savedBankAccountId } from '../saved-accounts';
import type { LedgerSqlManager } from '../claim';

jest.setTimeout(300 * 1000);

// Made-up details only (the repo is public).
const NUMBER = '512345670001';
const NAME = 'TAN AH KOW';
const STRANGER = 'LIM AH LIAN';
const TRON = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const LOCAL = '91234567';
const FULL = `65${LOCAL}`;

const entry = (bankCode: string, accountNumber: string, holder = NAME) => ({
  id: savedBankAccountId(bankCode, accountNumber),
  bankCode,
  bankName: bankCode,
  accountNumber,
  accountHolderName: holder,
  savedAt: '2026-01-01T00:00:00.000Z',
});

moduleIntegrationTestRunner<PacksModuleService>({
  moduleName: PACKS_MODULE,
  resolve: path.resolve(__dirname, '../../..', 'modules/packs'),
  moduleModels: [GatewayWithdrawal, VisitorSignal],
  testSuite: ({ service, MikroOrmWrapper }) => {
    const em = () => MikroOrmWrapper.forkManager();
    const sql = () => em() as unknown as LedgerSqlManager;
    let n = 0;
    const put = (id: string, metadata: Record<string, unknown>) =>
      em().execute(
        'insert into "customer" ("id", "metadata") values (?, ?::jsonb)',
        [id, JSON.stringify(metadata)],
      );
    const payout = (
      customer_id: string,
      bank_code: string,
      account_number: string,
      status: 'pending' | 'held' | 'settled' | 'failed' = 'settled',
      holder = NAME,
    ) =>
      service.createGatewayWithdrawals([
        {
          merchant_transaction_id: `PW-DEST-${String(++n).padStart(4, '0')}`,
          customer_id,
          amount: 100,
          bank_code,
          account_number,
          account_holder_name: holder,
          gateway: 'fake',
          status,
        },
      ]);
    const ban = (key: string) =>
      em().execute(
        'insert into "banned_payout_account" ("account_key") values (?)',
        [key],
      );
    const standing = (customerId: string, bankCode: string | null, number: string) =>
      numberStanding(sql(), customerId, { bankCode, accountNumber: number });
    const ids = async (customerId: string, bankCode: string, number: string) =>
      (await standing(customerId, bankCode, number)).holders
        .map((h) => h.customerId)
        .sort();

    beforeEach(async () => {
      // The saved list is raw SQL on the core customer table (ADR 0015), and the
      // ban list is not a model: both made by hand, as the migrations make them.
      await em().execute(
        'create table if not exists "customer" ("id" text primary key, "metadata" jsonb, "updated_at" timestamptz null, "deleted_at" timestamptz null)',
      );
      await em().execute(
        'create table if not exists "banned_payout_account" ("account_key" text not null primary key, "bank_code" text null, "reason" text null, "created_at" timestamptz not null default now())',
      );
      await em().execute('delete from "customer"');
      await em().execute('delete from "banned_payout_account"');
      await put('cus_player', {});
    });

    it('finds a number through padding and separators, on saved lists and payouts', async () => {
      await put('cus_spaced', { bank_accounts: [entry('MBBEMYKL', '5123 4567-0001')] });
      await put('cus_legacy', { bank_accounts: [entry('MYMB2U', NUMBER)] });
      await put('cus_odd', { bank_accounts: 'x' });
      await payout('cus_padded', 'MBBEMYKL', `00${NUMBER}`);
      expect(await ids('cus_player', 'MBBEMYKL', NUMBER)).toEqual([
        'cus_legacy',
        'cus_padded',
        'cus_spaced',
      ]);
      // Asked padded or spaced, it is the same number.
      expect(await ids('cus_player', 'MBBEMYKL', `0${NUMBER}`)).toEqual([
        'cus_legacy',
        'cus_padded',
        'cus_spaced',
      ]);
      // Never yourself.
      expect(await ids('cus_spaced', 'MBBEMYKL', NUMBER)).toEqual([
        'cus_legacy',
        'cus_padded',
      ]);
    });

    it('the same digits at another bank are not a holder', async () => {
      await put('cus_pbb', { bank_accounts: [entry('PBBEMYKL', NUMBER)] });
      await payout('cus_pbb_paid', 'PBBEMYKL', NUMBER);
      expect(await ids('cus_player', 'MBBEMYKL', NUMBER)).toEqual([]);
      expect(await ids('cus_player', 'PBBEMYKL', NUMBER)).toEqual([
        'cus_pbb',
        'cus_pbb_paid',
      ]);
    });

    it('failed payouts are not holders; pending, held and settled are, as paid', async () => {
      await put('cus_saver', { bank_accounts: [entry('MBBEMYKL', NUMBER)] });
      await payout('cus_failed', 'MBBEMYKL', NUMBER, 'failed');
      await payout('cus_pending', 'MBBEMYKL', NUMBER, 'pending');
      await payout('cus_held', 'MBBEMYKL', NUMBER, 'held');
      await payout('cus_settled', 'MBBEMYKL', NUMBER, 'settled');
      // Saved and paid: one entry, paid.
      await payout('cus_saver', 'MBBEMYKL', NUMBER, 'failed');
      const s = await standing('cus_player', 'MBBEMYKL', NUMBER);
      expect(
        s.holders
          .map((h) => `${h.customerId}:${h.paid}`)
          .sort(),
      ).toEqual([
        'cus_held:true',
        'cus_pending:true',
        'cus_saver:false',
        'cus_settled:true',
      ]);
    });

    it('a deleted account and a cut row hold nothing', async () => {
      await put('cus_gone', { bank_accounts: [entry('MBBEMYKL', NUMBER)] });
      await em().execute(
        "update customer set deleted_at = now() where id = 'cus_gone'",
      );
      // The deletion scrub (and freePayoutAccount) keep the last 4 only.
      await payout('cus_cut', 'MBBEMYKL', '0001');
      expect(await ids('cus_player', 'MBBEMYKL', NUMBER)).toEqual([]);
      expect(await ids('cus_player', 'MBBEMYKL', '00001')).toEqual([]);
    });

    it('a PayNow mobile with or without its 65 is one number, for holders and bans', async () => {
      await put('cus_local', { bank_accounts: [entry('PAYNOWSG', LOCAL)] });
      await payout('cus_full', 'PAYNOWSG', FULL);
      for (const asked of [LOCAL, FULL, '+65 9123 4567']) {
        const s = await standing('cus_player', 'PAYNOWSG', asked);
        expect(s.forms).toEqual([LOCAL, FULL]);
        expect(s.key).toBe(LOCAL);
        expect(s.holders.map((h) => h.customerId).sort()).toEqual([
          'cus_full',
          'cus_local',
        ]);
      }
      await ban(FULL);
      for (const asked of [LOCAL, FULL]) {
        const s = await standing('cus_player', 'PAYNOWSG', asked);
        expect(s.banned).toBe(true);
        expect(s.bannedForPlayer).toBe(true);
      }
      // At another bank, the 65 is part of the number.
      expect(
        (await standing('cus_player', 'PBBEMYKL', LOCAL)).banned,
      ).toBe(false);
    });

    it('a ban holds at any bank and however the number is padded', async () => {
      await ban(NUMBER);
      for (const [bank, asked] of [
        ['MBBEMYKL', NUMBER],
        ['PBBEMYKL', `0${NUMBER}`],
        [null, '5123-4567-0001'],
      ] as const) {
        expect(await standing('cus_player', bank, asked)).toMatchObject({
          banned: true,
          bannedForPlayer: true,
        });
      }
      expect(await standing('cus_player', 'MBBEMYKL', '998877665544')).toMatchObject({
        banned: false,
        bannedForPlayer: false,
      });
    });

    it('a lift counts for that player only', async () => {
      await ban(NUMBER);
      await put('cus_lifted', {
        payout_ban_lifted: {
          [NUMBER]: { bank_code: 'MBBEMYKL', at: '2026-11-04T00:00:00.000Z' },
        },
      });
      expect(await standing('cus_lifted', 'MBBEMYKL', NUMBER)).toMatchObject({
        banned: true,
        bannedForPlayer: false,
      });
      expect(await standing('cus_player', 'MBBEMYKL', NUMBER)).toMatchObject({
        banned: true,
        bannedForPlayer: true,
      });
    });

    it("a deleted account's lift and name clearing count for no one", async () => {
      await ban(NUMBER);
      await put('cus_saved', {
        bank_accounts: [entry('MBBEMYKL', '998877665544')],
      });
      await put('cus_gone', {
        payout_ban_lifted: {
          [NUMBER]: { bank_code: 'MBBEMYKL', at: '2026-11-04T00:00:00.000Z' },
        },
        holder_name_cleared: {
          tanahkow: {
            name: NAME,
            at: '2026-11-04T00:00:00.000Z',
            with: ['cus_saved'],
          },
        },
      });
      expect(
        (await standing('cus_gone', 'MBBEMYKL', NUMBER)).bannedForPlayer,
      ).toBe(false);
      expect((await nameStanding(sql(), 'cus_gone', NAME)).blocking).toEqual([]);
      await em().execute(
        "update customer set deleted_at = now() where id = 'cus_gone'",
      );
      expect(
        (await standing('cus_gone', 'MBBEMYKL', NUMBER)).bannedForPlayer,
      ).toBe(true);
      expect((await nameStanding(sql(), 'cus_gone', NAME)).blocking).toEqual([
        'cus_saved',
      ]);
    });

    it('an EVM address is banned and keyed in lower case, as it is stored', async () => {
      // The EIP-55 checksum example address: a test vector, nobody's wallet.
      const EVM = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
      await ban(EVM.toLowerCase());
      expect(await standing('cus_player', 'USDTERC20', EVM)).toMatchObject({
        key: EVM.toLowerCase(),
        banned: true,
        bannedForPlayer: true,
      });
      // A Tron address is case-sensitive: kept as typed.
      expect((await standing('cus_player', 'USDTTRC20', TRON)).key).toBe(TRON);
    });

    it('an unknown bank code matches holders under another unknown code, as before', async () => {
      // A retired code no alias maps can stay on an old saved list or row.
      await put('cus_old_saved', {
        bank_accounts: [entry('OLDBANKX', NUMBER)],
      });
      await payout('cus_old_paid', 'OLDBANKY', `0${NUMBER}`);
      await put('cus_known', { bank_accounts: [entry('MBBEMYKL', NUMBER)] });
      const s = await standing('cus_player', 'OLDBANKZ', NUMBER);
      expect(s.bankId).toBeNull();
      expect(s.holders.map((h) => `${h.customerId}:${h.paid}`).sort()).toEqual([
        'cus_old_paid:true',
        'cus_old_saved:false',
      ]);
      // A known bank does not see them, nor they it.
      expect(await ids('cus_player', 'MBBEMYKL', NUMBER)).toEqual(['cus_known']);
      // Verified under an unknown code: verified, as verifiedElsewhere read it.
      const old = entry('OLDBANKX', '998877665544');
      await put('cus_old_verified', {
        bank_accounts: [old],
        bank_share_verified: { [old.id]: '2026-11-03T00:00:00.000Z' },
      });
      expect(
        (await standing('cus_player', 'OLDBANKZ', '998877665544')).holders,
      ).toEqual([{ customerId: 'cus_old_verified', paid: false, verified: true }]);
    });

    it('a wallet address matches whole, never by its digits', async () => {
      // Same digits, other letters: another wallet.
      const lookalike = TRON.replace(/[A-Za-z]/g, 'X');
      await put('cus_wallet', {
        bank_accounts: [entry('USDTTRC20', TRON, 'USDT · TRC20 (Tron)')],
      });
      await put('cus_lookalike', {
        bank_accounts: [entry('USDTTRC20', lookalike, 'USDT · TRC20 (Tron)')],
      });
      await payout('cus_paid', 'USDTTRC20', TRON);
      const s = await standing('cus_player', 'USDTTRC20', TRON);
      expect(s.holders.map((h) => `${h.customerId}:${h.paid}`).sort()).toEqual([
        'cus_paid:true',
        'cus_wallet:false',
      ]);
      expect(s.key).toBe(TRON);
    });

    it('marks the holder support verified on this number', async () => {
      const verifiedOn = (bankCode: string, number: string) => {
        const e = entry(bankCode, number);
        return {
          bank_accounts: [e],
          bank_share_verified: { [e.id]: '2026-11-03T00:00:00.000Z' },
        };
      };
      await put('cus_verified', verifiedOn('MBBEMYKL', `0${NUMBER}`));
      await put('cus_saver', { bank_accounts: [entry('MBBEMYKL', NUMBER)] });
      // Verified on the other PayNow spelling: the same number.
      await put('cus_paynow', verifiedOn('PAYNOWSG', FULL));
      const s = await standing('cus_player', 'MBBEMYKL', NUMBER);
      expect(s.holders.map((h) => `${h.customerId}:${h.verified}`).sort()).toEqual([
        'cus_saver:false',
        'cus_verified:true',
      ]);
      expect(
        (await standing('cus_player', 'PAYNOWSG', LOCAL)).holders,
      ).toEqual([{ customerId: 'cus_paynow', paid: false, verified: true }]);
    });

    it('the service delegate reads the same standing', async () => {
      await put('cus_saver', { bank_accounts: [entry('MBBEMYKL', NUMBER)] });
      expect(
        await service.payoutNumberStanding('cus_player', {
          bankCode: 'MBBEMYKL',
          accountNumber: NUMBER,
        }),
      ).toEqual(await standing('cus_player', 'MBBEMYKL', NUMBER));
    });

    it('finds a holder name saved or paid elsewhere, and leaves cleared accounts out of the blocks', async () => {
      await put('cus_saved', {
        bank_accounts: [entry('MBBEMYKL', '998877665544', 'Tan Ah Ków&')],
      });
      await payout('cus_paid', 'PBBEMYKL', '111122223333', 'settled', 'ᴛᴀɴ ᴀʜ ᴋᴏᴡ');
      await payout('cus_failed', 'PBBEMYKL', '111122224444', 'failed', NAME);
      await put('cus_stranger', {
        bank_accounts: [entry('MBBEMYKL', '777766665555', STRANGER)],
      });
      const holders = async (id: string) =>
        (await nameStanding(sql(), id, NAME)).holders.sort();
      expect(await holders('cus_player')).toEqual(['cus_paid', 'cus_saved']);
      await em().execute(
        "update customer set metadata = ?::jsonb where id = 'cus_player'",
        [
          JSON.stringify({
            holder_name_cleared: {
              tanahkow: {
                name: NAME,
                at: '2026-11-04T00:00:00.000Z',
                with: ['cus_saved'],
              },
            },
          }),
        ],
      );
      const s = await nameStanding(sql(), 'cus_player', 'Tan Ah Kow');
      expect(s.holders.sort()).toEqual(['cus_paid', 'cus_saved']);
      expect(s.blocking).toEqual(['cus_paid']);
      // The clearing is this player's: another account still sees both.
      await put('cus_other', {});
      expect(
        (await nameStanding(sql(), 'cus_other', NAME)).blocking.sort(),
      ).toEqual(['cus_paid', 'cus_saved']);
      expect(
        await service.payoutNameStanding('cus_player', 'Tan Ah Kow'),
      ).toEqual(s);
    });

    // ADR 0016: IP and device signals are a review clue, never a gate.
    it('two accounts on one browser and network hold nothing of each other', async () => {
      await put('cus_twin', {
        bank_accounts: [entry('MBBEMYKL', '998877665544', STRANGER)],
      });
      for (const customerId of ['cus_player', 'cus_twin']) {
        await service.recordVisitorSignal({
          customerId,
          ip: '203.0.113.7',
          deviceId: 'device-shared',
        });
      }
      const [{ count }] = await em().execute<{ count: string }[]>(
        'select count(*) from visitor_signal',
      );
      expect(Number(count)).toBe(2);
      const number = await standing('cus_player', 'MBBEMYKL', NUMBER);
      const name = await nameStanding(sql(), 'cus_player', NAME);
      expect(number.holders).toEqual([]);
      expect(name).toEqual({ holders: [], blocking: [] });
      expect(
        saveVerdict({
          number,
          name,
          saved: [],
          accountId: savedBankAccountId('MBBEMYKL', NUMBER),
          holderName: NAME,
        }),
      ).toEqual({ alreadySaved: false, blocks: [] });
    });
  },
});
