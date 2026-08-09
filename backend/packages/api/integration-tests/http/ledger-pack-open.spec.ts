import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { Modules } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { clearFxDisplayCache } from '../../src/modules/packs/pricing';
import { mintSuperAdmin, postStoreCustomer, unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

const PASSWORD = 'ledger-pack-open-test-password-1'; // gitleaks:allow
const ADMIN_EMAIL = 'ledger-pack-open-admin@test.dev';

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
      // Only for the Wallet-tab assertion below (Task 9) — the SP writer
      // itself needs no admin.
      let adminToken: string;

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

        adminToken = await mintSuperAdmin(container, api, ADMIN_EMAIL, PASSWORD);

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
        const created = await postStoreCustomer(
          api,
          getContainer(),
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
        // Pinned to the exact display price, not just > 0 — a loose bound
        // here is exactly what let the brief's own double-multiplier bug
        // (240 vs the buggy 288) slip through cases 1-3 undetected; only
        // case 4's round-trip math caught it.
        expect(Number(rows[0].vault_delta)).toBe(DISPLAY_PRICE);
        expect(rows[0].display_id).toMatch(/^SP/);

        // The Wallet tab's SP arm (Task 9): a pack_open credit_transaction
        // keys on source_transaction_id (the open id), NOT on its own id the
        // way TP/AD/SE do. Asserted here rather than in
        // admin-ledger-route.spec.ts because this file already owns the pack /
        // odds / FX scaffolding a real open needs.
        const wallet = await api.get(`/admin/customers/${id}/transactions`, {
          headers: { authorization: `Bearer ${adminToken}` },
        });
        const openRow = wallet.data.items.find(
          (t: { reason: string }) => t.reason === 'pack_open',
        );
        expect(openRow.ledger_display_id).toBe(rows[0].display_id);
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
      //
      // VERDICT (full reasoning in task-7-report.md, upheld + sharpened on
      // review): a payout-based vault_delta is a BUG, not intentional margin
      // retention — decisively so, because it is unimplementable for the OD
      // writer (physical delivery removes a card from the vault with
      // wallet_delta = 0 and no buyback rate anywhere on that path, so
      // there is nothing to apply a percentage TO). Only a full-value
      // vault_delta is expressible across SP, SE, and OD alike. SE
      // (recordBuybackCreditTransaction, service.ts) was fixed in the same
      // pass as this test: vaultDelta is now -valueMyr (the card's full
      // display price, already computed at buyback-pull.ts:136), not
      // -input.amount (the payout). This test now asserts the round trip
      // nets to EXACTLY ZERO — the number this comment originally predicted
      // a future fix would require.
      it('pull-then-sell round trip: vault_delta nets to zero', async () => {
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
        // -DISPLAY_PRICE, not -INSTANT_AMOUNT (the payout) — the fixed
        // convention: vault_delta is the card's full value, same magnitude
        // SP wrote on entry, regardless of what cash the sale actually paid.
        expect(Number(seRows[0].vault_delta)).toBe(-DISPLAY_PRICE);
        const sePayload = seRows[0].payload as Record<string, unknown>;
        expect(sePayload.price).toBe(DISPLAY_PRICE); // also fixed — was the payout

        const roundTrip =
          Number(spRows[0].vault_delta) + Number(seRows[0].vault_delta);
        expect(roundTrip).toBe(0); // fixed: full value in, full value out
      });
    });
  },
});
