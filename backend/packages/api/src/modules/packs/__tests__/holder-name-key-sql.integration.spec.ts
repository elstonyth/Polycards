/**
 * holderNameKeySql against a REAL Postgres — integration:modules
 *
 * holderNameHolders keys the stored holder names in SQL and the typed one in JS
 * (holderNameKey). The two must agree, or a name saved with an accent, a symbol
 * or small capitals on one account stops matching the plain name on another.
 * This runs the SQL on every code point and on whole names, and checks that
 * both halves of the lookup (saved lists, payouts) use it.
 */

import path from 'path';
import { moduleIntegrationTestRunner } from '@medusajs/test-utils';
import { PACKS_MODULE } from '../index';
import PacksModuleService, { holderNameKeySql } from '../service';
import GatewayWithdrawal from '../models/gateway-withdrawal';
import { holderNameKey, savedBankAccountId } from '../saved-accounts';

jest.setTimeout(300 * 1000);

// Made-up names only (the repo is public).
const NAMES = [
  'TAN AH KOW',
  'TAN AH KOW&',
  'TAN AH KÓW',
  'TAN AH KÓW',
  'ᴛᴀɴ ᴀʜ ᴋᴏᴡ',
  'ＴＡＮ ＡＨ ＫＯＷ',
  '𝐓𝐀𝐍 AH KOW',
  'Tan Ah Kow 2',
  'Ta​n',
  'ﬁona',
  'Strauß',
  'STRAUẞ',
  'Æsir',
  'Søren Ø',
  'İbrahim',
  'Işık',
  'ǿ ǽ',
  'Đặng Văn Đức',
  'ðÐ ħĦ ŧŦ',
  'Łukasz',
  'Þór',
  'Œuvre',
  'ɑnn',
  'KKelvin',
  'ſam',
  'Ahmad b. Ali @ Abu',
  '陈大文',
  '1234',
  '🙂',
  '',
];

moduleIntegrationTestRunner<PacksModuleService>({
  moduleName: PACKS_MODULE,
  resolve: path.resolve(__dirname, '../../..', 'modules/packs'),
  moduleModels: [GatewayWithdrawal],
  testSuite: ({ service, MikroOrmWrapper }) => {
    const em = () => MikroOrmWrapper.forkManager();

    it('keys whole names as holderNameKey does', async () => {
      const rows = await em().execute<{ k: string }[]>(
        `select ${holderNameKeySql('t.v')} as k from jsonb_array_elements_text(?::jsonb) with ordinality t(v, n) order by t.n`,
        [JSON.stringify(NAMES)],
      );
      expect(rows.map((r) => r.k)).toEqual(NAMES.map(holderNameKey));
    });

    it('keys every code point as holderNameKey does', async () => {
      const rows = await em().execute<{ i: number; k: string; d: boolean }[]>(
        `select i, k, d from (select i, ${holderNameKeySql('chr(i)')} as k, normalize(chr(i), NFKD) <> chr(i) as d from generate_series(1, 1114111) i where i not between 55296 and 57343) s where k <> '' or d`,
      );
      const sql = new Map(rows.map((r) => [Number(r.i), r.k]));
      const decomposes = new Set(
        rows.filter((r) => r.d).map((r) => Number(r.i)),
      );
      const mismatches: string[] = [];
      for (let i = 1; i <= 0x10ffff; i++) {
        if (i >= 0xd800 && i <= 0xdfff) continue;
        const c = String.fromCodePoint(i);
        // Postgres's Unicode tables can be older than Node's: a letter added
        // since has no decomposition there yet. normalizeHolderName (NFKC, in
        // JS) folds it before a name is stored, so only our folds are compared.
        if (c.normalize('NFKD') !== c && !decomposes.has(i)) continue;
        const js = holderNameKey(c);
        if ((sql.get(i) ?? '') !== js) {
          mismatches.push(
            `U+${i.toString(16)} sql=${sql.get(i) ?? ''} js=${js}`,
          );
        }
      }
      expect(mismatches).toEqual([]);
    });

    it('finds a decorated name saved or paid on another account', async () => {
      await em().execute(
        'create table if not exists "customer" ("id" text primary key, "metadata" jsonb, "updated_at" timestamptz null, "deleted_at" timestamptz null)',
      );
      await em().execute('delete from "customer"');
      const put = (id: string, holder: string) =>
        em().execute(
          'insert into "customer" ("id", "metadata") values (?, ?::jsonb)',
          [
            id,
            JSON.stringify({
              bank_accounts: [
                {
                  id: savedBankAccountId('MBBEMYKL', '512345670001'),
                  bankCode: 'MBBEMYKL',
                  bankName: 'Maybank',
                  accountNumber: '512345670001',
                  accountHolderName: holder,
                },
              ],
            }),
          ],
        );
      await put('cus_player', 'TAN AH KOW');
      await put('cus_saved', 'TAN AH KÓW&');
      await put('cus_stranger', 'LIM AH LIAN');
      // Saved before names with no English letter were refused.
      await put('cus_legacy', '陈大文');
      const paid = (customer_id: string, status: 'settled' | 'failed') =>
        service.createGatewayWithdrawals([
          {
            merchant_transaction_id: `PW-KEY-${customer_id}`,
            customer_id,
            amount: 100,
            bank_code: 'MBBEMYKL',
            account_number: '998877665544',
            account_holder_name: 'ᴛᴀɴ ᴀʜ ᴋᴏᴡ 2',
            gateway: 'fake',
            status,
          },
        ]);
      await paid('cus_paid', 'settled');
      await paid('cus_failed', 'failed');

      expect(
        (await service.holderNameHolders('cus_player', 'TAN AH KOW')).sort(),
      ).toEqual(['cus_paid', 'cus_saved']);
      expect(
        await service.holderNameHeldByAnother('cus_player', 'Tan Ah Kow'),
      ).toBe(true);
      // No English letter: compared by its old key, so a legacy holder of the
      // same name is still found, and not every blank or non-Latin row.
      expect(await service.holderNameHolders('cus_player', '陈大文')).toEqual([
        'cus_legacy',
      ]);
      expect(await service.holderNameHolders('cus_player', '李小龙')).toEqual(
        [],
      );
    });
  },
});
