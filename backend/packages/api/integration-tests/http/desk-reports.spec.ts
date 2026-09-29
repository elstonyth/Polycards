import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils';
import type { ICustomerModuleService } from '@medusajs/framework/types';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { ensureDefaultPlayerGroup } from '../../src/modules/packs/player-groups';
import { mintSuperAdmin, unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

// Desk reports (spec 2026-09-29-desk-reports-design.md): the key-guarded
// /reports/finance/* routes, over directly seeded rows so every number is
// predictable. The guard reads the key per request, so setting it here is
// enough.
const FINANCE_KEY = 'f'.repeat(48);
const STORE_KEY = 's'.repeat(48);
process.env.REPORT_KEY_FINANCE = FINANCE_KEY;
process.env.REPORT_KEY_STORE = STORE_KEY;

type Pg = {
  raw: (
    sql: string,
    bindings?: unknown[],
  ) => Promise<{ rowCount: number; rows: unknown[] }>;
};

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    const packs = () =>
      getContainer().resolve<PacksModuleService>(PACKS_MODULE);
    const customers = () =>
      getContainer().resolve<ICustomerModuleService>(Modules.CUSTOMER);
    const pg = () =>
      getContainer().resolve(
        ContainerRegistrationKeys.PG_CONNECTION,
      ) as unknown as Pg;
    const report = (path: string, key: string | null = FINANCE_KEY) =>
      unwrapResponse(
        api.get(`/reports/finance/${path}`, {
          headers: key ? { 'x-report-key': key } : {},
        }),
      );
    // created_at is ORM-managed on insert, so rows are backdated afterwards.
    const backdate = async (table: string, id: string, iso: string) => {
      const res = await pg().raw(
        `UPDATE ${table} SET created_at = ? WHERE id = ?`,
        [iso, id],
      );
      expect(res.rowCount).toBe(1);
    };
    const opens = (rows: Array<[string, number]>) =>
      packs().createCreditTransactions(
        rows.map(([customer_id, amount]) => ({
          customer_id,
          amount: -amount,
          reason: 'pack_open' as const,
        })),
      );

    // Nine players whose effective groups differ in every way the SQL rule
    // and effectivePlayerGroup could disagree about. Each opens packs for a
    // distinct power of two, so any sum names exactly who is in it:
    //   DEFAULT = nogroup 1 + defonly 2 + renamed 16 + left 32 + deadgroup 64 = 115
    //   Partners = partner 4 + both 8 + pw 128 = 140;  Whales = whale 256
    async function seedGroups() {
      const c = customers();
      const group = (name: string, metadata?: Record<string, unknown>) =>
        c.createCustomerGroups({ name, metadata });
      const def = await ensureDefaultPlayerGroup(getContainer());
      const partners = await group('Partners');
      const whales = await group('Whales');
      const house = await group('House', { is_default: true }); // a renamed default
      const oldVip = await group('Old VIP');
      // Partners is OLDER than Whales, so a player in both is in Partners.
      await pg().raw('UPDATE customer_group SET created_at = ? WHERE id = ?', [
        '2026-01-01T00:00:00.000Z',
        partners.id,
      ]);
      await pg().raw('UPDATE customer_group SET created_at = ? WHERE id = ?', [
        '2026-02-01T00:00:00.000Z',
        whales.id,
      ]);
      const ids: Record<string, string> = {};
      for (const name of [
        'nogroup',
        'defonly',
        'partner',
        'both',
        'renamed',
        'left',
        'deadgroup',
        'pw',
        'whale',
      ]) {
        ids[name] = (
          await c.createCustomers({ email: `dr-${name}@test.dev` })
        ).id;
      }
      const join = (who: string, g: { id: string }) =>
        c.addCustomerToGroup({
          customer_id: ids[who],
          customer_group_id: g.id,
        });
      await join('defonly', def);
      await join('partner', partners);
      await join('both', def);
      await join('both', partners);
      await join('renamed', house);
      await join('left', partners);
      await join('deadgroup', oldVip);
      await join('pw', whales);
      await join('pw', partners);
      await join('whale', whales);
      // A removed membership and a deleted group: both players are DEFAULT again.
      await pg().raw(
        'UPDATE customer_group_customer SET deleted_at = now() WHERE customer_id = ?',
        [ids.left],
      );
      await pg().raw(
        'UPDATE customer_group SET deleted_at = now() WHERE id = ?',
        [oldVip.id],
      );
      await opens([
        [ids.nogroup, 1],
        [ids.defonly, 2],
        [ids.partner, 4],
        [ids.both, 8],
        [ids.renamed, 16],
        [ids.left, 32],
        [ids.deadgroup, 64],
        [ids.pw, 128],
        [ids.whale, 256],
      ]);
      return ids;
    }

    describe('the /reports/finance key', () => {
      it('answers 401 without a key and for another desk key', async () => {
        expect((await report('economy', null)).status).toBe(401);
        expect((await report('economy', STORE_KEY)).status).toBe(401);
      });

      it('answers 503 while the finance key is unset', async () => {
        delete process.env.REPORT_KEY_FINANCE;
        try {
          expect((await report('economy')).status).toBe(503);
        } finally {
          process.env.REPORT_KEY_FINANCE = FINANCE_KEY;
        }
      });
    });

    describe('GET /reports/finance/economy', () => {
      it("scopes by each player's effective group", async () => {
        await seedGroups();
        const revenue = async (group: string) => {
          const res = await report(
            `economy?group=${encodeURIComponent(group)}`,
          );
          expect(res.status).toBe(200);
          return res.data.totals.revenue as number;
        };
        expect(await revenue('all')).toBe(511);
        // no group, DEFAULT only, renamed default, removed membership, deleted group
        expect(await revenue('default')).toBe(115);
        expect(await revenue('House')).toBe(115);
        // Partners only, DEFAULT + Partners, Whales + Partners (Partners is older)
        expect(await revenue('partners')).toBe(140);
        expect(await revenue('Whales')).toBe(256);
        const res = await report('economy?group=default');
        expect(res.data.scope.group).toBe('DEFAULT');
        expect(res.data.currency).toBe('MYR');
        expect(res.data.liability_now_all_players).toEqual({
          vault_cards: 0,
          vault_value: 0,
          outstanding_vouchers: 0,
        });
      });

      it('default plus every named group adds up to all (the partition invariant)', async () => {
        await seedGroups();
        const totals = async (group: string) =>
          (await report(`economy?group=${group}`)).data.totals as Record<
            string,
            number
          >;
        const all = await totals('all');
        const parts = [
          await totals('default'),
          await totals('Partners'),
          await totals('Whales'),
        ];
        for (const field of Object.keys(all)) {
          const sum = parts.reduce((s, t) => s + Math.round(t[field] * 100), 0);
          expect(sum / 100).toBe(all[field]);
        }
      });

      it('rejects an unknown or deleted group, listing the real ones', async () => {
        await seedGroups();
        const res = await report('economy?group=Old%20VIP');
        expect(res.status).toBe(400);
        const listed = res.data.message.split('one of:')[1];
        expect(listed).toContain('Partners');
        expect(listed).not.toContain('Old VIP');
      });

      it('rejects a malformed window instead of reporting all time', async () => {
        expect((await report('economy?from=yesterday')).status).toBe(400);
      });

      it('group=all matches /admin/economy exactly, all-time and windowed', async () => {
        const token = await mintSuperAdmin(
          getContainer(),
          api,
          'desk-reports-admin@test.dev',
          'desk-reports-password-1', // gitleaks:allow
        );
        const rows = await packs().createCreditTransactions([
          { customer_id: 'cus_lock', amount: 100, reason: 'topup' as const },
          {
            customer_id: 'cus_lock',
            amount: -25,
            reason: 'pack_open' as const,
          },
          {
            customer_id: 'cus_lock',
            amount: 11.61,
            reason: 'buyback' as const,
          },
          { customer_id: 'cus_lock', amount: 5, reason: 'adjustment' as const },
          { customer_id: 'cus_lock', amount: -20, reason: 'cashout' as const },
          {
            customer_id: 'cus_lock',
            amount: -12,
            reason: 'delivery_fee' as const,
          },
          {
            customer_id: 'cus_lock',
            amount: 3,
            reason: 'referral_commission' as const,
          },
          {
            customer_id: 'cus_lock',
            amount: 2,
            reason: 'voucher_claim' as const,
          },
        ]);
        // Two rows move into January, so the windowed comparison both
        // includes and excludes something.
        await backdate(
          'credit_transaction',
          rows[1].id,
          '2026-01-15T04:00:00.000Z',
        );
        await backdate(
          'credit_transaction',
          rows[2].id,
          '2026-01-20T04:00:00.000Z',
        );
        const admin = (query: string) =>
          unwrapResponse(
            api.get(`/admin/economy${query}`, {
              headers: { authorization: `Bearer ${token}` },
            }),
          );
        for (const query of [
          '',
          '?from=2026-01-01T00:00:00.000Z&to=2026-02-01T00:00:00.000Z',
        ]) {
          const [ours, theirs] = await Promise.all([
            report(`economy${query}`),
            admin(query),
          ]);
          expect(ours.status).toBe(200);
          expect(theirs.status).toBe(200);
          expect(ours.data.totals).toEqual(theirs.data.totals);
        }
        const january = await report(
          'economy?from=2026-01-01T00:00:00.000Z&to=2026-02-01T00:00:00.000Z',
        );
        expect(january.data.totals.revenue).toBe(25);
        expect(january.data.totals.payouts).toBe(11.61);
        expect(january.data.totals.topups).toBe(0);
        expect(january.data.window).toEqual({
          from: '2026-01-01T00:00:00.000Z',
          to: '2026-02-01T00:00:00.000Z',
        });
      });
    });
  },
});
