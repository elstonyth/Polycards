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

      // Verified phone-change route (Task 4). Unlike the OTP routes above,
      // this one is authed - it's the only way to set a new phone once
      // enforcement is on (the /me gate in phone-verification-guard.ts closes
      // the core route). A register token's actor_id is empty until POST
      // /store/customers links it (see the "gated signup" register() helper
      // below), so every case here logs in fresh via /auth/customer/emailpass
      // to get an actor-bound bearer token, same as the direct-phone-write
      // test above.
      describe("POST /store/phone-verification/change", () => {
        const createLoggedInCustomer = async (
          email: string,
        ): Promise<Record<string, string>> => {
          const reg = await api.post("/auth/customer/emailpass/register", {
            email,
            password: PASSWORD,
          });
          await api.post(
            "/store/customers",
            { email },
            {
              headers: {
                ...headers,
                authorization: `Bearer ${reg.data.token}`,
              },
            },
          );
          const login = await api.post("/auth/customer/emailpass", {
            email,
            password: PASSWORD,
          });
          return { ...headers, authorization: `Bearer ${login.data.token}` };
        };

        const change = (
          body: Record<string, unknown>,
          authHeaders: Record<string, string>,
        ) =>
          unwrapResponse(
            api.post("/store/phone-verification/change", body, {
              headers: authHeaders,
            }),
          );

        it("200s a valid phone-change proof, reflected on GET /store/customers/me", async () => {
          const authHeaders = await createLoggedInCustomer(
            "change-valid@test.dev",
          );
          const phone = "+60107667790";

          await start({ phone, purpose: "phone-change" });
          const checked = await check({
            phone,
            purpose: "phone-change",
            code: "000000",
          });
          expect(checked.status).toBe(200);

          const res = await change(
            { phone, token: checked.data.token },
            authHeaders,
          );
          expect(res.status).toBe(200);
          expect(res.data).toMatchObject({ customer: { phone } });

          const me = await unwrapResponse(
            api.get("/store/customers/me", { headers: authHeaders }),
          );
          expect(me.data.customer.phone).toBe(phone);
        });

        it("400s a signup-purpose proof", async () => {
          const authHeaders = await createLoggedInCustomer(
            "change-wrong-purpose@test.dev",
          );
          const phone = "+60107667791";

          await start({ phone, purpose: "signup" });
          const checked = await check({
            phone,
            purpose: "signup",
            code: "000000",
          });
          expect(checked.status).toBe(200);

          const res = await change(
            { phone, token: checked.data.token },
            authHeaders,
          );
          expect(res.status).toBe(400);
          expect(res.data).toMatchObject({
            message: "Phone verification required.",
          });
        });

        it("400s a proof minted for a different phone", async () => {
          const authHeaders = await createLoggedInCustomer(
            "change-mismatch@test.dev",
          );
          const proofPhone = "+60107667792";
          const requestedPhone = "+60107667793";

          await start({ phone: proofPhone, purpose: "phone-change" });
          const checked = await check({
            phone: proofPhone,
            purpose: "phone-change",
            code: "000000",
          });
          expect(checked.status).toBe(200);

          const res = await change(
            { phone: requestedPhone, token: checked.data.token },
            authHeaders,
          );
          expect(res.status).toBe(400);
          expect(res.data).toMatchObject({
            message: "Phone verification required.",
          });
        });

        it("401s an unauthenticated request", async () => {
          const res = await unwrapResponse(
            api.post(
              "/store/phone-verification/change",
              { phone: "+60107667794", token: "bogus" },
              { headers },
            ),
          );
          expect(res.status).toBe(401);
        });

        // This route's whole reason to exist is being the escape hatch
        // blockUnverifiedPhoneWrite's doc comment points at once
        // PHONE_VERIFICATION_REQUIRED is on (the direct /me write is closed
        // in that mode - see the "gated signup" describe below). Prove it
        // actually still works under enforcement, not just with it off.
        describe("with enforcement on", () => {
          beforeAll(() => {
            process.env.PHONE_VERIFICATION_REQUIRED = "true";
          });
          afterAll(() => {
            delete process.env.PHONE_VERIFICATION_REQUIRED;
          });

          it("still sets the new phone via a verified proof", async () => {
            // createLoggedInCustomer posts { email } with no phone, so
            // requireSignupPhoneProof next()s it untouched even with
            // enforcement on (that guard only fires when the body carries a
            // phone).
            const authHeaders = await createLoggedInCustomer(
              "change-enforced@test.dev",
            );
            const phone = "+60107667795";

            await start({ phone, purpose: "phone-change" });
            const checked = await check({
              phone,
              purpose: "phone-change",
              code: "000000",
            });
            expect(checked.status).toBe(200);

            const res = await change(
              { phone, token: checked.data.token },
              authHeaders,
            );
            expect(res.status).toBe(200);
            expect(res.data).toMatchObject({ customer: { phone } });

            const me = await unwrapResponse(
              api.get("/store/customers/me", { headers: authHeaders }),
            );
            expect(me.data.customer.phone).toBe(phone);
          });
        });
      });

      // Forgot-password-by-phone (Task 5): proof exchanges for the SAME
      // single-use 15m reset token the email flow issues
      // (generateResetPasswordTokenWorkflow — see route.ts's header comment
      // for the full workflow-contract verification). The returned token is
      // a genuine core reset token, so it already goes through the existing
      // '/auth/*/emailpass/update' single-use guard (reset-token-guard.ts) —
      // the happy-path test's single successful update is that guard working
      // WITH this route, not a gap in coverage.
      describe("POST /store/phone-verification/password-reset", () => {
        const passwordReset = (body: Record<string, unknown>) =>
          unwrapResponse(
            api.post("/store/phone-verification/password-reset", body, {
              headers,
            }),
          );

        it("runs the full loop: proof -> reset token -> emailpass update -> login with the new password", async () => {
          const email = "pw-reset-happy@test.dev";
          const phone = "+60107667800";
          const newPassword = "phone-verify-new-pw-2";
          await registerCustomerWithPhone(email, phone);

          await start({ phone, purpose: "password-reset" });
          const checked = await check({
            phone,
            purpose: "password-reset",
            code: "000000",
          });
          expect(checked.status).toBe(200);

          const res = await passwordReset({ token: checked.data.token });
          expect(res.status).toBe(200);
          expect(typeof res.data.token).toBe("string");
          expect(res.data.maskedEmail).toMatch(/^.\*+@/);

          const updated = await unwrapResponse(
            api.post(
              "/auth/customer/emailpass/update",
              { password: newPassword },
              { headers: { Authorization: `Bearer ${res.data.token}` } },
            ),
          );
          expect(updated.status).toBe(200);
          expect(updated.data).toMatchObject({ success: true });

          const login = await api.post("/auth/customer/emailpass", {
            email,
            password: newPassword,
          });
          expect(login.status).toBe(200);
          expect(login.data.token).toEqual(expect.any(String));
        });

        it("400s a signup-purpose proof", async () => {
          const phone = "+60107667801";
          await start({ phone, purpose: "signup" });
          const checked = await check({
            phone,
            purpose: "signup",
            code: "000000",
          });
          expect(checked.status).toBe(200);

          const res = await passwordReset({ token: checked.data.token });
          expect(res.status).toBe(400);
          expect(res.data).toMatchObject({
            message: "Phone verification required.",
          });
        });

        it("404s a phone matching zero customers", async () => {
          const phone = "+60107667802";
          await start({ phone, purpose: "password-reset" });
          const checked = await check({
            phone,
            purpose: "password-reset",
            code: "000000",
          });
          expect(checked.status).toBe(200);

          const res = await passwordReset({ token: checked.data.token });
          expect(res.status).toBe(404);
          expect(res.data).toMatchObject({
            message: "No account uses this phone number.",
          });
        });

        it("400s when two accounts share the phone, with the reset-by-email message", async () => {
          const phone = "+60107667803";
          await registerCustomerWithPhone("pw-reset-dup-a@test.dev", phone);
          await registerCustomerWithPhone("pw-reset-dup-b@test.dev", phone);

          await start({ phone, purpose: "password-reset" });
          const checked = await check({
            phone,
            purpose: "password-reset",
            code: "000000",
          });
          expect(checked.status).toBe(200);

          const res = await passwordReset({ token: checked.data.token });
          expect(res.status).toBe(400);
          expect(res.data).toMatchObject({
            message:
              "More than one account uses this phone number. Reset by email instead.",
          });
        });

        // Google-only account: has_account:true + a phone, but no `emailpass`
        // provider identity — seeded directly via the AUTH module (rather
        // than POST /auth/customer/emailpass/register, which would create
        // one) so the row shape matches a real Google-only signup. A genuine
        // `google` auth-provider strategy isn't registered in this test env
        // (medusa-config.ts only adds it when GOOGLE_CLIENT_ID/SECRET/
        // CALLBACK_URL are set, and .env.test sets none of them), so this
        // seeds the provider_identity row directly instead of going through
        // a live Google OAuth callback.
        it("400s (NOT_ALLOWED) for an account with no emailpass identity", async () => {
          const email = "pw-reset-google-only@test.dev";
          const phone = "+60107667804";
          const container = getContainer();
          const customerService = container.resolve(Modules.CUSTOMER);
          const authService = container.resolve(Modules.AUTH);
          await customerService.createCustomers({
            email,
            phone,
            has_account: true,
          });
          await authService.createAuthIdentities({
            provider_identities: [{ provider: "google", entity_id: email }],
          });

          await start({ phone, purpose: "password-reset" });
          const checked = await check({
            phone,
            purpose: "password-reset",
            code: "000000",
          });
          expect(checked.status).toBe(200);

          const res = await passwordReset({ token: checked.data.token });
          expect(res.status).toBe(400);
          expect(res.data).toMatchObject({
            message: "This account signs in with Google.",
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
          // Pin the rejection source to requireSignupPhoneProof, not
          // rejectCustomerMetadata or core body validation (both also 400 on
          // this route, which would let an unwired guard pass silently).
          expect(res.data).toMatchObject({
            message: "Phone verification required.",
          });
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
          // Pin the rejection source to blockUnverifiedPhoneWrite, not
          // rejectCustomerMetadata or core validation (same reasoning as the
          // signup-gate assertion above).
          expect(res.data).toMatchObject({
            message: "Phone changes require verification.",
          });
        });
      });
    });
  },
});
