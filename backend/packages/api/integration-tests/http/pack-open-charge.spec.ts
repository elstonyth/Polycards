import { medusaIntegrationTestRunner } from "@medusajs/test-utils";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import { PACKS_MODULE } from "../../src/modules/packs";
import type PacksModuleService from "../../src/modules/packs/service";
import { unwrapResponse } from "./utils";

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
        await api.post(
          "/store/customers",
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
    });
  },
});
