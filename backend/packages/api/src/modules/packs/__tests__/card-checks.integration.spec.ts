/**
 * The assistant cards' "done since" check against a REAL Postgres —
 * integration:modules
 *
 * A tap on an unban-number or free-number card is refused when its change was
 * audited on the player after the card was made: its own first tap, or a
 * colleague doing or undoing it (security audit 2026-11-09). This proves the
 * two follow-ups: the audit names the exact number by a fingerprint, so two
 * numbers sharing their last 4 no longer refuse each other's cards (#1007),
 * and the check runs inside the write's transaction under the player's lock,
 * so a colleague's change that lands while a tap waits is seen (#1009).
 */

import path from 'path';
import { moduleIntegrationTestRunner } from '@medusajs/test-utils';
import { PACKS_MODULE } from '../index';
import PacksModuleService from '../service';
import GatewayWithdrawal from '../models/gateway-withdrawal';
import AdminActionAudit from '../models/admin-action-audit';
import { liftedPayoutBans, savedBankAccountId } from '../saved-accounts';
import { numberMarkWith } from '../../../utils/number-mark';

jest.setTimeout(300 * 1000);

// Made-up details only (the repo is public): two numbers ending 1234.
const MAYBANK = '512345671234';
const PUBLIC_BANK = '887766551234';
const OTHER_MAYBANK = '998877661234';
const SINCE_REFUSAL = /since it was proposed/;
const saved = (bankCode: string, accountNumber: string) => ({
  id: savedBankAccountId(bankCode, accountNumber),
  bankCode,
  bankName: bankCode,
  accountNumber,
  accountHolderName: 'TAN AH KOW',
  savedAt: '2026-01-01T00:00:00.000Z',
});

