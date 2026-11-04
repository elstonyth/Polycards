/**
 * freePayoutAccount against a REAL Postgres — integration:modules
 *
 * Support frees a bank number from the other accounts on it so one player can
 * save it themselves (owner, 2026-11-04, the admin assistant's
 * free_bank_number). The unit spec drives a fake `em`; this proves the SQL:
 * the digit match (spaces, a leading zero), the cut to the last 4 with a blank
 * holder name, that only the listed accounts' rows move, that the other
 * account stops counting as a holder of the number AND of the name on those
 * rows, and that a refusal or a failed re-check leaves every row as it was.
 */

import path from 'path';
import { moduleIntegrationTestRunner } from '@medusajs/test-utils';
import { PACKS_MODULE } from '../index';
import PacksModuleService from '../service';
import GatewayWithdrawal from '../models/gateway-withdrawal';
import AdminActionAudit from '../models/admin-action-audit';
import { savedBankAccountId } from '../saved-accounts';

jest.setTimeout(300 * 1000);

// Made-up details only (the repo is public).
const NUMBER = '512345670001';
const NAME = 'TAN AH KOW';
const STRANGER = 'LIM AH LIAN';
const saved = (accountNumber: string, holder = NAME) => ({
  id: savedBankAccountId('MBBEMYKL', accountNumber),
  bankCode: 'MBBEMYKL',
  bankName: 'Maybank',
  accountNumber,
  accountHolderName: holder,
  savedAt: '2026-01-01T00:00:00.000Z',
});

