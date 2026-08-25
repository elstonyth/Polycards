import { medusaIntegrationTestRunner } from "@medusajs/test-utils";
import { Modules } from "@medusajs/framework/utils";
import { PACKS_MODULE } from "../../src/modules/packs";
import type PacksModuleService from "../../src/modules/packs/service";
import { postStoreCustomer, unwrapResponse } from "./utils";

jest.setTimeout(240 * 1000);

const PASSWORD = "ledger-conservation-password-1";

// Plan 031 — cross-flow ledger-conservation invariant. PR #138 deleted the
// virtual-month sim harness (scripts/sim/ledger.mjs), the ONLY check the
// project ever had that the credit economy CONSERVES money across a live
// multi-step flow. This restores that single invariant as one HTTP integration
// spec: after every money hop (topup → open → buyback),
//   Σ(ledger rows) == creditSummary().balance == walletSummary().balance ==
//   the /store/credits view — and the external-funded (deposit) basis adds up.
// Deliberately NOT the sim, personas, or viewer: one invariant, not a
// simulation. It is meant to stay green before AND after plan 026 (playthrough
// basis change), so this flow uses a DEPOSIT-funded open where both bases agree
// and never pins playthrough.used.

const PACK_SLUG = "ledger-pack";
const CARD_HANDLE = "ledger-card";
const PACK_PRICE = 10;
const FMV = 50;
const MULTIPLIER = 1.2;
// The markup is MOVED between the open and the sell (see step (c2)). Buyback
// pays a cut of the LIVE display value, so the payout pinned below is the
// BUMPED one. Without a price move this spec asserted conservation only under
// frozen fixtures - the case that cannot fail - while reading in the PR as
// general conservation proof.
const BUMPED_MULTIPLIER = 1.5;
const MANUAL_RATE = 4.0;
const INSTANT_PERCENT = 96;
// Buyback credits a cut of the FX-converted MYR Value, not raw USD:
//   FMV × MANUAL_RATE × BUMPED_MULTIPLIER = 50 × 4.0 × 1.5 = RM 300 (the
//   shown Value AT SELL TIME) × 96% instant = RM 288.00. FX pinned in beforeEach.
const INSTANT_AMOUNT = 288;
const TOPUP = 100;
// Deposit-funded open, so the final balance is exact:
//   topup − price + buyback = 100 − 10 + 288 = RM 378.00.
const FINAL_BALANCE = 378;

