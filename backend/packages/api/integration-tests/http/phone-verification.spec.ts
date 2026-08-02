import { medusaIntegrationTestRunner } from "@medusajs/test-utils";
import { Modules } from "@medusajs/framework/utils";
import { unwrapResponse } from "./utils";

jest.setTimeout(240 * 1000);

// OTP start/check routes (Task 2). The test runner sets NODE_ENV=test, so
// sendPhoneOtp/checkPhoneOtpCode never touch Twilio - the dev transport code
// is the fixed '000000' (src/utils/phone-verification.ts). Both routes are
// PUBLIC (no bearer auth) but live under /store/*, so they need the same
// publishable-key header as every other /store/* route.
//
// Call-count note: the phone-otp-start limiter defaults to 3 requests/60s
// (rate-limit.ts createPhoneOtpStartRateLimit) and the test config carries no
// override for it - this suite makes EXACTLY 3 /start calls total so it
// never trips its own limiter. Add more calls only alongside a test-config
// override (see how AUTH_RATE_* / CREDIT_TOPUP_RATE_* / STORE_READ_RATE_*
// do it for their own suites).

const PHONE = "+60107667787";

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe("phone-verification OTP routes", () => {
      let headers: Record<string, string>;

      beforeEach(async () => {
        const apiKeyModule = getContainer().resolve(Modules.API_KEY);
        const key = await apiKeyModule.createApiKeys({
          title: "phone-verification-test",
          type: "publishable",
          created_by: "phone-verification-test",
        });
        headers = { "x-publishable-api-key": key.token };
      });

      const start = (body: Record<string, unknown>) =>
        unwrapResponse(
          api.post("/store/phone-verification/start", body, { headers }),
        );
      const check = (body: Record<string, unknown>) =>
        unwrapResponse(
          api.post("/store/phone-verification/check", body, { headers }),
        );

      describe("POST /store/phone-verification/start", () => {
        it("200-oks a valid E.164 + purpose", async () => {
          const res = await start({ phone: PHONE, purpose: "signup" });
          expect(res.status).toBe(200);
          expect(res.data).toEqual({ ok: true });
        });

        it("400s a non-E.164 phone and an unknown purpose", async () => {
          const badPhone = await start({
            phone: "0107667787",
            purpose: "signup",
          });
          expect(badPhone.status).toBe(400);

          const badPurpose = await start({ phone: PHONE, purpose: "admin" });
          expect(badPurpose.status).toBe(400);
        });
      });

      describe("POST /store/phone-verification/check", () => {
        it("mints a proof token for the dev code", async () => {
          const res = await check({
            phone: PHONE,
            purpose: "signup",
            code: "000000",
          });
          expect(res.status).toBe(200);
          expect(typeof res.data.token).toBe("string");
          expect(res.data.token).toContain(".");
        });

        it("400s a wrong code with a generic message", async () => {
          const res = await check({
            phone: PHONE,
            purpose: "signup",
            code: "111111",
          });
          expect(res.status).toBe(400);
          expect(res.data).toMatchObject({
            message: "Invalid or expired code.",
          });
        });
      });
    });
  },
});
