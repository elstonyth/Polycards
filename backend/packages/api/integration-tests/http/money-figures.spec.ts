import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils';
import type { ICustomerModuleService } from '@medusajs/framework/types';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { ensureDefaultPlayerGroup } from '../../src/modules/packs/player-groups';
import {
  EFFECTIVE_GROUP_SQL,
  effectivePlayerGroup,
} from '../../src/modules/packs/odds-sets';
import { ledgerTotals } from '../../src/modules/packs/economy';
import { mergeSettlementPeriods } from '../../src/modules/packs/gateway-settlement';
import { resolveFxRate } from '../../src/modules/packs/pricing';
import {
  BUYBACK_CASH,
  BUYBACK_FULL,
  CAPSULE_OPEN_SQL,
  COIN_FLIP_WINS,
  GATEWAY,
  LEDGER_TOTALS_BASIS,
  PACK_SALES_CASH,
  PACK_SALES_FULL,
  TOPUPS_LEDGER,
  cardValueSen,
  populationSql,
  type Figure,
  type Population,
} from '../../src/modules/packs/money-figures';
import { DEFAULT_MARKET_MULTIPLIER } from '../../src/modules/packs/pricing';
import { FLAT_PERCENT } from '../../src/modules/packs/buyback-rate';
import { scopeFilter, type ReportDb } from '../../src/api/reports/sql';
import { resolveGroupScope } from '../../src/api/reports/params';
import { packWindowRows } from '../../src/api/admin/profit-report/pnl/queries';
import { gamesWindowRows } from '../../src/api/admin/profit-report/pnl/queries-games';
import { packSales } from '../../src/api/reports/finance/queries';
import { mintSuperAdmin, unwrapResponse } from './utils';
import { vaultCards } from '../../src/api/admin/profit-report/pnl/queries-balance';

jest.setTimeout(240 * 1000);

const FINANCE_KEY = 'm'.repeat(48);
process.env.REPORT_KEY_FINANCE = FINANCE_KEY;

// The money figure catalog (modules/packs/money-figures.ts) against a real
// Postgres: each drift-prone figure's SQL equals a plain JS fold over the same
// rows and equals what the reports print, and every population filter spelling
// (NOT IN, NOT EXISTS, the JS rule) selects the same customers.

