import { medusaIntegrationTestRunner } from "@medusajs/test-utils";
import { Modules } from "@medusajs/framework/utils";
import type Redis from "ioredis";
import { connectTestRedisOrFail, unwrapResponse } from "./utils";

jest.setTimeout(240 * 1000);

// Limits sized for this harness. In-app opens are fast (~15ms warm), so a
// short burst window still comfortably holds the 3 sequential opens the burst
// test fires — and keeping it short means the "let the burst window drain"
// wait below is ~1.5s instead of the 15s+ it used to cost every CI run. The
// sustained window stays long (120s) so all opens across the whole lifecycle
// test remain inside it. BURST_WINDOW_MS is the single source of truth: the
// env value, the drain sleep, and the retry-after bound all derive from it so
// they can't drift.
// The middleware reads these at boot (see src/api/utils/rate-limit.ts).
const BURST_WINDOW_MS = 1000;
const RATE_ENV = {
  PACK_OPEN_RATE_BURST_LIMIT: "3",
  PACK_OPEN_RATE_BURST_WINDOW_MS: String(BURST_WINDOW_MS),
  PACK_OPEN_RATE_LIMIT: "5",
  PACK_OPEN_RATE_WINDOW_MS: "120000",
};

const PASSWORD = "rl-test-password-1";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The bearer token is a JWT; its payload carries the customer's actor_id,
// which is the limiter's Redis key suffix (rl:pack-open:<actor_id>).
const actorIdFromToken = (token: string): string =>
  JSON.parse(Buffer.from(token.split(".")[1], "base64").toString()).actor_id;

medusaIntegrationTestRunner({
  inApp: true,
  env: RATE_ENV,
  testSuite: ({ api, getContainer }) => {
    describe("POST /store/packs/:slug/open rate limiting", () => {
      let storeHeaders: Record<string, string>;
      let redis: Redis;

      beforeAll(async () => {
        redis = await connectTestRedisOrFail(
          "the rate-limit suite must observe the real rl:pack-open:* keys"
        );
      });

      afterAll(() => {
        redis?.disconnect();
      });

      // The runner resets the database between `it` blocks, so the
      // publishable key (and any customers) must be recreated per test.
      beforeEach(async () => {
        const apiKeyModule = getContainer().resolve(Modules.API_KEY);
        const key = await apiKeyModule.createApiKeys({
          title: "rate-limit-test",
          type: "publishable",
          created_by: "rate-limit-test",
        });
        storeHeaders = { "x-publishable-api-key": key.token };
      });

      const post = (
        path: string,
        body: Record<string, unknown>,
        headers: Record<string, string>
      ) => unwrapResponse(api.post(path, body, { headers }));

      // The slug doesn't need to exist: the limiter runs before the route
      // handler, so under the limit we see the handler's 404/400 for an
      // unknown pack, and over the limit we see the middleware's 429.
      const openPack = (bearer: string) =>
        post(
          "/store/packs/no-such-pack/open",
          {},
          { ...storeHeaders, authorization: `Bearer ${bearer}` }
        );

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
          }
        );
        const login = await api.post("/auth/customer/emailpass", {
          email,
          password: PASSWORD,
        });
        return login.data.token;
      };

      it("still rejects unauthenticated requests with 401, never 429", async () => {
        for (let i = 0; i < 5; i++) {
          const res = await post(
            "/store/packs/no-such-pack/open",
            {},
            storeHeaders
          );
          expect(res.status).toBe(401);
        }
      });

      it("enforces burst limit, recovers, then trips the sustained limit", async () => {
        const token = await registerCustomer("rl-customer-1@test.dev");
        const limiterKey = `rl:pack-open:${actorIdFromToken(token)}`;

        // Under the limit the request reaches the handler, which rejects the
        // unknown slug (non-429); the limiter itself must not interfere.
        const firstOpenAt = Date.now();
        for (let i = 0; i < 3; i++) {
          const res = await openPack(token);
          expect(res.status).not.toBe(429);
          expect(res.status).toBeGreaterThanOrEqual(400); // unknown pack
        }

        // 4th request inside the burst window → 429 from the middleware.
        const limited = await openPack(token);
        const deniedAt = Date.now();
        expect(limited.status).toBe(429);
        expect(limited.data).toMatchObject({ type: "rate_limit_exceeded" });
        const retryAfter = Number(limited.headers["retry-after"]);
        expect(Number.isFinite(retryAfter)).toBe(true);
        expect(retryAfter).toBeGreaterThanOrEqual(1);
        // Tight bound: the wait is until the FIRST open ages out of the burst
        // window, i.e. at most the window minus the time already elapsed
        // (±1s for ceil + clock granularity). A constant full-window bug
        // (e.g. the Lua wait=win fallback) fails this.
        const burstWindowSec = BURST_WINDOW_MS / 1000;
        const elapsedSec = (deniedAt - firstOpenAt) / 1000;
        expect(retryAfter).toBeLessThanOrEqual(
          Math.ceil(burstWindowSec - elapsedSec) + 1,
        );

        // The REAL Redis store must have served this (not the in-memory
        // failover): exactly 3 events recorded, the denial added nothing.
        expect(await redis.zcard(limiterKey)).toBe(3);

        // Let the burst window empty (events age out BURST_WINDOW_MS after they
        // landed); the sustained window (120s) still holds all 3 opens.
        await sleep(BURST_WINDOW_MS + 500);

        // 3 opens consumed so far. The denied attempt must NOT have counted
        // (all-or-nothing), so exactly two more fit under the sustained
        // limit of 5. If the 429 above had been recorded, the second of
        // these would already be denied.
        expect((await openPack(token)).status).not.toBe(429);
        expect((await openPack(token)).status).not.toBe(429);

        // Burst window now holds only those 2 events, so this denial can
        // only come from the sustained rule (5 per 120s).
        const sustained = await openPack(token);
        expect(sustained.status).toBe(429);
        const sustainedRetry = Number(sustained.headers["retry-after"]);
        // Beyond the burst window: a burst-rule retry can never exceed it, so
        // this denial can only be the sustained rule (bounded by its 120s window).
        expect(sustainedRetry).toBeGreaterThan(burstWindowSec);
        expect(sustainedRetry).toBeLessThanOrEqual(120);
      });

      it("tracks customers independently", async () => {
        const tokenA = await registerCustomer("rl-customer-a@test.dev");
        const tokenB = await registerCustomer("rl-customer-b@test.dev");

        // Exhaust A's burst budget.
        for (let i = 0; i < 3; i++) {
          expect((await openPack(tokenA)).status).not.toBe(429);
        }
        expect((await openPack(tokenA)).status).toBe(429);

        // B is untouched by A's lockout.
        expect((await openPack(tokenB)).status).not.toBe(429);
      });
    });
  },
});
