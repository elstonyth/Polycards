import { medusaIntegrationTestRunner } from "@medusajs/test-utils";
import { mintSuperAdmin, unwrapResponse } from "./utils";

jest.setTimeout(240 * 1000);

const PASSWORD = "fx-rate-test-pw-1";
const ADMIN_EMAIL = "admin-fx-rate@test.dev";

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe("GET/POST /admin/pricing/fx", () => {
      let adminToken: string;

      beforeEach(async () => {
        adminToken = await mintSuperAdmin(getContainer(), api, ADMIN_EMAIL, PASSWORD);
      });

      const adminHeaders = () => ({
        headers: { authorization: `Bearer ${adminToken}` },
      });

      it("fallback then manual override", async () => {
        const before = await unwrapResponse(api.get("/admin/pricing/fx", adminHeaders()));
        expect(before.status).toBe(200);
        expect(before.data.effective).toBeGreaterThan(0);

        const post = await unwrapResponse(
          api.post(
            "/admin/pricing/fx",
            { manual_override: true, manual_rate: 4.85 },
            adminHeaders(),
          ),
        );
        expect(post.status).toBe(200);
        expect(post.data.effective).toBe(4.85);

        const after = await unwrapResponse(api.get("/admin/pricing/fx", adminHeaders()));
        expect(after.data.effective).toBe(4.85);
        expect(after.data.manual_override).toBe(true);
        expect(after.data.manual_rate).toBe(4.85);
      });
    });
  },
});