// The two fields assertConserved reads off each raw ledger row. amount is RM
// (decimal); external_funded_cents is SEN (integer, signed). They are summed
// separately and NEVER crossed.
type LedgerRow = {
  amount: number | string;
  reason: string;
  external_funded_cents: number | null;
};

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe("ledger conservation across the money loop", () => {
      let storeHeaders: Record<string, string>;

      beforeEach(async () => {
        const container = getContainer();

        const apiKeyModule = container.resolve(Modules.API_KEY);
        const key = await apiKeyModule.createApiKeys({
          title: "ledger-conservation-test",
          type: "publishable",
          created_by: "ledger-conservation-test",
        });
        storeHeaders = { "x-publishable-api-key": key.token };

        // Single-card pool → deterministic roll (the only card always wins). No
        // tracked inventory: the open's stock decrement is best-effort (a
        // fulfillment counter, never a gate — see open-pack.ts), so a
        // conservation check needs none of the stock/product scaffolding the
        // pack-open-charge exemplar carries for its no-side-effects assertion.
        const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
        await packs.createPacks([
          {
            slug: PACK_SLUG,
            title: "Ledger Test Pack",
            category: "pokemon",
            price: PACK_PRICE,
            image: "/cdn/test-pack.webp",
            buyback_percent: INSTANT_PERCENT,
          },
        ]);
        await packs.createCards([
          {
            handle: CARD_HANDLE,
            name: "Ledger Test Card PSA 10",
            set: "Test Set",
            grader: "PSA",
            grade: "10",
            market_value: FMV,
            market_multiplier: MULTIPLIER,
            image: "/cdn/test-card.webp",
          },
        ]);
        await packs.createPackOdds([
          {
            pack_id: PACK_SLUG,
            card_id: CARD_HANDLE,
            weight: 100,
            locked: false,
            rarity: "Rare" as const,
          },
        ]);
        // Pin USD→MYR so the buyback credit is deterministic — the sell path
        // pays a cut of the FX-converted Value.
        await packs.createFxRates([
          {
            pair: "USD_MYR",
            rate: MANUAL_RATE,
            source: "test",
            manual_override: true,
            manual_rate: MANUAL_RATE,
          },
        ]);
      });

      const authed = (token: string): Record<string, string> => ({
        ...storeHeaders,
        authorization: `Bearer ${token}`,
      });

      // Register + create + login; returns the login token AND the customer id.
      // The id is the actor_id every store route keys the ledger on (open/topup
      // read req.auth_context.actor_id), so the direct creditSummary /
      // walletSummary calls below hit exactly the rows the HTTP view sums.
      const registerCustomer = async (
        email: string,
      ): Promise<{ token: string; customerId: string }> => {
        const reg = await api.post("/auth/customer/emailpass/register", {
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
        const login = await api.post("/auth/customer/emailpass", {
          email,
          password: PASSWORD,
        });
        return {
          token: login.data.token,
          customerId: created.data.customer.id,
        };
      };

      const open = (headers: Record<string, string>) =>
        unwrapResponse(
          api.post(`/store/packs/${PACK_SLUG}/open`, {}, { headers }),
        );

      const topUp = (amount: number, headers: Record<string, string>) =>
        unwrapResponse(
          api.post(
            "/store/credits/topup",
            { amount },
            {
              headers: {
                ...headers,
                "idempotency-key": "ledger-conservation-topup",
              },
            },
          ),
        );

      // THE INVARIANT. Re-read the whole ledger and assert every balance view
      // agrees with Σ(rows), and the external-funded basis conserves. Money in
      // RM (row.amount, decimal) and external in SEN (external_funded_cents,
      // integer) are summed SEPARATELY. Called after every money hop.
      const assertConserved = async (
        customerId: string,
        headers: Record<string, string>,
      ): Promise<void> => {
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        const rows = (await packs.listCreditTransactions(
          { customer_id: customerId },
          { take: 1000 },
        )) as unknown as LedgerRow[];

        // Σ(amount) in integer cents, rounded PER ROW (matches the service's
        // SUM(ROUND(amount*100)); sum-then-round would drift).
        const sumRm =
          rows.reduce((acc, r) => acc + Math.round(Number(r.amount) * 100), 0) /
          100;

        const summary = await packs.creditSummary(customerId);
        const wallet = await packs.walletSummary(customerId);
        expect(summary.balance).toBeCloseTo(sumRm, 2);
        expect(wallet.balance).toBeCloseTo(sumRm, 2);

        // The HTTP view agrees with the ledger (both the top-level balance and
        // the wallet sub-object).
        const credits = await unwrapResponse(
          api.get("/store/credits", { headers }),
        );
        expect(credits.status).toBe(200);
        expect(credits.data.balance).toBeCloseTo(sumRm, 2);
        expect(credits.data.wallet.balance).toBeCloseTo(sumRm, 2);

        // available = balance when not frozen; withdrawable ≤ available.
        if (!wallet.isFrozen) {
          expect(wallet.available).toBeCloseTo(wallet.balance, 2);
        }
        expect(wallet.withdrawable).toBeLessThanOrEqual(wallet.available + 1e-9);

        // External-basis EXACT conservation, all in SEN — non-topup/non-open
        // rows must carry zero external basis. (An inequality bound here would
        // let a buyback/adjustment row that incorrectly carried positive
        // external_funded_cents slip through inside the headroom —
        // CodeRabbit, PR #143.)
        const sumExtSen = rows.reduce(
          (acc, r) => acc + (r.external_funded_cents ?? 0),
          0,
        );
        const topupExtSen = rows.reduce(
          (acc, r) =>
            acc + (r.reason === "topup" ? r.external_funded_cents ?? 0 : 0),
          0,
        );
        // Negative: pack_open rows snapshot the consumed sen sign-flipped.
        const packOpenExtSen = rows.reduce(
          (acc, r) =>
            acc + (r.reason === "pack_open" ? r.external_funded_cents ?? 0 : 0),
          0,
        );
        expect(sumExtSen).toBeGreaterThanOrEqual(0); // cheap sanity floor
        // Integer sen, so exact equality is safe (no float rounding).
        expect(sumExtSen).toBe(topupExtSen + packOpenExtSen);
        for (const r of rows) {
          if (r.reason !== "topup" && r.reason !== "pack_open") {
            expect(r.external_funded_cents ?? 0).toBe(0);
          }
        }

        // The aggregate externalFundedSpendTotal equals Σ(−external) over the
        // pack_open rows (the service SQL vs. the same rows folded in JS).
        expect(Math.round(summary.externalFundedSpendTotal * 100)).toBe(
          // + 0 normalizes -0 → 0: with no pack_open rows yet the sum is +0,
          // its negation is -0, and toBe (Object.is) treats -0 !== 0.
          -packOpenExtSen + 0,
        );
      };

      it("ledger conserves across topup → open → buyback", async () => {
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        const { token, customerId } = await registerCustomer(
          "ledger-conservation@test.dev",
        );
        const headers = authed(token);

        // (a) Empty ledger: the direct summary path resolves and reads 0.
        expect((await packs.creditSummary(customerId)).balance).toBe(0);
        await assertConserved(customerId, headers);

        // (b) Top up RM 100.
        const topup = await topUp(TOPUP, headers);
        expect(topup.status).toBe(200);
        await assertConserved(customerId, headers);

        // (c) Open one pack — a deposit-funded debit of RM PACK_PRICE.
        const opened = await open(headers);
        expect(opened.status).toBe(200);
        expect(opened.data.price).toBe(PACK_PRICE);
        expect(opened.data.balance).toBeCloseTo(TOPUP - PACK_PRICE, 2);
        await assertConserved(customerId, headers);

        // (c2) MOVE THE PRICE mid-flow - a PriceCharting FMV sync or an admin
        // markup edit landing between the open and the sell. Conservation has
        // to hold ACROSS a revaluation, not merely under frozen fixtures: the
        // ledger accumulates historical amounts while every balance view
        // recomputes, so a writer that stamped or reversed a stale value
        // drifts from the pinned values below.
        //
        // The assertConserved that closes this step is NOT what catches such a
        // writer. It is TAUTOLOGICAL w.r.t. price: it sums credit_transaction
        // rows and compares them to summaries derived from those same rows
        // (creditSummary, walletSummary and GET /store/credits carry no price
        // dependency), and no credit row is written between (c) and (c2), so
        // it re-asserts identical state. The real discriminators are the
        // exact-value pins in (d) (INSTANT_AMOUNT) and (e) (FINAL_BALANCE) -
        // proven by mutation: freeze the buyback markup and those go RED while
        // this assertConserved stays green. DO NOT delete them as "already
        // covered by conservation" - that restores the vacuity this spec had
        // before the price move was added.
        const [card] = await packs.listCards(
          { handle: CARD_HANDLE },
          { take: 1 },
        );
        await packs.updateCards([
          { id: card.id, market_multiplier: BUMPED_MULTIPLIER },
        ]);
        await assertConserved(customerId, headers);

        // (d) Instant-buyback the freshly-opened pull (inside the instant window).
        const pullId: string = opened.data.pull.id;
        const buyback = await unwrapResponse(
          api.post(`/store/vault/${pullId}/buyback`, {}, { headers }),
        );
        expect(buyback.status).toBe(200);
        expect(buyback.data.amount).toBeCloseTo(INSTANT_AMOUNT, 2);
        await assertConserved(customerId, headers);

        // (e) Final exact-value pin: 100 − 10 + 288 = RM 378.00, and the
        // deposit basis is the full topup. playthrough.used is intentionally NOT
        // pinned — plan 026 changes that basis; deposited is stable.
        const wallet = await packs.walletSummary(customerId);
        expect(wallet.balance).toBeCloseTo(FINAL_BALANCE, 2);
        expect(wallet.playthrough.deposited).toBeCloseTo(TOPUP, 2);
      });
    });
  },
});
