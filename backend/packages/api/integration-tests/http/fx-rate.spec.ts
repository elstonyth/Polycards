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

        // UPDATE branch: second override edit
        const updatePost = await unwrapResponse(
          api.post(
            "/admin/pricing/fx",
            { manual_override: true, manual_rate: 4.2 },
            adminHeaders(),
          ),
        );
        expect(updatePost.status).toBe(200);
        expect(updatePost.data.effective).toBe(4.2);

        const afterUpdate = await unwrapResponse(api.get("/admin/pricing/fx", adminHeaders()));
        expect(afterUpdate.data.effective).toBe(4.2);
        expect(afterUpdate.data.manual_rate).toBe(4.2);
      });

      // Auth proof: the FX write sets a global pricing multiplier; an
      // unauthenticated POST must be rejected by the framework /admin guard.
      it("rejects an unauthenticated POST with 401", async () => {
        const res = await unwrapResponse(
          api.post("/admin/pricing/fx", { manual_override: true, manual_rate: 4.85 }),
        );
        expect(res.status).toBe(401);
      });

      // Full manual_rate boundary coverage of requirePositiveNumberOrNull:
      // reject <=0, >1000, and non-numeric; accept the inclusive 1000 bound.
      it("rejects manual_rate > 1000 with 400", async () => {
        const res = await unwrapResponse(
          api.post(
            "/admin/pricing/fx",
            { manual_override: true, manual_rate: 1001 },
            adminHeaders(),
          ),
        );
        expect(res.status).toBe(400);
      });

      it("rejects manual_rate = 0 with 400", async () => {
        const res = await unwrapResponse(
          api.post(
            "/admin/pricing/fx",
            { manual_override: true, manual_rate: 0 },
            adminHeaders(),
          ),
        );
        expect(res.status).toBe(400);
      });

      it("rejects a negative manual_rate with 400", async () => {
        const res = await unwrapResponse(
          api.post(
            "/admin/pricing/fx",
            { manual_override: true, manual_rate: -1 },
            adminHeaders(),
          ),
        );
        expect(res.status).toBe(400);
      });

      it("accepts manual_rate = 1000 (inclusive upper bound) with 200", async () => {
        const res = await unwrapResponse(
          api.post(
            "/admin/pricing/fx",
            { manual_override: true, manual_rate: 1000 },
            adminHeaders(),
          ),
        );
        expect(res.status).toBe(200);
        expect(res.data.effective).toBe(1000);
      });

      it("rejects a non-numeric manual_rate with 400", async () => {
        const res = await unwrapResponse(
          api.post(
            "/admin/pricing/fx",
            { manual_override: true, manual_rate: "abc" },
            adminHeaders(),
          ),
        );
        expect(res.status).toBe(400);
      });

      it("rejects an empty-string manual_rate with 400", async () => {
        const res = await unwrapResponse(
          api.post(
            "/admin/pricing/fx",
            { manual_override: true, manual_rate: "" },
            adminHeaders(),
          ),
        );
        expect(res.status).toBe(400);
      });
    });
  },
});
