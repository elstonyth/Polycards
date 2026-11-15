/**
 * Player eligibility — integration:modules
 *
 * The SQL twins in eligibility.ts and the JS readers they mirror must agree on
 * a real Postgres: who is disabled, which group is a player's effective group,
 * who has topped up, and why a game turns a player away. Every fixture time is
 * pinned.
 */
import path from 'path';
import { moduleIntegrationTestRunner } from '@medusajs/test-utils';
import type { Context } from '@medusajs/framework/types';
import { PACKS_MODULE } from '../index';
import type PacksModuleService from '../service';
import { CORE_CUSTOMER_MODELS } from '../test-support/core-customer-models';
import CreditTransaction from '../models/credit-transaction';
import CustomerAccountState from '../models/customer-account-state';
import {
  disabledAccountSql,
  mayPlay,
  playRefusal,
  realGroupMemberSql,
} from '../eligibility';
import { EFFECTIVE_GROUP_SQL, effectivePlayerGroup } from '../odds-sets';
import { groupPolicyOf } from '../group-policy';
import { realCustomerSql } from '../real-customers';

jest.setTimeout(300 * 1000);

type Row = { id: string };
type GroupRow = {
  customer_id: string;
  id: string;
  name: string;
  metadata: Record<string, unknown> | null;
  created_at: Date;
};

const T0 = '2026-01-01T00:00:00.000100Z';
const T1 = '2026-02-01T00:00:00.000100Z';

// [id, name, metadata, created_at, deleted_at]
const GROUPS: [string, string, Record<string, unknown>, string, string | null][] = [
  ['grp_default', 'DEFAULT', {}, '2025-12-01T00:00:00.000100Z', null],
  ['grp_flagged', 'Starter', { is_default: true }, T0, null],
  ['grp_strflag', 'String Flag', { is_default: 'true' }, T0, null],
  ['grp_old', 'Older', { odds_set: 2 }, T0, null],
  ['grp_new', 'Newer', { odds_set: 3 }, T1, null],
  ['grp_eq_a', 'Equal A', {}, T1, null],
  ['grp_eq_b', 'Equal B', {}, T1, null],
  // The same millisecond: the later id comes first by microsecond.
  ['grp_us_b', 'Micro B', {}, '2026-02-01T00:00:00.123100Z', null],
  ['grp_us_a', 'Micro A', {}, '2026-02-01T00:00:00.123400Z', null],
  // Equal times: by locale 'a' < 'B', by code point 'B' < 'a'.
  ['grp_cs_B', 'Case B', {}, T1, null],
  ['grp_cs_a', 'Case A', {}, T1, null],
  ['grp_gone', 'Gone', {}, '2025-11-01T00:00:00.000100Z', '2026-03-01T00:00:00.000100Z'],
  ['grp_blocked', 'Partner', { partner_rate_bp: 100, withdrawals_blocked: true }, T0, null],
  ['grp_rebate', 'Rebate', { partner_rate_bp: 300, withdrawals_blocked: false }, T0, null],
];

// [customer, group, membership deleted_at]
const MEMBERS: [string, string, string | null][] = [
  ['c_default', 'grp_default', null],
  ['c_flagged', 'grp_flagged', null],
  ['c_strflag', 'grp_strflag', null],
  ['c_two', 'grp_new', null],
  ['c_two', 'grp_old', null],
  ['c_eq', 'grp_eq_b', null],
  ['c_eq', 'grp_eq_a', null],
  ['c_us', 'grp_us_b', null],
  ['c_us', 'grp_us_a', null],
  ['c_cs', 'grp_cs_a', null],
  ['c_cs', 'grp_cs_B', null],
  ['c_gone_group', 'grp_gone', null],
  ['c_gone_member', 'grp_new', '2026-03-01T00:00:00.000100Z'],
  ['c_partner', 'grp_blocked', null],
  ['c_rebate', 'grp_rebate', null],
  ['c_default_plus', 'grp_default', null],
  ['c_default_plus', 'grp_new', null],
  ['c_frozen_manual', 'grp_rebate', null],
];

const CUSTOMERS = [
  'c_none',
  ...new Set(MEMBERS.map(([c]) => c)),
  'c_disabled',
  'c_soft_disabled',
  'c_frozen_auto',
  'c_topup',
  'c_played',
  'c_negative',
  'c_subsen',
];

