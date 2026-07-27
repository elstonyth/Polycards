import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils';
import type { ICustomerModuleService } from '@medusajs/framework/types';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { clearPackDetailCache } from '../../src/api/store/packs/[slug]/route';
import { unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

// POLYCARD-BACK Epic 3 (odds sets) — the acceptance gate: two customers open
// the SAME pack and draw from DIFFERENT distributions, decided entirely by the
// customer group they belong to and resolved SERVER-SIDE at spin time (§2.5).
//
// DETERMINISM — degenerate weights, not a seeded RNG. This is the repo's
// existing "single-card pool → deterministic roll" idiom (pack-open-charge)
// extended to two cards and two weight columns:
//
//     card    weight (set 1)   weight_2 (set 2)   weight_3 (set 3)
//     alpha        10000                0               NULL
//     beta             0            10000               NULL
//
// Every set totals 10000 bps, so a CSPRNG roll in [0, 10000) can only ever land
// on the 10000-weight row. Set 1 ⇒ ALWAYS alpha, set 2 ⇒ ALWAYS beta. weight_3
// stays NULL on both rows so set 3 INHERITS set 2 per card (weightForSet's
// 3→2→1 fallback), which is why an odds_set 3 group also draws beta.
//
// A drawn card that is neither alpha nor beta is impossible; a WRONG one means
// the wrong weight column was rolled — i.e. the odds set was mis-resolved.

const PASSWORD = 'odds-sets-test-password-1'; // gitleaks:allow

// created_at is optional on CustomerGroupDTO; an unset one would silently make
// the multi-group ordering assertion below compare against NaN (every
// comparison false → a confusing failure), so fail on the real cause instead.
const createdAtMs = (group: { created_at?: string | Date }): number => {
  const at = group.created_at;
  if (at === undefined) throw new Error('customer_group.created_at is unset');
  return new Date(at).getTime();
};

const PACK_SLUG = 'odds-sets-pack';
const ALPHA = 'odds-sets-alpha';
const BETA = 'odds-sets-beta';
const PACK_PRICE = 10;
const FMV = 50;
const MULTIPLIER = 1.2;
const MANUAL_RATE = 4.0;
const TOTAL_BPS = 10000;

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('odds sets — group-resolved draw distributions', () => {
      let storeHeaders: Record<string, string>;

      const customerModule = (): ICustomerModuleService =>
        getContainer().resolve<ICustomerModuleService>(Modules.CUSTOMER);

      beforeEach(async () => {
        const container = getContainer();
        // The 30s pack-detail cache is MODULE state — it outlives this suite's
        // per-test DB reset, so a body cached by an earlier test would be served
        // to a later one (the route ships this seam for exactly that reason).
        clearPackDetailCache();

        const apiKeyModule = container.resolve(Modules.API_KEY);
        const key = await apiKeyModule.createApiKeys({
          title: 'odds-sets-test',
          type: 'publishable',
          created_by: 'odds-sets-test',
        });
        storeHeaders = { 'x-publishable-api-key': key.token };

        const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
        await packs.createPacks([
          {
            slug: PACK_SLUG,
            title: 'Odds Sets Test Pack',
            category: 'pokemon',
            price: PACK_PRICE,
            image: '/cdn/test-pack.webp',
            buyback_percent: 90,
          },
        ]);
        await packs.createCards([
          {
            handle: ALPHA,
            name: 'Odds Sets Alpha PSA 10',
            set: 'Test Set',
            grader: 'PSA',
            grade: '10',
            market_value: FMV,
            market_multiplier: MULTIPLIER,
            image: '/cdn/test-card-alpha.webp',
          },
          {
            handle: BETA,
            name: 'Odds Sets Beta PSA 10',
            set: 'Test Set',
            grader: 'PSA',
            grade: '10',
            market_value: FMV,
            market_multiplier: MULTIPLIER,
            image: '/cdn/test-card-beta.webp',
          },
        ]);
        await packs.createPackOdds([
          {
            pack_id: PACK_SLUG,
            card_id: ALPHA,
            rarity: 'Rare' as const,
            locked: false,
            weight: TOTAL_BPS,
            weight_2: 0,
          },
          {
            pack_id: PACK_SLUG,
            card_id: BETA,
            rarity: 'Rare' as const,
            locked: false,
            weight: 0,
            weight_2: TOTAL_BPS,
          },
        ]);

        // The whole gate rests on an EXPLICIT weight_2 = 0 surviving the insert:
        // if it came back NULL, alpha would INHERIT its set-1 10000 into set 2,
        // set 2 would total 20000, and every case below would become a coin flip
        // that passes most of the time. Read it back rather than assume.
        const seeded = await packs.listPackOdds(
          { pack_id: PACK_SLUG },
          { take: 10 },
        );
        const alphaRow = seeded.find((o) => o.card_id === ALPHA);
        const betaRow = seeded.find((o) => o.card_id === BETA);
        expect(alphaRow).toMatchObject({ weight: TOTAL_BPS, weight_2: 0 });
        expect(betaRow).toMatchObject({ weight: 0, weight_2: TOTAL_BPS });
        // NULL weight_3 on both rows is what makes set 3 inherit set 2.
        expect(alphaRow?.weight_3 ?? null).toBeNull();
        expect(betaRow?.weight_3 ?? null).toBeNull();

        // Pin USD→MYR so the post-commit buyback quote is FIRM — a degraded
        // quote is non-fatal on the open path, but pinning it keeps a failure
        // here from being mistaken for an odds-set failure.
        await packs.createFxRates([
          {
            pair: 'USD_MYR',
            rate: MANUAL_RATE,
            source: 'test',
            manual_override: true,
            manual_rate: MANUAL_RATE,
          },
        ]);
      });

      const authed = (token: string): Record<string, string> => ({
        ...storeHeaders,
        authorization: `Bearer ${token}`,
      });

      // The top-up dedupe is keyed {customer_id, reference}, so one shared
      // idempotency key across DIFFERENT customers is safe.
      const topUp = (amount: number, headers: Record<string, string>) =>
        unwrapResponse(
          api.post(
            '/store/credits/topup',
            { amount },
            { headers: { ...headers, 'idempotency-key': 'odds-sets-topup' } },
          ),
        );

      /**
       * Registers + links + logs in a customer, funds them, and returns their
       * REAL customer id. The id must come from the linked customer row, never
       * the register token — that JWT carries an empty actor_id until
       * POST /store/customers links it, and an empty id would make every
       * group assertion below pass vacuously.
       */
      const registerCustomer = async (
        email: string,
        fund: number,
      ): Promise<{ id: string; headers: Record<string, string> }> => {
        const reg = await api.post('/auth/customer/emailpass/register', {
          email,
          password: PASSWORD,
        });
        await api.post(
          '/store/customers',
          { email },
          {
            headers: {
              ...storeHeaders,
              authorization: `Bearer ${reg.data.token}`,
            },
          },
        );
        const login = await api.post('/auth/customer/emailpass', {
          email,
          password: PASSWORD,
        });
        const headers = authed(login.data.token);
        const [customer] = await customerModule().listCustomers(
          { email },
          { take: 1 },
        );
        expect(customer?.id).toBeTruthy();
        expect((await topUp(fund, headers)).status).toBe(200);
        return { id: customer.id, headers };
      };

      /** Creates a group carrying an odds_set in its metadata (admin-written,
       *  untyped JSON — hence the unknown). */
      const createGroup = async (name: string, oddsSet: unknown) =>
        customerModule().createCustomerGroups({
          name,
          metadata: { odds_set: oddsSet },
        });

      const open = (headers: Record<string, string>) =>
        unwrapResponse(
          api.post(`/store/packs/${PACK_SLUG}/open`, {}, { headers }),
        );

      const openBatch = (count: number, headers: Record<string, string>) =>
        unwrapResponse(
          api.post(
            `/store/packs/${PACK_SLUG}/open-batch`,
            { count },
            { headers },
          ),
        );

      // Case 1 — no group at all: the default set. Also the anonymous/demo
      // shape, since the resolver short-circuits an absent customer id to 1.
      it('draws set 1 for an ungrouped customer', async () => {
        // Decoy: a set-2 group customer A is NOT in. Proves the resolver filters
        // by MEMBERSHIP, not just 'oldest group in the DB'.
        await createGroup('decoy-set2-group', 2);
        const a = await registerCustomer('odds-a@test.dev', PACK_PRICE);

        const opened = await open(a.headers);
        expect(opened.status).toBe(200);
        expect(opened.data.card.handle).toBe(ALPHA);
      });

      // Case 2 — the headline: SAME pack, SAME request, different card, and the
      // set came from the group's metadata (never from the request body).
      it('draws set 2 for a customer in an odds_set 2 group', async () => {
        const group = await createGroup('set2-group', 2);
        const b = await registerCustomer('odds-b@test.dev', PACK_PRICE);
        await customerModule().addCustomerToGroup({
          customer_id: b.id,
          customer_group_id: group.id,
        });

        const opened = await open(b.headers);
        expect(opened.status).toBe(200);
        expect(opened.data.card.handle).toBe(BETA);
      });

      // Case 3 — the batch chain is threaded too. The slot spin rides
      // open-batch, so a set that resolved on /open but not here would send the
      // same customer to two different distributions depending on reel count.
      // Both rolls must be beta: the set is resolved ONCE for the whole batch.
      it('draws set 2 for EVERY roll of a batch open', async () => {
        const group = await createGroup('set2-group', 2);
        const COUNT = 2;
        const b = await registerCustomer(
          'odds-batch@test.dev',
          PACK_PRICE * COUNT,
        );
        await customerModule().addCustomerToGroup({
          customer_id: b.id,
          customer_group_id: group.id,
        });

        const opened = await openBatch(COUNT, b.headers);
        expect(opened.status).toBe(200);
        expect(opened.data.rolls).toHaveLength(COUNT);
        for (const roll of opened.data.rolls) {
          expect(roll.card.handle).toBe(BETA);
        }
      });

      // Case 4 — group metadata is admin-written, untyped JSON. Junk must NOT
      // throw and must NOT roll an unconfigured column; it defaults to set 1.
      it('defaults a junk odds_set to set 1', async () => {
        const group = await createGroup('junk-group', 99);
        const c = await registerCustomer('odds-c@test.dev', PACK_PRICE);
        await customerModule().addCustomerToGroup({
          customer_id: c.id,
          customer_group_id: group.id,
        });

        const opened = await open(c.headers);
        expect(opened.status).toBe(200);
        expect(opened.data.card.handle).toBe(ALPHA);
      });

      // Case 5 — SECRET ODDS regression. The public pack detail is served under
      // a publishable key (visible in any customer's network tab); leaking the
      // per-card weights would publish the real win rates AND the alternate
      // odds tables. The substring covers weight / weight_2 / weight_3.
      // Status + row count are asserted FIRST so a 404 (or an empty pool) can
      // never satisfy the "contains no weights" check vacuously.
      it('never exposes any weight column on the public pack detail', async () => {
        const detail = await unwrapResponse(
          api.get(`/store/packs/${PACK_SLUG}`, { headers: storeHeaders }),
        );
        expect(detail.status).toBe(200);
        expect(detail.data.odds).toHaveLength(2);

        expect(JSON.stringify(detail.data)).not.toContain('"weight');
      });

      // Case 6 — MULTI-GROUP determinism. A customer can belong to several
      // groups; the resolver takes the OLDEST (created_at ASC, take 1). Nothing
      // else in the repo exercises that filter+order-through-join, so this is
      // the only proof "oldest wins" is real rather than incidental.
      //
      // The two sets are chosen so the three failure modes are DISTINGUISHABLE:
      // older-wins ⇒ beta; newer-wins ⇒ alpha; no group found ⇒ alpha. Only a
      // correct resolver returns beta.
      //
      // created_at is backdated over raw SQL rather than relying on wall-clock
      // separation: two back-to-back inserts can share a millisecond, and the
      // ordering — hence this whole assertion — would then be arbitrary.
      it('draws the OLDER group odds set when a customer is in two groups', async () => {
        const older = await createGroup('older-set2-group', 2);
        const newer = await createGroup('newer-set1-group', 1);

        const pg = getContainer().resolve(
          ContainerRegistrationKeys.PG_CONNECTION,
        ) as unknown as {
          raw: (sql: string, bindings?: unknown[]) => Promise<unknown>;
        };
        const OLDER_AT = '2020-01-01T00:00:00.000Z';
        const NEWER_AT = '2021-01-01T00:00:00.000Z';
        await pg.raw(
          'update "customer_group" set "created_at" = ? where "id" = ?',
          [OLDER_AT, older.id],
        );
        await pg.raw(
          'update "customer_group" set "created_at" = ? where "id" = ?',
          [NEWER_AT, newer.id],
        );
        // Assert the EXACT backdated values, not just their order: a silently
        // failed UPDATE (wrong table/column) would leave the rows at their
        // insertion times, which are already ordered — so an order-only check
        // would stay green while the spec quietly went back to depending on two
        // inserts not sharing a millisecond.
        const [olderRow, newerRow] = await Promise.all([
          customerModule().retrieveCustomerGroup(older.id),
          customerModule().retrieveCustomerGroup(newer.id),
        ]);
        expect(createdAtMs(olderRow)).toBe(Date.parse(OLDER_AT));
        expect(createdAtMs(newerRow)).toBe(Date.parse(NEWER_AT));

        const d = await registerCustomer('odds-d@test.dev', PACK_PRICE);
        // DELIBERATELY joined NEWEST-GROUP-FIRST, in two separate calls — do
        // NOT "tidy" this into one array. customer_group_customer carries its
        // OWN created_at, so if the resolver's `order: { created_at: 'ASC' }`
        // bound to the JOIN row instead of the GROUP, a batch insert in group-age
        // order would still return beta — green for the wrong reason, and that
        // ambiguity is the whole thing this case exists to rule out. Joining in
        // the opposite order makes group age, join-row age and insertion order
        // all point different ways, so beta is reachable ONLY via the group's
        // backdated created_at.
        await customerModule().addCustomerToGroup({
          customer_id: d.id,
          customer_group_id: newer.id,
        });
        await customerModule().addCustomerToGroup({
          customer_id: d.id,
          customer_group_id: older.id,
        });

        const opened = await open(d.headers);
        expect(opened.status).toBe(200);
        expect(opened.data.card.handle).toBe(BETA);
      });
    });
  },
});
