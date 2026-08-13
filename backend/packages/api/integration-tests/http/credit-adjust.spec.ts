import { medusaIntegrationTestRunner } from "@medusajs/test-utils";
import { Modules } from "@medusajs/framework/utils";
import { PACKS_MODULE } from "../../src/modules/packs";
import { ADJUST_MAX_RM } from "../../src/modules/packs/credit-adjust";
import type PacksModuleService from "../../src/modules/packs/service";
import { mintSuperAdmin, postStoreCustomer, unwrapResponse } from "./utils";

jest.setTimeout(240 * 1000);

const PASSWORD = "adjust-test-password-1";
const ADMIN_EMAIL = "adjust-admin@test.dev";

// Manual credit adjustment: an operator applies a signed ledger row (reason
// "adjustment", note in "reference") with a $0 balance floor. Grants raise
// the balance, deductions past zero are refused with NO row written, and the
// row is customer-visible through GET /store/credits.

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe("admin credit adjustment", () => {
      let storeHeaders: Record<string, string>;
      let adminToken: string;

      // The runner resets the database between `it` blocks, so the publishable
      // key, the admin user, and any customers are recreated per test.
      beforeEach(async () => {
        const container = getContainer();
        const apiKeyModule = container.resolve(Modules.API_KEY);
        const key = await apiKeyModule.createApiKeys({
          title: "credit-adjust-test",
          type: "publishable",
          created_by: "credit-adjust-test",
        });
        storeHeaders = { "x-publishable-api-key": key.token };

        adminToken = await mintSuperAdmin(
          container,
          api,
          ADMIN_EMAIL,
          PASSWORD,
        );
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
        return { token: login.data.token, id: created.data.customer.id };
      };

      const adjust = (
        customerId: string,
        body: Record<string, unknown>,
        headers: Record<string, string>,
      ) =>
        unwrapResponse(
          api.post(`/admin/customers/${customerId}/credits`, body, { headers }),
        );

      const ledgerRows = async () => {
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        return packs.listCreditTransactions(
          { reason: "adjustment" },
          { take: 100 },
        );
      };

      it("rejects an unauthenticated adjustment with 401", async () => {
        const { id } = await registerCustomer("adjust-customer-a@test.dev");
        const res = await adjust(id, { amount: 5, note: "grant" }, {});
        expect(res.status).toBe(401);
        expect(await ledgerRows()).toHaveLength(0);
      });

      it("grants credit, records the note, and is customer-visible", async () => {
        const { id, token } = await registerCustomer(
          "adjust-customer-b@test.dev",
        );

        const granted = await adjust(
          id,
          { amount: 12.5, note: "Goodwill for failed open" },
          adminHeaders(),
        );
        expect(granted.status).toBe(200);
        expect(granted.data).toMatchObject({ amount: 12.5, balance: 12.5 });

        const [row] = await ledgerRows();
        expect(row).toMatchObject({
          customer_id: id,
          reason: "adjustment",
          pull_id: null,
          reference: "Goodwill for failed open",
        });
        expect(Number(row.amount)).toBe(12.5);

        // Customer sees the adjustment in their own ledger.
        const credits = await unwrapResponse(
          api.get("/store/credits", {
            headers: { ...storeHeaders, authorization: `Bearer ${token}` },
          }),
        );
        expect(credits.data.balance).toBe(12.5);
        expect(credits.data.transactions[0]).toMatchObject({
          amount: 12.5,
          reason: "adjustment",
        });
      });

      it("deducts within the balance but refuses to go below RM 0 (no row written)", async () => {
        const { id } = await registerCustomer("adjust-customer-c@test.dev");

        const grant = await adjust(
          id,
          { amount: 10, note: "seed balance" },
          adminHeaders(),
        );
        expect(grant.status).toBe(200);

        const deduct = await adjust(
          id,
          { amount: -4, note: "partial clawback" },
          adminHeaders(),
        );
        expect(deduct.status).toBe(200);
        expect(deduct.data.balance).toBe(6);

        const tooFar = await adjust(
          id,
          { amount: -6.01, note: "overdraw attempt" },
          adminHeaders(),
        );
        expect(tooFar.status).toBe(400);
        expect(tooFar.data.message).toMatch(/below RM 0/i);
        expect(await ledgerRows()).toHaveLength(2); // grant + partial only
      });

      it("rejects invalid amounts and missing notes with 400 and writes nothing", async () => {
        const { id } = await registerCustomer("adjust-customer-d@test.dev");

        for (const body of [
          { amount: 0, note: "zero" },
          { amount: ADJUST_MAX_RM + 0.01, note: "too big" },
          { amount: 1.234, note: "sub-cent" },
          { amount: "5", note: "string" },
          { amount: 5 }, // missing note
          { amount: 5, note: "   " }, // blank note
        ]) {
          const res = await adjust(id, body, adminHeaders());
          expect(res.status).toBe(400);
        }
        expect(await ledgerRows()).toHaveLength(0);
      });

      // The ceiling is the interesting number after the 10_000 -> 1_000_000
      // raise: `amount` is an unbounded pg numeric with a raw_amount jsonb
      // sidecar, and nothing else asserts the new headroom actually lands.
      // A bound below the app layer (a CHECK, a precision loss in the
      // bigNumber round-trip) would keep every unit test green and fail on
      // the first real six-figure grant.
      it("grants the full ceiling without losing precision", async () => {
        const { id, token } = await registerCustomer(
          "adjust-customer-e@test.dev",
        );

        const granted = await adjust(
          id,
          { amount: ADJUST_MAX_RM, note: "ceiling grant" },
          adminHeaders(),
        );
        expect(granted.status).toBe(200);
        expect(granted.data).toMatchObject({
          amount: ADJUST_MAX_RM,
          balance: ADJUST_MAX_RM,
        });

        const [row] = await ledgerRows();
        expect(Number(row.amount)).toBe(ADJUST_MAX_RM);

        const credits = await unwrapResponse(
          api.get("/store/credits", {
            headers: { ...storeHeaders, authorization: `Bearer ${token}` },
          }),
        );
        expect(credits.data.balance).toBe(ADJUST_MAX_RM);
      });
      it("404s an unknown customer id", async () => {
        const res = await adjust(
          "cus_does_not_exist",
          { amount: 5, note: "ghost" },
          adminHeaders(),
        );
        expect(res.status).toBe(404);
      });
    });
  },
});