moduleIntegrationTestRunner<PacksModuleService>({
  moduleName: PACKS_MODULE,
  resolve: path.resolve(__dirname, '../../..', 'modules/packs'),
  moduleModels: [...CORE_CUSTOMER_MODELS, CreditTransaction, CustomerAccountState],
  testSuite: ({ service, MikroOrmWrapper }) => {
    const em = () => MikroOrmWrapper.forkManager();
    const ids = (rows: Row[]) => rows.map((r) => r.id).sort();

    const seed = async () => {
      const m = em();
      for (const id of CUSTOMERS) {
        await m.execute(
          'INSERT INTO customer (id, has_account, created_at, updated_at) VALUES (?, false, ?, ?)',
          [id, T0, T0],
        );
      }
      for (const [id, name, metadata, at, deleted] of GROUPS) {
        await m.execute(
          'INSERT INTO customer_group (id, name, metadata, created_at, updated_at, deleted_at) ' +
            'VALUES (?, ?, CAST(? AS jsonb), ?, ?, ?)',
          [id, name, JSON.stringify(metadata), at, at, deleted],
        );
      }
      for (const [i, [customer, group, deleted]] of MEMBERS.entries()) {
        await m.execute(
          'INSERT INTO customer_group_customer (id, customer_id, customer_group_id, created_at, updated_at, deleted_at) ' +
            'VALUES (?, ?, ?, ?, ?, ?)',
          [`cgc_${i}`, customer, group, T1, T1, deleted],
        );
      }
      await service.createCustomerAccountStates([
        { customer_id: 'c_disabled', disabled: true },
        { customer_id: 'c_soft_disabled', disabled: true },
        { customer_id: 'c_frozen_manual', frozen: true, cause: 'manual' },
        { customer_id: 'c_frozen_auto', frozen: true, cause: 'auto' },
      ]);
      const [soft] = await service.listCustomerAccountStates({ customer_id: 'c_soft_disabled' });
      await service.softDeleteCustomerAccountStates([soft.id]);
      await service.createCreditTransactions([
        { customer_id: 'c_topup', amount: 10, reason: 'topup', external_funded_cents: 1000 },
        { customer_id: 'c_played', amount: 10, reason: 'topup', external_funded_cents: 1000 },
        { customer_id: 'c_played', amount: -10, reason: 'pack_open', external_funded_cents: -1000 },
        { customer_id: 'c_negative', amount: -5, reason: 'topup' },
        // Under half a sen: rounds to 0, so neither hasTopUp nor the wallet counts it.
        { customer_id: 'c_subsen', amount: 0.004, reason: 'topup' },
      ]);
    };

    // What every JS reader is handed: a customer's live memberships in live groups.
    const memberships = async (): Promise<Map<string, GroupRow[]>> => {
      const rows = await em().execute<GroupRow[]>(
        'SELECT cgc.customer_id, cg.id, cg.name, cg.metadata, cg.created_at ' +
          'FROM customer_group_customer cgc ' +
          'JOIN customer_group cg ON cg.id = cgc.customer_group_id AND cg.deleted_at IS NULL ' +
          'WHERE cgc.deleted_at IS NULL',
      );
      const out = new Map<string, GroupRow[]>();
      for (const r of rows) out.set(r.customer_id, [...(out.get(r.customer_id) ?? []), r]);
      return out;
    };
    const jsGroup = (all: Map<string, GroupRow[]>, id: string) =>
      effectivePlayerGroup(all.get(id) ?? []);

    it('disabledAccountSql = disabledCustomerIds = isAccountDisabled', async () => {
      await seed();
      const sql = ids(
        await em().execute<Row[]>(
          `SELECT c.id FROM customer c WHERE ${disabledAccountSql('c.id')}`,
        ),
      );
      expect(sql).toEqual(['c_disabled']);
      expect([...(await service.disabledCustomerIds(CUSTOMERS))].sort()).toEqual(sql);
      const one: string[] = [];
      for (const id of CUSTOMERS) if (await service.isAccountDisabled(id)) one.push(id);
      expect(one.sort()).toEqual(sql);
    });

    it('EFFECTIVE_GROUP_SQL = effectivePlayerGroup = partnerGroupOfCustomers = realGroupMemberSql = NOT realCustomerSql', async () => {
      await seed();
      const sql = new Map(
        (
          await em().execute<{ customer_id: string; group_id: string }[]>(EFFECTIVE_GROUP_SQL)
        ).map((r) => [r.customer_id, r.group_id]),
      );
      // Not vacuous: each fixture lands where the rule says.
      expect(Object.fromEntries([...sql].sort())).toEqual({
        c_cs: 'grp_cs_B', // id by code point, not by locale
        c_default_plus: 'grp_new', // DEFAULT plus a real group follows the real group
        c_eq: 'grp_eq_a', // equal created_at: id breaks the tie
        c_us: 'grp_us_a', // created_at to the millisecond, as JS reads it
        c_frozen_manual: 'grp_rebate',
        c_partner: 'grp_blocked',
        c_rebate: 'grp_rebate',
        c_strflag: 'grp_strflag', // is_default "true" as a string is a real group
        c_two: 'grp_old', // oldest real group wins
      });

      const all = await memberships();
      for (const id of CUSTOMERS) {
        expect([id, jsGroup(all, id)?.id ?? null]).toEqual([id, sql.get(id) ?? null]);
      }

      const partners = await service.partnerGroupOfCustomers(CUSTOMERS);
      const expectedPartners = new Map<string, { name: string; rate_bp: number }>();
      for (const id of CUSTOMERS) {
        const g = jsGroup(all, id);
        const rate = g ? groupPolicyOf(g).partner_rate_bp : null;
        if (g && rate !== null) expectedPartners.set(id, { name: g.name, rate_bp: rate });
      }
      expect(Object.fromEntries(partners)).toEqual(Object.fromEntries(expectedPartners));
      expect([...partners.keys()].sort()).toEqual(['c_frozen_manual', 'c_partner', 'c_rebate']);

      const members = ids(
        await em().execute<Row[]>(`SELECT c.id FROM customer c WHERE ${realGroupMemberSql('c.id')}`),
      );
      expect(members).toEqual([...sql.keys()].sort());
      const notReal = ids(
        await em().execute<Row[]>(`SELECT c.id FROM customer c WHERE NOT (${realCustomerSql('c.id')})`),
      );
      expect(notReal).toEqual(members);
    });

    it('hasTopUp = walletSummary.hasTopup', async () => {
      await seed();
      const topped: string[] = [];
      for (const id of CUSTOMERS) {
        const exists = await service.hasTopUp(id);
        expect([id, exists]).toEqual([id, (await service.walletSummary(id)).hasTopup]);
        if (exists) topped.push(id);
      }
      expect(topped.sort()).toEqual(['c_played', 'c_topup']);
    });

    it('mayPlay = playRefusal over the JS facts', async () => {
      await seed();
      const all = await memberships();
      const ctx = (): Context => ({ manager: em() }) as unknown as Context;
      const seen: Record<string, [string | null, string | null]> = {};
      for (const id of CUSTOMERS) {
        const wallet = await service.walletSummary(id);
        const g = jsGroup(all, id);
        const coin = {
          disabled: await service.isAccountDisabled(id),
          frozen: wallet.isFrozen,
          hasTopup: wallet.hasTopup,
          playthroughRemaining: wallet.playthrough.remaining,
          group: g ? groupPolicyOf(g) : null,
        };
        // Lucky Draw keeps hasTopUp; Coin Flip keeps the wallet's topup sum.
        const lucky = { ...coin, hasTopup: await service.hasTopUp(id) };
        const got: [string | null, string | null] = [
          await mayPlay(service, id, 'coin_flip', ctx()),
          await mayPlay(service, id, 'lucky_draw', ctx()),
        ];
        expect([id, ...got]).toEqual([id, playRefusal('coin_flip', coin), playRefusal('lucky_draw', lucky)]);
        expect([id, await service.mayPlay(id, 'coin_flip'), await service.mayPlay(id, 'lucky_draw')]).toEqual([id, ...got]);
        seen[id] = got;
      }
      expect(seen).toMatchObject({
        c_none: ['no_topup', 'no_topup'],
        c_default: ['no_topup', 'no_topup'],
        c_flagged: ['no_topup', 'no_topup'], // a renamed DEFAULT is still DEFAULT
        c_strflag: [null, null],
        c_gone_group: ['no_topup', 'no_topup'],
        c_gone_member: ['no_topup', 'no_topup'],
        c_partner: [null, null],
        c_rebate: [null, null],
        c_disabled: ['unavailable', 'unavailable'],
        c_soft_disabled: ['no_topup', 'no_topup'],
        c_frozen_manual: ['frozen', null], // the play gate reads no freeze for Lucky Draw
        c_frozen_auto: ['frozen', 'no_topup'],
        c_topup: ['playthrough', null],
        c_played: [null, null],
        c_negative: ['no_topup', 'no_topup'],
        c_subsen: ['no_topup', 'no_topup'],
      });
    });
  },
});
