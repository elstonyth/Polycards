import { medusaIntegrationTestRunner } from "@medusajs/test-utils";
import { Modules } from "@medusajs/framework/utils";
import type Redis from "ioredis";
import {
  connectTestRedisOrFail,
  TEST_REDIS_URL,
  unwrapResponse,
} from "./utils";

jest.setTimeout(240 * 1000);

// Finding 1 (phone-verification pre-merge review): POST
// /store/phone-verification/start now carries TWO limiter tiers (see
// rate-limit.ts's "Phone-OTP limiters" comment) — a per-phone tier keyed on
// the request body's `phone`, and a sitewide IP tier. The per-phone tier is
// the fix: without it, the storefront's server-side OTP proxy means every
// browser's request arrives from the SAME one egress IP in prod, so an
// IP-only limiter is one shared bucket for every visitor (one user exhausts
// everyone's signup/change/reset OTP budget).
//
// This is a SEPARATE file (not folded into phone-verification.spec.ts) for
// the same reason auth-rate-limit.spec.ts is separate from the functional
// auth specs: it needs a tight, real-Redis-observable burst, which would
// 429 the functional suite's own generous-budget assumptions if shared.
//
// Every request in this harness shares one IP — exactly what makes the
// per-phone tier's independence from IP-keying observable: if `keyOf` ever
// silently fell back to IP (e.g. req.body not parsed yet when this
// middleware runs), a hammered number would drag an unrelated number's
// requests down with it.
const RATE_ENV = {
  PHONE_OTP_START_PHONE_RATE_BURST_LIMIT: "3",
  PHONE_OTP_START_PHONE_RATE_BURST_WINDOW_MS: "60000",
  PHONE_OTP_START_PHONE_RATE_LIMIT: "1000",
  PHONE_OTP_START_PHONE_RATE_WINDOW_MS: "3600000",
  // Sitewide IP tier parked high — only the per-phone burst rule is under
  // test here.
  PHONE_OTP_START_RATE_BURST_LIMIT: "1000",
  PHONE_OTP_START_RATE_BURST_WINDOW_MS: "60000",
  PHONE_OTP_START_RATE_LIMIT: "5000",
  PHONE_OTP_START_RATE_WINDOW_MS: "3600000",
  // The app-under-test limiter must write to the SAME redis the probe below
  // inspects — same reasoning as auth-rate-limit.spec.ts.
  REDIS_URL: TEST_REDIS_URL,
};

const PHONE_A = "+60177000001";
const PHONE_B = "+60177000002";

medusaIntegrationTestRunner({
  inApp: true,
  env: RATE_ENV,
  testSuite: ({ api, getContainer }) => {
    describe("phone-otp per-phone rate limiting (Finding 1)", () => {
      let redis: Redis;
      let headers: Record<string, string>;

      beforeAll(async () => {
        redis = await connectTestRedisOrFail(
          "the phone-otp-rate-limit suite must observe the real rl:phone-otp-start-phone:* keys",
        );
        // A previous run's events within the window would shift this run's
        // budget — start from a clean slate (same idiom as auth-rate-limit).
        const keys = await redis.keys("rl:phone-otp-start-phone:*");
        if (keys.length) await redis.del(...keys);
      });

      afterAll(() => {
        redis?.disconnect();
      });

      beforeEach(async () => {
        const apiKeyModule = getContainer().resolve(Modules.API_KEY);
        const key = await apiKeyModule.createApiKeys({
          title: "phone-otp-rate-limit-test",
          type: "publishable",
          created_by: "phone-otp-rate-limit-test",
        });
        headers = { "x-publishable-api-key": key.token };
      });

      const start = (phone: string) =>
        unwrapResponse(
          api.post(
            "/store/phone-verification/start",
            { phone, purpose: "signup" },
            { headers },
          ),
        );

      it("429s a hammered phone number without throttling a different one", async () => {
        for (let i = 0; i < 3; i++) {
          expect((await start(PHONE_A)).status).toBe(200);
        }
        const limited = await start(PHONE_A);
        expect(limited.status).toBe(429);
        expect(limited.data).toMatchObject({ type: "rate_limit_exceeded" });

        // The load-bearing assertion: if the per-phone limiter had silently
        // fallen back to IP-keying, PHONE_B (same IP, different number)
        // would inherit PHONE_A's exhausted bucket and 429 here too.
        const bystander = await start(PHONE_B);
        expect(bystander.status).toBe(200);

        // Confirm the REAL Redis store served this keyed on phone (one key
        // per number under the phone: prefix), not one shared IP key.
        const keys = (await redis.keys("rl:phone-otp-start-phone:phone:*")).sort();
        expect(keys).toEqual(
          [
            `rl:phone-otp-start-phone:phone:${PHONE_A}`,
            `rl:phone-otp-start-phone:phone:${PHONE_B}`,
          ].sort(),
        );
      });
    });
  },
});
