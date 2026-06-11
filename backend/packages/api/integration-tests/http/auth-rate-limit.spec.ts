import { medusaIntegrationTestRunner } from "@medusajs/test-utils";
import Redis from "ioredis";

jest.setTimeout(240 * 1000);

// The auth credential endpoints are public, so the limiter keys on the request
// IP — every call in this harness shares one IP, which is exactly what makes
// the budget observable. The tight values below OVERRIDE the effectively-
// unlimited ones in .env.test (which exist so the OTHER suites' register/login
// traffic never trips this limiter). The sustained rule is parked high: the
// burst rule is the behavior under test and one rule keeps the suite short.
const RATE_ENV = {
  AUTH_RATE_BURST_LIMIT: "3",
  AUTH_RATE_BURST_WINDOW_MS: "15000",
  AUTH_RATE_LIMIT: "1000",
  AUTH_RATE_WINDOW_MS: "60000",
};

medusaIntegrationTestRunner({
  inApp: true,
  env: RATE_ENV,
  testSuite: ({ api }) => {
    describe("auth endpoint rate limiting", () => {
      let redis: Redis;

      // Deliberately FAILS (no skip) when Redis is unreachable — same contract
      // as the pack-open suite: the limiter silently fails over to in-memory,
      // so without observing the real rl:auth:* keys the suite would stay
      // green even if the Redis path were broken.
      beforeAll(async () => {
        const url = process.env.REDIS_URL ?? "redis://localhost:6379";
        redis = new Redis(url, {
          lazyConnect: true,
          connectTimeout: 2_000,
          maxRetriesPerRequest: 1,
          enableOfflineQueue: false,
        });
        redis.on("error", () => {
          /* assertions surface failures; avoid unhandled 'error' events */
        });
        try {
          await redis.connect();
        } catch (err) {
          throw new Error(
            `Redis unreachable at ${url} — the auth-rate-limit suite must observe ` +
              `the real rl:auth:* keys. Start it: docker start pokenic-redis. (${err})`
          );
        }
        // A previous run's events within the window would shift this run's
        // budget — start from a clean slate.
        const keys = await redis.keys("rl:auth:*");
        if (keys.length) await redis.del(...keys);
      });

      afterAll(() => {
        redis?.disconnect();
      });

      // Returns the axios response for both 2xx and error statuses.
      const post = (path: string, body: Record<string, unknown>) =>
        api.post(path, body).then(
          (r: { status: number }) => r,
          (e: { response?: { status: number } }) => {
            if (!e.response) throw e;
            return e.response;
          }
        );

      const badLogin = () =>
        post("/auth/customer/emailpass", {
          email: "nobody@test.dev",
          password: "wrong-password-1",
        });

      it("401s under the limit, 429s over it, and covers register but not token refresh", async () => {
        // Under the limit the request reaches the auth provider, which rejects
        // the unknown account (401) — the limiter must not interfere.
        for (let i = 0; i < 3; i++) {
          expect((await badLogin()).status).toBe(401);
        }

        // 4th credential attempt inside the burst window → 429 + Retry-After.
        const limited = await badLogin();
        expect(limited.status).toBe(429);
        expect(limited.data).toMatchObject({ type: "rate_limit_exceeded" });
        const retryAfter = Number(limited.headers["retry-after"]);
        expect(retryAfter).toBeGreaterThanOrEqual(1);
        expect(retryAfter).toBeLessThanOrEqual(15);

        // Register shares the same per-IP budget (the /auth/*/emailpass/*
        // matcher): while locked out, registration is denied too — an attacker
        // can't sidestep the login limiter by hammering register instead.
        const register = await post("/auth/customer/emailpass/register", {
          email: "rl-auth-new@test.dev",
          password: "some-password-1",
        });
        expect(register.status).toBe(429);

        // Token refresh is deliberately NOT matched (high-frequency, already
        // token-gated): even mid-lockout it must reach the handler (401 for a
        // missing token), never the limiter's 429.
        const refresh = await post("/auth/token/refresh", {});
        expect(refresh.status).toBe(401);

        // The REAL Redis store served this (not the in-memory failover), and
        // denials recorded nothing (all-or-nothing): exactly the 3 allowed
        // events are on the ZSET.
        const keys = await redis.keys("rl:auth:ip:*");
        expect(keys).toHaveLength(1);
        expect(await redis.zcard(keys[0])).toBe(3);
      });
    });
  },
});
