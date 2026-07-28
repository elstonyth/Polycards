import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { Modules } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { clearFxDisplayCache } from '../../src/modules/packs/pricing';
import { unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

const PASSWORD = 'ledger-pack-open-test-password-1'; // gitleaks:allow

// Task 7 (POLYCARD-BACK Epic 4 §5.3) — the SP ledger writer wired into
// open-pack / open-batch: a pack open appends exactly ONE SP ledger row
// (wallet_delta -price, vault_delta +pull-value) in the SAME transaction as
// the pull insert, whether the open is a single pull or a whole batch (ONE
// row per open_id, not one per pull). Pack-open behavior itself (charging,
// stock, VIP settle) is pack-open-charge.spec.ts's job; this file only tests
// the new ledger row.

const PACK_SLUG = 'ledger-sp-pack';
const CARD_HANDLE = 'ledger-sp-card';
const FMV = 50;
const MULTIPLIER = 1.2;
const MANUAL_RATE = 4.0;
const INSTANT_PERCENT = 96;
const PACK_PRICE = 10;
// Display price = FMV x FX x multiplier (D1) = 50 x 4.0 x 1.2 = RM 240 — the
// full "pull value" SP's vault_delta must carry (spec's own annotation).
const DISPLAY_PRICE = 240;
// buybackAmount(240, 96%) = RM 230.40 — the actual wallet payout SE credits.
const INSTANT_AMOUNT = 230.4;

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('ledger: SP writer — pack-open spend (single + batch)', () => {
      let storeHeaders: Record<string, string>;

      // The runner resets the database between `it` blocks, so the publishable
      // key, the gacha fixtures, and any customers are recreated per test.
      beforeEach(async () => {
        // SP is the first writer to use the LENIENT resolveFxRate, which caches
        // for 30s (pricing.ts). Without this, a rate cached by an earlier test
        // (in this file or an adjacent one sharing the --runInBand process)
        // could outlive this test's own FxRate row and silently mis-price
        // vault_delta — clearing keeps every test's FX read scoped to its own
        // fixtures.
        clearFxDisplayCache();

        const container = getContainer();
        const apiKeyModule = container.resolve(Modules.API_KEY);
        const key = await apiKeyModule.createApiKeys({
          title: 'ledger-pack-open-test',
          type: 'publishable',
          created_by: 'ledger-pack-open-test',
        });
        storeHeaders = { 'x-publishable-api-key': key.token };

        // Gacha fixtures: an active pack with a SINGLE-card pool, so the
        // weighted roll is deterministic (the only card always wins). No
        // product/inventory setup — stock is a best-effort counter, not a
        // gate (decrement-card-stock.ts), so an untracked card opens fine.
        const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
        await packs.createPacks([
          {
            slug: PACK_SLUG,
            title: 'Ledger SP Test Pack',
            category: 'pokemon',
            price: PACK_PRICE,
            image: '/cdn/test-pack.webp',
            buyback_percent: INSTANT_PERCENT,
          },
        ]);
        await packs.createCards([
          {
            handle: CARD_HANDLE,
            name: 'Ledger SP Test Card PSA 10',
            set: 'Test Set',
            grader: 'PSA',
            grade: '10',
            market_value: FMV,
            market_multiplier: MULTIPLIER,
            image: '/cdn/test-card.webp',
          },
        ]);
        await packs.createPackOdds([
          {
            pack_id: PACK_SLUG,
            card_id: CARD_HANDLE,
            weight: 100,
            locked: false,
            rarity: 'Rare' as const,
          },
        ]);
        // Pin USD->MYR so vault_delta and the buyback amount are deterministic.
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

      // registerCustomer captures the customer id (not just the token, unlike
      // pack-open-charge.spec.ts's copy) — Task 7 needs it to scope
      // ledgerEntryRowsFor, the same shape Task 4/5/6 already ship.
      const registerCustomer = async (
        email: string,
      ): Promise<{ token: string; id: string }> => {
        const reg = await api.post('/auth/customer/emailpass/register', {
          email,
          password: PASSWORD,
        });
        const created = await api.post(
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
        return { token: login.data.token, id: created.data.customer.id };
      };

      const ledgerEntryRowsFor = async (
        customerId: string,
        type?: string,
      ): Promise<Awaited<ReturnType<PacksModuleService['listLedgerEntries']>>> => {
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        const filter: Record<string, unknown> = { customer_id: customerId };
        if (type) filter.type = type;
        return packs.listLedgerEntries(filter, {
          order: { occurred_at: 'DESC' },
        });
      };

      const topUp = (amount: number, headers: Record<string, string>) =>
        unwrapResponse(
          api.post(
            '/store/credits/topup',
            { amount },
            { headers: { ...headers, 'idempotency-key': 'ledger-sp-topup' } },
          ),
        );

      it('a single open writes ONE SP row: wallet -price, vault +pull value', async () => {
        const { token, id } = await registerCustomer('ledger-test-7@test.dev');
        await topUp(1000, authed(token));
        const res = await api.post(
          `/store/packs/${PACK_SLUG}/open`,
          {},
          { headers: authed(token) },
        );
        expect(res.status).toBe(200);

        const rows = await ledgerEntryRowsFor(id, 'SP');
        expect(rows).toHaveLength(1);
        expect(Number(rows[0].wallet_delta)).toBe(-res.data.price);
        expect(Number(rows[0].vault_delta)).toBeGreaterThan(0);
        expect(rows[0].display_id).toMatch(/^SP/);
      });

      it('a batch open (count=3) writes ONE SP row for the whole batch, not three', async () => {
        const { token, id } = await registerCustomer('ledger-test-8@test.dev');
        await topUp(1000, authed(token));
        const res = await api.post(
          `/store/packs/${PACK_SLUG}/open-batch`,
          { count: 3 },
          { headers: authed(token) },
        );
        expect(res.status).toBe(200);

        const rows = await ledgerEntryRowsFor(id, 'SP');
        expect(rows).toHaveLength(1);
        // The route's JSON field is `total_charged` (open-batch/route.ts:167
        // renames the workflow's internal `result.total`), matching how
        // pack-open-charge.spec.ts itself asserts this same field — the
        // brief's literal `res.data.total` does not exist on the response.
        expect(Number(rows[0].wallet_delta)).toBe(-res.data.total_charged);
        // payload is model.json().nullable() at the DB level (defensively —
        // every writer in this epic always supplies one), so the generated
        // type carries `| null`; cast (not `any`) rather than a non-null
        // assertion the linter would flag.
        const payload = rows[0].payload as Record<string, unknown>;
        expect(payload.prize_skus).toHaveLength(3);
        expect(payload.channel).toBe('batch');
      });

      it('a reversed open leaves its SP ledger row standing (append-only — scope boundary, see Global Constraints)', async () => {
        // getContainer() is the same seam pack-open-charge.spec.ts already uses to
        // resolve PacksModuleService directly — reverseOpen is a post-commit admin/
        // fraud tool with no store or admin ROUTE of its own today, so the test
        // reaches it exactly the way any future admin route would: via the service.
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);

        const { token, id } = await registerCustomer('ledger-test-9@test.dev');
        await topUp(1000, authed(token));
        await api.post(`/store/packs/${PACK_SLUG}/open`, {}, { headers: authed(token) });

        const [pull] = await packs.listPulls(
          { customer_id: id },
          { take: 1, order: { rolled_at: 'DESC' } },
        );
        const before = (await ledgerEntryRowsFor(id, 'SP'))[0];
        expect(pull.open_id).toBeTruthy();

        await packs.reverseOpen(pull.open_id as string); // post-commit reversal, NOT workflow compensation

        const after = (await ledgerEntryRowsFor(id, 'SP'))[0];
        expect(Number(after.wallet_delta)).toBe(Number(before.wallet_delta)); // unchanged — no clawback
        expect(after.display_id).toBe(before.display_id); // same row, not a new one
      });

      // THE round trip Task 7 must settle (task-7-brief.md "THE ONE THING THIS
      // TASK MUST SETTLE"). SP writes vault_delta = +DISPLAY_PRICE (the full
      // pull value — spec §5.3's "(pull value)" annotation, Open Item #4).
      // SE (already shipped, Task 6, service.ts's recordBuybackCreditTransaction)
      // writes vault_delta = -amount, where `amount` is the buyback PAYOUT
      // (valueMyr x percent/100) — NOT the full display price. A pull-then-
      // sell cycle therefore does NOT net vault_delta back to zero: it leaves
      // a residual equal to the house's spread (DISPLAY_PRICE x (1 - percent
      // /100) = 240 x 0.04 = RM 9.60 at this fixture's 96% instant rate).
      //
      // VERDICT (full reasoning in task-7-report.md): this residual is a BUG,
      // not intentional margin retention. The spec's own OD row (§5.3) is
      // fully symmetric — vault - at order create, vault + on cancel,
      // wallet_delta = 0 throughout — proving vault_delta is a pure
      // inventory-value column, uncoupled from cash. SE's `vaultDelta:
      // -input.amount` conflates the two; the fix belongs in the ALREADY-
      // SHIPPED recordBuybackCreditTransaction (vaultDelta should be
      // -valueMyr, the full display price already computed at
      // buyback-pull.ts:136, not -amount). NOT applied here — out of this
      // task's scope; flagged for a follow-up, per the brief's explicit
      // instruction not to silently change SE.
      //
      // This test therefore pins CURRENT behavior (the 9.60 residual), not
      // the intended target (0). If a future task fixes SE, this test's
      // final assertion SHOULD go red — the correct response then is to
      // update THIS test to expect 0 (round trip nets clean), never to
      // "fix" SE back to keep this number green.
      it('pull-then-sell round trip: vault_delta sums to the house spread, not zero (current SE behavior — see task-7-report.md)', async () => {
        const { token, id } = await registerCustomer('ledger-test-10@test.dev');
        await topUp(PACK_PRICE, authed(token));

        const opened = await api.post(
          `/store/packs/${PACK_SLUG}/open`,
          {},
          { headers: authed(token) },
        );
        expect(opened.status).toBe(200);
        const pullId: string = opened.data.pull.id;

        const buyback = await api.post(
          `/store/vault/${pullId}/buyback`,
          {},
          { headers: authed(token) },
        );
        expect(buyback.status).toBe(200);
        // Pin the rate itself first — if the instant window ever flips to the
        // flat 90% here, THAT assertion fails (loudly, as a window/timing
        // problem), instead of silently changing the "spread" below to a
        // different number that still happens to look plausible.
        expect(buyback.data.percent).toBe(INSTANT_PERCENT);
        expect(buyback.data.amount).toBe(INSTANT_AMOUNT);

        const spRows = await ledgerEntryRowsFor(id, 'SP');
        const seRows = await ledgerEntryRowsFor(id, 'SE');
        expect(spRows).toHaveLength(1);
        expect(seRows).toHaveLength(1);
        expect(Number(spRows[0].vault_delta)).toBe(DISPLAY_PRICE);
        expect(Number(seRows[0].vault_delta)).toBe(-INSTANT_AMOUNT);

        const roundTrip =
          Number(spRows[0].vault_delta) + Number(seRows[0].vault_delta);
        expect(roundTrip).toBeCloseTo(DISPLAY_PRICE - INSTANT_AMOUNT, 2); // RM 9.60 — NOT 0
      });
    });
  },
});
