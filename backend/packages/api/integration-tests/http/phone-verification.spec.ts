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
// The phone-otp-start/check limiters default to a tight 3/60s and 5/60s
// burst (rate-limit.ts) - this suite's call count exceeds that, so the whole
// file raises the budget via the runner's `env:` override, same precedent as
// auth-rate-limit.spec.ts's RATE_ENV (there the override tightens the auth
// limiter to make it observable; here it loosens the phone-otp limiter so
// this functional suite doesn't 429 itself).
const RATE_ENV = {
  PHONE_OTP_START_RATE_BURST_LIMIT: "50",
  PHONE_OTP_START_RATE_BURST_WINDOW_MS: "60000",
  PHONE_OTP_START_RATE_LIMIT: "200",
  PHONE_OTP_START_RATE_WINDOW_MS: "3600000",
  PHONE_OTP_CHECK_RATE_BURST_LIMIT: "50",
  PHONE_OTP_CHECK_RATE_BURST_WINDOW_MS: "60000",
  PHONE_OTP_CHECK_RATE_LIMIT: "200",
  PHONE_OTP_CHECK_RATE_WINDOW_MS: "3600000",
};

const PHONE = "+60107667787";
const PASSWORD = "phone-verify-test-pw-1"; // gitleaks:allow

medusaIntegrationTestRunner({
  inApp: true,
  env: RATE_ENV,
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

      // Register + link (POST /auth/.../register -> POST /store/customers)
      // is what sets has_account: true (core create-customer-account
      // workflow: `has_account: !!data.input.authIdentityId`) - same flow
      // disabled-login.spec.ts uses. `phone` passes straight through the
      // core create-customer workflow (only `metadata` is guarded).
      const registerCustomerWithPhone = async (
        email: string,
        phone: string,
      ): Promise<void> => {
        const reg = await api.post("/auth/customer/emailpass/register", {
          email,
          password: PASSWORD,
        });
        await api.post(
          "/store/customers",
          { email, phone },
          { headers: { ...headers, authorization: `Bearer ${reg.data.token}` } },
        );
      };

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

        // Security-critical branch (start/route.ts): password-reset must
        // never disclose whether a phone belongs to an account - zero
        // matches and exactly-one-match both answer identically, and
        // neither actually blocks on the (mocked-away) SMS send.
        describe("password-reset (no-oracle)", () => {
          it("200-oks {ok:true} for a phone matching zero customers", async () => {
            const res = await start({
              phone: "+60199999998",
              purpose: "password-reset",
            });
            expect(res.status).toBe(200);
            expect(res.data).toEqual({ ok: true });
          });

          it("200-oks the identical {ok:true} for a phone matching a real registered customer", async () => {
            const phone = "+60199999997";
            await registerCustomerWithPhone("pr-seeded@test.dev", phone);

            const res = await start({ phone, purpose: "password-reset" });
            expect(res.status).toBe(200);
            expect(res.data).toEqual({ ok: true });
          });
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

      // Enforcement gates (Task 3, src/api/utils/phone-verification-guard.ts).
      // The guards read PHONE_VERIFICATION_REQUIRED per request, so flipping
      // the env var here (rather than a runner `env:` override) reaches the
      // already-booted app without a restart - scoped to this describe block
      // only via beforeAll/afterAll so the tests above stay opt-in.
      describe("gated signup", () => {
        beforeAll(() => {
          process.env.PHONE_VERIFICATION_REQUIRED = "true";
        });
        afterAll(() => {
          delete process.env.PHONE_VERIFICATION_REQUIRED;
        });

        // Register-only helper (no /store/customers call yet) so each test
        // controls its own create-attempt body/headers.
        const register = async (email: string): Promise<string> => {
          const reg = await api.post("/auth/customer/emailpass/register", {
            email,
            password: PASSWORD,
          });
          return reg.data.token as string;
        };

        it("refuses registration with a phone but no proof", async () => {
          const email = "gated-no-proof@test.dev";
          const phone = "+60199999996";
          const token = await register(email);

          const res = await unwrapResponse(
            api.post(
              "/store/customers",
              { email, phone },
              { headers: { ...headers, authorization: `Bearer ${token}` } },
            ),
          );
          expect(res.status).toBe(400);
        });

        it("accepts registration with a fresh signup proof header", async () => {
          const email = "gated-with-proof@test.dev";
          const phone = "+60199999995";
          const token = await register(email);

          await start({ phone, purpose: "signup" });
          const checked = await check({
            phone,
            purpose: "signup",
            code: "000000",
          });
          expect(checked.status).toBe(200);
          const proof = checked.data.token as string;

          const res = await unwrapResponse(
            api.post(
              "/store/customers",
              { email, phone },
              {
                headers: {
                  ...headers,
                  authorization: `Bearer ${token}`,
                  "x-phone-verification": proof,
                },
              },
            ),
          );
          expect(res.status).toBe(200);
          expect(res.data.customer.phone).toBe(phone);
        });

        it("refuses a direct phone change on /store/customers/me", async () => {
          const email = "gated-me-change@test.dev";
          const token = await register(email);
          await unwrapResponse(
            api.post(
              "/store/customers",
              { email },
              { headers: { ...headers, authorization: `Bearer ${token}` } },
            ),
          );
          const login = await api.post("/auth/customer/emailpass", {
            email,
            password: PASSWORD,
          });
          const loginHeaders = {
            ...headers,
            authorization: `Bearer ${login.data.token}`,
          };

          const res = await unwrapResponse(
            api.post(
              "/store/customers/me",
              { phone: "+60199999994" },
              { headers: loginHeaders },
            ),
          );
          expect(res.status).toBe(400);
        });
      });
    });
  },
});
