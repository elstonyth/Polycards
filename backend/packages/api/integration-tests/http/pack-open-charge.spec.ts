import { medusaIntegrationTestRunner } from "@medusajs/test-utils";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import { PACKS_MODULE } from "../../src/modules/packs";
import type PacksModuleService from "../../src/modules/packs/service";
import { postStoreCustomer, unwrapResponse } from "./utils";

jest.setTimeout(240 * 1000);

const PASSWORD = "poc-test-password-1";

// Task A2 — pack opens charge the credit ledger: an open debits exactly the
// pack price; insufficient credit blocks the open with NO side effects (no
// Pull row, no stock decrement, no ledger row). The economy loop closes:
// top-up funds opens, buyback refills the balance.

const PACK_SLUG = "poc-pack";
const CARD_HANDLE = "poc-card";
const PACK_PRICE = 10;
const FMV = 50;
const MULTIPLIER = 1.2;
const MANUAL_RATE = 4.0;
// Buyback is a cut of the FX-converted Value (50 × 4.0 × 1.2 = RM 240), not raw
// USD: 96% × 240 = RM 230.40. FX pinned in beforeEach for determinism.
const INSTANT_PERCENT = 96;
const INSTANT_AMOUNT = 230.4;
const STOCKED = 5;

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe("pack-open charge", () => {
      let storeHeaders: Record<string, string>;
      let inventoryItemId: string;
      let stockLocationId: string;

      beforeEach(async () => {
        const container = getContainer();

        const apiKeyModule = container.resolve(Modules.API_KEY);
        const key = await apiKeyModule.createApiKeys({
          title: "pack-open-charge-test",
          type: "publishable",
          created_by: "pack-open-charge-test",
        });
        storeHeaders = { "x-publishable-api-key": key.token };

        // Single-card pool → deterministic roll (the only card always wins).
        const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
        await packs.createPacks([
          {
            slug: PACK_SLUG,
            title: "POC Test Pack",
            category: "pokemon",
            price: PACK_PRICE,
            image: "/cdn/test-pack.webp",
            buyback_percent: INSTANT_PERCENT,
          },
        ]);
        await packs.createCards([
          {
            handle: CARD_HANDLE,
            name: "POC Test Card PSA 10",
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
        // Pin USD→MYR so the buyback credit is deterministic — the sell path now
        // pays a cut of the FX-converted Value, not raw USD.
        await packs.createFxRates([
          {
            pair: "USD_MYR",
            rate: MANUAL_RATE,
            source: "test",
            manual_override: true,
            manual_rate: MANUAL_RATE,
          },
        ]);

        // Tracked inventory so the no-side-effects assertion can watch stock.
        const productModule = container.resolve(Modules.PRODUCT);
        const [product] = await productModule.createProducts([
          {
            title: "POC Test Card PSA 10",
            handle: CARD_HANDLE,
            status: "published",
            options: [{ title: "Format", values: ["Slab"] }],
            variants: [
              {
                title: "Slab",
                sku: `CARD-${CARD_HANDLE.toUpperCase()}`,
                manage_inventory: true,
                options: { Format: "Slab" },
              },
            ],
          },
        ]);
        const stockLocationModule = container.resolve(Modules.STOCK_LOCATION);
        const location = await stockLocationModule.createStockLocations({
          name: "POC Test Warehouse",
        });
        stockLocationId = location.id;
        const inventoryModule = container.resolve(Modules.INVENTORY);
        const item = await inventoryModule.createInventoryItems({
          sku: `CARD-${CARD_HANDLE.toUpperCase()}`,
        });
        inventoryItemId = item.id;
        await inventoryModule.createInventoryLevels([
          {
            inventory_item_id: inventoryItemId,
            location_id: stockLocationId,
            stocked_quantity: STOCKED,
          },
        ]);
        const link = container.resolve(ContainerRegistrationKeys.LINK);
        await link.create({
          [Modules.PRODUCT]: { variant_id: product.variants[0].id },
          [Modules.INVENTORY]: { inventory_item_id: inventoryItemId },
        });
      });

      const stockedQuantity = async (): Promise<number> => {
        const inventoryModule = getContainer().resolve(Modules.INVENTORY);
        const [level] = await inventoryModule.listInventoryLevels({
          inventory_item_id: inventoryItemId,
        });
        return Number(level.stocked_quantity);
      };

      const pullCount = async (): Promise<number> => {
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        const pulls = await packs.listPulls({}, { take: 100 });
        return pulls.length;
      };

      const authed = (token: string): Record<string, string> => ({
        ...storeHeaders,
        authorization: `Bearer ${token}`,
      });

      const registerCustomer = async (email: string): Promise<string> => {
        const reg = await api.post("/auth/customer/emailpass/register", {
          email,
          password: PASSWORD,
        });
        await postStoreCustomer(
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
        return login.data.token;
      };

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

      // The top-up idempotency dedupe is scoped to {customer_id, reference}, so
      // sharing one key across DIFFERENT customers is safe. Calling this twice for
      // the SAME customer, though, replays the first top-up instead of adding to it.
      const topUp = (amount: number, headers: Record<string, string>) =>
        unwrapResponse(
          api.post(
            "/store/credits/topup",
            { amount },
            { headers: { ...headers, "idempotency-key": "pack-open-charge-topup" } },
          ),
        );

      it("blocks an unfunded open with 400 and NO side effects", async () => {
        const token = await registerCustomer("poc-customer-a@test.dev");

        const res = await open(authed(token));
        expect(res.status).toBe(400);
        expect(res.data.message).toMatch(/not enough credits/i);
        // Plan 016 — the message names the numbers so the customer knows the
        // price, their balance, and exactly how much more to top up.
        expect(res.data.message).toContain(`RM ${PACK_PRICE.toFixed(2)}`); // price
        expect(res.data.message).toContain("RM 0.00"); // balance (unfunded)
        expect(res.data.message).toContain(
          `top up at least RM ${PACK_PRICE.toFixed(2)}.`, // shortfall = full price
        );

        // Nothing happened: no Pull, no stock movement, no ledger row.
        expect(await pullCount()).toBe(0);
        expect(await stockedQuantity()).toBe(STOCKED);
        const credits = await unwrapResponse(
          api.get("/store/credits", { headers: authed(token) }),
        );
        expect(credits.data.balance).toBe(0);
        expect(credits.data.transactions).toHaveLength(0);
      });

      it("debits exactly the price on open (exact balance works), then buyback refills", async () => {
        const token = await registerCustomer("poc-customer-b@test.dev");

        // Fund EXACTLY the price — the affordability rule is >=, not >.
        expect((await topUp(PACK_PRICE, authed(token))).status).toBe(200);

        const opened = await open(authed(token));
        expect(opened.status).toBe(200);
        expect(opened.data.price).toBe(PACK_PRICE);
        expect(opened.data.balance).toBe(0);
        expect(opened.data.card.handle).toBe(CARD_HANDLE);
        // The reveal's instant sell-back offer is AUTHORITATIVE from the open
        // response (resolveBuybackRate), so the reveal quote can never disagree
        // with the credit — the storefront must not recompute it from its own
        // (possibly stale/mock) pack catalog. This is the freshly-opened pull,
        // so it is inside the instant window: percent == the pack's buyback %.
        expect(opened.data.buyback).toMatchObject({
          percent: INSTANT_PERCENT,
          amount: INSTANT_AMOUNT,
          rate_type: "instant",
        });
        expect(await pullCount()).toBe(1);
        expect(await stockedQuantity()).toBe(STOCKED - 1);

        // The ledger shows topup then the negative pack_open debit.
        const credits = await unwrapResponse(
          api.get("/store/credits", { headers: authed(token) }),
        );
        expect(credits.data.balance).toBe(0);
        expect(credits.data.transactions).toHaveLength(2);
        expect(credits.data.transactions[0]).toMatchObject({
          amount: -PACK_PRICE,
          reason: "pack_open",
          pull_id: null,
        });

        // A second open at zero balance is blocked — and leaves the one pull.
        const blocked = await open(authed(token));
        expect(blocked.status).toBe(400);
        expect(blocked.data.message).toMatch(/not enough credits/i);
        expect(await pullCount()).toBe(1);
        expect(await stockedQuantity()).toBe(STOCKED - 1);

        // Buyback of the PAID pull still credits Value(MYR) × instant % on top.
        const pullId: string = opened.data.pull.id;
        const buyback = await unwrapResponse(
          api.post(
            `/store/vault/${pullId}/buyback`,
            {},
            { headers: authed(token) },
          ),
        );
        expect(buyback.status).toBe(200);
        expect(buyback.data.amount).toBe(INSTANT_AMOUNT);
        expect(buyback.data.balance).toBe(INSTANT_AMOUNT);
      });

      // The slot spin (count = reels) rides open-batch, and the reel animation
      // only starts once this response lands — so a debit already in the ledger
      // by then is one the player cannot dodge by leaving mid-spin. A batch is
      // ONE charge row, not one per reel (spec §9).
      it("debits count×price as a single charge row on open-batch; an unfunded batch records no pull", async () => {
        const token = await registerCustomer("poc-customer-c@test.dev");
        const COUNT = 2;
        const TOTAL = PACK_PRICE * COUNT;

        expect((await topUp(TOTAL, authed(token))).status).toBe(200);

        const opened = await openBatch(COUNT, authed(token));
        expect(opened.status).toBe(200);
        expect(opened.data.price).toBe(PACK_PRICE);
        expect(opened.data.total_charged).toBe(TOTAL);
        // The response itself carries the POST-charge balance.
        expect(opened.data.balance).toBe(0);
        expect(opened.data.rolls).toHaveLength(COUNT);

        // Paid AND recorded by response time — never one without the other.
        expect(await pullCount()).toBe(COUNT);

        // Re-read the ledger: ONE pack_open row of -TOTAL for the whole batch.
        // The reason filter is the robust part (a total row count would break on any
        // unrelated future credit). The balance re-read below pins the total, but it
        // reflects EVERY row: seed a vip_level ladder here and a rung crossed by this
        // spend would grant credit and fail it. (opened.data.balance is computed inside
        // settleOpen, before settleVipStep, so it stays robust either way.)
        const credits = await unwrapResponse(
          api.get("/store/credits", { headers: authed(token) }),
        );
        expect(credits.data.balance).toBe(0);
        const opens = credits.data.transactions.filter(
          (t: { reason?: string }) => t.reason === "pack_open",
        );
        expect(opens).toHaveLength(1);
        expect(opens[0]).toMatchObject({ amount: -TOTAL });

        // Broke now: the next batch is refused and records NO pull. Teeth on the
        // INVARIANT — never a pull without a paid debit — not on step order: a charge
        // moved after recordPullsBatchStep would still abort and compensate the pull
        // rows away, leaving this same end state. The saga enforces order;
        // credit-race.spec covers concurrent double-spend.
        const blocked = await openBatch(COUNT, authed(token));
        expect(blocked.status).toBe(400);
        expect(blocked.data.message).toMatch(/not enough credits/i);
        expect(await pullCount()).toBe(COUNT);

        // ...and the refusal took no money either — still the ONE pack_open row from
        // the paid batch. Closes the other direction: the assertions above prove no
        // pull without a debit; this proves no debit without a pull.
        const after = await unwrapResponse(
          api.get("/store/credits", { headers: authed(token) }),
        );
        expect(
          after.data.transactions.filter(
            (t: { reason?: string }) => t.reason === "pack_open",
          ),
        ).toHaveLength(1);
        expect(after.data.balance).toBe(0);
      });

      // Both open routes enrich the response with a buyback quote AFTER the
      // workflow has already debited the customer and written the pull — and
      // nothing there can roll that back. A throw in that enrichment used to
      // fail the whole request, so a player who had just paid saw a generic
      // error instead of their reveal (the storefront's !res.ok branch), even
      // though the card was in their vault the whole time: a lost charge, as
      // far as they could tell. The enrichment is now non-fatal — the PAID roll
      // still comes back, with only the quote degraded to null.
      //
      // quoteBuyback is spied because it is called ONLY in post-commit route
      // enrichment (the workflow never calls it), so a throw there provably
      // exercises the charged-then-failed path and nothing earlier.
      //
      // It is also the ONLY sound seam here. The enrichment's other DB reads are
      // not enrichment-exclusive: listCards is called PRE-commit by the roll-pack
      // step, so spying it fails the workflow before the charge (verified: 500,
      // no Pull, no debit — which is correct, nobody paid). The FX read cannot
      // throw at all; resolveFxRateInfo swallows and degrades to firm:false
      // itself. Since every thrower funnels into the same catch, quoteBuyback
      // covers the path.
      const throwOnQuote = () =>
        jest
          .spyOn(
            getContainer().resolve<PacksModuleService>(PACKS_MODULE),
            "quoteBuyback",
          )
          .mockRejectedValue(new Error("quote path exploded"));

      it("serves the PAID pull with a non-firm buyback when the quote throws", async () => {
        const token = await registerCustomer("poc-customer-c@test.dev");
        expect((await topUp(PACK_PRICE, authed(token))).status).toBe(200);

        const quoteSpy = throwOnQuote();
        let pullId: string;
        try {
          const opened = await open(authed(token));

          // Served, not 500'd — the reveal still gets its card and pull id.
          expect(opened.status).toBe(200);
          expect(opened.data.card.handle).toBe(CARD_HANDLE);
          expect(opened.data.pull.id).toEqual(expect.any(String));
          // The debit is real and the response says so — this is what proves
          // "paid, and served anyway" rather than "silently not charged".
          expect(opened.data.price).toBe(PACK_PRICE);
          expect(opened.data.balance).toBe(0);
          expect(await pullCount()).toBe(1);
          // Only the quote degrades — and it degrades to an explicitly NON-FIRM
          // offer, never null/absent. A missing buyback is treated as FIRM by the
          // storefront's offer builder (`roll.buyback?.firm ?? true`, an older-
          // backend allowance), which with no marketPriceMyr would fabricate a
          // firm "Sell for RM 0.00 (90%)" CTA with a live countdown. firm:false
          // is what makes the reveal render Keep-only + "sell when rates return".
          expect(opened.data.buyback).toMatchObject({ firm: false });
          expect(opened.data.card.marketPriceMyr).toBeUndefined();
          expect(quoteSpy).toHaveBeenCalled();
          pullId = opened.data.pull.id;
        } finally {
          quoteSpy.mockRestore();
        }

        // Nothing was lost: once quoting recovers the same pull sells for the
        // full instant amount, so the degraded reveal cost the player nothing.
        const buyback = await unwrapResponse(
          api.post(
            `/store/vault/${pullId}/buyback`,
            {},
            { headers: authed(token) },
          ),
        );
        expect(buyback.status).toBe(200);
        expect(buyback.data.amount).toBe(INSTANT_AMOUNT);
      });

      it("serves PAID batch rolls with non-firm buybacks when the quote throws", async () => {
        const token = await registerCustomer("poc-customer-d@test.dev");
        const COUNT = 2;
        expect((await topUp(PACK_PRICE * COUNT, authed(token))).status).toBe(
          200,
        );

        const quoteSpy = throwOnQuote();
        try {
          const opened = await openBatch(COUNT, authed(token));

          expect(opened.status).toBe(200);
          // Every paid roll is surfaced — not one of them is dropped.
          expect(opened.data.rolls).toHaveLength(COUNT);
          for (const roll of opened.data.rolls) {
            expect(roll.card.handle).toBe(CARD_HANDLE);
            expect(roll.pull.id).toEqual(expect.any(String));
            // Non-firm, never null — see the single-open case for why.
            expect(roll.buyback).toMatchObject({ firm: false });
            expect(roll.card.marketPriceMyr).toBeUndefined();
          }
          // ...and the batch debit is reported, not hidden behind an error.
          expect(opened.data.total_charged).toBe(PACK_PRICE * COUNT);
          expect(opened.data.balance).toBe(0);
          expect(await pullCount()).toBe(COUNT);
        } finally {
          quoteSpy.mockRestore();
        }
      });
    });
  },
});
