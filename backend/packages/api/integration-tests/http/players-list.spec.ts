import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { Modules } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import {
  clearFxDisplayCache,
  displayMarketPrice,
  resolveFxRate,
} from '../../src/modules/packs/pricing';
import { toMoney } from '../../src/modules/packs/money';
import { mintSuperAdmin, unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

const PASSWORD = 'players-list-test-password-1'; // gitleaks:allow
const ADMIN_EMAIL = 'players-list-admin@test.dev';
// A's local part is unique enough that ?q= can't also match B or the admin.
const A_EMAIL = 'alphaplayer-zzq@test.dev';
const B_EMAIL = 'bravoplayer-yyr@test.dev';
const CARD_HANDLE = 'players-list-card';
const CARD_USD = 12.34;
const PACK_SLUG = 'players-list-pack';
const GROUP_NAME = 'Players List Whales';

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('GET /admin/players (POLYCARD-BACK §4.2)', () => {
      let adminToken: string;
      let aId: string;
      let bId: string;
      let fx: number;

      const packsService = (): PacksModuleService =>
        getContainer().resolve<PacksModuleService>(PACKS_MODULE);

      beforeEach(async () => {
        const container = getContainer();
        const packs = packsService();

        // FIRM fx row FIRST, before any request can resolve (and cache) the
        // 4.7 display fallback — seeded exactly the way seed-e2e-fixtures.ts
        // does. clearFxDisplayCache() is belt-and-braces for the 30s process
        // cache surviving between tests in this file.
        clearFxDisplayCache();
        await packs.createFxRates([
          {
            pair: 'USD_MYR',
            rate: 4.0725,
            source: 'players-list-test',
            manual_override: false,
            manual_rate: null,
          },
        ]);
        fx = await resolveFxRate(packs);

        adminToken = await mintSuperAdmin(
          container,
          api,
          ADMIN_EMAIL,
          PASSWORD,
        );

        const customers = container.resolve(Modules.CUSTOMER);
        // A first, B second → created_at DESC puts B ahead of A (ties possible).
        const a = await customers.createCustomers({
          email: A_EMAIL,
          first_name: 'Alpha',
          last_name: 'Player',
          phone: '+60123456789',
        });
        aId = a.id;
        const b = await customers.createCustomers({ email: B_EMAIL });
        bId = b.id;

        // A carries a real customer group so the `groups` column is proven
        // populated, not vacuously empty — this also exercises the to-many
        // join under skip/take that the route flags as its known ceiling.
        const group = await customers.createCustomerGroups({
          name: GROUP_NAME,
        });
        await customers.addCustomerToGroup({
          customer_id: aId,
          customer_group_id: group.id,
        });

        // A: +100 topup, −30 pack_open, one vaulted pack pull, VIP level 3.
        await packs.createCreditTransactions([
          { customer_id: aId, amount: 100, reason: 'topup' },
          { customer_id: aId, amount: -30, reason: 'pack_open' },
        ]);
        await packs.createCards([
          {
            handle: CARD_HANDLE,
            name: 'Players List Test Card PSA 10',
            set: 'Test Set',
            grader: 'PSA',
            grade: '10',
            market_value: CARD_USD,
            image: '/cdn/players-list-card.webp',
          },
        ]);
        await packs.createPulls([
          {
            customer_id: aId,
            pack_id: PACK_SLUG,
            card_id: CARD_HANDLE,
            rolled_at: new Date(),
            status: 'vaulted' as const,
            source: 'pack' as const,
          },
        ]);
        await packs.createVipMemberStates([
          { customer_id: aId, current_level: 3, highest_level_ever: 3 },
        ]);
        // B: no activity at all.
      });

      const adminHeaders = (): Record<string, string> => ({
        authorization: `Bearer ${adminToken}`,
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const list = (qs = ''): Promise<any> =>
        unwrapResponse(
          api.get(`/admin/players${qs}`, { headers: adminHeaders() }),
        );

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rowFor = (res: any, id: string): any =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        res.data.players.find((p: any) => p.id === id);

      // Regression guard, not a live hole: /admin/* is framework-auto-protected.
      // This route hands back every customer's email, phone, wallet balance and
      // vault value in one call, so a middlewares edit must never un-protect it
      // silently (same guard as economy.spec.ts:30).
      it('rejects an unauthenticated read with 401', async () => {
        const res = await unwrapResponse(api.get('/admin/players'));
        expect(res.status).toBe(401);
      });

      it('200 — lists both customers, newest first, with total', async () => {
        const res = await list();
        expect(res.status).toBe(200);
        expect(res.data.total).toBe(2);
        expect(res.data.limit).toBe(50);
        expect(res.data.offset).toBe(0);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ids = res.data.players.map((p: any) => p.id).sort();
        expect(ids).toEqual([aId, bId].sort());

        // created_at DESC — asserted as non-increasing, not as a fixed order:
        // two customers created in the same tick can share a created_at.
        const stamps = res.data.players.map(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (p: any) => new Date(p.registered_at).getTime(),
        );
        for (let i = 1; i < stamps.length; i++) {
          expect(stamps[i - 1]).toBeGreaterThanOrEqual(stamps[i]);
        }
      });

      it('reconciles against creditSummary + the pricing seam (spec §4)', async () => {
        const packs = packsService();
        const summary = await packs.creditSummary(aId);
        const [card] = await packs.listCards(
          { handle: CARD_HANDLE },
          { take: 1 },
        );

        const res = await list();
        const a = rowFor(res, aId);

        expect(a.email).toBe(A_EMAIL);
        expect(a.name).toBe('Alpha Player');
        expect(a.phone).toBe('+60123456789');
        expect(a.groups).toEqual([GROUP_NAME]);
        // Equality against the live oracle, not the seeded constants.
        expect(a.wallet_balance).toBe(summary.balance);
        expect(a.total_spend).toBe(summary.vipSpendTotal);
        expect(a.total_pulls).toBe(1);
        expect(a.vault_count).toBe(1);
        // Vault is FMV at multiplier 1 — the admin convention (vaultLiabilityMyr).
        expect(a.vault_value).toBe(
          displayMarketPrice(toMoney(card.market_value), fx, 1),
        );
        expect(a.vip_level).toBe(3);
        expect(a.last_spend_at).not.toBeNull();
        expect(a.frozen).toBe(false);
        expect(a.disabled).toBe(false);
      });

      it('a customer with no activity reads zeros / level 1 / null last spend', async () => {
        const res = await list();
        const b = rowFor(res, bId);

        expect(b.email).toBe(B_EMAIL);
        expect(b.name).toBeNull();
        expect(b.groups).toEqual([]); // the empty side of A's populated groups
        expect(b.wallet_balance).toBe(0);
        expect(b.total_spend).toBe(0);
        expect(b.total_pulls).toBe(0);
        expect(b.vault_count).toBe(0);
        expect(b.vault_value).toBe(0);
        expect(b.vip_level).toBe(1);
        expect(b.last_spend_at).toBeNull();
        expect(b.frozen).toBe(false);
        expect(b.disabled).toBe(false);
      });

      // Distinct SQL path from B's "no ledger rows at all": the customer HAS a
      // credit_transaction group, so MAX(created_at) FILTER (…) is what must
      // come back NULL.
      it('credit rows without a pack_open still read last_spend_at null', async () => {
        await packsService().createCreditTransactions([
          { customer_id: bId, amount: 25, reason: 'topup' },
        ]);

        const b = rowFor(await list(), bId);
        expect(b.wallet_balance).toBe(25);
        expect(b.total_spend).toBe(0);
        expect(b.last_spend_at).toBeNull();
      });

      it('?q= narrows to the matching customer', async () => {
        const res = await list('?q=alphaplayer-zzq');
        expect(res.status).toBe(200);
        expect(res.data.total).toBe(1);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        expect(res.data.players.map((p: any) => p.id)).toEqual([aId]);
      });

      it('pages with limit/offset and rejects limit > 200', async () => {
        const first = await list('?limit=1&offset=0');
        expect(first.status).toBe(200);
        expect(first.data.total).toBe(2);
        expect(first.data.players).toHaveLength(1);

        const second = await list('?limit=1&offset=1');
        expect(second.status).toBe(200);
        expect(second.data.offset).toBe(1);
        expect(second.data.players).toHaveLength(1);
        // Order-independent: the two pages must cover both customers exactly.
        expect(
          [first.data.players[0].id, second.data.players[0].id].sort(),
        ).toEqual([aId, bId].sort());

        const tooBig = await list('?limit=500');
        expect(tooBig.status).toBe(400);
      });

      it('?sort= orders by an allowlisted column; unknown keys degrade silently', async () => {
        const asc = await list('?sort=email:asc');
        expect(asc.status).toBe(200);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const emails = asc.data.players.map((p: any) => p.email);
        // Every fixture address is lowercase ASCII, the one class where a JS
        // code-unit sort and Postgres' collation cannot disagree. Don't widen
        // the fixtures to mixed case without replacing this comparison.
        expect(emails).toEqual([...emails].sort());

        // Built from the ASCENDING response (asserted sorted above) and then
        // reversed — never from the descending response itself, which would
        // compare a list against a permutation of itself and always pass.
        const expectedDesc = [...emails].sort().reverse();
        const desc = await list('?sort=email:desc');
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const emailsDesc = desc.data.players.map((p: any) => p.email);
        expect(emailsDesc).toEqual(expectedDesc);

        // wallet_balance is a JS-side aggregate, NOT a customer column. It must
        // degrade to the route's WHOLE default — created_at DESC — rather than
        // keeping the `:asc` from a request whose key was refused.
        const unknown = await list('?sort=wallet_balance:asc');
        expect(unknown.status).toBe(200);
        const stamps = unknown.data.players.map(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (p: any) => new Date(p.registered_at).getTime(),
        );
        for (let i = 1; i < stamps.length; i++) {
          expect(stamps[i - 1]).toBeGreaterThanOrEqual(stamps[i]);
        }
      });

      // `name` is the one bespoke key mapping on this route: the response's
      // `name` is a JS join of first_name + last_name, so the route expands the
      // key into BOTH underlying columns. A typo in either would be admitted by
      // the allowlist and only fail against a real database — which is what
      // this covers. A is 'Alpha Player'; B has no name at all.
      it('?sort=name= orders on the underlying first/last name columns', async () => {
        const asc = await list('?sort=name:asc');
        expect(asc.status).toBe(200);
        // ASC puts the named customer first (Postgres sorts NULLS LAST on ASC).
        expect(asc.data.players[0].id).toBe(aId);
        expect(asc.data.players[0].name).toBe('Alpha Player');

        // DESC is NULLS FIRST, so the nameless customer leads. Pinned rather
        // than fixed: it is the same trade-off the Deposits Credited column
        // documents, and a future NULLS LAST should fail here deliberately.
        const desc = await list('?sort=name:desc');
        expect(desc.data.players[0].id).toBe(bId);
        expect(desc.data.players[0].name).toBeNull();
      });

      it('disabled (Task 1) flows through to the row', async () => {
        const disable = await unwrapResponse(
          api.post(
            `/admin/customers/${aId}/disable`,
            { reason: 'players list test' },
            { headers: adminHeaders() },
          ),
        );
        expect(disable.status).toBe(200);

        const res = await list();
        expect(rowFor(res, aId).disabled).toBe(true);
        expect(rowFor(res, bId).disabled).toBe(false);
      });
    });
  },
});
