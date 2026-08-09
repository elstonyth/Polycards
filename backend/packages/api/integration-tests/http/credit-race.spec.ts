import { medusaIntegrationTestRunner } from "@medusajs/test-utils";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import { PACKS_MODULE } from "../../src/modules/packs";
import type PacksModuleService from "../../src/modules/packs/service";
import { mintSuperAdmin, postStoreCustomer, unwrapResponse } from "./utils";

jest.setTimeout(240 * 1000);

// #2 + #4 — credit mutations for one customer must serialize. Two concurrent
// pack-opens (or an open racing an admin deduct) on a one-pack balance must not
// both pass the balance/floor check and overspend into a negative balance.
// The charge/deduct re-reads Σ(ledger) then writes — without a per-customer
// lock those reads interleave and both writes land (a "free" pack / breached
// floor). These tests fire the requests concurrently and assert exactly one
// wins and the balance never drops below $0.

const PASSWORD = "credit-race-password-1";
const ADMIN_EMAIL = "credit-race-admin@test.dev";
const PACK_SLUG = "race-pack";
const CARD_HANDLE = "race-card";
const PACK_PRICE = 25;
const FMV = 50;
const STOCKED = 5;

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe("credit double-spend serialization", () => {
      let storeHeaders: Record<string, string>;
      let adminToken: string;

      beforeEach(async () => {
        const container = getContainer();

        const apiKeyModule = container.resolve(Modules.API_KEY);
        const key = await apiKeyModule.createApiKeys({
          title: "credit-race-test",
          type: "publishable",
          created_by: "credit-race-test",
        });
        storeHeaders = { "x-publishable-api-key": key.token };
        adminToken = await mintSuperAdmin(container, api, ADMIN_EMAIL, PASSWORD);

        // Single-card pool → deterministic roll. Stock well above the credit
        // budget so credit, not stock, is the binding constraint under the race.
        const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
        await packs.createPacks([
          {
            slug: PACK_SLUG,
            title: "Race Test Pack",
            category: "pokemon",
            price: PACK_PRICE,
            image: "/cdn/test-pack.webp",
            buyback_percent: 90,
          },
        ]);
        await packs.createCards([
          {
            handle: CARD_HANDLE,
            name: "Race Test Card PSA 10",
            set: "Test Set",
            grader: "PSA",
            grade: "10",
            market_value: FMV,
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

        const productModule = container.resolve(Modules.PRODUCT);
        const [product] = await productModule.createProducts([
          {
            title: "Race Test Card PSA 10",
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
          name: "Race Test Warehouse",
        });
        const inventoryModule = container.resolve(Modules.INVENTORY);
        const item = await inventoryModule.createInventoryItems({
          sku: `CARD-${CARD_HANDLE.toUpperCase()}`,
        });
        await inventoryModule.createInventoryLevels([
          {
            inventory_item_id: item.id,
            location_id: location.id,
            stocked_quantity: STOCKED,
          },
        ]);
        const link = container.resolve(ContainerRegistrationKeys.LINK);
        await link.create({
          [Modules.PRODUCT]: { variant_id: product.variants[0].id },
          [Modules.INVENTORY]: { inventory_item_id: item.id },
        });
      });

      const authed = (token: string): Record<string, string> => ({
        ...storeHeaders,
        authorization: `Bearer ${token}`,
      });
      const adminHeaders = (): Record<string, string> => ({
        authorization: `Bearer ${adminToken}`,
      });

      const registerCustomer = async (
        email: string,
      ): Promise<{ token: string; id: string }> => {
        const reg = await api.post("/auth/customer/emailpass/register", {
          email,
          password: PASSWORD,
        });
        const created = await postStoreCustomer(
          api,
          getContainer(),
          { email },
          { headers: { ...storeHeaders, authorization: `Bearer ${reg.data.token}` } },
        );
        const login = await api.post("/auth/customer/emailpass", {
          email,
          password: PASSWORD,
        });
        return { token: login.data.token, id: created.data.customer.id };
      };

      const open = (token: string) =>
        unwrapResponse(
          api.post(`/store/packs/${PACK_SLUG}/open`, {}, { headers: authed(token) }),
        );
      const topUp = (amount: number, token: string) =>
        unwrapResponse(
          api.post(
            "/store/credits/topup",
            { amount },
            { headers: { ...authed(token), "idempotency-key": "race-topup" } },
          ),
        );
      const adjust = (id: string, amount: number, note: string) =>
        unwrapResponse(
          api.post(
            `/admin/customers/${id}/credits`,
            { amount, note },
            { headers: adminHeaders() },
          ),
        );
      const balanceOf = (token: string) =>
        unwrapResponse(api.get("/store/credits", { headers: authed(token) })).then(
          (r) => r.data.balance as number,
        );

      it("two concurrent opens on a one-pack balance → exactly one wins, balance never < 0", async () => {
        const { token, id } = await registerCustomer("race-a@test.dev");
        expect((await topUp(PACK_PRICE, token)).status).toBe(200);

        const [r1, r2] = await Promise.all([open(token), open(token)]);
        const statuses = [r1.status, r2.status].sort();
        expect(statuses).toEqual([200, 400]);

        // Scope to THIS customer — a global count is flaky if a sibling test
        // shares the DB context (CodeRabbit).
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        const pulls = await packs.listPulls({ customer_id: id }, { take: 100 });
        expect(pulls).toHaveLength(1);
        expect(await balanceOf(token)).toBe(0);
      });

      it("an open racing an admin deduct on a one-pack balance → floor holds, balance never < 0", async () => {
        const { token, id } = await registerCustomer("race-b@test.dev");
        expect((await topUp(PACK_PRICE, token)).status).toBe(200);

        const [openRes, deductRes] = await Promise.all([
          open(token),
          adjust(id, -PACK_PRICE, "clawback race"),
        ]);
        const statuses = [openRes.status, deductRes.status].sort();
        expect(statuses).toEqual([200, 400]); // exactly one mutation wins
        expect(await balanceOf(token)).toBeGreaterThanOrEqual(0);
      });

      it("sequential opens with sufficient funds all succeed (no false serialization failure)", async () => {
        const { token } = await registerCustomer("race-c@test.dev");
        expect((await topUp(PACK_PRICE * 3, token)).status).toBe(200);

        for (let i = 0; i < 3; i++) {
          expect((await open(token)).status).toBe(200);
        }
        expect(await balanceOf(token)).toBe(0);
      });
    });
  },
});