moduleIntegrationTestRunner<PacksModuleService>({
  moduleName: PACKS_MODULE,
  resolve: path.resolve(__dirname, '../../..', 'modules/packs'),
  moduleModels: [GatewayWithdrawal, AdminActionAudit],
  testSuite: ({ service, MikroOrmWrapper }) => {
    const em = () => MikroOrmWrapper.forkManager();
    let n = 0;
    const payout = async (
      customer_id: string,
      account_number: string,
      status: 'pending' | 'held' | 'settled' | 'failed' = 'settled',
      holder = NAME,
    ) =>
      (
        await service.createGatewayWithdrawals([
          {
            // Padded, so the rows read back in the order they were made.
            merchant_transaction_id: `PW-FREE-${String(++n).padStart(4, '0')}`,
            customer_id,
            amount: 100,
            bank_code: 'MBBEMYKL',
            account_number,
            account_holder_name: holder,
            gateway: 'fake',
            status,
          },
        ])
      )[0];
    const rows = async () =>
      (
        await em().execute<
          {
            customer_id: string;
            account_number: string;
            account_holder_name: string;
          }[]
        >(
          'select customer_id, account_number, account_holder_name from gateway_withdrawal order by merchant_transaction_id',
        )
      ).map(
        (r) => `${r.customer_id} ${r.account_number} ${r.account_holder_name}`,
      );
    const metadataOf = async (id: string) =>
      (
        await em().execute<{ metadata: Record<string, unknown> }[]>(
          'select metadata from customer where id = ?',
          [id],
        )
      )[0].metadata;

    beforeEach(async () => {
      // The saved list is raw SQL on the core customer table (ADR 0015).
      await em().execute(
        'create table if not exists "customer" ("id" text primary key, "metadata" jsonb, "updated_at" timestamptz null, "deleted_at" timestamptz null)',
      );
      await em().execute('delete from "customer"');
      const put = (id: string, metadata: Record<string, unknown>) =>
        em().execute(
          'insert into "customer" ("id", "metadata") values (?, ?::jsonb)',
          [id, JSON.stringify(metadata)],
        );
      await put('cus_player', {});
      // The banned twin: saved the number (spaced) and was paid to it with a
      // leading zero, plus a failed payout; also a second bank it keeps.
      await put('cus_twin', {
        bank_accounts: [saved('5123 4567 0001'), saved('998877665544')],
        bank_share_verified: {
          [saved('5123 4567 0001').id]: '2026-11-03T00:00:00.000Z',
        },
        avatar_url: 'kept',
      });
      // A stranger on another number and name: never touched.
      await put('cus_stranger', {
        bank_accounts: [saved('111122223333', STRANGER)],
      });
      await payout('cus_twin', `0${NUMBER}`);
      await payout('cus_twin', NUMBER, 'failed');
      await payout('cus_twin', '998877665544');
      await payout('cus_stranger', '111122223333', 'settled', STRANGER);
      await payout('cus_player', NUMBER);
    });

    it('takes it off the twin: saved entry, its stamp, every payout row to it', async () => {
      expect(
        (await service.payoutAccountsOf('cus_twin')).map((k) => k.account_key),
      ).toEqual([NUMBER, '998877665544']);
      expect(await service.holderNameHeldByAnother('cus_player', NAME)).toBe(
        true,
      );

      await expect(
        service.freePayoutAccount({
          customerId: 'cus_player',
          adminId: 'user_1',
          accountKey: NUMBER,
          fromIds: ['cus_twin'],
          reason: 'owner approved',
        }),
      ).resolves.toEqual({
        from: [{ customer_id: 'cus_twin', saved: 1, payouts: 2 }],
      });

      expect(await rows()).toEqual([
        'cus_twin 0001 ',
        'cus_twin 0001 ',
        `cus_twin 998877665544 ${NAME}`,
        `cus_stranger 111122223333 ${STRANGER}`,
        `cus_player ${NUMBER} ${NAME}`,
      ]);
      expect(await metadataOf('cus_twin')).toEqual({
        bank_accounts: [saved('998877665544')],
        avatar_url: 'kept',
      });
      expect(
        await service.otherPayoutAccountHolders('cus_player', NUMBER),
      ).toEqual([]);
      // The twin still holds the name on the bank it kept: clear_name_clash.
      expect(await service.holderNameHolders('cus_player', NAME)).toEqual([
        'cus_twin',
      ]);
      const audits = await service.listAdminActionAudits({});
      expect(audits.map((a) => a.entity_id).sort()).toEqual([
        'cus_player',
        'cus_twin',
      ]);
      expect(JSON.stringify(audits)).not.toContain(NUMBER);
    });

    it('frees the name too when the number was its only use', async () => {
      await em().execute(
        `update customer set metadata = '{}'::jsonb where id = 'cus_twin'`,
      );
      await em().execute(
        `delete from gateway_withdrawal where customer_id = 'cus_twin' and account_number = '998877665544'`,
      );
      await service.freePayoutAccount({
        customerId: 'cus_player',
        adminId: 'user_1',
        accountKey: NUMBER,
        fromIds: ['cus_twin'],
        reason: 'owner approved',
      });
      expect(await service.holderNameHeldByAnother('cus_player', NAME)).toBe(
        false,
      );
    });

    it('changes nothing when refused: an unlisted holder, a payout on its way', async () => {
      const before = await rows();
      await expect(
        service.freePayoutAccount({
          customerId: 'cus_stranger',
          adminId: 'user_1',
          accountKey: NUMBER,
          fromIds: ['cus_twin'],
          reason: 'x',
        }),
      ).rejects.toThrow(/now holds …0001 too/);
      await payout('cus_twin', NUMBER, 'pending');
      await expect(
        service.freePayoutAccount({
          customerId: 'cus_player',
          adminId: 'user_1',
          accountKey: NUMBER,
          fromIds: ['cus_twin'],
          reason: 'x',
        }),
      ).rejects.toThrow(/still on its way/);
      expect((await rows()).slice(0, before.length)).toEqual(before);
      expect((await metadataOf('cus_twin')).bank_accounts).toHaveLength(2);
      expect(await service.listAdminActionAudits({})).toEqual([]);
    });

    it('rolls every write back when the re-check fails', async () => {
      const before = await rows();
      // On the class: the container hands out a wrapped service.
      const proto = PacksModuleService.prototype;
      const real = proto.otherPayoutAccountHolders;
      let calls = 0;
      const spy = jest
        .spyOn(proto, 'otherPayoutAccountHolders')
        .mockImplementation(function (this: PacksModuleService, ...args) {
          // The second look still sees a holder: a racer saved it meanwhile.
          return ++calls === 2
            ? Promise.resolve([
                {
                  customer_id: 'cus_twin',
                  bank_code: 'MBBEMYKL',
                  holder_name: null,
                },
              ])
            : real.apply(this, args);
        });
      await expect(
        service.freePayoutAccount({
          customerId: 'cus_player',
          adminId: 'user_1',
          accountKey: NUMBER,
          fromIds: ['cus_twin'],
          reason: 'x',
        }),
      ).rejects.toThrow(/still held by another account/);
      spy.mockRestore();
      expect(await rows()).toEqual(before);
      expect((await metadataOf('cus_twin')).bank_accounts).toHaveLength(2);
      expect(await service.listAdminActionAudits({})).toEqual([]);
    });
  },
});