moduleIntegrationTestRunner<PacksModuleService>({
  moduleName: PACKS_MODULE,
  resolve: path.resolve(__dirname, '../../..', 'modules/packs'),
  moduleModels: [GatewayWithdrawal, AdminActionAudit],
  testSuite: ({ service, MikroOrmWrapper }) => {
    const em = () => MikroOrmWrapper.forkManager();
    // The card was made a minute ago.
    let since = '';
    const metadataOf = async (id: string) =>
      (
        await em().execute<{ metadata: Record<string, unknown> }[]>(
          'select metadata from customer where id = ?',
          [id],
        )
      )[0].metadata;
    const audits = () =>
      em().execute<{ entity_id: string; after: Record<string, unknown> }[]>(
        'select entity_id, after from admin_action_audit order by created_at',
      );

    beforeEach(async () => {
      since = new Date(Date.now() - 60_000).toISOString();
      // Raw SQL tables (ADR 0015, Migration20261103230000).
      await em().execute(
        'create table if not exists "customer" ("id" text primary key, "metadata" jsonb, "updated_at" timestamptz null, "deleted_at" timestamptz null)',
      );
      await em().execute(
        'create table if not exists "banned_payout_account" ("account_key" text not null primary key, "bank_code" text null, "reason" text null, "created_at" timestamptz not null default now())',
      );
      await em().execute('delete from "customer"');
      await em().execute('delete from "banned_payout_account"');
      await em().execute('delete from "admin_action_audit"');
      await em().execute('delete from "gateway_withdrawal"');
      const put = (id: string, metadata: Record<string, unknown>) =>
        em().execute(
          'insert into "customer" ("id", "metadata") values (?, ?::jsonb)',
          [id, JSON.stringify(metadata)],
        );
      // The player holds two banned numbers ending 1234.
      await put('cus_player', {
        bank_accounts: [
          saved('MBBEMYKL', MAYBANK),
          saved('PBBEMYKL', PUBLIC_BANK),
        ],
      });
      for (const [key, bank] of [
        [MAYBANK, 'MBBEMYKL'],
        [PUBLIC_BANK, 'PBBEMYKL'],
      ]) {
        await em().execute(
          'insert into "banned_payout_account" ("account_key", "bank_code") values (?, ?)',
          [key, bank],
        );
      }
      // Two other accounts, each on its own Maybank number ending 1234.
      await put('cus_twin', { bank_accounts: [saved('MBBEMYKL', MAYBANK)] });
      await put('cus_other', {
        bank_accounts: [saved('MBBEMYKL', OTHER_MAYBANK)],
      });
    });

    const lift = (bankCode: string) =>
      service.setPayoutBanLifted({
        customerId: 'cus_player',
        adminId: 'user_1',
        last4: '1234',
        bankCode,
        lifted: true,
        reason: 'owner approved',
        since,
      });
    const free = (accountKey: string, from: string) =>
      service.freePayoutAccount({
        customerId: 'cus_player',
        adminId: 'user_1',
        accountKey,
        bankCode: 'MBBEMYKL',
        fromIds: [from],
        reason: 'owner approved',
        since,
      });

    it('an unban card is not refused by a lift of another number with the same last 4; a replay is (#1007)', async () => {
      await expect(lift('MBBEMYKL')).resolves.toMatchObject({ changed: true });
      await expect(lift('PBBEMYKL')).resolves.toMatchObject({ changed: true });
      await expect(lift('MBBEMYKL')).rejects.toThrow(SINCE_REFUSAL);
      expect(Object.keys(liftedPayoutBans(await metadataOf('cus_player'))).sort()).toEqual(
        [MAYBANK, PUBLIC_BANK].sort(),
      );
      // The rows name each number by its fingerprint, never in full.
      const rows = await audits();
      expect(rows.map((r) => r.after.number_mark)).toEqual([
        numberMarkWith(process.env.JWT_SECRET || 'supersecret', MAYBANK),
        numberMarkWith(process.env.JWT_SECRET || 'supersecret', PUBLIC_BANK),
      ]);
      expect(JSON.stringify(rows)).not.toMatch(/5123456|8877665/);
    });

    it('a free card is not refused by a free of another number with the same last 4; a replay is (#1007)', async () => {
      await expect(free(MAYBANK, 'cus_twin')).resolves.toBeTruthy();
      await expect(free(OTHER_MAYBANK, 'cus_other')).resolves.toBeTruthy();
      // Refused for the audit, before "nothing to free".
      await expect(free(MAYBANK, 'cus_twin')).rejects.toThrow(SINCE_REFUSAL);
    });

    it('an audit row from before fingerprints still refuses by the last 4', async () => {
      await service.createAdminActionAudits([
        {
          admin_id: 'user_2',
          entity_type: 'customer',
          entity_id: 'cus_player',
          action: 'edit',
          before: {},
          after: {
            banned_number: { bank_code: 'MBBEMYKL', last4: '1234' },
            lifted_for_player: false,
          },
          reason: 'colleague',
        },
      ]);
      await expect(lift('PBBEMYKL')).rejects.toThrow(SINCE_REFUSAL);
      // Without a card's time (the player page), no check.
      await expect(
        service.setPayoutBanLifted({
          customerId: 'cus_player',
          adminId: 'user_1',
          last4: '1234',
          bankCode: 'PBBEMYKL',
          lifted: true,
          reason: 'from the player page',
        }),
      ).resolves.toMatchObject({ changed: true });
    });

    it("a colleague's re-ban that lands while the tap waits refuses the tap (#1009)", async () => {
      // The colleague holds the player's lock, as their write does.
      const colleague = await em().getKnex().transaction();
      await colleague.raw('select pg_advisory_xact_lock(hashtextextended(?, 0))', [
        'metadata:cus_player',
      ]);
      let settled = false;
      const tap = lift('MBBEMYKL').finally(() => {
        settled = true;
      });
      tap.catch(() => undefined);
      await new Promise((r) => setTimeout(r, 500));
      expect(settled).toBe(false);
      await colleague.raw(
        "insert into admin_action_audit (id, admin_id, entity_type, entity_id, action, after, reason, created_at, updated_at) values ('aud_colleague', 'user_2', 'customer', 'cus_player', 'edit', ?::jsonb, 'banned again', now(), now())",
        [
          JSON.stringify({
            banned_number: { bank_code: 'MBBEMYKL', last4: '1234' },
            lifted_for_player: false,
            number_mark: numberMarkWith(
              process.env.JWT_SECRET || 'supersecret',
              MAYBANK,
            ),
          }),
        ],
      );
      await colleague.commit();
      await expect(tap).rejects.toThrow(SINCE_REFUSAL);
      expect(liftedPayoutBans(await metadataOf('cus_player'))).toEqual({});
      // The other number is a different change: its card still goes through.
      await expect(lift('PBBEMYKL')).resolves.toMatchObject({ changed: true });
    });
  },
});