const n = (v: unknown) => Number(v ?? 0);

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    const packs = () =>
      getContainer().resolve<PacksModuleService>(PACKS_MODULE);
    const customers = () =>
      getContainer().resolve<ICustomerModuleService>(Modules.CUSTOMER);
    const db = () =>
      getContainer().resolve(
        ContainerRegistrationKeys.PG_CONNECTION,
      ) as unknown as ReportDb;
    const one = async (sql: string, params: unknown[] = []) =>
      n(Object.values((await db().raw<Record<string, unknown>>(sql, params)).rows[0] ?? {})[0]);
    // A figure summed in SQL over every live ledger row.
    const figureSql = (f: Figure, extra = '') =>
      one(
        `SELECT COALESCE(SUM(${f.sen('ct.')}), 0)::bigint FROM credit_transaction ct ` +
          `WHERE ct.deleted_at IS NULL AND ${f.where('ct.')}${extra}`,
      );

    describe('population parity', () => {
      it('NOT IN, NOT EXISTS and the JS rule pick the same customers', async () => {
        const c = customers();
        const group = (name: string, metadata?: Record<string, unknown>) =>
          c.createCustomerGroups({ name, metadata });
        const def = await ensureDefaultPlayerGroup(getContainer());
        const older = await group('MF Older');
        const newer = await group('MF Newer');
        const house = await group('MF House', { is_default: true }); // a renamed default
        const dead = await group('MF Dead');
        await db().raw('UPDATE customer_group SET created_at = ? WHERE id = ?', [
          '2026-01-01T00:00:00.000Z',
          older.id,
        ]);
        await db().raw('UPDATE customer_group SET created_at = ? WHERE id = ?', [
          '2026-02-01T00:00:00.000Z',
          newer.id,
        ]);
        const names = [
          'nogroup',
          'defonly',
          'renamed',
          'deadgroup',
          'left',
          'member',
          'defandmember',
          'twogroups',
          'credential',
          'credmember',
        ];
        const ids: Record<string, string> = {};
        for (const name of names) {
          ids[name] = (
            await c.createCustomers({
              email: `mf-${name}@test.dev`,
              metadata: name.startsWith('cred')
                ? { partner_credential: { password: 'x', issued_at: 'y' } }
                : undefined,
            })
          ).id;
        }
        const join = (who: string, g: { id: string }) =>
          c.addCustomerToGroup({ customer_id: ids[who], customer_group_id: g.id });
        await join('defonly', def);
        await join('renamed', house);
        await join('deadgroup', dead);
        await join('left', older);
        await join('member', newer);
        await join('defandmember', def);
        await join('defandmember', older);
        await join('twogroups', newer);
        await join('twogroups', older); // older wins: effective group is Older
        await join('credmember', newer);
        // A removed membership and a deleted group: both are DEFAULT again.
        await db().raw(
          'UPDATE customer_group_customer SET deleted_at = now() WHERE customer_id = ?',
          [ids.left],
        );
        await db().raw('UPDATE customer_group SET deleted_at = now() WHERE id = ?', [
          dead.id,
        ]);

        const picked = async (clause: string, params: unknown[] = []) =>
          (
            await db().raw<{ email: string }>(
              `SELECT c.email FROM customer c WHERE c.email LIKE 'mf-%'${clause}`,
              params,
            )
          )
            .rows.map((r) => r.email.slice(3, -'@test.dev'.length))
            .sort();
        const viaPop = (p: Population) => {
          const part = populationSql(p, 'c.id');
          return picked(part.sql, part.params);
        };

        // The JS rule: effectivePlayerGroup over the live memberships. Read
        // by SQL: listCustomers' groups relation still returns a membership
        // whose customer_group_customer row is soft-deleted.
        const { rows: live } = await db().raw<{
          customer_id: string;
          id: string;
          name: string | null;
          metadata: Record<string, unknown> | null;
          created_at: Date;
        }>(
          'SELECT cgc.customer_id, cg.id, cg.name, cg.metadata, cg.created_at ' +
            'FROM customer_group_customer cgc JOIN customer_group cg ON cg.id = cgc.customer_group_id ' +
            'WHERE cgc.deleted_at IS NULL AND cg.deleted_at IS NULL',
        );
        const effective = new Map(
          Object.values(ids).map((id) => [
            id,
            effectivePlayerGroup(live.filter((m) => m.customer_id === id))?.id ?? null,
          ]),
        );
        const credential = new Set([ids.credential, ids.credmember]);
        const js = (keep: (id: string) => boolean) =>
          names.filter((name) => keep(ids[name])).sort();

        const defaultGroup = js((id) => effective.get(id) === null);
        expect(defaultGroup).toEqual(
          ['credential', 'defonly', 'deadgroup', 'left', 'nogroup', 'renamed'].sort(),
        );
        // ?group=default before C3 (NOT IN) and now (NOT EXISTS).
        expect(
          await picked(` AND c.id NOT IN (SELECT customer_id FROM (${EFFECTIVE_GROUP_SQL}) eff)`),
        ).toEqual(defaultGroup);
        expect(await viaPop({ kind: 'default_group' })).toEqual(defaultGroup);
        const groups = await c.listCustomerGroups({}, { take: 100 });
        const desk = scopeFilter(resolveGroupScope('default', groups), 'c.id');
        expect(await picked(desk.sql, desk.params)).toEqual(defaultGroup);

        // CustomerScope 'default' = default group minus credential accounts.
        expect(await viaPop({ kind: 'real' })).toEqual(
          js((id) => effective.get(id) === null && !credential.has(id)),
        );

        // A named group is the EFFECTIVE group: twogroups counts in Older only.
        for (const g of [older, newer]) {
          const want = js((id) => effective.get(id) === g.id);
          expect(await viaPop({ kind: 'group', id: g.id, name: g.name })).toEqual(want);
          const named = scopeFilter(resolveGroupScope(g.name, groups), 'c.id');
          expect(await picked(named.sql, named.params)).toEqual(want);
        }
        expect(js((id) => effective.get(id) === older.id)).toEqual(
          ['defandmember', 'twogroups'],
        );

        expect(await viaPop({ kind: 'everyone' })).toEqual([...names].sort());
        expect(await viaPop({ kind: 'customer', id: ids.member })).toEqual(['member']);
      });
    });

    describe('basis', () => {
      it('the reports say what their money figures count', async () => {
        const finance = (path: string) =>
          unwrapResponse(
            api.get(`/reports/finance/${path}`, {
              headers: { 'x-report-key': FINANCE_KEY },
            }),
          );
        const economy = await finance('economy');
        expect(economy.status).toBe(200);
        expect(economy.data.basis).toEqual({ totals: LEDGER_TOTALS_BASIS });
        const sales = await finance('pack-sales');
        expect(sales.data.basis).toEqual({ revenue: PACK_SALES_CASH.note });
        const token = await mintSuperAdmin(getContainer(), api, 'mf-basis-admin@test.dev', 'mf-basis-test-password-1');
        const profit = await unwrapResponse(
          api.get('/admin/profit-report?range=all', {
            headers: { authorization: `Bearer ${token}` },
          }),
        );
        expect(profit.status).toBe(200);
        expect(profit.data.basis).toEqual({
          activity: {
            pack_sales: PACK_SALES_CASH.note,
            sellbacks: BUYBACK_CASH.note,
            coin_flip_payouts: COIN_FLIP_WINS.note,
          },
        });
      });
    });

    describe('one pack per charge', () => {
      it('Finance pack sales and P&L capsule sales attribute each charge once', async () => {
        const [p] = await customers().createCustomers([{ email: 'mf-attr@test.dev' }]);
        const ct = (amount: number, bonus_cents: number, source: string | null) => ({
          customer_id: p.id,
          reason: 'pack_open',
          amount: -amount,
          bonus_cents: -bonus_cents,
          source_transaction_id: source,
        });
        await packs().createCreditTransactions(
          [
            ct(10, 400, 'mf-batch'), // a count=3 batch: one charge, three pulls
            ct(4, 0, 'mf-single'),
            ct(3, 100, 'mf-capsule'), // a two-spin capsule batch
            ct(2, 0, null), // before open_id
            ct(1, 0, 'mf-nopulls'), // an open that never produced pulls
            ct(0.5, 0, 'mf-gone'), // its only pull was deleted
          ] as never,
        );
        const pull = (open_id: string, pack_id: string) => ({
          customer_id: p.id,
          pack_id,
          card_id: 'mf-none',
          status: 'vaulted' as const,
          source: 'pack' as const,
          open_id,
          rolled_at: new Date(),
        });
        const pulls = await packs().createPulls([
          pull('mf-batch', 'mf-a'),
          pull('mf-batch', 'mf-a'),
          pull('mf-batch', 'mf-a'),
          pull('mf-single', 'mf-b'),
          pull('mf-gone', 'mf-b'),
        ] as never);
        await db().raw('UPDATE pull SET deleted_at = now() WHERE id = ?', [
          (pulls as unknown as { id: string }[])[4].id,
        ]);
        const spin = () => ({
          customer_id: p.id,
          pack_id: 'mf-cap',
          tickets: 4,
          source: 'pack' as const,
          open_id: 'mf-capsule',
          rolled_at: new Date(),
        });
        await packs().createTicketSpins([spin(), spin()] as never);

        const sales = await packSales(
          db(),
          populationSql({ kind: 'customer', id: p.id }, 'ct.customer_id'),
          populationSql({ kind: 'customer', id: p.id }, 'p.customer_id'),
        );
        expect(Object.fromEntries(sales.bySlug)).toEqual({
          'mf-a': { opened: 3, cents: 600 }, // cash part of RM 10 with RM 4 bonus
          'mf-b': { opened: 1, cents: 400 },
          'mf-cap': { opened: 2, cents: 200 },
        });
        expect(sales.unattributedCents).toBe(200 + 100 + 50);

        const games = await gamesWindowRows(db(), {}, 'all');
        expect(games.capsules.filter((c) => c.slug === 'mf-cap')).toEqual([
          { slug: 'mf-cap', full_sen: 300, bonus_sen: 100 },
        ]);
      });
    });

    describe('SQL equals fold', () => {
      it('pack sales full, cash and capsules, buyback, coin flip and ledger top-ups', async () => {
        const [p] = await customers().createCustomers([{ email: 'mf-sales@test.dev' }]);
        const ct = (
          reason: string,
          amount: number,
          bonus_cents: number | null,
          source_transaction_id: string | null = null,
        ) => ({ customer_id: p.id, reason, amount, bonus_cents, source_transaction_id });
        await packs().createCreditTransactions(
          [
            ct('pack_open', -10, -400, 'mf-o1'), // cash 600, full 1000
            ct('pack_open', -5.55, null, 'mf-o2'), // no bonus column: 555 both
            ct('pack_open', 1, 0, 'mf-o2'), // a partial reversal
            ct('pack_open', -3, -100, 'mf-o3'), // a capsule open
            ct('pack_open', -2, 0, null), // unattributed
            ct('buyback', 8, 300), // a pre-2026-10-09 sell-back: bonus share back
            ct('coin_flip_win', 4, 0, 'mf-cf1'),
            ct('topup', 20, 0, 'mf-t1'),
            ct('topup', -3, 0, 'mf-t2'), // a negative correction
          ] as never,
        );
        await packs().createPulls([
          { customer_id: p.id, pack_id: 'mf-pack', card_id: 'mf-none', status: 'vaulted' as const, source: 'pack' as const, open_id: 'mf-o1', rolled_at: new Date() },
          { customer_id: p.id, pack_id: 'mf-pack', card_id: 'mf-none', status: 'vaulted' as const, source: 'pack' as const, open_id: 'mf-o2', rolled_at: new Date() },
        ] as never);
        await packs().createTicketSpins([
          { customer_id: p.id, pack_id: 'mf-capsule', tickets: 4, source: 'pack' as const, open_id: 'mf-o3', rolled_at: new Date() },
        ] as never);

        // The JS fold over the raw rows.
        const { rows } = await db().raw<{
          reason: string;
          amount: string;
          bonus_cents: string | null;
          capsule: boolean;
        }>(
          `SELECT ct.reason, ct.amount, ct.bonus_cents, ${CAPSULE_OPEN_SQL('ct.')} AS capsule ` +
            'FROM credit_transaction ct WHERE ct.deleted_at IS NULL',
        );
        const sum = (reason: string, sen: (r: (typeof rows)[number]) => number, keep = (_: (typeof rows)[number]) => true) =>
          rows.filter((r) => r.reason === reason && keep(r)).reduce((s, r) => s + sen(r), 0);
        const full = (r: (typeof rows)[number]) => Math.round(n(r.amount) * 100);
        const cash = (r: (typeof rows)[number]) => full(r) - n(r.bonus_cents);

        const cashSales = -sum('pack_open', cash);
        const fullSales = -sum('pack_open', full, (r) => !r.capsule);
        expect([cashSales, fullSales]).toEqual([1455, 1655]);
        expect(await figureSql(PACK_SALES_CASH)).toBe(cashSales);
        expect(
          await figureSql(PACK_SALES_FULL, ` AND NOT ${CAPSULE_OPEN_SQL('ct.')}`),
        ).toBe(fullSales);
        expect(await figureSql(BUYBACK_CASH)).toBe(sum('buyback', cash));
        expect(await figureSql(BUYBACK_FULL)).toBe(sum('buyback', full));
        expect(await figureSql(COIN_FLIP_WINS)).toBe(sum('coin_flip_win', cash));
        expect(await figureSql(TOPUPS_LEDGER)).toBe(sum('topup', cash));

        // The reports print the same: Economy (cash basis) and P&L (full price).
        const economy = ledgerTotals(await packs().ledgerReasonTotals());
        expect(economy.revenue).toBe(cashSales / 100);
        expect(economy.payouts).toBe(5);
        expect(economy.coinFlipPayouts).toBe(4);
        expect(economy.topups).toBe(17);
        const pnl = await packWindowRows(db(), {}, 'all');
        expect([...pnl.paid.values()].reduce((s, v) => s + v.full_sen, 0)).toBe(fullSales);
        expect(pnl.paid.get(null)?.full_sen).toBe(200); // the unattributed charge
        // The player page counts positive top-up rows only (owner G6).
        expect((await packs().creditSummary(p.id)).topupTotal).toBe(20);
      });

      it('gateway top-ups: a known amount, a hand-settled NULL and a zero', async () => {
        const [p] = await customers().createCustomers([{ email: 'mf-gw@test.dev' }]);
        const now = new Date();
        const dep = (id: string, amount_settled: number | null, net_amount: number | null) => ({
          merchant_transaction_id: id,
          customer_id: p.id,
          amount_requested: 15,
          amount_settled,
          net_amount,
          payment_method_code: 'BQR',
          status: 'settled' as const,
          settled_at: now,
        });
        await packs().createGatewayDeposits([
          dep('mf-d1', 20, 19.5),
          dep('mf-d2', null, null),
          dep('mf-d3', 0, 0),
        ] as never);
        const { rows } = await db().raw<{ amount_settled: string | null; net_amount: string | null }>(
          "SELECT amount_settled, net_amount FROM gateway_deposit WHERE status = 'settled' AND deleted_at IS NULL",
        );
        const known = rows.filter((r) => r.amount_settled !== null);
        const grossSen = known.reduce((s, r) => s + Math.round(n(r.amount_settled) * 100), 0);
        const feeSen = known
          .filter((r) => r.net_amount !== null)
          .reduce((s, r) => s + Math.round((n(r.amount_settled) - n(r.net_amount)) * 100), 0);

        // Dashboard: amount_settled > 0 only. Profit: every row counted, NULL
        // as missing, never summed as RM 0.
        const day = 86_400_000;
        const stats = await packs().signupTopupStats(
          new Date(now.getTime() - day),
          new Date(now.getTime() + day),
          'all',
        );
        expect([stats.topup_count, stats.topup_amount]).toEqual([1, 20]);
        const cash = await packs().profitCashTotals(null, 'all');
        expect(cash.allTime.topups).toMatchObject({
          count: 3,
          grossCents: grossSen,
          feeCents: feeSen,
          missingGross: 1,
        });
        expect(
          await one(
            `SELECT COALESCE(SUM(${GATEWAY.depositFeeSen()}), 0)::bigint FROM gateway_deposit ` +
              "WHERE status = 'settled' AND net_amount IS NOT NULL AND amount_settled IS NOT NULL",
          ),
        ).toBe(feeSen);
      });

      it('payout fee: ABS per row in Profit, signed in Settlement (owner G2)', async () => {
        const [p] = await customers().createCustomers([{ email: 'mf-fee@test.dev' }]);
        const now = new Date();
        const wd = (id: string, net_amount: number) => ({
          merchant_transaction_id: id,
          customer_id: p.id,
          amount: 100,
          amount_settled: 100,
          net_amount,
          bank_code: 'MBB',
          account_number: '000000000000',
          account_holder_name: 'MF Test',
          status: 'settled' as const,
          settled_at: now,
        });
        // Net = paid + fee (the direction rule), and a legacy row the other way.
        await packs().createGatewayWithdrawals([wd('mf-w1', 101), wd('mf-w2', 99)] as never);
        const absSen = 200;
        expect(
          await one(
            `SELECT SUM(${GATEWAY.payoutFeeSen()})::bigint FROM gateway_withdrawal WHERE status = 'settled'`,
          ),
        ).toBe(absSen);
        const cash = await packs().profitCashTotals(null, 'all');
        expect(cash.allTime.withdrawals.feeCents).toBe(absSen);
        const s = await packs().settlementRows('month', new Date(now.getTime() - 86_400_000 * 40));
        const periods = mergeSettlementPeriods(s.deposits, s.withdrawals, s.ledger);
        expect(periods.reduce((t, x) => t + x.withdrawals.fee, 0)).toBe(0);
      });

      it('FX earned: Profit rounds per row, the Settlement FX card once', async () => {
        const [p] = await customers().createCustomers([{ email: 'mf-fx@test.dev' }]);
        const now = new Date();
        // Each top-up earns RM 0.004 (10 SGD x 3.2004 - RM 32), the payout
        // RM 0.007 (RM 100 - 31.25 SGD x 3.199776).
        await packs().createGatewayDeposits(
          ['mf-fx1', 'mf-fx2'].map((id) => ({
            merchant_transaction_id: id,
            customer_id: p.id,
            amount_requested: 32,
            amount_settled: 32,
            net_amount: 32,
            payment_method_code: 'PAYNOW',
            status: 'settled' as const,
            settled_at: now,
            gateway: 'a3pay',
            currency: 'SGD',
            gateway_amount: 10,
            fx_mid: 3.2004,
          })) as never,
        );
        await packs().createGatewayWithdrawals([
          {
            merchant_transaction_id: 'mf-fx3',
            customer_id: p.id,
            amount: 100,
            amount_settled: 100,
            bank_code: 'PAYNOW',
            account_number: '91234567',
            account_holder_name: 'MF Test',
            status: 'settled' as const,
            settled_at: now,
            gateway: 'a3pay',
            currency: 'SGD',
            gateway_amount: 31.25,
            fx_mid: 3.199776,
          },
        ] as never);
        expect(
          await one(`SELECT SUM(${GATEWAY.depositFxRm('d.')})::float8 FROM gateway_deposit d`),
        ).toBeCloseTo(0.008, 9);
        expect(
          await one(`SELECT SUM(${GATEWAY.payoutFxRm('w.')})::float8 FROM gateway_withdrawal w`),
        ).toBeCloseTo(0.007, 9);
        // Profit: ROUND per row, so the two 0.4-sen top-ups earn 0.
        expect((await packs().profitCashTotals(null, 'all')).allTime.fxCents).toBe(1);
        // Settlement's FX card: summed, then rounded once.
        const token = await mintSuperAdmin(getContainer(), api, 'mf-fx-admin@test.dev', 'mf-fx-test-password-1');
        const r = await unwrapResponse(
          api.get('/admin/payments/fx?currency=SGD', {
            headers: { authorization: `Bearer ${token}` },
          }),
        );
        expect(r.status).toBe(200);
        expect(r.data.earnings).toEqual({
          deposits: { count: 2, rm: 0.01 },
          payouts: { count: 1, rm: 0.01 },
          total_rm: 0.02,
        });
      });

      it('card liability: vaulted, delivering in a requested or a shipped order, delivered', async () => {
        const [p] = await customers().createCustomers([{ email: 'mf-cards@test.dev' }]);
        await packs().createCreditTransactions([
          { customer_id: p.id, amount: 10, reason: 'topup' as const, source_transaction_id: 'mf-ct1' },
        ] as never);
        await packs().createCards([
          { handle: 'mf-card', name: 'MF Card', set: 'QA', grader: 'PSA', grade: '9', market_value: 10, image: '/qa.png' },
        ]);
        const pulls = await packs().createPulls(
          (['vaulted', 'delivering', 'delivering', 'delivered'] as const).map((status) => ({
            customer_id: p.id,
            pack_id: 'mf-pack',
            card_id: 'mf-card',
            status,
            rolled_at: new Date(),
          })),
        );
        const order = (status: 'requested' | 'shipped') => ({
          customer_id: p.id,
          status,
          ship_name: 'MF',
          ship_address_1: '1 Street',
          ship_city: 'City',
          ship_postal_code: '10000',
          ship_country_code: 'my',
          ship_phone: '+60100000000',
          shipping_fee: 10,
        });
        const [requested, shipped] = await packs().createDeliveryOrders([
          order('requested'),
          order('shipped'),
        ]);
        await packs().createDeliveryOrderItems([
          { delivery_order_id: requested.id, pull_id: pulls[1].id },
          { delivery_order_id: shipped.id, pull_id: pulls[2].id },
        ]);

        const fx = await resolveFxRate(packs());
        const displaySen = Math.round(10 * DEFAULT_MARKET_MULTIPLIER * fx * 100);
        const sellbackSen = Math.round(10 * DEFAULT_MARKET_MULTIPLIER * fx * FLAT_PERCENT);
        const valued = (basis: 'display' | 'sellback', status: string) =>
          one(
            `SELECT COALESCE(SUM(${cardValueSen(basis)}), 0)::bigint FROM pull p ` +
              'JOIN card c ON c.handle = p.card_id AND c.deleted_at IS NULL ' +
              'WHERE p.deleted_at IS NULL AND p.status = ?',
            basis === 'display'
              ? [DEFAULT_MARKET_MULTIPLIER, fx, status]
              : [DEFAULT_MARKET_MULTIPLIER, fx, FLAT_PERCENT, status],
          );

        // Economy: vaulted only, at display value.
        expect(await valued('display', 'vaulted')).toBe(displaySen);
        expect(await packs().vaultLiabilityMyr(fx)).toEqual({
          count: 1,
          liability: displaySen / 100,
        });
        // Profit: vaulted and EVERY delivering pull at sell-back (owner G3).
        expect(await valued('sellback', 'delivering')).toBe(2 * sellbackSen);
        const owed = await packs().profitOwed('all', fx);
        expect([owed.cardCount, owed.cardSellbackCents]).toEqual([3, 3 * sellbackSen]);
        expect([owed.shippedCount, owed.shippedCents]).toEqual([1, sellbackSen]);
        // P&L: only the delivering pull in an active order.
        expect(await vaultCards(db(), 'all', fx)).toEqual({
          vault: { cards: 1, sen: sellbackSen },
          processing: { cards: 1, sen: sellbackSen },
        });
      });
    });
  },
});
